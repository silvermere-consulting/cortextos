import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FrozenTurnWatchdog } from '../../../src/daemon/frozen-turn-watchdog';
import { logObserverEvent } from '../../../src/bus/event';
import type { BusPaths } from '../../../src/types';

// The emission leg of `bus watchdog-proximity --emit-events` (task_1784498913017).
// The predecessor metric's terminal defect was 62 rows carrying NO PAYLOAD — the
// emitter recorded that a check happened and none of the numbers the check exists
// to produce (analyst, 2026-07-20 07:0xZ, measured with has() not `//`). So this
// test asserts PRESENCE of every payload key on the row actually written to the
// events JSONL — key-in-object, the has() discipline, never truthiness — plus a
// known-absent control so the presence detector is calibrated at both ends.

const T0 = Date.parse('2026-07-20T12:00:00Z');
const MIN = 60_000;
const AGENT = 'chief';
const ORG = 'silvermere-tech';

let ctxRoot: string;

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function mkPaths(): BusPaths {
  const analyticsDir = join(ctxRoot, 'orgs', ORG, 'analytics');
  mkdirSync(analyticsDir, { recursive: true });
  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox'),
    inflight: join(ctxRoot, 'inflight'),
    processed: join(ctxRoot, 'processed'),
    logDir: join(ctxRoot, 'logs'),
    stateDir: join(ctxRoot, 'state', AGENT),
    taskDir: join(ctxRoot, 'tasks'),
    approvalDir: join(ctxRoot, 'approvals'),
    analyticsDir,
    deliverablesDir: join(ctxRoot, 'deliverables'),
  };
}

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'wd-emit-'));
});
afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
});

describe('watchdog-proximity event emission carries the payload', () => {
  it('the row written to the events JSONL has every metric key PRESENT (has(), not truthiness)', () => {
    // Real fixture state so zeros in the row are earned, not defaults.
    const cronDir = join(ctxRoot, '.cortextOS', 'state', 'agents', AGENT);
    mkdirSync(cronDir, { recursive: true });
    writeFileSync(join(cronDir, 'cron-execution.log'),
      JSON.stringify({ ts: iso(T0 - 60 * MIN), cron: 'heartbeat', status: 'fired', attempt: 1, duration_ms: 5, error: null }) + '\n');
    mkdirSync(join(ctxRoot, 'state', AGENT), { recursive: true });
    writeFileSync(join(ctxRoot, 'state', AGENT, 'heartbeat.json'), JSON.stringify({
      agent: AGENT, org: ORG, status: 'working', current_task: '', mode: 'night',
      last_heartbeat: iso(T0 - 30 * MIN), loop_interval: '1h',
    }));

    const wd = new FrozenTurnWatchdog({
      ctxRoot,
      getRunningAgents: () => [AGENT],
      resolveOrg: () => ORG,
      restartAgent: async () => { throw new Error('read-only'); },
      logger: () => {},
    });
    const row = { org: ORG, ...wd.proximity(AGENT, T0) };

    // Exactly what the CLI's --emit-events does with the row.
    const paths = mkPaths();
    logObserverEvent(paths, row.agent, row.org, 'metric', 'watchdog_freeze_proximity',
      row.frozen ? 'warning' : 'info', row as unknown as Record<string, unknown>);

    const day = new Date().toISOString().split('T')[0];
    const written = readFileSync(join(paths.analyticsDir, 'events', AGENT, `${day}.jsonl`), 'utf-8')
      .trim().split('\n').map((l) => JSON.parse(l));
    expect(written).toHaveLength(1);
    const ev = written[0];

    expect(ev.event).toBe('watchdog_freeze_proximity');
    expect(ev.observer).toBe(true); // must never count as the agent's own pulse

    // PRESENCE of every payload key — the predecessor's defect was absence.
    const meta = ev.metadata;
    for (const k of ['agent', 'org', 'unanswered_fires', 'freeze_threshold', 'grace_ms',
      'fires_today_utc', 'last_real_response', 'frozen', 'derived', 'predicate']) {
      expect(Object.prototype.hasOwnProperty.call(meta, k), `metadata key missing: ${k}`).toBe(true);
    }
    // And the values are the derived ones, not nulls wearing the keys.
    expect(meta.unanswered_fires).toBe(0);
    expect(meta.fires_today_utc).toBe(1);
    expect(meta.derived).toBe(true);
    expect(typeof meta.predicate).toBe('string');

    // Known-absent control: the presence detector must be able to say no.
    expect(Object.prototype.hasOwnProperty.call(meta, 'zzz_never_written_control')).toBe(false);
  });
});
