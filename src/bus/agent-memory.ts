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
  /**
   * The session-root pid's own PSS in MB — the true per-session footprint. THE GATING FIELD:
   * evaluateMemoryAnomalies (LEVEL ladder) gates on this since 2026-08-02, and evaluateSlope
   * (SLOPE arm) since 2026-09-15 — NOT rss_mb, which is a process-TREE sum inflated by child
   * builds. Optional/best-effort (populated by the emitting caller via collectSessionPss); an
   * agent missing it is SKIPPED by the level arm and recorded in sessionPssAbsent, never fallen
   * back to the tree-sum. rss_mb is kept as CONTEXT only.
   */
  session_pss_mb?: number;
}

export interface MemorySnapshot {
  agents: AgentMemory[];
  mem_total_mb: number;
  mem_available_mb: number;
  /** MemAvailable as a percentage of MemTotal (0–100), rounded. */
  available_pct: number;
}

export interface MemoryThresholds {
  /**
   * Per-agent SESSION-PSS (MB) ladder — evaluated against session_pss_mb (the true
   * per-session footprint), NOT the process-tree RSS sum. See evaluateMemoryAnomalies
   * for why (class: rss_mb_is_a_tree_sum, fixed 2026-08-02).
   */
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
  // Per-agent SESSION-PSS ladder (MB). ⚠️ PROVISIONAL / UNCALIBRATED (2026-08-02):
  // guessed off a HEALTHY-ONLY distribution (session_pss 278–349 MB observed) with
  // ZERO observed-breach data — the upper tail here is imagined, not measured. These
  // are env-overridable (CTX_MEM_AGENT_*_MB); treat the FIRST real high-session_pss
  // event as the calibration point and harvest it — do NOT re-guess from a desk.
  // (Previously 1000/1300/1600, but that was TREE-SUM scale; see evaluateMemoryAnomalies.)
  agent_warn_mb: 600,
  agent_elevated_mb: 900,
  agent_critical_mb: 1200,
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

/** Extract Pss in kB from the contents of /proc/<pid>/smaps_rollup. null if absent. */
export function parsePssKb(smapsRollupText: string): number | null {
  const m = smapsRollupText.match(/^Pss:\s+(\d+)\s*kB/m);
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
 * Classify a snapshot into anomalies. Per-agent: one anomaly per agent whose
 * session_pss_mb exceeds the ladder WHILE the host is constrained (see the
 * per-agent block for the two-gate rationale). Headroom: one anomaly when
 * MemAvailable is low (the primary, box-relative OOM signal). Also returns
 * sessionPssAbsent — agents skipped for missing session_pss — so a silent skip
 * cannot pass as a clean evaluation. Pure — the load-bearing logic analyst routes on.
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
  /**
   * scope:'agent' GATING figure — the true per-session footprint (PSS of the
   * session-root pid). This is what the per-agent ladder tiers on. Undefined for
   * headroom anomalies.
   */
  session_pss_mb?: number;
  /**
   * scope:'agent' CONTEXT only — the process-tree RSS sum. NOT the gate: it is
   * inflated by an agent's own child builds (see evaluateMemoryAnomalies). Kept in
   * the anomaly so a reader can see the tree-vs-session gap that caused the old FPs.
   */
  rss_mb?: number;
  threshold_mb?: number;
  mem_available_mb: number;
  mem_total_mb: number;
  available_pct: number;
}

/**
 * Result of evaluateMemoryAnomalies. `sessionPssAbsent` names every agent the
 * per-agent arm SKIPPED because its session_pss_mb was unavailable — surfaced so a
 * silent skip cannot masquerade as a clean evaluation. If the population wiring
 * regresses fleet-wide, this list fills with every agent instead of a quiet green.
 */
export interface MemoryAnomalyResult {
  anomalies: MemoryAnomaly[];
  sessionPssAbsent: string[];
}

export function evaluateMemoryAnomalies(
  snap: MemorySnapshot,
  t: MemoryThresholds = DEFAULT_MEMORY_THRESHOLDS,
): MemoryAnomalyResult {
  const out: MemoryAnomaly[] = [];
  const sessionPssAbsent: string[] = [];
  const base = {
    mem_available_mb: snap.mem_available_mb,
    mem_total_mb: snap.mem_total_mb,
    available_pct: snap.available_pct,
  };

  // Per-agent SESSION-FOOTPRINT ladder.
  //
  // Fixed 2026-08-02 (class: rss_mb_is_a_tree_sum). This arm gates on
  // session_pss_mb — the true per-session footprint (PSS of the session-root pid,
  // shared pages divided by their sharers) — NOT rss_mb, which is a process-TREE
  // SUM. A coding agent's own child builds inflate the tree-sum, so it tripped a
  // ~1 GB ladder almost every cycle while its real footprint was ~300 MB (measured
  // FPs 2026-08-01/02: engineer 1077/278, 1100/293, 1158/349; research 1261/320).
  // That was a WRONG-OBJECT measurement — workload SHAPE read as memory pressure —
  // not a wrong threshold, which is why the fix changes WHAT is measured, not the
  // ceiling.
  //
  // ⚠️ TWO-PART FIX, MUST STAY TOGETHER — do NOT land "the simple half". The
  // emitting caller (collect-memory-sample) must POPULATE a.session_pss_mb onto the
  // snapshot AND this arm must READ it. Reading without the population wiring sees
  // `undefined`, fires never, and is DISABLED — indistinguishable from a correctly
  // desensitised arm on a fixture set made only of should-not-fire cases. The
  // known-positive fixtures are the only thing that tell those two apart.
  //
  // GATE #2 — host pressure. A large per-session footprint is only PRESSURE when
  // the host is ALSO constrained (available_pct below the headroom warn bar). A big
  // session on a box with free RAM is workload, not pressure. So this arm is "name
  // the disproportionate contributor when the host is already tight"; the headroom
  // ladder below is the PRIMARY, box-relative OOM tripwire (it fires even when
  // session_pss is unavailable, and catches many-medium-sessions no per-agent level
  // could).
  const hostConstrained = snap.mem_total_mb > 0 && snap.available_pct < t.headroom_warn_pct;
  for (const a of snap.agents) {
    const footprint = a.session_pss_mb;
    // Cannot measure the session footprint → SKIP this agent's arm, but RECORD the
    // skip (observability: a silent skip is byte-identical to a clean eval). NEVER
    // fall back to the tree-sum (that reintroduces the very defect). The headroom
    // ladder still covers the box. Recorded regardless of host state — this is the
    // DATA-health signal, not a pressure signal.
    if (footprint == null) { sessionPssAbsent.push(a.agent); continue; }
    // Not pressure unless the host is also tight (AND, not OR).
    if (!hostConstrained) continue;
    let tier: MemoryAnomaly['tier'] | null = null;
    let threshold = 0;
    if (footprint > t.agent_critical_mb) { tier = 'critical'; threshold = t.agent_critical_mb; }
    else if (footprint > t.agent_elevated_mb) { tier = 'elevated'; threshold = t.agent_elevated_mb; }
    else if (footprint > t.agent_warn_mb) { tier = 'warning'; threshold = t.agent_warn_mb; }
    if (tier) {
      out.push({
        kind: 'memory', scope: 'agent',
        severity: tier === 'critical' ? 'critical' : 'warning',
        tier, agent: a.agent, session_pss_mb: footprint, rss_mb: a.rss_mb,
        threshold_mb: threshold, ...base,
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

  return { anomalies: out, sessionPssAbsent };
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

  const selfPid = String(process.pid);
  for (const pid of pids) {
    // Probe-in-its-own-result-set (2026-07-22): the sampler is a node child
    // inheriting CTX_AGENT_NAME, so every agent total included the measurement
    // that produced it. Exclude by construction, not by remembering.
    if (pid === selfPid) continue;
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

/**
 * OBSERVE-ONLY (2026-07-23): per-agent PSS of the *session-root* pid — the object
 * the ladder SHOULD measure once recalibrated (see the design doc + AgentMemory
 * .session_pss_mb). This reads the same session anchors the slope monitor already
 * resolves (`collectSessionKeys`, keyed "<pid>:<starttime>") so the level and
 * slope arms agree on the object by construction — no second pid-resolution copy.
 *
 * PSS (`Pss:` in smaps_rollup) divides shared pages by their sharers, so it is a
 * true per-process footprint with no shared-page over-count. If smaps_rollup is
 * unreadable (older kernel / perms) we fall back to VmRSS for the SAME anchor pid
 * — session-scoped, just without shared-page division — and NEVER to a tree-sum
 * (that would reintroduce the very defect this measures around).
 *
 * Best-effort and never throws: any unreadable/gone pid is simply skipped, so a
 * PSS read can never break the metrics report. This result is the GATING field for
 * both the level ladder (since 2026-08-02) and the slope arm (since 2026-09-15);
 * rss_mb is logged beside it as context only.
 */
export function collectSessionPss(
  sessionKeys: Map<string, string>,
  procDir = '/proc',
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [agent, key] of sessionKeys) {
    if (!key) continue; // no resolvable session pid — omit (headroom ladder still runs)
    const pid = key.split(':', 1)[0];
    if (!pid || !/^\d+$/.test(pid)) continue;
    let kb: number | null = null;
    try {
      kb = parsePssKb(readFileSync(join(procDir, pid, 'smaps_rollup'), 'utf-8'));
    } catch { /* smaps_rollup unreadable — fall through to VmRSS on the same pid */ }
    if (kb == null) {
      try {
        kb = parseVmRssKb(readFileSync(join(procDir, pid, 'status'), 'utf-8'));
      } catch { continue; } // pid gone / unreadable — skip
    }
    if (kb == null) continue;
    out.set(agent, Math.round(kb / 1024));
  }
  return out;
}
