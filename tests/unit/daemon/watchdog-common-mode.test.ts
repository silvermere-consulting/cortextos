import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FrozenTurnWatchdog } from '../../../src/daemon/frozen-turn-watchdog';

// COMMON-MODE ARM (2026-07-21, the 8h fleet outage): ≥N concurrently-frozen
// agents pages the operator directly — per-agent rung-3 escalation routes
// into the orchestrator's session, which in a common-mode failure (shared
// credential expiry) is exactly as dead as everyone else's.
//
// The load-bearing fixture here is the STAGGERED CASCADE: chief's design
// question was whether an instantaneous concurrent count can be defeated by
// agents freezing at different times. The structural answer — evaluate()
// reads persistent on-disk state, so "frozen" accumulates until a real
// recovery clears it — is PROVEN here, not asserted: a one-agent-per-20-min
// cascade must trip the arm, and a freeze-recover-freeze chain must not.

const T0 = Date.parse('2026-07-20T21:00:00Z');
const MIN = 60_000;
const ORG = 'silvermere-tech';

let ctxRoot: string;

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function writeFires(agent: string, fireMs: number[]): void {
  const dir = join(ctxRoot, '.cortextOS', 'state', 'agents', agent);
  mkdirSync(dir, { recursive: true });
  const rows = fireMs.map((ms) => ({ ts: iso(ms), cron: 'heartbeat', status: 'fired', attempt: 1, duration_ms: 5, error: null }));
  writeFileSync(join(dir, 'cron-execution.log'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function writeHeartbeat(agent: string, lastHeartbeatMs: number, status = 'working'): void {
  const dir = join(ctxRoot, 'state', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({
    agent, org: ORG, status, current_task: '', mode: 'night',
    last_heartbeat: iso(lastHeartbeatMs), loop_interval: '1h',
  }));
}

/** Freeze `agent` as of `freezeMs`: two grace-elapsed unanswered fires. */
function freezeAgentAt(agent: string, freezeMs: number): void {
  writeFires(agent, [freezeMs - 30 * MIN, freezeMs - 15 * MIN]);
  writeHeartbeat(agent, freezeMs - 60 * MIN); // last real response before both fires
}

/** Healthy `agent`: fires answered by a later real heartbeat. */
function healthyAgent(agent: string, nowMs: number): void {
  writeFires(agent, [nowMs - 90 * MIN, nowMs - 30 * MIN]);
  writeHeartbeat(agent, nowMs - 5 * MIN);
}

interface Harness {
  wd: FrozenTurnWatchdog;
  pages: string[];
  events: { event: string; meta: Record<string, unknown> }[];
  setNow: (ms: number) => void;
  setPageResult: (ok: boolean) => void;
}

function mkHarness(agents: string[], opts: { pageOperator?: false } = {}): Harness {
  let nowMs = T0;
  let pageResult = true;
  const pages: string[] = [];
  const events: { event: string; meta: Record<string, unknown> }[] = [];
  const wd = new FrozenTurnWatchdog({
    ctxRoot,
    getRunningAgents: () => agents,
    resolveOrg: () => ORG,
    restartAgent: async () => { /* no-op: recovery is not under test */ },
    recordEvent: (e) => { events.push({ event: e.event, meta: e.meta }); },
    ...(opts.pageOperator === false ? {} : {
      pageOperator: (message: string) => { pages.push(message); return pageResult; },
    }),
    logger: () => {},
    now: () => nowMs,
  });
  return {
    wd, pages, events,
    setNow: (ms) => { nowMs = ms; },
    setPageResult: (ok) => { pageResult = ok; },
  };
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'wd-cm-'));
});
afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
});

