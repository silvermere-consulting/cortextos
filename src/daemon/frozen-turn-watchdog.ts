/**
 * frozen-turn-watchdog.ts — Daemon-level frozen-turn detector + recovery.
 *
 * WHY THIS EXISTS (incident 2026-06-20): a fleet-wide ~10–14h freeze where
 * agents' Claude REPLs hung mid-turn. A `--continue` config-reload at 07:12Z
 * did NOT recover them — only a full PTY kill+respawn (`cortextos restart`)
 * did. Critically, the FastChecker's 50-min idle-stamp kept advancing
 * `last_heartbeat` the whole time, so a naive heartbeat-AGE monitor saw the
 * frozen agents as healthy. And the in-session fleet monitor (analyst) was
 * itself frozen, so the detector cannot live inside any agent PTY.
 *
 * This watchdog runs in the DAEMON process (outside every agent PTY) and does
 * pure file reads of state the daemon already maintains. It therefore stays
 * alive and able to recover ANY agent — including the monitor agent itself.
 *
 * DETECTION (fired-vs-responded correlation, NOT age — see incident above):
 *   The daemon owns the *stimulus*: it fires each agent's `heartbeat` cron and
 *   logs every fire to cron-execution.log. We pair each grace-elapsed fire with
 *   a check for an agent-produced *effect*:
 *     - heartbeat.json.last_heartbeat advanced with the agent's OWN status
 *       (NOT the FastChecker `[watchdog] … idle` stamp), OR
 *     - a fresh row in the agent's analytics events JSONL.
 *   A heartbeat fire that is older than GRACE and has NO real response after it
 *   is "unanswered". FREEZE_THRESHOLD (2) consecutive unanswered fires = frozen.
 *
 * RECOVERY — 3-rung escalation ladder (chief + analyst, 2026-06-20), keyed per
 * agent per rolling hour:
 *   Rung 1 (1st freeze in the hour): restartAgent() — fresh PTY, PRESERVED
 *           context (--continue, no .force-fresh). This is exactly what
 *           `cortextos restart` does = the proven recovery.
 *   Rung 2 (2nd recovery same agent same hour — whether a fresh freeze or
 *           rung-1's verify failed): write .force-fresh THEN restartAgent() —
 *           fresh PTY + context WIPE, to break a re-freeze loop caused by a
 *           wedge IN the preserved context. shouldContinue() consumes the
 *           one-shot marker, so the next recovery reverts to preserve-context.
 *   Rung 3 (3rd in the hour): NO auto-restart — escalate to the orchestrator
 *           and hold for the rest of the window. Never hammer-loop.
 *
 * Every recovery writes a `.restart-planned` marker first so the SessionEnd
 * crash-alert hook reports a clean planned restart, not a false crash alarm.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { cronExecutionLogPathFor } from '../bus/crons-schema.js';
import type { CronExecutionLogEntry, Heartbeat } from '../types/index.js';

/** Status-string prefix the FastChecker idle-stamp writes. A heartbeat.json
 *  whose status starts with this is NOT proof the REPL processed anything —
 *  it only proves the FastChecker loop (which runs in-process, separate from
 *  the Claude turn) is alive. See fast-checker.ts. */
export const WATCHDOG_IDLE_STATUS_PREFIX = '[watchdog]';

export interface FrozenTurnDetail {
  agent: string;
  /** Recovery rung: 1 = preserve-context, 2 = cold/force-fresh, 3 = escalate. */
  attempt: number;
  /** True when this recovery wiped context (.force-fresh) — rung 2. */
  cold: boolean;
  /** How many consecutive grace-elapsed heartbeat fires went unanswered. */
  unansweredFires: number;
  /** ISO timestamp of the agent's last real response, or null if none seen. */
  lastRealHeartbeat: string | null;
}

export type WatchdogEventCategory = 'action' | 'error';

