import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import type { MemorySnapshot, MemoryAnomaly } from './agent-memory.js';

/**
 * Memory SLOPE arm — the identity-free replacement for the 2026-06-22 prose
 * routing contract ("agent=engineer + tier=warning = EXPECTED-BASELINE, NEVER
 * escalate", banked in analyst's MEMORY.md and executed by hand for 3 weeks).
 *
 * Principle (chief, 2026-07-14): A LEAK IS A SLOPE, NOT A LEVEL. Suppress a
 * FLAT baseline at any level for ANYONE; alarm on a RISING one for ANYONE.
 * No agent name appears in any predicate in this file.
 *
 * Restart-awareness is BY CONSTRUCTION, not by filtering: samples carry a
 * session_key = "<pid>:<starttime>" of the agent's oldest live process. A
 * restart mints a new key, so a series can never span a restart and the
 * nightly-restart sawtooth is unrepresentable rather than specially cased.
 */

export interface MemorySample {
  /** ISO 8601 sample time. */
  ts: string;
  agent: string;
  rss_mb: number;
  /** "<pid>:<starttime-ticks>" of the agent's oldest live process; '' if unknown. */
  session_key: string;
}

export interface SlopeThresholds {
  /** Minimum total rise (MB) across the series before a slope can fire. */
  min_rise_mb: number;
  /** Minimum sustained rate (MB/hour) across the series. */
  min_rate_mb_per_h: number;
  /** Minimum samples in one session series before ANY slope/flat verdict. */
  min_samples: number;
  /** Minimum span (hours) between first and last sample of the series. */
  min_span_h: number;
  /** History retention (days) for the sample file. */
  retention_days: number;
}

export const DEFAULT_SLOPE_THRESHOLDS: SlopeThresholds = {
  min_rise_mb: 200,
  min_rate_mb_per_h: 30,
  min_samples: 4,
  min_span_h: 2,
  retention_days: 14,
};