describe('watchdog common-mode arm', () => {
  it('KNOWN-POSITIVE: 3 concurrently frozen agents → one page naming all three + event', async () => {
    const agents = ['chief', 'engineer', 'writer'];
    for (const a of agents) freezeAgentAt(a, T0);
    const h = mkHarness(agents);

    await h.wd.tick();

    expect(h.pages).toHaveLength(1);
    expect(h.pages[0]).toContain('COMMON-MODE');
    for (const a of agents) expect(h.pages[0]).toContain(a);
    const cm = h.events.filter((e) => e.event === 'watchdog_common_mode');
    expect(cm).toHaveLength(1);
    expect(cm[0].meta.frozen_count).toBe(3);
    expect(cm[0].meta.page_delivered).toBe(true);
  });

  it('KNOWN-NEGATIVE: 2 frozen + 1 healthy → no page (below threshold)', async () => {
    freezeAgentAt('chief', T0);
    freezeAgentAt('engineer', T0);
    healthyAgent('writer', T0);
    const h = mkHarness(['chief', 'engineer', 'writer']);

    await h.wd.tick();

    expect(h.pages).toHaveLength(0);
    expect(h.events.filter((e) => e.event === 'watchdog_common_mode')).toHaveLength(0);
  });

  it('STAGGERED CASCADE (the chief question): one freeze per 20 min still trips — frozen state is persistent, so the count is rolling by construction', async () => {
    const agents = ['chief', 'engineer', 'writer'];
    freezeAgentAt('chief', T0);
    freezeAgentAt('engineer', T0 + 20 * MIN);
    freezeAgentAt('writer', T0 + 40 * MIN);
    const h = mkHarness(agents);

    // At T0+25: chief + engineer frozen, writer's fires not yet grace-elapsed.
    h.setNow(T0 + 25 * MIN);
    await h.wd.tick();
    expect(h.pages).toHaveLength(0);

    // At T0+41: writer's second fire is grace-elapsed → 3 concurrent. Chief
    // and engineer froze 41 and 21 minutes ago and NOTHING recovered them,
    // so they still count. No rolling-window bookkeeping was needed.
    h.setNow(T0 + 41 * MIN);
    await h.wd.tick();
    expect(h.pages).toHaveLength(1);
    expect(h.pages[0]).toContain('3 of 3');
  });

  it('NEGATIVE CASCADE: freeze→recover→freeze chain never has 3 concurrent → no page (recoveries succeeding ⇒ not common-mode)', async () => {
    const agents = ['chief', 'engineer', 'writer'];
    freezeAgentAt('chief', T0);
    freezeAgentAt('engineer', T0 + 20 * MIN);
    // chief RECOVERS (real heartbeat after its fires) before writer freezes.
    writeHeartbeat('chief', T0 + 30 * MIN);
    freezeAgentAt('writer', T0 + 40 * MIN);
    const h = mkHarness(agents);

    h.setNow(T0 + 41 * MIN);
    await h.wd.tick();

    expect(h.pages).toHaveLength(0);
  });

  it('COOLDOWN: no re-page inside the hour; re-pages after it while the outage persists', async () => {
    const agents = ['chief', 'engineer', 'writer'];
    for (const a of agents) freezeAgentAt(a, T0);
    const h = mkHarness(agents);

    await h.wd.tick();
    expect(h.pages).toHaveLength(1);

    h.setNow(T0 + 30 * MIN);
    await h.wd.tick();
    expect(h.pages).toHaveLength(1); // still inside cooldown

    h.setNow(T0 + 61 * MIN);
    await h.wd.tick();
    expect(h.pages).toHaveLength(2); // outage persists → page again
  });

  it('FAILED DELIVERY does not start the cooldown — retries next tick (a failed page must not sleep through the outage)', async () => {
    const agents = ['chief', 'engineer', 'writer'];
    for (const a of agents) freezeAgentAt(a, T0);
    const h = mkHarness(agents);
    h.setPageResult(false);

    await h.wd.tick();
    expect(h.pages).toHaveLength(1);
    const cm = h.events.filter((e) => e.event === 'watchdog_common_mode');
    expect(cm[0].meta.page_delivered).toBe(false);

    h.setNow(T0 + 1 * MIN);
    await h.wd.tick();
    expect(h.pages).toHaveLength(2); // retried immediately

    h.setPageResult(true);
    h.setNow(T0 + 2 * MIN);
    await h.wd.tick();
    expect(h.pages).toHaveLength(3); // delivered → cooldown starts

    h.setNow(T0 + 10 * MIN);
    await h.wd.tick();
    expect(h.pages).toHaveLength(3); // now inside cooldown
  });

  it('no pageOperator wired → sweep is inert (no throw, recovery unaffected)', async () => {
    const agents = ['chief', 'engineer', 'writer'];
    for (const a of agents) freezeAgentAt(a, T0);
    const h = mkHarness(agents, { pageOperator: false });

    await expect(h.wd.tick()).resolves.toBeUndefined();
    expect(h.pages).toHaveLength(0);
  });
});