export interface FrozenTurnWatchdogOptions {
  /** Instance root, e.g. ~/.cortextos/default. */
  ctxRoot: string;
  instanceId?: string;
  /** Names of agents the daemon currently has running. */
  getRunningAgents: () => string[];
  /** Resolve an agent's org (for analytics-event paths + event logging). */
  resolveOrg: (agent: string) => string | undefined;
  /** Hard PTY respawn — same path as `cortextos restart`. */
  restartAgent: (agent: string) => Promise<void>;
  /** Persist a watchdog event (wired to bus logEvent in the daemon). */
  recordEvent?: (e: {
    agent: string;
    org: string;
    category: WatchdogEventCategory;
    event: string;
    severity: 'info' | 'warning' | 'error';
    meta: Record<string, unknown>;
  }) => void;
  /** Escalate to the orchestrator (rung 3). */
  escalate?: (detail: FrozenTurnDetail) => void;
  /**
   * COMMON-MODE ARM (2026-07-21, the 8h outage): page the operator chat
   * directly — no Claude turn in the path. Fired when ≥ commonModeThreshold
   * agents are concurrently frozen: per-agent rung-3 escalation routes into
   * the orchestrator's session, which in a common-mode failure (e.g. the
   * shared OAuth credential expiring) is exactly as dead as every other
   * session. Returns delivery success (Telegram-confirmed, not curl exit).
   */
  pageOperator?: (message: string) => boolean;
  logger?: (msg: string) => void;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
  checkIntervalMs?: number;
  graceMs?: number;
  verifyMs?: number;
  rollingWindowMs?: number;
  freezeThreshold?: number;
  heartbeatCronName?: string;
  /** Concurrently-frozen agent count that trips the common-mode page. */
  commonModeThreshold?: number;
  /** Min interval between common-mode pages (re-pages while outage persists). */
  commonModePageCooldownMs?: number;
}

interface AgentRuntimeState {
  /** Timestamps (ms) of recovery actions taken within the rolling window. */
  attempts: number[];
  /** Detection is paused for this agent until this time (post-restart verify). */
  recoveringUntil: number;
  /** A restart is awaiting its verify verdict. */
  pendingVerify: boolean;
  /** Last rung-3 escalation time, to avoid re-escalating every tick. */
  lastEscalatedAt: number;
}

const DEFAULTS = {
  checkIntervalMs: 60_000, // scan every minute
  graceMs: 10 * 60_000, // a fire has 10 min to produce a real response
  verifyMs: 5 * 60_000, // after a restart, give it 5 min before re-judging
  rollingWindowMs: 60 * 60_000, // recovery-attempt counter window: 1 hour
  freezeThreshold: 2, // N consecutive unanswered fires
  heartbeatCronName: 'heartbeat',
  commonModeThreshold: 3, // N concurrently-frozen agents = common-mode failure
  commonModePageCooldownMs: 60 * 60_000, // re-page hourly while it persists
};

export class FrozenTurnWatchdog {
  private readonly opt: Required<Omit<FrozenTurnWatchdogOptions,
    'recordEvent' | 'escalate' | 'pageOperator' | 'logger' | 'now' | 'instanceId'>> &
    Pick<FrozenTurnWatchdogOptions, 'recordEvent' | 'escalate' | 'pageOperator' | 'logger' | 'now' | 'instanceId'>;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly state = new Map<string, AgentRuntimeState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guard so an overrunning tick never overlaps the next interval. */
  private ticking = false;
  /** Last successful common-mode page (ms); 0 = never. */
  private lastCommonModePageAt = 0;

