/**
 * Per-agent memory (RSS) monitor.
 *
 * Cycle-6 audit finding (OOM domain): the .126 Hiba box OOM'd with 8 agents on
 * 3.8 GB (~475 MB each, oversubscribed) and nothing flagged it. This measures
 * per-agent resident memory + total-RAM headroom and flags pressure so we can
 * right-size RAM/agents BEFORE the kernel OOM-killer fires.
 *
 * ── CRITICAL: this is a FLAG-ONLY monitor. It NEVER restarts anything. ──
 * Memory-exhaustion is a DIFFERENT failure class from a frozen turn:
 *   - frozen-turn-watchdog  → detects a hung/STOPped PTY and RESTARTS it.
 *   - this monitor          → detects memory pressure and only FLAGS it.
 * An auto-restart on an OOM-pressured box is actively HARMFUL: restarting a
 * killed/heavy agent frees nothing structural and produces a restart-loop that
 * MASKS the real fix (fewer agents / more RAM). So OOM pressure must be
 * surfaced to a human (via analyst routing), not "recovered" by a watchdog.
 * Keep this distinction: never wire this monitor to a restart action.
 *
 * Surfacing mirrors the disk monitor (PR#3): the data lands in the metrics
 * report and an exceedance emits a `metric/anomaly_detected` event the analyst
 * already routes on.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

/** Per-agent resident memory, summed across the agent's process tree. */
export interface AgentMemory {
  agent: string;
  /** Resident Set Size in MB (sum of VmRSS across all PIDs tagged with this agent). */
  rss_mb: number;
  /** Number of processes attributed to the agent (claude PTY child + node children). */
  procs: number;
}

export interface MemorySnapshot {
  agents: AgentMemory[];
  mem_total_mb: number;
  mem_available_mb: number;
  /** MemAvailable as a percentage of MemTotal (0–100), rounded. */
  available_pct: number;
}

export interface MemoryThresholds {
  /** Per-agent RSS (MB) ladder. */
  agent_warn_mb: number;
  agent_elevated_mb: number;
  agent_critical_mb: number;
  /** Total-headroom ladder: MemAvailable as % of MemTotal (lower = worse). */
  headroom_warn_pct: number;
  headroom_elevated_pct: number;
  headroom_critical_pct: number;
}

/**
 * Defaults are TUNABLE (env-overridable). The headroom ladder is the primary
 * OOM-predictive signal because it is box-relative (the Hiba box was small);
 * the per-agent ladder catches a single bloated agent on any box.
 */
export const DEFAULT_MEMORY_THRESHOLDS: MemoryThresholds = {
  agent_warn_mb: 1000,
  agent_elevated_mb: 1300,
  agent_critical_mb: 1600,
  headroom_warn_pct: 15,
  headroom_elevated_pct: 10,
  headroom_critical_pct: 7,
};

