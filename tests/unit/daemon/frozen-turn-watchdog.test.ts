import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FrozenTurnWatchdog } from '../../../src/daemon/frozen-turn-watchdog';

/**
 * Acceptance criteria from the spec (§8):
 *  1. Frozen turn (cron fired, no response for N cycles) → exactly one restart.
 *  2. Does NOT fire for (a) .user-stop, (b) idle agent (no unanswered fire),
 *     (c) disabled agent.
 *  3. Loop-safety: 3rd failure in the hour escalates, does not restart-loop.
 *  4. Marker hygiene: writes .restart-planned (never a crash alarm).
 *  5. Idle-stamp masking is defeated: an agent whose ONLY heartbeat advance is
 *     the FastChecker `[watchdog] … idle` stamp is still detected as frozen
 *     (this is the precise gap that hid the 2026-06-20 fleet freeze).
 */

const T0 = Date.parse('2026-06-20T12:00:00Z'); // fixed base; same UTC day throughout
const MIN = 60_000;
const AGENT = 'engineer';
const ORG = 'silvermere-tech';

let ctxRoot: string;

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Write heartbeat-cron 'fired' rows to cron-execution.log at the given times. */
function writeFires(agent: string, fireMs: number[], extra: Array<{ cron: string; status: string; ts: number }> = []): void {
  const dir = join(ctxRoot, '.cortextOS', 'state', 'agents', agent);
  mkdirSync(dir, { recursive: true });
  const rows = [
    ...fireMs.map((ms) => ({ ts: iso(ms), cron: 'heartbeat', status: 'fired', attempt: 1, duration_ms: 5, error: null })),
    ...extra.map((e) => ({ ts: iso(e.ts), cron: e.cron, status: e.status, attempt: 1, duration_ms: 5, error: null })),
  ].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  writeFileSync(join(dir, 'cron-execution.log'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function writeHeartbeat(agent: string, lastHeartbeatMs: number, status: string): void {
  const dir = join(ctxRoot, 'state', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({
    agent, org: ORG, status, current_task: '', mode: 'night',
    last_heartbeat: iso(lastHeartbeatMs), loop_interval: '1h',
  }));
}

function writeEvent(agent: string, org: string, tsMs: number, event = 'agent_heartbeat'): void {
  const day = new Date(tsMs).toISOString().split('T')[0];
  const dir = join(ctxRoot, 'orgs', org, 'analytics', 'events', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${day}.jsonl`), JSON.stringify({
    id: `${tsMs}-${agent}-x`, agent, org, timestamp: iso(tsMs),
    category: 'heartbeat', event, severity: 'info', metadata: {},
  }) + '\n');
}

function writeEnabled(map: Record<string, { enabled?: boolean; org?: string }>): void {
  const dir = join(ctxRoot, 'config');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'enabled-agents.json'), JSON.stringify(map));
}

function marker(agent: string, name: string): void {
  const dir = join(ctxRoot, 'state', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), 'x');
}

interface Harness {
  wd: FrozenTurnWatchdog;
  restarts: string[];
  events: Array<{ event: string; meta: Record<string, unknown> }>;
  escalations: Array<{ agent: string; attempt: number }>;
  setNow: (ms: number) => void;
}

function makeWatchdog(running: string[] = [AGENT]): Harness {
  let nowMs = T0;
  const restarts: string[] = [];
  const events: Array<{ event: string; meta: Record<string, unknown> }> = [];
  const escalations: Array<{ agent: string; attempt: number }> = [];
  const wd = new FrozenTurnWatchdog({
    ctxRoot,
    getRunningAgents: () => running,
    resolveOrg: () => ORG,
    restartAgent: async (a) => { restarts.push(a); },
    recordEvent: ({ event, meta }) => { events.push({ event, meta }); },
    escalate: (d) => { escalations.push({ agent: d.agent, attempt: d.attempt }); },
    logger: () => {},
    now: () => nowMs,
    graceMs: 1_000,
    verifyMs: 1_000,
    rollingWindowMs: 60 * MIN,
    freezeThreshold: 2,
  });
  return { wd, restarts, events, escalations, setNow: (ms) => { nowMs = ms; } };
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-wd-test-'));
  writeEnabled({ [AGENT]: { enabled: true, org: ORG } });
});

afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('FrozenTurnWatchdog — detection', () => {
  it('detects a frozen turn even when the [watchdog] idle-stamp keeps heartbeat.json fresh (§8.5)', async () => {
    // Two heartbeat fires, both grace-elapsed. The ONLY heartbeat advance is the
    // FastChecker idle-stamp (fresh, but `[watchdog]` status) — no real response.
    writeFires(AGENT, [T0, T0 + 60 * MIN]);
    writeHeartbeat(AGENT, T0 + 120 * MIN, '[watchdog] engineer alive — idle session');
    const h = makeWatchdog();
    h.setNow(T0 + 130 * MIN);

    await h.wd.tick();

    expect(h.restarts).toEqual([AGENT]); // exactly one restart
    const restart = h.events.find((e) => e.event === 'watchdog_auto_restart');
    expect(restart?.meta).toMatchObject({ attempt: 1, cold: false, unanswered_fires: 2 });
    // Marker hygiene: planned-restart written, NOT a context wipe on rung 1.
    expect(existsSync(join(ctxRoot, 'state', AGENT, '.restart-planned'))).toBe(true);
    expect(existsSync(join(ctxRoot, 'state', AGENT, '.force-fresh'))).toBe(false);
  });

  it('does NOT fire when the agent answered the fires (a real event after them)', async () => {
    writeFires(AGENT, [T0, T0 + 60 * MIN]);
    writeEvent(AGENT, ORG, T0 + 61 * MIN); // real response after the last fire
    writeHeartbeat(AGENT, T0 + 61 * MIN, 'healthy — working');
    const h = makeWatchdog();
    h.setNow(T0 + 130 * MIN);

    await h.wd.tick();

    expect(h.restarts).toEqual([]);
  });

  it('does NOT count a not-yet-grace-elapsed fire (slow-but-healthy protection)', async () => {
    // One old unanswered fire + one that fired 0.5s ago (inside the 1s grace).
    const h = makeWatchdog();
    const now = T0 + 130 * MIN;
    writeFires(AGENT, [T0, now - 500]);
    writeHeartbeat(AGENT, T0 - MIN, '[watchdog] idle');
    h.setNow(now);

    await h.wd.tick();

    expect(h.restarts).toEqual([]); // only 1 grace-elapsed unanswered fire < threshold 2
  });
});

describe('FrozenTurnWatchdog — gate (must not restart)', () => {
  function frozen(): Harness {
    writeFires(AGENT, [T0, T0 + 60 * MIN]);
    writeHeartbeat(AGENT, T0 + 120 * MIN, '[watchdog] idle');
    const h = makeWatchdog();
    h.setNow(T0 + 130 * MIN);
    return h;
  }

  it('skips a .user-stop agent', async () => {
    const h = frozen();
    marker(AGENT, '.user-stop');
    await h.wd.tick();
    expect(h.restarts).toEqual([]);
  });

  it('skips a .user-disable agent', async () => {
    const h = frozen();
    marker(AGENT, '.user-disable');
    await h.wd.tick();
    expect(h.restarts).toEqual([]);
  });

  it('skips an agent disabled in enabled-agents.json', async () => {
    writeEnabled({ [AGENT]: { enabled: false, org: ORG } });
    const h = frozen();
    await h.wd.tick();
    expect(h.restarts).toEqual([]);
  });
});

describe('FrozenTurnWatchdog — recovery ladder + loop-safety', () => {
  it('escalates after two failed restarts in the hour and stops restart-looping (§8.3)', async () => {
    writeFires(AGENT, [T0, T0 + 60 * MIN]);
    writeHeartbeat(AGENT, T0 + 120 * MIN, '[watchdog] idle'); // never recovers
    const h = makeWatchdog();

    // Rung 1 — preserve context.
    h.setNow(T0 + 130 * MIN);
    await h.wd.tick();
    expect(h.restarts.length).toBe(1);
    expect(existsSync(join(ctxRoot, 'state', AGENT, '.force-fresh'))).toBe(false);

    // Rung 2 — still frozen after verify window → COLD restart (.force-fresh).
    h.setNow(T0 + 132 * MIN); // past verifyMs (1s) and recoveringUntil
    await h.wd.tick();
    expect(h.restarts.length).toBe(2);
    const cold = h.events.find((e) => e.event === 'watchdog_auto_restart' && (e.meta as { attempt?: number }).attempt === 2);
    expect(cold?.meta).toMatchObject({ attempt: 2, cold: true });
    expect(existsSync(join(ctxRoot, 'state', AGENT, '.force-fresh'))).toBe(true);

    // Rung 3 — escalate, NO third restart.
    h.setNow(T0 + 134 * MIN);
    await h.wd.tick();
    expect(h.restarts.length).toBe(2); // did NOT restart a third time
    expect(h.escalations).toEqual([{ agent: AGENT, attempt: 3 }]);
    expect(h.events.some((e) => e.event === 'watchdog_recovery_failed')).toBe(true);

    // Further ticks in the same hour stay held — no restart storm.
    h.setNow(T0 + 140 * MIN);
    await h.wd.tick();
    expect(h.restarts.length).toBe(2);
    expect(h.escalations.length).toBe(1); // escalated only once
  });

  it('logs recovery_ok and stops when the agent comes back after a restart', async () => {
    writeFires(AGENT, [T0, T0 + 60 * MIN]);
    writeHeartbeat(AGENT, T0 + 120 * MIN, '[watchdog] idle');
    const h = makeWatchdog();

    h.setNow(T0 + 130 * MIN);
    await h.wd.tick();
    expect(h.restarts.length).toBe(1);

    // Simulate recovery: the fresh PTY emits a real event after the restart.
    writeEvent(AGENT, ORG, T0 + 131 * MIN, 'session_start');
    h.setNow(T0 + 132 * MIN); // past verify window

    await h.wd.tick();
    expect(h.restarts.length).toBe(1); // no further restart
    expect(h.events.some((e) => e.event === 'watchdog_recovery_ok')).toBe(true);
  });
});