  constructor(options: FrozenTurnWatchdogOptions) {
    this.opt = {
      checkIntervalMs: options.checkIntervalMs ?? DEFAULTS.checkIntervalMs,
      graceMs: options.graceMs ?? DEFAULTS.graceMs,
      verifyMs: options.verifyMs ?? DEFAULTS.verifyMs,
      rollingWindowMs: options.rollingWindowMs ?? DEFAULTS.rollingWindowMs,
      freezeThreshold: options.freezeThreshold ?? DEFAULTS.freezeThreshold,
      heartbeatCronName: options.heartbeatCronName ?? DEFAULTS.heartbeatCronName,
      commonModeThreshold: options.commonModeThreshold ?? DEFAULTS.commonModeThreshold,
      commonModePageCooldownMs: options.commonModePageCooldownMs ?? DEFAULTS.commonModePageCooldownMs,
      ctxRoot: options.ctxRoot,
      getRunningAgents: options.getRunningAgents,
      resolveOrg: options.resolveOrg,
      restartAgent: options.restartAgent,
      recordEvent: options.recordEvent,
      escalate: options.escalate,
      pageOperator: options.pageOperator,
      logger: options.logger,
      now: options.now,
      instanceId: options.instanceId,
    };
    this.now = options.now ?? (() => Date.now());
    this.log = options.logger ?? ((msg) => console.log(`[watchdog] ${msg}`));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.opt.checkIntervalMs);
    // Don't keep the event loop alive purely for the watchdog.
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.log(
      `started (check ${Math.round(this.opt.checkIntervalMs / 1000)}s, grace ${Math.round(
        this.opt.graceMs / 60000,
      )}m, N=${this.opt.freezeThreshold})`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run one detection+recovery pass over all running agents. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const agents = this.safe(() => this.opt.getRunningAgents(), [] as string[]);

      // COMMON-MODE SWEEP — before per-agent recovery, and independent of it.
      // evaluate() is a pure read of persistent on-disk state, so "frozen"
      // accumulates until a REAL recovery clears it: a staggered cascade
      // (one agent freezing every 20 min) still converges to N-concurrent
      // unless recoveries are succeeding — and if they succeed, it is not a
      // common-mode failure. The count is rolling by construction; no
      // separate window bookkeeping needed (proven by the cascade fixture
      // in watchdog-common-mode.test.ts, not asserted).
      this.checkCommonMode(agents);

      for (const agent of agents) {
        try {
          await this.evaluateAndRecover(agent);
        } catch (err) {
          this.log(`error evaluating ${agent}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * ≥ commonModeThreshold concurrently-frozen agents = a failure with a
   * shared cause (credential expiry, API outage, daemon-side breakage).
   * Per-agent rung-3 escalation routes into the orchestrator's session —
   * in a common-mode failure that session is exactly as dead as the rest
   * (2026-07-20: 8h fleet outage, every specialist's rung-3 died in the
   * orchestrator's logged-out session; the operator found out by noticing).
   * This arm pages the operator directly, no Claude turn in the path.
   * Re-pages on a cooldown while the condition persists. Cooldown restarts
   * only on CONFIRMED delivery — a failed page must retry next tick, not
   * silently sleep through the outage.
   */
  private checkCommonMode(agents: string[]): void {
    if (!this.opt.pageOperator) return;
    const now = this.now();
    if (now - this.lastCommonModePageAt < this.opt.commonModePageCooldownMs) return;

    const frozen: { agent: string; unanswered: number; lastReal: string | null }[] = [];
    for (const agent of agents) {
      try {
        const ev = this.evaluate(agent, now);
        if (ev.frozen) frozen.push({ agent, unanswered: ev.unansweredFires, lastReal: ev.lastRealHeartbeat });
      } catch { /* one unreadable agent must not break the sweep */ }
    }
    if (frozen.length < this.opt.commonModeThreshold) return;

    const names = frozen.map((f) => `${f.agent} (${f.unanswered} unanswered, last real ${f.lastReal ?? 'never'})`).join('; ');
    const message =
      `🚨🚨 COMMON-MODE FLEET FAILURE: ${frozen.length} of ${agents.length} agents concurrently frozen — ` +
      `a shared cause (credential expiry, API outage) is likely and per-agent auto-restart will NOT fix it. ` +
      `Frozen: ${names}. ` +
      `Check: OAuth expiry (cortextos bus list-oauth-accounts), then agent stdout for "Login expired".`;

    const delivered = this.safe(() => this.opt.pageOperator!(message), false);
    if (delivered) this.lastCommonModePageAt = now;
    this.log(delivered
      ? `common-mode page delivered (${frozen.length} frozen)`
      : `common-mode page NOT delivered (${frozen.length} frozen) — will retry next tick`);

    const org = this.opt.resolveOrg(frozen[0].agent) ?? '';
    this.record(frozen[0].agent, org, 'error', 'watchdog_common_mode', 'error', {
      frozen_count: frozen.length,
      running_count: agents.length,
      frozen_agents: frozen.map((f) => f.agent),
      page_delivered: delivered,
      threshold: this.opt.commonModeThreshold,
    });
  }

  private agentState(agent: string): AgentRuntimeState {
    let s = this.state.get(agent);
    if (!s) {
      s = { attempts: [], recoveringUntil: 0, pendingVerify: false, lastEscalatedAt: 0 };
      this.state.set(agent, s);
    }
    return s;
  }

  private async evaluateAndRecover(agent: string): Promise<void> {
    const now = this.now();
    const st = this.agentState(agent);

    // Mid-recovery: give the fresh PTY its verify window before judging again.
    if (now < st.recoveringUntil) return;

    const ev = this.evaluate(agent, now);

    // Emit the verdict for a restart whose verify window just elapsed.
    if (st.pendingVerify) {
      st.pendingVerify = false;
      const org = this.opt.resolveOrg(agent) ?? '';
      if (!ev.frozen) {
        this.record(agent, org, 'action', 'watchdog_recovery_ok', 'info', {
          last_real_hb: ev.lastRealHeartbeat,
        });
        this.log(`${agent} recovered after restart`);
        return; // healthy again — nothing to do this tick
      }
      this.record(agent, org, 'error', 'watchdog_recovery_failed', 'warning', {
        unanswered_fires: ev.unansweredFires,
        last_real_hb: ev.lastRealHeartbeat,
      });
      this.log(`${agent} still frozen after restart — escalating rung`);
      // fall through to recover() which picks the next rung
    }

    if (ev.frozen && this.gateOk(agent)) {
      await this.recover(agent, ev, now);
    }
  }

  /**
   * Machine-derived freeze-proximity snapshot for one agent — THE instrument
   * behind the orchestrator_freeze_proximity metric (task_1784498913017).
   * Derives every field from the same on-disk state and the same code path
   * the recovery ladder uses (evaluate() + readHeartbeatFires()), so the
   * metric can never drift from the watchdog's own counter. The predicate is
   * emitted WITH each row so a reader can regenerate rather than trust.
   * The 59 pre-2026-07-20 hand-filled rows (event name
   * orchestrator_freeze_proximity) are NON-COMPARABLE with this output by
   * construction — different event name, different provenance.
   */
  proximity(agent: string, now: number): {
    agent: string;
    unanswered_fires: number;
    freeze_threshold: number;
    grace_ms: number;
    fires_today_utc: number;
    last_real_response: string | null;
    frozen: boolean;
    derived: true;
    predicate: string;
  } {
    const ev = this.evaluate(agent, now);
    const dayStart = Date.parse(new Date(now).toISOString().split('T')[0] + 'T00:00:00Z');
    const firesToday = this.readHeartbeatFires(agent).filter((t) => t >= dayStart && t <= now).length;
    return {
      agent,
      unanswered_fires: ev.unansweredFires,
      freeze_threshold: this.opt.freezeThreshold,
      grace_ms: this.opt.graceMs,
      fires_today_utc: firesToday,
      last_real_response: ev.lastRealHeartbeat,
      frozen: ev.frozen,
      derived: true,
      predicate:
        `unanswered = heartbeat-cron 'fired' rows with ts > last_real_response AND now-ts > ${this.opt.graceMs}ms; ` +
        `frozen = unanswered >= ${this.opt.freezeThreshold}; last_real_response = max(heartbeat.json own-status ts, newest agent-authored analytics row); ` +
        `fires_today_utc = 'fired' rows since UTC midnight; ` +
        // The pointer rides IN the series so a cold query of the new name learns the
        // predecessor exists — otherwise its few good derived rows are visible only
        // to readers who happened to open the runbook first (analyst, 2026-07-20).
        // Deliberately NO counts here: "3 rows, 59 excluded" was a reading, not the
        // rule, and a snapshot inside an unchecked string goes stale silently. The
        // predicate half is durable; the tallies live where they can be re-derived.
        `predecessor series: orchestrator_freeze_proximity (trust only its derived:true rows; all others are hand-filled and excluded)`,
    };
  }

  /**
   * Pure derivation from on-disk state: count heartbeat-cron fires that are
   * grace-elapsed AND have no real agent response after them.
   */
  evaluate(agent: string, now: number): { frozen: boolean; unansweredFires: number; lastRealHeartbeat: string | null } {
    const fires = this.readHeartbeatFires(agent); // ascending ms
    const lastReal = this.readLastRealResponse(agent); // ms or 0
    const unanswered = fires.filter((t) => t > lastReal && now - t > this.opt.graceMs);
    return {
      frozen: unanswered.length >= this.opt.freezeThreshold,
      unansweredFires: unanswered.length,
      lastRealHeartbeat: lastReal > 0 ? new Date(lastReal).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
    };
  }

  private gateOk(agent: string): boolean {
    // Deliberately stopped (markers win over everything).
    const stateDir = join(this.opt.ctxRoot, 'state', agent);
    if (existsSync(join(stateDir, '.user-stop'))) return false;
    if (existsSync(join(stateDir, '.user-disable'))) return false;

    // Explicitly disabled in the instance registry.
    const enabled = this.readEnabledList();
    const entry = enabled[agent];
    if (entry && entry.enabled === false) return false;

    // on_demand idle is naturally excluded: an idle on_demand agent that
    // self-stopped is not in getRunningAgents(), and a running one with no
    // unanswered heartbeat fires never reaches evaluate().frozen. No special
    // case needed — detection already requires a fired-but-unanswered cron.
    return true;
  }

  private async recover(agent: string, ev: { unansweredFires: number; lastRealHeartbeat: string | null }, now: number): Promise<void> {
    const st = this.agentState(agent);
    const org = this.opt.resolveOrg(agent) ?? '';

    // Prune the rolling-hour attempt window, then the rung = next attempt number.
    st.attempts = st.attempts.filter((t) => now - t < this.opt.rollingWindowMs);
    const rung = st.attempts.length + 1;

    // Rung 3: stop auto-restarting — escalate and hold for the rest of the window.
    if (rung >= 3) {
      const detail: FrozenTurnDetail = {
        agent,
        attempt: rung,
        cold: false,
        unansweredFires: ev.unansweredFires,
        lastRealHeartbeat: ev.lastRealHeartbeat,
      };
      if (now - st.lastEscalatedAt > this.opt.rollingWindowMs || st.lastEscalatedAt === 0) {
        st.lastEscalatedAt = now;
        this.record(agent, org, 'error', 'watchdog_recovery_failed', 'error', {
          attempt: rung,
          escalated: true,
          unanswered_fires: ev.unansweredFires,
          last_real_hb: ev.lastRealHeartbeat,
        });
        this.safe(() => this.opt.escalate?.(detail), undefined);
        this.log(`${agent}: 2 auto-restarts failed in the hour — escalated to orchestrator, holding`);
      }
      // Hold off all detection for this agent until the window clears.
      st.recoveringUntil = now + this.opt.rollingWindowMs;
      return;
    }

    const cold = rung === 2;
    const detail: FrozenTurnDetail = {
      agent,
      attempt: rung,
      cold,
      unansweredFires: ev.unansweredFires,
      lastRealHeartbeat: ev.lastRealHeartbeat,
    };

    this.record(agent, org, 'action', 'watchdog_auto_restart', 'warning', {
      attempt: rung,
      cold,
      unanswered_fires: ev.unansweredFires,
      last_real_hb: ev.lastRealHeartbeat,
    });
    this.log(
      `${agent}: frozen turn (${ev.unansweredFires} unanswered fires) — rung ${rung} ${cold ? 'COLD restart (force-fresh)' : 'restart (preserve context)'}`,
    );

    // Planned-restart marker so the crash-alert hook reports a clean restart.
    this.writePlannedMarker(agent, `[watchdog] frozen-turn rung ${rung}${cold ? ' (cold)' : ''} — last real hb ${ev.lastRealHeartbeat ?? 'never'}`);
    // Rung 2: one-shot context wipe consumed by shouldContinue() on respawn.
    if (cold) this.writeForceFresh(agent);

    st.attempts.push(now);
    st.recoveringUntil = now + this.opt.verifyMs;
    st.pendingVerify = true;

    await this.opt.restartAgent(agent);
  }

  // --- on-disk readers (resolve the real layout; see paths.ts / crons-schema.ts) ---

  /** Ascending list of heartbeat-cron successful fire timestamps (ms). */
  private readHeartbeatFires(agent: string): number[] {
    const path = join(this.opt.ctxRoot, cronExecutionLogPathFor(agent));
    if (!existsSync(path)) return [];
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch {
      return [];
    }
    const out: number[] = [];
    // Only the recent tail matters; cap parse work on a large (≤1000-line) log.
    const lines = raw.split('\n');
    const tail = lines.slice(Math.max(0, lines.length - 200));
    for (const line of tail) {
      const t = line.trim();
      if (!t) continue;
      let entry: CronExecutionLogEntry;
      try {
        entry = JSON.parse(t) as CronExecutionLogEntry;
      } catch {
        continue;
      }
      if (entry.cron !== this.opt.heartbeatCronName) continue;
      if (entry.status !== 'fired') continue; // ignore retry/failed: prompt never reached the agent
      const ms = Date.parse(entry.ts);
      if (!Number.isNaN(ms)) out.push(ms);
    }
    out.sort((a, b) => a - b);
    return out;
  }

  /**
   * Latest moment the agent demonstrably processed something (ms), via:
   *   (a) heartbeat.json.last_heartbeat with the agent's OWN status (not the
   *       FastChecker idle-stamp), OR
   *   (b) the newest AGENT-AUTHORED analytics event row (observer rows —
   *       watchdog_*, `observer: true` — are excluded; see below).
   * The idle-stamp advances (a)'s timestamp but with a `[watchdog]` status,
   * so it is excluded. Arm (a) additionally relies on observer events not
   * bumping last_heartbeat (LogEventOptions.observer) — a bump that merely
   * preserves the agent's old status is not attributable to the agent.
   */
  private readLastRealResponse(agent: string): number {
    let last = 0;

    // (a) heartbeat.json — only counts if status is the agent's own.
    const hbPath = join(this.opt.ctxRoot, 'state', agent, 'heartbeat.json');
    if (existsSync(hbPath)) {
      try {
        const hb = JSON.parse(readFileSync(hbPath, 'utf-8')) as Heartbeat;
        const status = hb.status ?? '';
        if (hb.last_heartbeat && !status.startsWith(WATCHDOG_IDLE_STATUS_PREFIX)) {
          const ms = Date.parse(hb.last_heartbeat);
          if (!Number.isNaN(ms)) last = Math.max(last, ms);
        }
      } catch {
        /* ignore */
      }
    }

    // (b) newest analytics event row WRITTEN BY THE AGENT'S OWN PROCESS.
    // Events are appended chronologically, so scan each file from the end —
    // but skip rows that were written ABOUT the agent by an observer:
    //   - rows stamped `observer: true` (logObserverEvent — watchdog,
    //     inbound-telegram logger), and
    //   - rows named watchdog_* regardless of stamp, covering rows written
    //     before the observer flag existed.
    // Before this filter existed, the watchdog's own watchdog_auto_restart
    // row was the newest line at every verify pass, so the watchdog read its
    // own breadcrumb as the agent's pulse and reported recovery_ok against
    // still-frozen agents; the same logEvent also bumped last_heartbeat with
    // the agent's own status preserved, poisoning arm (a). Observer events
    // no longer bump the heartbeat (see LogEventOptions.observer), so both
    // arms now only see agent-authored signals.
    const org = this.opt.resolveOrg(agent);
    const analyticsBase = org ? join(this.opt.ctxRoot, 'orgs', org, 'analytics') : join(this.opt.ctxRoot, 'analytics');
    const eventsDir = join(analyticsBase, 'events', agent);
    for (const day of this.recentEventDates()) {
      const file = join(eventsDir, `${day}.jsonl`);
      if (!existsSync(file)) continue;
      try {
        const raw = readFileSync(file, 'utf-8');
        const lines = raw.split('\n').filter((l) => l.trim());
        for (let i = lines.length - 1; i >= 0; i--) {
          let row: { timestamp?: string; event?: string; observer?: boolean };
          try {
            row = JSON.parse(lines[i]) as { timestamp?: string; event?: string; observer?: boolean };
          } catch {
            continue; // malformed line — keep scanning for an older valid row
          }
          if (row.observer === true) continue;
          if (typeof row.event === 'string' && row.event.startsWith('watchdog_')) continue;
          if (row.timestamp) {
            const ms = Date.parse(row.timestamp);
            if (!Number.isNaN(ms)) last = Math.max(last, ms);
          }
          break; // newest agent-authored row found for this file
        }
      } catch {
        /* ignore */
      }
    }
    return last;
  }

  /** Today + yesterday in UTC YYYY-MM-DD (covers the midnight file rollover). */
  private recentEventDates(): string[] {
    const now = this.now();
    const today = new Date(now).toISOString().split('T')[0];
    const yesterday = new Date(now - 24 * 60 * 60_000).toISOString().split('T')[0];
    return [today, yesterday];
  }

  private readEnabledList(): Record<string, { enabled?: boolean; org?: string }> {
    const file = join(this.opt.ctxRoot, 'config', 'enabled-agents.json');
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      return {};
    }
  }

  private writePlannedMarker(agent: string, reason: string): void {
    this.writeStateFile(agent, '.restart-planned', reason + '\n');
  }

  private writeForceFresh(agent: string): void {
    this.writeStateFile(agent, '.force-fresh', 'watchdog cold restart (frozen-turn rung 2)\n');
  }

  private writeStateFile(agent: string, name: string, content: string): void {
    try {
      const stateDir = join(this.opt.ctxRoot, 'state', agent);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, name), content, { encoding: 'utf-8' });
    } catch (err) {
      this.log(`failed to write ${name} for ${agent}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private record(
    agent: string,
    org: string,
    category: WatchdogEventCategory,
    event: string,
    severity: 'info' | 'warning' | 'error',
    meta: Record<string, unknown>,
  ): void {
    this.safe(() => this.opt.recordEvent?.({ agent, org, category, event, severity, meta }), undefined);
  }

  private safe<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch (err) {
      this.log(`internal error: ${err instanceof Error ? err.message : String(err)}`);
      return fallback;
    }
  }
}
