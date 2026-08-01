import { readdirSync, readFileSync, existsSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import type { Heartbeat, BusPaths } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { readCrons } from './crons.js';

/**
 * Look up the agent's `heartbeat` cron schedule string from crons.json so we
 * can stamp `loop_interval` on every heartbeat write. Returns '' if there is
 * no heartbeat cron or the schedule isn't an interval expression — the
 * staleness calculator (utils/heartbeat-staleness.ts) handles that case via
 * its fallback.
 *
 * Resolves the audit's writer-false-STALE finding: relying on callers to pass
 * --loop-interval left the field empty for any agent whose heartbeat cron
 * fired without it.
 */
function resolveLoopInterval(agentName: string): string {
  try {
    const crons = readCrons(agentName);
    const heartbeatCron = crons.find(c => c.name === 'heartbeat');
    return heartbeatCron?.schedule ?? '';
  } catch {
    return '';
  }
}

/**
 * SessionEnd-hook end-type markers (see src/hooks/hook-crash-alert.ts). A
 * restart writes one of these; the crash-alert hook reads it WITHOUT consuming
 * it, because one restart fires the hook twice and both firings must classify
 * from the same marker. clearEndMarkers is the marker's primary cleanup: an
 * agent updating its heartbeat is genuinely alive in its post-restart session,
 * so a pending end-marker is stale and is removed here — but only once it is
 * past the grace window below. The hook's TTL is the backstop for a start that
 * fails before ever heartbeating.
 */
const END_TYPE_MARKERS = [
  '.restart-planned',
  '.session-refresh',
  '.user-restart',
  '.user-disable',
  '.user-stop',
  '.daemon-crashed',
  '.daemon-stop',
];

/**
 * A marker younger than this is left alone by clearEndMarkers — it may belong
 * to a restart still in flight. The hazard: the post-restart session can reach
 * its first heartbeat before the dying restart's SECOND SessionEnd firing
 * lands (firing#2 is typically 13-22s after firing#1, but not hard-bounded).
 * Without a grace window, that heartbeat would wipe the marker and firing#2
 * would classify `crash` — the exact false positive this whole change exists
 * to kill, reintroduced under a narrower window.
 *
 * The grace makes that race negligible, not mathematically zero: a firing#2
 * delayed past 120s under heavy load could still miss the marker. That is the
 * same bounded residual as the hook's TTL and is accepted. The window is sized
 * generously on the TTL's cost asymmetry — too tight reopens the FP; too loose
 * only delays cleanup harmlessly (the heartbeat clears it on a later pass, and
 * the 300s hook TTL backstops). 120s clears any plausible firing#2 delay while
 * staying well under the TTL.
 */
const MARKER_CLEAR_GRACE_MS = 120_000; // 2 minutes

/**
 * Remove SessionEnd-hook end-type markers from an agent's state dir, skipping
 * any marker younger than MARKER_CLEAR_GRACE_MS (an in-flight restart whose
 * second hook firing may not have landed yet). `nowMs` is injectable for tests.
 */
export function clearEndMarkers(stateDir: string, nowMs: number = Date.now()): void {
  for (const file of END_TYPE_MARKERS) {
    const p = join(stateDir, file);
    if (!existsSync(p)) continue;
    try {
      if (nowMs - statSync(p).mtimeMs < MARKER_CLEAR_GRACE_MS) continue; // in-flight — leave it
      unlinkSync(p);
    } catch { /* ignore — best-effort cleanup */ }
  }
}

/**
 * Update heartbeat for the current agent.
 * Writes to: {ctxRoot}/state/{agent}/heartbeat.json
 * Matches bash update-heartbeat.sh format exactly.
 */
export function updateHeartbeat(
  paths: BusPaths,
  agentName: string,
  status: string,
  options?: { org?: string; timezone?: string; loopInterval?: string; currentTask?: string; displayName?: string },
): void {
  ensureDir(paths.stateDir);

  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  // Fallback resolves the AGENT'S configured operating zone (TZ / CTX_TIMEZONE,
  // injected by the daemon), NOT hardcoded UTC. The old UTC fallback made the
  // mode field read "night" ~8h wrong for every agent that calls update-heartbeat
  // WITHOUT --timezone (which is all of them) — a reliably-wrong DISPLAY field.
  // Fixing the fallback (not each call site) makes every caller correct by
  // construction; a call-site fix is a list we would miss the next entry on.
  // NOTE: this is the agent OPERATING window (dashboard status). User-contact
  // day/night is a different decision and must use contact-clock.sh, never this.
  const mode = detectDayNightMode(
    options?.timezone ?? process.env.TZ ?? process.env.CTX_TIMEZONE ?? 'UTC',
  );

  const heartbeat: Heartbeat = {
    agent: agentName,
    org: options?.org ?? '',
    ...(options?.displayName ? { display_name: options.displayName } : {}),
    status,
    current_task: options?.currentTask ?? '',
    mode,
    last_heartbeat: ts,
    loop_interval: options?.loopInterval ?? resolveLoopInterval(agentName),
  };

  atomicWriteSync(
    join(paths.stateDir, 'heartbeat.json'),
    JSON.stringify(heartbeat),
  );

  // The agent is alive in its (post-restart) session — clear stale SessionEnd
  // markers so the crash-alert hook cannot misclassify a later genuine crash
  // as a planned restart. Markers inside the grace window are left in place
  // (an in-flight restart's second hook firing may not have landed); they are
  // cleared on a later heartbeat. This is the primary marker cleanup; the
  // hook's TTL is the failed-start backstop.
  clearEndMarkers(paths.stateDir);
}

/**
 * Detect day/night mode based on timezone.
 * Default window: 08:00 - 22:00 (minute-precise when a window is passed).
 *
 * The window is configurable via org context.json day_mode_start/day_mode_end —
 * fields that existed (and were displayed by get-config) but were never read by
 * this decision until 2026-07-14: the org config asserted 06:00 while this
 * function hardcoded 8, which is where the SOUL/SYSTEM-vs-AGENTS doc split
 * came from. Callers answering "is the USER awake?" must pass the timezone
 * from resolveUserTimezone(), never the agent's CTX_TIMEZONE directly.
 */
export function detectDayNightMode(
  timezone: string,
  window?: { start?: string; end?: string },
): 'day' | 'night' {
  const startMin = parseHhMm(window?.start) ?? 8 * 60;
  const endMin = parseHhMm(window?.end) ?? 22 * 60;
  let nowMin: number;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour12: false, hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date());
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '', 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '', 10);
    if (Number.isNaN(hour) || Number.isNaN(minute)) throw new Error('unparseable');
    nowMin = (hour % 24) * 60 + minute;
  } catch {
    // Fallback to UTC
    const now = new Date();
    nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  }
  return (nowMin >= startMin && nowMin < endMin) ? 'day' : 'night';
}

