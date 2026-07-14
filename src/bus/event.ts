import { appendFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { EventCategory, EventSeverity, BusPaths, Heartbeat } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { randomString } from '../utils/random.js';
import { validateEventCategory, validateEventSeverity, isValidJson } from '../utils/validate.js';

/**
 * Log a structured event. Appends JSONL line to daily event file.
 * Identical to bash log-event.sh format.
 *
 * Events are stored at: {analyticsDir}/events/{agent}/{YYYY-MM-DD}.jsonl
 *
 * Side-effect: if this agent has an existing heartbeat.json, refresh its
 * `last_heartbeat` timestamp. Activity is liveness — if the agent is
 * logging events, it is by definition alive, so the stale-heartbeat
 * monitor should not page on it. Other fields (status, mode, etc.) are
 * preserved from the last explicit update-heartbeat call. Best-effort:
 * a failing heartbeat refresh never blocks the event write itself.
 * If no heartbeat file exists yet we do nothing — the first
 * update-heartbeat call creates it with full field values.
 */
export interface LogEventOptions {
  /**
   * Mark this row as OBSERVER-written: recorded ABOUT the agent by another
   * process (daemon watchdog, inbound-message logger), not BY the agent's
   * own process. Observer rows are stamped `observer: true` in the JSONL so
   * liveness readers can exclude them, and they do NOT refresh
   * heartbeat.json.last_heartbeat — an observer writing about an agent is no
   * evidence the agent processed anything. Before this flag existed the
   * frozen-turn watchdog's own `watchdog_auto_restart` row bumped the frozen
   * target's heartbeat AND became the newest event line, so every recovery
   * verify read the watchdog's breadcrumb as the agent's pulse and reported
   * `watchdog_recovery_ok` for agents that were still bricks (2026-07-13).
   */
  observer?: boolean;
}

export function logEvent(
  paths: BusPaths,
  agentName: string,
  org: string,
  category: EventCategory,
  eventName: string,
  severity: EventSeverity,
  metadata?: Record<string, unknown> | string,
  options?: LogEventOptions,
): void {
  validateEventCategory(category);
  validateEventSeverity(severity);

  // Parse metadata if it's a string
  let meta: Record<string, unknown> = {};
  if (typeof metadata === 'string') {
    if (isValidJson(metadata)) {
      meta = JSON.parse(metadata);
    }
  } else if (metadata) {
    meta = metadata;
  }

  const epoch = Math.floor(Date.now() / 1000);
  const rand = randomString(5);
  const eventId = `${epoch}-${agentName}-${rand}`;
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const eventsDir = join(paths.analyticsDir, 'events', agentName);
  ensureDir(eventsDir);

  const eventLine = JSON.stringify({
    id: eventId,
    agent: agentName,
    org,
    timestamp,
    category,
    event: eventName,
    severity,
    metadata: meta,
    ...(options?.observer ? { observer: true } : {}),
  });

  appendFileSync(join(eventsDir, `${today}.jsonl`), eventLine + '\n', 'utf-8');

  // Refresh heartbeat timestamp as a side-effect — but ONLY for rows the
  // agent's own process wrote. See LogEventOptions.observer.
  if (!options?.observer) {
    refreshHeartbeatTimestamp(paths, timestamp);
  }
}

/**
 * Log an event ABOUT an agent from outside its process (daemon watchdog,
 * inbound-message logger, …). Identical to logEvent with observer semantics:
 * the row is visible in the agent's feed for dashboards, but it neither
 * bumps the agent's heartbeat nor counts as the agent's pulse for liveness
 * readers. Call sites that speak about an agent MUST use this, not logEvent.
 */
export function logObserverEvent(
  paths: BusPaths,
  agentName: string,
  org: string,
  category: EventCategory,
  eventName: string,
  severity: EventSeverity,
  metadata?: Record<string, unknown> | string,
): void {
  logEvent(paths, agentName, org, category, eventName, severity, metadata, { observer: true });
}

/**
 * Bump the `last_heartbeat` timestamp on the existing heartbeat.json,
 * preserving every other field. No-op when the file does not exist yet
 * or when any step fails — event writes are the authoritative record
 * and must never be blocked by heartbeat housekeeping.
 */
function refreshHeartbeatTimestamp(paths: BusPaths, timestamp: string): void {
  try {
    const hbPath = join(paths.stateDir, 'heartbeat.json');
    if (!existsSync(hbPath)) return;
    const hb = JSON.parse(readFileSync(hbPath, 'utf-8')) as Heartbeat;
    hb.last_heartbeat = timestamp;
    atomicWriteSync(hbPath, JSON.stringify(hb));
  } catch {
    // Best-effort — event already persisted, heartbeat refresh is secondary.
  }
}
