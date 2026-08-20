import { AgentManager } from './agent-manager.js';
import { IPCServer } from './ipc-server.js';
import { FrozenTurnWatchdog, type FrozenTurnDetail } from './frozen-turn-watchdog.js';
import { pageOperator, validateOperatorChat, operatorSelfTestEvent } from './operator-page.js';
import { checkClaudePinFromEnv } from './claude-pin.js';
import { CredentialRefresher, buildCredentialGate } from './credential-refresh.js';
import { readdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { ensureDir } from '../utils/atomic.js';
import { logObserverEvent } from '../bus/event.js';
import { sendMessage } from '../bus/message.js';
import { resolvePaths } from '../utils/paths.js';
import { stripBom } from '../utils/strip-bom.js';

// Each fast-checker registers a process-level SIGUSR1 handler (see
// fast-checker.ts:102). With >10 active agents the default Node listener cap
// trips MaxListenersExceededWarning. Bump for the full fleet.
process.setMaxListeners(20);

// ---------------------------------------------------------------------------
// Crash handling: turn silent daemon deaths into attributable, observable
// events. Three responsibilities:
//   1. Write a .daemon-crashed marker per agent — hook-crash-alert.ts uses
//      this on the next session boot to emit "🚨 daemon crashed" instead of
//      the misleading "🚨 agent crashed" default.
//   2. Maintain a small crash-history JSON so we can detect crash-loops.
//   3. On ≥3 crashes in 15 min, send ONE Telegram alert to the operator chat
//      (with a 30-min cooldown). PM2's max_restarts: 10 is the final
//      circuit breaker; our alert fires before the fleet goes fully dead.
// Context: root cause of 2026-04-22 restart storm was unguarded this.pty!
// in worker-process.ts:93 — PR #196 fixed 3 sister sites but missed this
// one. The inject.ts try/catch + worker-process ?. land the structural fix;
// this module is the visibility layer.
// ---------------------------------------------------------------------------

export interface CrashEvent { ts: string; err: string; }
export interface CrashHistory { crashes: CrashEvent[]; lastAlertAt?: string; }

export const CRASH_HISTORY_MAX = 20;
export const CRASH_LOOP_WINDOW_MS = 15 * 60 * 1000;    // 15 min detection window
export const CRASH_LOOP_THRESHOLD = 3;                  // 3 crashes trips the alert
export const CRASH_LOOP_COOLDOWN_MS = 30 * 60 * 1000;   // 30 min between alerts
const TELEGRAM_SEND_TIMEOUT_MS = 3000;           // bounded — we're crashing

export function crashHistoryPath(ctxRoot: string): string {
  return join(ctxRoot, 'state', '.daemon-crash-history.json');
}

export function readCrashHistory(ctxRoot: string): CrashHistory {
  const p = crashHistoryPath(ctxRoot);
  if (!existsSync(p)) return { crashes: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as CrashHistory;
    return { crashes: parsed.crashes ?? [], lastAlertAt: parsed.lastAlertAt };
  } catch {
    return { crashes: [] };
  }
}

export function writeCrashHistory(ctxRoot: string, history: CrashHistory): void {
  try {
    ensureDir(join(ctxRoot, 'state'));
    writeFileSync(crashHistoryPath(ctxRoot), JSON.stringify(history, null, 2), 'utf-8');
  } catch {
    // disk full / permission issue — don't block exit
    console.error('[daemon] Failed to persist crash history (non-fatal)');
  }
}

export function recordCrash(ctxRoot: string, errStr: string): CrashHistory {
  const history = readCrashHistory(ctxRoot);
  history.crashes.push({ ts: new Date().toISOString(), err: errStr.slice(0, 2000) });
  if (history.crashes.length > CRASH_HISTORY_MAX) {
    history.crashes = history.crashes.slice(-CRASH_HISTORY_MAX);
  }
  writeCrashHistory(ctxRoot, history);
  return history;
}

export function shouldSendCrashLoopAlert(history: CrashHistory): boolean {
  const now = Date.now();
  const windowStart = now - CRASH_LOOP_WINDOW_MS;
  const recent = history.crashes.filter(c => Date.parse(c.ts) >= windowStart).length;
  if (recent < CRASH_LOOP_THRESHOLD) return false;
  if (history.lastAlertAt) {
    const cooldownEnd = Date.parse(history.lastAlertAt) + CRASH_LOOP_COOLDOWN_MS;
    if (now < cooldownEnd) return false;
  }
  return true;
}

export function countRecentCrashes(history: CrashHistory): number {
  const windowStart = Date.now() - CRASH_LOOP_WINDOW_MS;
  return history.crashes.filter(c => Date.parse(c.ts) >= windowStart).length;
}

export function writeDaemonCrashedMarkers(ctxRoot: string): void {
  // Scan state/ for per-agent dirs (each agent has state/<name>/ created
  // by AgentProcess). Writing here parallels the .daemon-stop marker path
  // in agent-manager.ts:stopAll — lets hook-crash-alert.ts distinguish
  // crash from planned stop. Each write is independently try/catch'd so
  // a single bad agent dir can't block the exit path.
  const stateDir = join(ctxRoot, 'state');
  if (!existsSync(stateDir)) return;
  let names: string[];
  try {
    names = readdirSync(stateDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return; }
  const ts = new Date().toISOString();
  for (const name of names) {
    try {
      writeFileSync(join(stateDir, name, '.daemon-crashed'), ts, 'utf-8');
    } catch { /* swallow per-agent */ }
  }
}

// Operator-page primitive extracted to operator-page.ts (2026-07-21, F3):
// it is the fleet's only alert path with no Claude turn in it, so it is a
// general capability with multiple callers, not a rung-3 special case.
//
// requireExplicit EVERYWHERE (chief's call, 2026-07-21): the fallback was
// exercised 24 times across the 8h outage and produced zero alerting value
// at real cost — pages at a person with no context or ability to act, while
// the operator learned nothing. "Page-to-wrong-chat beats page-to-nobody"
// was tested at scale and it lost. All operator pages send only to the chat
// chosen by CTX_OPERATOR_* config; unconfigured = inert-and-loud (the boot
// self-test goes red, re-checked hourly, evented to each org's orchestrator).
function sendOperatorAlertBestEffort(
  frameworkRoot: string,
  message: string,
  label: string,
): boolean {
  return pageOperator(frameworkRoot, message, label, { requireExplicit: true });
}

function sendCrashLoopAlertBestEffort(
  frameworkRoot: string,
  crashCount: number,
  errStr: string,
): boolean {
  const message =
    `🚨 CRITICAL: cortextos daemon is crash-looping\n` +
    `${crashCount} crashes in 15 minutes\n` +
    `Last error: ${errStr.slice(0, 500)}\n` +
    `Next alert in 30 min if the pattern continues.`;
  return sendOperatorAlertBestEffort(frameworkRoot, message, 'Crash-loop alert');
}

/**
 * Where a rung-3 freeze escalation must go. The orchestrator is the normal
 * route — but when the frozen agent IS the orchestrator (or no orchestrator
 * resolves), routing through it would consult the wedged party, so the alert
 * pages the operator chat directly instead. Every input maps to a target;
 * there is deliberately no "drop it" arm (2026-07-19 blind spot: the old
 * early-return made chief — the one agent that routes everything to the
 * human — the one agent the alarm could not report).
 */
export type FrozenEscalationTarget =
  | { kind: 'orchestrator'; orchestrator: string }
  | { kind: 'operator'; reason: 'subject-is-orchestrator' | 'no-orchestrator' };

export function deriveFrozenEscalationTarget(
  orchestrator: string | undefined,
  agent: string,
): FrozenEscalationTarget {
  if (orchestrator && orchestrator !== agent) return { kind: 'orchestrator', orchestrator };
  return { kind: 'operator', reason: orchestrator ? 'subject-is-orchestrator' : 'no-orchestrator' };
}

export interface FrozenEscalationDeps {
  /** Resolve the org's orchestrator name (context.json), or undefined. */
  resolveOrchestrator: (org: string) => string | undefined;
  /** Deliver a high-priority bus message to another agent in the org. */
  sendToAgent: (org: string, to: string, text: string) => void;
  /** Page the operator Telegram chat directly. Returns delivery success. */
  pageOperator: (message: string) => boolean;
  log: (msg: string) => void;
}

/**
 * Route a rung-3 frozen-turn escalation. Exported (with injectable deps) so
 * tests can watch BOTH branches fire — including subject==orchestrator, the
 * branch the pre-2026-07-19 code silently dropped.
 */
export function escalateFrozenTurnImpl(
  detail: FrozenTurnDetail,
  org: string | undefined,
  deps: FrozenEscalationDeps,
): FrozenEscalationTarget {
  const orchestrator = org ? deps.resolveOrchestrator(org) : undefined;
  const target = deriveFrozenEscalationTarget(orchestrator, detail.agent);
  const core =
    `${detail.agent} appears frozen and TWO auto-restarts in the last hour did not recover it ` +
    `(${detail.unansweredFires} unanswered heartbeat fires; last real response ${detail.lastRealHeartbeat ?? 'never'}). ` +
    `Auto-restart is now paused for this agent for the rest of the hour. Manual check needed: \`cortextos restart ${detail.agent}\` ` +
    `or inspect its PTY/logs for a wedged turn.`;

  if (target.kind === 'orchestrator') {
    // org is defined here: an orchestrator can only resolve from an org.
    deps.sendToAgent(org as string, target.orchestrator, `🚨 WATCHDOG ESCALATION: ${core}`);
    deps.log(`escalated ${detail.agent} freeze to ${target.orchestrator}`);
    return target;
  }

  const why = target.reason === 'subject-is-orchestrator'
    ? `the frozen agent IS the orchestrator${org ? ` of ${org}` : ''} — it cannot receive its own alarm`
    : `no orchestrator resolved${org ? ` for org ${org}` : ' (agent org unknown)'}`;
  const sent = deps.pageOperator(`🚨 WATCHDOG ESCALATION (paging operator: ${why}): ${core}`);
  deps.log(sent
    ? `escalated ${detail.agent} freeze DIRECTLY to the operator chat (${target.reason})`
    : `OPERATOR PAGE FAILED for frozen ${detail.agent} (${target.reason}) — no reachable alert channel; set CTX_OPERATOR_CHAT_ID + CTX_OPERATOR_BOT_TOKEN`);
  return target;
}

/**
 * Shared fatal-error handler for both uncaughtException and
 * unhandledRejection. Performs marker writes + crash recording + optional
 * telegram alert, then optionally exits. Stays fully synchronous so it
 * finishes before Node's default crash behavior triggers.
 */
function handleFatal(
  tag: 'uncaughtException' | 'unhandledRejection',
  err: unknown,
  ctxRoot: string,
  frameworkRoot: string,
  doExit: boolean,
): void {
  const errStr = err instanceof Error ? (err.stack || err.message) : String(err);
  console.error(`[daemon] FATAL ${tag} — exiting for PM2 respawn`);
  console.error(errStr);

  writeDaemonCrashedMarkers(ctxRoot);
  const history = recordCrash(ctxRoot, errStr);

  if (shouldSendCrashLoopAlert(history)) {
    const recent = countRecentCrashes(history);
    if (sendCrashLoopAlertBestEffort(frameworkRoot, recent, errStr)) {
      history.lastAlertAt = new Date().toISOString();
      writeCrashHistory(ctxRoot, history);
    }
  }

  if (doExit) process.exit(1);
}

/**
 * cortextOS Daemon - single process managing all agents.
 * Run via `pm2 start ecosystem.config.js` or `cortextos ecosystem && pm2 start`.
 */
class Daemon {
  private agentManager: AgentManager | null = null;
  private ipcServer: IPCServer | null = null;
  private watchdog: FrozenTurnWatchdog | null = null;
  private instanceId: string;
  private ctxRoot: string;

  constructor() {
    this.instanceId = process.env.CTX_INSTANCE_ID || 'default';
    // Always derive ctxRoot from instanceId to avoid inheriting a parent cortextOS's CTX_ROOT
    this.ctxRoot = join(homedir(), '.cortextos', this.instanceId);
  }

  async start(): Promise<void> {
    // Force restrictive default permissions for everything the daemon writes:
    // 0700 dirs, 0600 files. Belt-and-suspenders for explicit chmod calls.
    if (process.platform !== 'win32') {
      process.umask(0o077);
    }

    console.log(`[daemon] Starting cortextOS daemon (instance: ${this.instanceId})`);

    const frameworkRoot = process.env.CTX_FRAMEWORK_ROOT || '';
    const org = process.env.CTX_ORG || '';

    if (!frameworkRoot) {
      console.error('[daemon] CTX_FRAMEWORK_ROOT not set');
      process.exit(1);
    }

    // Write PID file
    const pidFile = join(this.ctxRoot, 'daemon.pid');
    ensureDir(this.ctxRoot);
    writeFileSync(pidFile, String(process.pid), 'utf-8');
    if (process.platform !== 'win32') {
      try {
        chmodSync(pidFile, 0o600);
      } catch { /* best effort */ }
    }

    // Boot-time claude pin guard (task_1785377221211). Runs BEFORE agents spawn,
    // since agents inherit CTX_CLAUDE_BIN. Logs the resolved binary + its actual
    // --version — the known-positive that makes "which version are agents on"
    // answerable from the boot log instead of /proc archaeology — and pages the
    // operator loudly on a mismatch. Never exits: a fleet on the wrong version
    // beats a dead fleet, and the page ensures a human sees it.
    try {
      const pin = checkClaudePinFromEnv();
      console.log(`[daemon] [pin] ${pin.reason}`);
      if (!pin.ok) {
        console.error(`[daemon] [pin] CRITICAL — ${pin.reason}`);
        pageOperator(frameworkRoot, `Claude pin check FAILED at daemon boot: ${pin.reason}`, 'claude-pin');
      }
    } catch (err) {
      console.error(`[daemon] [pin] pin check threw (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    // Create agent manager
    this.agentManager = new AgentManager(this.instanceId, this.ctxRoot, frameworkRoot, org);

    // Start IPC server
    this.ipcServer = new IPCServer(this.agentManager, this.instanceId);
    await this.ipcServer.start();

    // Discover and start agents
    await this.agentManager.discoverAndStart();

    // Start the daemon-level frozen-turn watchdog. Runs OUTSIDE every agent
    // PTY (pure file reads of state the daemon already maintains), so it can
    // detect and recover a hung agent — including the fleet-monitor agent
    // itself, which an in-session monitor structurally cannot. See the module
    // header for the 2026-06-20 incident this closes.
    const am = this.agentManager;
    const instanceId = this.instanceId;
    // Optional env overrides for the watchdog timing constants. Lets ops tune
    // detection latency (and run a short profile for a controlled acceptance
    // test) without a code change. Unset → the module's production defaults.
    const envNum = (key: string): number | undefined => {
      const v = process.env[key];
      if (!v) return undefined;
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    this.watchdog = new FrozenTurnWatchdog({
      ctxRoot: this.ctxRoot,
      instanceId,
      getRunningAgents: () => am.getAgentNames(),
      resolveOrg: (agent) => am.getAgentOrg(agent),
      restartAgent: (agent) => am.restartAgent(agent),
      recordEvent: ({ agent, org, category, event, severity, meta }) => {
        try {
          // MUST be the observer variant: the watchdog speaks ABOUT the agent.
          // Plain logEvent here bumped the frozen target's heartbeat and made
          // the watchdog's own row its "pulse" — every recovery verify then
          // passed against a still-frozen agent (fixed 2026-07-13).
          logObserverEvent(resolvePaths(agent, instanceId, org || undefined), agent, org, category, event, severity, meta);
        } catch { /* observational only — never disrupt the watchdog */ }
      },
      escalate: (detail) => this.escalateFrozenTurn(frameworkRoot, instanceId, detail),
      // COMMON-MODE ARM (2026-07-21, the 8h outage): ≥N agents concurrently
      // frozen pages the operator directly, regardless of who the subject is.
      // Rung-3 escalation alone routes specialists' alarms INTO the
      // orchestrator's session — which in a common-mode failure (shared
      // credential expiry) is exactly as dead as everyone else's.
      // requireExplicit: the arm is a NEW capability — without CTX_OPERATOR_*
      // it must be inert-and-loud, never a page multiplier at whatever chat
      // the fallback walk happens to find (24 mis-addressed pages, 2026-07-20).
      pageOperator: (message) =>
        pageOperator(frameworkRoot, message, 'Watchdog common-mode alarm', { requireExplicit: true }),
      // F2: hold recovery rungs when a restart provably cannot help
      // (credential expired / token refused). See credential-refresh.ts.
      credentialGate: buildCredentialGate({ ctxRoot: this.ctxRoot }),
      logger: (msg) => console.log(`[watchdog] ${msg}`),
      checkIntervalMs: envNum('CTX_WATCHDOG_CHECK_MS'),
      graceMs: envNum('CTX_WATCHDOG_GRACE_MS'),
      verifyMs: envNum('CTX_WATCHDOG_VERIFY_MS'),
      rollingWindowMs: envNum('CTX_WATCHDOG_WINDOW_MS'),
      freezeThreshold: envNum('CTX_WATCHDOG_FREEZE_N'),
      commonModeThreshold: envNum('CTX_WATCHDOG_COMMON_MODE_N'),
    });
    this.watchdog.start();

    // Operator-page self-test: at boot and hourly thereafter. A dead
    // last-resort alarm must be loud while everything else is healthy — and
    // loud INTO A CHANNEL WITH A READER (chief, 2026-07-21): a CRITICAL log
    // only a person tailing the daemon would see is a near-side register
    // with extra steps. Red raises a bus event on each org's orchestrator
    // (activity feed + analyst's sweeps) and persists a marker any check
    // can read. requireExplicit because a fallback-resolved chat passes
    // reachability while paging the wrong human — green must mean "the
    // alarm reaches the operator", not "an alarm works".
    this.runOperatorSelfTest(frameworkRoot, instanceId);
    const selfTestTimer = setInterval(
      () => this.runOperatorSelfTest(frameworkRoot, instanceId),
      60 * 60_000,
    );
    if (typeof selfTestTimer.unref === 'function') selfTestTimer.unref();

    // F1: proactive credential refresh — the fleet's shared Claude token
    // must never expire while the daemon lives (2026-07-20: expiry logged
    // out all agents for 8h; restarts cannot mint a credential). One tick
    // every 5 minutes: cheap file reads; network only inside T-30. Design +
    // pinned deadline semantics: see credential-refresh.ts header.
    const credRefresher = new CredentialRefresher({
      ctxRoot: this.ctxRoot,
      page: (message) => pageOperator(frameworkRoot, message, 'Credential refresh', { requireExplicit: true }),
      log: (msg) => console.log(`[cred-refresh] ${msg}`),
      // A page can be refused (requireExplicit) and then the failure exists
      // only on a phone (2026-07-22 gap). An event cannot be refused — emit one
      // per org's orchestrator stream, the surfaces that actually get read.
      emitEvent: (event, meta) => {
        try {
          const am = this.agentManager;
          if (!am) return;
          const seenOrgs = new Set<string>();
          for (const agent of am.getAgentNames()) {
            const org = am.getAgentOrg(agent);
            if (!org || seenOrgs.has(org)) continue;
            seenOrgs.add(org);
            logObserverEvent(resolvePaths(agent, instanceId, org), agent, org, 'error', event, 'error', meta);
          }
        } catch { /* observational only — never disrupt the refresher */ }
      },
    });
    const credTimer = setInterval(() => {
      credRefresher.tick().catch((err) =>
        console.error(`[cred-refresh] tick threw (non-fatal): ${err instanceof Error ? err.message : String(err)}`));
    }, 5 * 60_000);
    if (typeof credTimer.unref === 'function') credTimer.unref();
    void credRefresher.tick().catch(() => { /* first pass best-effort */ });

    console.log(`[daemon] Running (pid: ${process.pid})`);

    // Handle shutdown signals
    const shutdown = async () => {
      console.log('[daemon] Shutting down...');
      try {
        this.watchdog?.stop();
        if (this.agentManager) {
          await this.agentManager.stopAll();
        }
      } catch (err) {
        console.error('[daemon] Error during shutdown:', err);
      }
      if (this.ipcServer) {
        this.ipcServer.stop();
      }
      // Clean up PID file
      try {
        const { unlinkSync } = require('fs');
        unlinkSync(pidFile);
      } catch { /* ignore */ }
      process.exit(0);
    };

    // BUG-003 fix: re-entrancy guard. A second SIGTERM arriving while
    // shutdown() is in flight would start a parallel stopAll(), causing
    // unpredictable signal cascades across child PTY processes.
    let shuttingDown = false;
    const handleSignal = () => {
      if (shuttingDown) {
        console.log('[daemon] Shutdown already in progress, ignoring signal');
        return;
      }
      shuttingDown = true;
      shutdown().catch((err) => {
        console.error('[daemon] Fatal shutdown error:', err);
        process.exit(1);
      });
    };

    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);

    // Global fatal-error handlers. uncaughtException exits for PM2 respawn.
    // unhandledRejection logs + records but does not exit (rejected promises
    // shouldn't be fatal by default; matches Node 15+ behavior without
    // adopting the new strict default). Both paths write .daemon-crashed
    // markers and increment the crash-loop counter.
    const ctxRootForHandler = this.ctxRoot;
    const frameworkRootForHandler = frameworkRoot;
    process.on('uncaughtException', (err) => {
      handleFatal('uncaughtException', err, ctxRootForHandler, frameworkRootForHandler, true);
    });
    process.on('unhandledRejection', (reason) => {
      handleFatal('unhandledRejection', reason, ctxRootForHandler, frameworkRootForHandler, false);
    });
    console.log('[daemon] Fatal-error handlers registered (uncaughtException + unhandledRejection)');

    // Debug-only: SIGUSR2 induces a controlled uncaughtException for
    // live crash-path verification. Off in production unless
    // CTX_DEBUG_ALLOW_CRASH_TRIGGER=1 is explicitly set. See docs/debugging.md.
    if (process.env.CTX_DEBUG_ALLOW_CRASH_TRIGGER === '1') {
      process.on('SIGUSR2', () => {
        console.error('[daemon] SIGUSR2 received — inducing test crash (CTX_DEBUG_ALLOW_CRASH_TRIGGER=1)');
        throw new Error('Simulated daemon crash via SIGUSR2 (test harness)');
      });
      console.log('[daemon] SIGUSR2 crash trigger ENABLED (debug mode)');
    }

    // Fallback cleanup on exit (belt-and-suspenders for Windows)
    process.on('exit', () => {
      if (this.ipcServer) {
        this.ipcServer.stop();
      }
      try {
        const { unlinkSync } = require('fs');
        unlinkSync(pidFile);
      } catch { /* ignore */ }
    });
  }

  /**
   * Validate the operator-page path and make a red result land where it has
   * readers: CRITICAL daemon log + persistent marker
   * (state/.operator-page-selftest.json) + an `operator_page_selftest_failed`
   * bus event on each org's orchestrator (dashboard activity feed, analyst
   * sweeps, chief's own stream). Runs at boot and hourly. Best-effort at
   * every step — the self-test must never disrupt the daemon.
   */
  private runOperatorSelfTest(frameworkRoot: string, instanceId: string): void {
    try {
      const v = validateOperatorChat(frameworkRoot, undefined, { requireExplicit: true });

      // Persistent marker: any check (heartbeat, census, fleet sweeps) can
      // read the current verdict without parsing logs.
      try {
        const stateDir = join(this.ctxRoot, 'state');
        ensureDir(stateDir);
        writeFileSync(
          join(stateDir, '.operator-page-selftest.json'),
          JSON.stringify({ ok: v.ok, failed: v.failed, detail: v.detail, checked_at: new Date().toISOString() }, null, 2),
          'utf-8',
        );
      } catch { /* marker is best-effort */ }

      if (v.ok) {
        console.log(`[daemon] operator-page self-test OK: ${v.detail}`);
      } else {
        console.error(`[daemon] ⚠️ CRITICAL: operator-page self-test FAILED (${v.failed}): ${v.detail} — ` +
          'the fleet CANNOT page the operator in a common-mode outage. Fix before relying on any alarm.');
      }

      // Emit a per-org event on EVERY run — `operator_page_selftest_ok` on pass,
      // `operator_page_selftest_failed` on fail — attributed to each org's
      // orchestrator (falls back to the org's first agent), the streams that
      // actually get read. A failure-only control cannot tell HEALTHY from DEAD:
      // event-stream silence reads identically whether the page works or the
      // self-test stopped running. The persistent marker already records both
      // states; this brings the event stream to parity so a sweep need not know
      // which store holds the positive signal (task_1787204161743, condition 1).
      const ev = operatorSelfTestEvent(v);
      const agents = this.agentManager?.getAgentNames() ?? [];
      const orgFirstAgent = new Map<string, string>();
      for (const a of agents) {
        const org = this.agentManager?.getAgentOrg(a);
        if (org && !orgFirstAgent.has(org)) orgFirstAgent.set(org, a);
      }
      for (const [org, firstAgent] of orgFirstAgent) {
        try {
          let target = firstAgent;
          try {
            const ctx = JSON.parse(stripBom(readFileSync(join(frameworkRoot, 'orgs', org, 'context.json'), 'utf-8')));
            if (typeof ctx.orchestrator === 'string' && ctx.orchestrator) target = ctx.orchestrator;
          } catch { /* no context.json — first agent carries it */ }
          logObserverEvent(
            resolvePaths(target, instanceId, org), target, org,
            ev.category, ev.event, ev.severity, ev.meta,
          );
        } catch { /* per-org best-effort */ }
      }
    } catch (err) {
      console.error(`[daemon] operator-page self-test threw (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Rung-3 escalation for the frozen-turn watchdog: after two auto-restarts in
   * the rolling hour failed to recover an agent, alert the org's orchestrator
   * on the bus — or, when the frozen agent IS the orchestrator (or none
   * resolves), page the operator Telegram chat directly. The routing lives in
   * escalateFrozenTurnImpl so tests can watch both branches fire. Best-effort —
   * a failure here must never disrupt the watchdog loop.
   */
  private escalateFrozenTurn(frameworkRoot: string, instanceId: string, detail: FrozenTurnDetail): void {
    try {
      const org = this.agentManager?.getAgentOrg(detail.agent);
      escalateFrozenTurnImpl(detail, org, {
        resolveOrchestrator: (o) => {
          try {
            const ctx = JSON.parse(stripBom(readFileSync(join(frameworkRoot, 'orgs', o, 'context.json'), 'utf-8')));
            return typeof ctx.orchestrator === 'string' && ctx.orchestrator ? ctx.orchestrator : undefined;
          } catch {
            return undefined; // no context.json — impl routes to the operator page
          }
        },
        sendToAgent: (o, to, text) => {
          const paths = resolvePaths(detail.agent, instanceId, o);
          sendMessage(paths, detail.agent, to, 'high', text);
        },
        pageOperator: (message) => sendOperatorAlertBestEffort(frameworkRoot, message, 'Watchdog escalation'),
        log: (msg) => console.log(`[watchdog] ${msg}`),
      });
    } catch (err) {
      console.error(`[watchdog] escalation failed for ${detail.agent}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// Only auto-start when run directly (e.g. `node dist/daemon.js` or via PM2).
// Guarding with require.main prevents accidental daemon spawn when the module
// is require()'d for testing or class imports — which would start a full daemon
// with TelegramPollers, IPC server, and Claude PTY processes as a side effect.
// See: https://github.com/grandamenium/cortextos/issues/44
if (require.main === module) {
  const daemon = new Daemon();
  daemon.start().catch(err => {
    console.error('[daemon] Fatal error:', err);
    process.exit(1);
  });
}