/** Read thresholds from env (CTX_MEM_*), falling back to defaults. Pure given an env map. */
export function memoryThresholdsFromEnv(env: NodeJS.ProcessEnv = process.env): MemoryThresholds {
  const num = (k: string, d: number): number => {
    const v = env[k];
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const d = DEFAULT_MEMORY_THRESHOLDS;
  return {
    agent_warn_mb: num('CTX_MEM_AGENT_WARN_MB', d.agent_warn_mb),
    agent_elevated_mb: num('CTX_MEM_AGENT_ELEVATED_MB', d.agent_elevated_mb),
    agent_critical_mb: num('CTX_MEM_AGENT_CRITICAL_MB', d.agent_critical_mb),
    headroom_warn_pct: num('CTX_MEM_HEADROOM_WARN_PCT', d.headroom_warn_pct),
    headroom_elevated_pct: num('CTX_MEM_HEADROOM_ELEVATED_PCT', d.headroom_elevated_pct),
    headroom_critical_pct: num('CTX_MEM_HEADROOM_CRITICAL_PCT', d.headroom_critical_pct),
  };
}

// ── Pure parsers (unit-testable, no IO) ──────────────────────────────────────

/** Extract VmRSS in kB from the contents of /proc/<pid>/status. null if absent. */
export function parseVmRssKb(statusText: string): number | null {
  const m = statusText.match(/^VmRSS:\s+(\d+)\s*kB/m);
  return m ? Number(m[1]) : null;
}

/** Extract a `Key: <n> kB` value from /proc/meminfo. null if absent. */
export function parseMeminfoKb(meminfoText: string, key: string): number | null {
  const m = meminfoText.match(new RegExp('^' + key + ':\\s+(\\d+)\\s*kB', 'm'));
  return m ? Number(m[1]) : null;
}

/** Extract CTX_AGENT_NAME from the NUL-separated contents of /proc/<pid>/environ. */
export function parseAgentFromEnviron(environText: string): string | null {
  for (const kv of environText.split('\0')) {
    if (kv.startsWith('CTX_AGENT_NAME=')) {
      const v = kv.slice('CTX_AGENT_NAME='.length).trim();
      return v || null;
    }
  }
  return null;
}

/**
 * Classify a snapshot into anomalies (one per over-threshold agent + one for
 * low headroom). Pure — this is the load-bearing logic the analyst routes on.
 * Severity: warning | critical; tier: warning | elevated | critical (matches the
 * disk monitor's shape so analyst routing is uniform). Steven-eligibility keys
 * off tier === 'critical'.
 */
export interface MemoryAnomaly {
  kind: 'memory';
  scope: 'agent' | 'headroom';
  severity: 'warning' | 'critical';
  tier: 'warning' | 'elevated' | 'critical';
  agent?: string;
  rss_mb?: number;
  threshold_mb?: number;
  mem_available_mb: number;
  mem_total_mb: number;
  available_pct: number;
}

export function evaluateMemoryAnomalies(
  snap: MemorySnapshot,
  t: MemoryThresholds = DEFAULT_MEMORY_THRESHOLDS,
): MemoryAnomaly[] {
  const out: MemoryAnomaly[] = [];
  const base = {
    mem_available_mb: snap.mem_available_mb,
    mem_total_mb: snap.mem_total_mb,
    available_pct: snap.available_pct,
  };

  // Per-agent RSS ladder.
  for (const a of snap.agents) {
    let tier: MemoryAnomaly['tier'] | null = null;
    let threshold = 0;
    if (a.rss_mb > t.agent_critical_mb) { tier = 'critical'; threshold = t.agent_critical_mb; }
    else if (a.rss_mb > t.agent_elevated_mb) { tier = 'elevated'; threshold = t.agent_elevated_mb; }
    else if (a.rss_mb > t.agent_warn_mb) { tier = 'warning'; threshold = t.agent_warn_mb; }
    if (tier) {
      out.push({
        kind: 'memory', scope: 'agent',
        severity: tier === 'critical' ? 'critical' : 'warning',
        tier, agent: a.agent, rss_mb: a.rss_mb, threshold_mb: threshold, ...base,
      });
    }
  }

  // Total-headroom ladder (primary OOM-predictive signal; box-relative).
  // Only meaningful when we actually read MemTotal.
  if (snap.mem_total_mb > 0) {
    const p = snap.available_pct;
    let tier: MemoryAnomaly['tier'] | null = null;
    if (p < t.headroom_critical_pct) tier = 'critical';
    else if (p < t.headroom_elevated_pct) tier = 'elevated';
    else if (p < t.headroom_warn_pct) tier = 'warning';
    if (tier) {
      out.push({
        kind: 'memory', scope: 'headroom',
        severity: tier === 'critical' ? 'critical' : 'warning',
        tier, ...base,
      });
    }
  }

  return out;
}

// ── Collection (best-effort /proc scan; Linux only, never throws) ────────────

/**
 * Walk /proc, bucket each process's VmRSS by its CTX_AGENT_NAME, and read
 * MemTotal/MemAvailable. Best-effort: returns an empty/zeroed snapshot on any
 * failure (non-Linux, perms, no agents) so a memory read never breaks the
 * metrics report. Summing RSS across an agent's PIDs slightly over-counts
 * shared pages — acceptable for a conservative pressure flag (errs toward
 * surfacing pressure, never hides it).
 */
export function collectAgentMemory(procDir = '/proc'): MemorySnapshot {
  const empty: MemorySnapshot = { agents: [], mem_total_mb: 0, mem_available_mb: 0, available_pct: 0 };
  if (!existsSync(procDir)) return empty;

  let memTotalKb = 0, memAvailKb = 0;
  try {
    const meminfo = readFileSync(join(procDir, 'meminfo'), 'utf-8');
    memTotalKb = parseMeminfoKb(meminfo, 'MemTotal') ?? 0;
    memAvailKb = parseMeminfoKb(meminfo, 'MemAvailable') ?? 0;
  } catch { /* leave zero */ }

  const byAgent = new Map<string, { kb: number; procs: number }>();
  let pids: string[] = [];
  try {
    pids = readdirSync(procDir).filter(n => /^\d+$/.test(n));
  } catch { /* no proc */ }

  for (const pid of pids) {
    let agent: string | null = null;
    try {
      agent = parseAgentFromEnviron(readFileSync(join(procDir, pid, 'environ'), 'utf-8'));
    } catch { continue; } // unreadable (perms / gone) — skip
    if (!agent) continue;
    let rssKb: number | null = null;
    try {
      rssKb = parseVmRssKb(readFileSync(join(procDir, pid, 'status'), 'utf-8'));
    } catch { continue; }
    if (rssKb == null) continue;
    const cur = byAgent.get(agent) || { kb: 0, procs: 0 };
    cur.kb += rssKb; cur.procs += 1;
    byAgent.set(agent, cur);
  }

  const toMb = (kb: number): number => Math.round(kb / 1024);
  const agents: AgentMemory[] = [...byAgent.entries()]
    .map(([agent, v]) => ({ agent, rss_mb: toMb(v.kb), procs: v.procs }))
    .sort((a, b) => b.rss_mb - a.rss_mb);

  return {
    agents,
    mem_total_mb: toMb(memTotalKb),
    mem_available_mb: toMb(memAvailKb),
    available_pct: memTotalKb > 0 ? Math.round((memAvailKb / memTotalKb) * 100) : 0,
  };
}