/** "HH:MM" (or "HH") -> minutes since midnight; undefined on malformed input. */
function parseHhMm(value?: string): number | undefined {
  if (!value) return undefined;
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return undefined;
  const hh = parseInt(m[1], 10);
  const mm = m[2] ? parseInt(m[2], 10) : 0;
  if (hh > 24 || mm > 59) return undefined;
  return hh * 60 + mm;
}

export interface ResolvedUserTimezone {
  timezone: string;
  /**
   * override          - CTX_USER_TIMEZONE in force
   * override-expired  - an override existed but its UNTIL date has passed (or was
   *                     malformed) -> fell back; callers should surface this ONCE
   * default           - no (usable) override configured
   */
  source: 'override' | 'override-expired' | 'default';
}

/**
 * Resolve the timezone in which "is the USER awake?" must be answered.
 *
 * The user's timezone is a MUTABLE FACT, not a config constant (2026-07-14:
 * Steve on a UK trip 12-21 Jul; a bare CTX_USER_TIMEZONE=Europe/London would be
 * correct until the 21st and silently wrong forever after). So the override
 * carries an optional expiry:
 *
 *   userTimezone      (CTX_USER_TIMEZONE)        IANA tz of the human
 *   userTimezoneUntil (CTX_USER_TIMEZONE_UNTIL)  YYYY-MM-DD; the override is valid
 *     THROUGH that date AS EXPERIENCED IN THE OVERRIDE TZ (the user's own calendar
 *     day), and expires at the first midnight after it. Fail-safe by construction:
 *     a stale override cannot outlive its date and needs no human to remember it.
 *     A malformed date or unusable tz also falls back - never honour an override
 *     whose end nobody can compute.
 */
export function resolveUserTimezone(
  fallbackTz: string,
  opts?: { userTimezone?: string; userTimezoneUntil?: string },
): ResolvedUserTimezone {
  const override = opts?.userTimezone?.trim();
  if (!override) return { timezone: fallbackTz, source: 'default' };

  // en-CA yields YYYY-MM-DD, string-comparable with the UNTIL date.
  let todayInOverrideTz: string;
  try {
    todayInOverrideTz = new Date().toLocaleDateString('en-CA', { timeZone: override });
  } catch {
    return { timezone: fallbackTz, source: 'override-expired' }; // unusable tz string
  }

  const until = opts?.userTimezoneUntil?.trim();
  if (until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      return { timezone: fallbackTz, source: 'override-expired' }; // uncomputable end
    }
    if (todayInOverrideTz > until) {
      return { timezone: fallbackTz, source: 'override-expired' };
    }
  }
  return { timezone: override, source: 'override' };
}

/**
 * Read all agent heartbeats.
 * Scans state/ directory for agent subdirs containing heartbeat.json.
 * Matches dashboard heartbeat path: state/{agent}/heartbeat.json
 */
export function readAllHeartbeats(paths: BusPaths): Heartbeat[] {
  const heartbeats: Heartbeat[] = [];
  const stateDir = join(paths.ctxRoot, 'state');
  let agentDirs: string[];
  try {
    agentDirs = readdirSync(stateDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }

  for (const agent of agentDirs) {
    const hbPath = join(stateDir, agent, 'heartbeat.json');
    try {
      const content = readFileSync(hbPath, 'utf-8');
      heartbeats.push(JSON.parse(content));
    } catch {
      // Skip agents without heartbeat
    }
  }

  return heartbeats;
}