/** Env-tunable (CTX_MEM_SLOPE_*), falling back to defaults. Pure given an env map. */
export function slopeThresholdsFromEnv(env: NodeJS.ProcessEnv = process.env): SlopeThresholds {
  const num = (k: string, d: number): number => {
    const v = env[k];
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const d = DEFAULT_SLOPE_THRESHOLDS;
  return {
    min_rise_mb: num('CTX_MEM_SLOPE_MIN_RISE_MB', d.min_rise_mb),
    min_rate_mb_per_h: num('CTX_MEM_SLOPE_MIN_RATE_MB_H', d.min_rate_mb_per_h),
    min_samples: num('CTX_MEM_SLOPE_MIN_SAMPLES', d.min_samples),
    min_span_h: num('CTX_MEM_SLOPE_MIN_SPAN_H', d.min_span_h),
    retention_days: num('CTX_MEM_SLOPE_RETENTION_DAYS', d.retention_days),
  };
}

export interface SlopeVerdict {
  agent: string;
  session_key: string;
  /**
   * rising        - sustained climb: page-worthy (a leak looks like this)
   * flat          - enough history, no material rise: safe to fold warning-tier
   *                 LEVEL noise into a trend note (the old prose contract, minus
   *                 the identity key)
   * insufficient  - not enough same-session history for ANY claim. NOT flat.
   *                 Level anomalies must pass through untouched (fail toward
   *                 noise, never toward silence).
   */
  verdict: 'rising' | 'flat' | 'insufficient';
  samples: number;
  span_h: number;
  rise_mb: number;
  rate_mb_per_h: number;
}

export interface MemorySlopeAnomaly {
  kind: 'memory_slope';
  scope: 'agent';
  severity: 'critical';
  tier: 'elevated';
  agent: string;
  session_key: string;
  rise_mb: number;
  rate_mb_per_h: number;
  span_h: number;
  samples: number;
}

/**
 * Evaluate one agent's CURRENT-session series. Pure.
 *
 * The series is the subset of samples sharing the LATEST session_key, in time
 * order. Rise is measured first-to-last, guarded against spike-then-flat: the
 * last sample must still be near the series maximum (>= 90%), otherwise a
 * transient peak that already receded would read as a permanent climb.
 */
export function evaluateSlope(
  samples: MemorySample[],
  t: SlopeThresholds = DEFAULT_SLOPE_THRESHOLDS,
): SlopeVerdict | null {
  if (samples.length === 0) return null;
  const agent = samples[0].agent;
  const ordered = samples
    .filter(s => s.agent === agent)
    .sort((a, b) => a.ts.localeCompare(b.ts));
  // Series = latest session only (restart-aware by construction).
  const latestKey = ordered[ordered.length - 1].session_key;
  const series = ordered.filter(s => s.session_key === latestKey && s.session_key !== '');

  const base = { agent, session_key: latestKey };
  if (series.length < t.min_samples) {
    return { ...base, verdict: 'insufficient', samples: series.length, span_h: 0, rise_mb: 0, rate_mb_per_h: 0 };
  }
  const first = series[0];
  const last = series[series.length - 1];
  const spanH = (Date.parse(last.ts) - Date.parse(first.ts)) / 3_600_000;
  if (!(spanH >= t.min_span_h)) {
    return { ...base, verdict: 'insufficient', samples: series.length, span_h: round1(spanH), rise_mb: 0, rate_mb_per_h: 0 };
  }
  const riseMb = last.rss_mb - first.rss_mb;
  const rate = riseMb / spanH;
  const maxMb = Math.max(...series.map(s => s.rss_mb));
  const stillNearPeak = last.rss_mb >= maxMb * 0.9;

  if (riseMb >= t.min_rise_mb && rate >= t.min_rate_mb_per_h && stillNearPeak) {
    return { ...base, verdict: 'rising', samples: series.length, span_h: round1(spanH), rise_mb: riseMb, rate_mb_per_h: round1(rate) };
  }
  return { ...base, verdict: 'flat', samples: series.length, span_h: round1(spanH), rise_mb: riseMb, rate_mb_per_h: round1(rate) };
}

function round1(n: number): number { return Math.round(n * 10) / 10; }

/**
 * Apply slope context to LEVEL anomalies. Pure.
 *
 * - warning-tier agent-scope anomaly + FLAT verdict  -> suppressed (returned in
 *   `suppressed_flat` for the trend note, dropped from `anomalies`).
 * - warning-tier + RISING or INSUFFICIENT             -> passes through.
 * - elevated / critical / headroom                    -> NEVER touched here.
 * - every RISING verdict emits a memory_slope anomaly (even below every level
 *   threshold — that is the whole point: the band we agreed not to look at).
 */
export function applySlopeToAnomalies(
  levelAnomalies: MemoryAnomaly[],
  verdicts: SlopeVerdict[],
): { anomalies: (MemoryAnomaly | MemorySlopeAnomaly)[]; suppressed_flat: MemoryAnomaly[] } {
  const byAgent = new Map(verdicts.map(v => [v.agent, v]));
  const anomalies: (MemoryAnomaly | MemorySlopeAnomaly)[] = [];
  const suppressed: MemoryAnomaly[] = [];

  for (const a of levelAnomalies) {
    const v = a.scope === 'agent' && a.agent ? byAgent.get(a.agent) : undefined;
    if (a.scope === 'agent' && a.tier === 'warning' && v?.verdict === 'flat') {
      suppressed.push(a);
    } else {
      anomalies.push(a);
    }
  }
  for (const v of verdicts) {
    if (v.verdict === 'rising') {
      anomalies.push({
        kind: 'memory_slope', scope: 'agent', severity: 'critical', tier: 'elevated',
        agent: v.agent, session_key: v.session_key,
        rise_mb: v.rise_mb, rate_mb_per_h: v.rate_mb_per_h, span_h: v.span_h, samples: v.samples,
      });
    }
  }
  return { anomalies, suppressed_flat: suppressed };
}

// ── Session keys + history IO (impure edges, kept thin) ─────────────────────

/**
 * "<pid>:<starttime>" of the agent's OLDEST live process (lowest starttime
 * ticks = the session root, normally the PTY's claude process). starttime is
 * /proc/<pid>/stat field 22 counted AFTER the closing paren of comm — comm may
 * contain spaces or parens, so split on the LAST ')' first. '' when unknown.
 */
export function collectSessionKeys(procDir = '/proc', ctxRoot?: string): Map<string, string> {
  const oldest = new Map<string, { pid: number; start: number }>();
  let pids: string[] = [];
  try { pids = readdirSync(procDir).filter(n => /^\d+$/.test(n)); } catch { return new Map(); }
  const selfPid = String(process.pid);
  for (const pid of pids) {
    // Probe-in-its-own-result-set: the sampler is a node child inheriting
    // CTX_AGENT_NAME, so without this it anchors/counts itself. Exclude by
    // construction, not by remembering (2026-07-22).
    if (pid === selfPid) continue;
    let agent: string | null = null;
    try {
      const environ = readFileSync(join(procDir, pid, 'environ'), 'utf-8');
      for (const kv of environ.split('\0')) {
        if (kv.startsWith('CTX_AGENT_NAME=')) { agent = kv.slice(15).trim() || null; break; }
      }
    } catch { continue; }
    if (!agent) continue;
    const start = readStarttime(procDir, pid);
    if (start == null) continue;
    const cur = oldest.get(agent);
    if (!cur || start < cur.start) oldest.set(agent, { pid: Number(pid), start });
  }
  const keys = new Map([...oldest.entries()].map(([a, v]) => [a, `${v.pid}:${v.start}`]));

  // Prefer the DAEMON-STAMPED session root (state/<agent>/session.pid) over the
  // oldest-tagged heuristic. The tag is INHERITED by spawned infra (dashboard,
  // npm wrappers, browsers), so "oldest tagged process" anchored an 18-hour
  // series to a wrapper that survives agent restarts — the 2026-07-22
  // misattribution. The daemon is the layer that owns "which pid is the
  // session", so its stamp wins WHEN IT IS STILL TRUE: pid alive AND still
  // tagged with this agent. A stale or mismatched stamp falls back to the
  // heuristic — trust is verified per read, never assumed from the file.
  // Tagging itself is deliberately untouched: the dashboard keeps its
  // inherited tag, which is what keeps the known-negative fixture
  // (dashboard-only restart -> series must NOT reset) constructible.
  if (ctxRoot) {
    for (const agent of new Set([...keys.keys(), ...listStampedAgents(ctxRoot)])) {
      const stampPath = join(ctxRoot, 'state', agent, 'session.pid');
      if (!existsSync(stampPath)) continue;
      let pid: string;
      try { pid = readFileSync(stampPath, 'utf-8').trim(); } catch { continue; }
      if (!/^\d+$/.test(pid) || pid === selfPid) continue;
      let tagged = false;
      try {
        const environ = readFileSync(join(procDir, pid, 'environ'), 'utf-8');
        tagged = environ.split('\0').some(kv => kv === `CTX_AGENT_NAME=${agent}`);
      } catch { continue; } // pid gone -> stale stamp -> heuristic stands
      if (!tagged) continue;
      const start = readStarttime(procDir, pid);
      if (start == null) continue;
      keys.set(agent, `${pid}:${start}`);
    }
  }
  return keys;
}

/** starttime is /proc/<pid>/stat field 22 counted AFTER the closing paren of
 * comm — comm may contain spaces or parens, so split on the LAST ')' first. */
function readStarttime(procDir: string, pid: string): number | null {
  try {
    const stat = readFileSync(join(procDir, pid, 'stat'), 'utf-8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
    const fields = afterComm.split(' ');
    // afterComm starts at field 3 (state); starttime is field 22 -> index 19.
    const v = Number(fields[19]);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

/** Agents with a session.pid stamp — covers an agent whose only live tagged
 * process IS the stamped one (it may be absent from the heuristic map when
 * unreadable) and never throws. */
function listStampedAgents(ctxRoot: string): string[] {
  try {
    return readdirSync(join(ctxRoot, 'state')).filter(a => existsSync(join(ctxRoot, 'state', a, 'session.pid')));
  } catch { return []; }
}

export function historyPath(ctxRoot: string): string {
  return join(ctxRoot, 'analytics', 'memory-history.jsonl');
}

/** Read all retained samples. Malformed lines are skipped, never fatal. */
export function readHistory(ctxRoot: string): MemorySample[] {
  const p = historyPath(ctxRoot);
  if (!existsSync(p)) return [];
  const out: MemorySample[] = [];
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line);
      if (s && typeof s.agent === 'string' && typeof s.rss_mb === 'number' && typeof s.ts === 'string') out.push(s);
    } catch { /* skip */ }
  }
  return out;
}

/**
 * Append this run's samples and prune beyond retention. Atomic rewrite — the
 * history is the slope arm's entire evidence base; a torn write here would
 * silently blind the instrument (the exact class this arm exists to end).
 */
export function appendHistory(
  ctxRoot: string,
  snap: MemorySnapshot,
  sessionKeys: Map<string, string>,
  t: SlopeThresholds = DEFAULT_SLOPE_THRESHOLDS,
  now: Date = new Date(),
): MemorySample[] {
  const ts = now.toISOString();
  const fresh: MemorySample[] = snap.agents.map(a => ({
    ts, agent: a.agent, rss_mb: a.rss_mb, session_key: sessionKeys.get(a.agent) ?? '',
  }));
  const cutoff = new Date(now.getTime() - t.retention_days * 86_400_000).toISOString();
  const all = [...readHistory(ctxRoot), ...fresh].filter(s => s.ts >= cutoff);
  ensureDir(join(ctxRoot, 'analytics'));
  atomicWriteSync(historyPath(ctxRoot), all.map(s => JSON.stringify(s)).join('\n') + (all.length ? '\n' : ''));
  return all;
}

/** Convenience: verdict per agent present in the snapshot, from full history. */
export function evaluateAllSlopes(
  history: MemorySample[],
  snap: MemorySnapshot,
  t: SlopeThresholds = DEFAULT_SLOPE_THRESHOLDS,
): SlopeVerdict[] {
  const out: SlopeVerdict[] = [];
  for (const a of snap.agents) {
    const mine = history.filter(s => s.agent === a.agent).sort((x, y) => x.ts.localeCompare(y.ts));
    const v = evaluateSlope(mine, t);
    if (v) out.push(v);
  }
  return out;
}
