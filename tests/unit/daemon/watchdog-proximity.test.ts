import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FrozenTurnWatchdog } from '../../../src/daemon/frozen-turn-watchdog';

// proximity() is THE instrument behind the freeze-proximity metric
// (task_1784498913017): every field machine-derived from the same readers the
// recovery ladder uses. These tests pin (a) parity with evaluate() — the metric
// can never disagree with the watchdog's own counter, (b) numeric types — the
// hand-filled era emitted strings like 'see-cron-log', (c) the UTC-midnight
// boundary on fires_today, (d) the predicate travelling with the row.

const T0 = Date.parse('2026-07-20T12:00:00Z'); // fixed base, mid-UTC-day
const MIN = 60_000;
const AGENT = 'chief';
const ORG = 'silvermere-tech';

let ctxRoot: string;

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function writeFires(fireMs: number[]): void {
  const dir = join(ctxRoot, '.cortextOS', 'state', 'agents', AGENT);
  mkdirSync(dir, { recursive: true });
  const rows = fireMs.map((ms) => ({ ts: iso(ms), cron: 'heartbeat', status: 'fired', attempt: 1, duration_ms: 5, error: null }));
  writeFileSync(join(dir, 'cron-execution.log'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function writeHeartbeat(lastHeartbeatMs: number, status = 'working'): void {
  const dir = join(ctxRoot, 'state', AGENT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({
    agent: AGENT, org: ORG, status, current_task: '', mode: 'night',
    last_heartbeat: iso(lastHeartbeatMs), loop_interval: '1h',
  }));
}

function mkWatchdog(): FrozenTurnWatchdog {
  return new FrozenTurnWatchdog({
    ctxRoot,
    getRunningAgents: () => [AGENT],
    resolveOrg: () => ORG,
    restartAgent: async () => { throw new Error('read-only test'); },
    logger: () => {},
  });
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'wd-prox-'));
});
afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
});

describe('FrozenTurnWatchdog.proximity', () => {
  it('healthy agent: zero unanswered, fires counted, all fields numeric', () => {
    writeFires([T0 - 120 * MIN, T0 - 60 * MIN]);
    writeHeartbeat(T0 - 30 * MIN); // real response after both fires
    const p = mkWatchdog().proximity(AGENT, T0);

    expect(p.unanswered_fires).toBe(0);
    expect(p.frozen).toBe(false);
    expect(p.fires_today_utc).toBe(2);
    expect(p.last_real_response).toBe(iso(T0 - 30 * MIN));
    // the hand-filled era's defect: strings where numbers belong
    for (const k of ['unanswered_fires', 'freeze_threshold', 'grace_ms', 'fires_today_utc'] as const) {
      expect(typeof p[k]).toBe('number');
    }
    expect(p.derived).toBe(true);
  });

  it('two grace-elapsed unanswered fires: frozen, counter matches evaluate() exactly', () => {
    writeFires([T0 - 120 * MIN, T0 - 60 * MIN]);
    writeHeartbeat(T0 - 180 * MIN); // last real response BEFORE both fires
    const wd = mkWatchdog();
    const p = wd.proximity(AGENT, T0);
    const ev = wd.evaluate(AGENT, T0);

    expect(p.unanswered_fires).toBe(2);
    expect(p.frozen).toBe(true);
    // parity: the metric IS the watchdog's counter, not a neighbour of it
    expect(p.unanswered_fires).toBe(ev.unansweredFires);
    expect(p.frozen).toBe(ev.frozen);
    expect(p.last_real_response).toBe(ev.lastRealHeartbeat);
  });

  it('fires_today_utc respects the UTC midnight boundary', () => {
    const yesterday = Date.parse('2026-07-19T23:30:00Z');
    const today = Date.parse('2026-07-20T00:30:00Z');
    writeFires([yesterday, today]);
    writeHeartbeat(T0 - MIN);
    const p = mkWatchdog().proximity(AGENT, T0);

    expect(p.fires_today_utc).toBe(1); // yesterday's fire excluded
  });

  it('emits its predicate with the row, carrying the live grace/threshold values', () => {
    writeFires([]);
    const p = mkWatchdog().proximity(AGENT, T0);

    expect(p.predicate).toContain('600000ms'); // default graceMs
    expect(p.predicate).toContain('>= 2'); // default freezeThreshold
    expect(p.predicate).toContain('UTC midnight');
  });

  it('agent with no state at all: zeros with null last response, not a crash', () => {
    const p = mkWatchdog().proximity('ghost', T0);

    expect(p.unanswered_fires).toBe(0);
    expect(p.fires_today_utc).toBe(0);
    expect(p.frozen).toBe(false);
    expect(p.last_real_response).toBeNull();
  });
});
