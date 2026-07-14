import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logEvent, logObserverEvent } from '../../../src/bus/event';
import type { BusPaths, Heartbeat } from '../../../src/types';

/**
 * Tests for the heartbeat-refresh side-effect on logEvent. The data
 * point that motivated this behavior: 76.4% of fleet activity events
 * landed while the agent's heartbeat was >5min stale — every event
 * implies the agent is alive, so the stale-monitor should never fire
 * on an agent that is actively logging activity.
 */
describe('Bus events', () => {
  let testDir: string;
  let paths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-event-test-'));
    paths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'spark'),
      inflight: join(testDir, 'inflight', 'spark'),
      processed: join(testDir, 'processed', 'spark'),
      logDir: join(testDir, 'logs', 'spark'),
      stateDir: join(testDir, 'state', 'spark'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    mkdirSync(paths.stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('logEvent appends a JSONL entry to the daily events file', () => {
    logEvent(paths, 'spark', 'eros-os', 'action', 'test_event', 'info', { foo: 'bar' });

    const today = new Date().toISOString().split('T')[0];
    const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
    expect(existsSync(eventFile)).toBe(true);

    const entries = readFileSync(eventFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      agent: 'spark',
      org: 'eros-os',
      category: 'action',
      event: 'test_event',
      severity: 'info',
      metadata: { foo: 'bar' },
    });
  });

  describe('heartbeat refresh side-effect', () => {
    it('bumps last_heartbeat on an existing heartbeat.json without overwriting other fields', async () => {
      const oldHeartbeat: Heartbeat = {
        agent: 'spark',
        org: 'eros-os',
        status: 'online',
        current_task: 'fix/log-event-refreshes-heartbeat',
        mode: 'day',
        last_heartbeat: '2026-04-23T12:00:00Z',
        loop_interval: '4h',
      };
      writeFileSync(join(paths.stateDir, 'heartbeat.json'), JSON.stringify(oldHeartbeat));

      // Let one millisecond tick so the new timestamp is strictly newer.
      await new Promise((resolve) => setTimeout(resolve, 2));
      logEvent(paths, 'spark', 'eros-os', 'action', 'activity_tick', 'info');

      const refreshed = JSON.parse(
        readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8'),
      ) as Heartbeat;

      // Timestamp bumped…
      expect(new Date(refreshed.last_heartbeat).getTime()).toBeGreaterThan(
        new Date(oldHeartbeat.last_heartbeat).getTime(),
      );
      // …other fields preserved intact.
      expect(refreshed.status).toBe('online');
      expect(refreshed.current_task).toBe('fix/log-event-refreshes-heartbeat');
      expect(refreshed.mode).toBe('day');
      expect(refreshed.loop_interval).toBe('4h');
      expect(refreshed.agent).toBe('spark');
      expect(refreshed.org).toBe('eros-os');
    });

    it('is a no-op when no heartbeat.json exists yet', () => {
      // Fresh agent — no heartbeat file written yet.
      expect(existsSync(join(paths.stateDir, 'heartbeat.json'))).toBe(false);

      logEvent(paths, 'spark', 'eros-os', 'action', 'first_boot', 'info');

      // Still no heartbeat file — refresh is a no-op when nothing exists.
      expect(existsSync(join(paths.stateDir, 'heartbeat.json'))).toBe(false);

      // But the event itself was written.
      const today = new Date().toISOString().split('T')[0];
      const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
      expect(existsSync(eventFile)).toBe(true);
    });

    it('never blocks event persistence when the heartbeat refresh fails', () => {
      // Write a corrupt heartbeat.json to exercise the error path.
      writeFileSync(join(paths.stateDir, 'heartbeat.json'), '{not valid json');

      // Must not throw.
      expect(() =>
        logEvent(paths, 'spark', 'eros-os', 'action', 'after_corrupt_hb', 'info'),
      ).not.toThrow();

      // Event still written.
      const today = new Date().toISOString().split('T')[0];
      const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
      const entries = readFileSync(eventFile, 'utf-8').trim().split('\n');
      expect(entries).toHaveLength(1);
    });
  });

  describe('observer events (2026-07-13 watchdog self-proof fix)', () => {
    // An observer event is written ABOUT an agent by another process. It must
    // be visible in the feed but never count as the agent's own pulse: no
    // heartbeat bump, and a machine-readable `observer: true` stamp so
    // liveness readers (frozen-turn watchdog arm (b)) can exclude the row.

    const FROZEN_HB: Heartbeat = {
      agent: 'spark',
      org: 'eros-os',
      status: 'healthy — mid task',
      current_task: 'x',
      mode: 'day',
      last_heartbeat: '2026-04-23T12:00:00Z',
      loop_interval: '1h',
    };

    it('logObserverEvent writes the row with observer: true and does NOT bump last_heartbeat', () => {
      writeFileSync(join(paths.stateDir, 'heartbeat.json'), JSON.stringify(FROZEN_HB));

      logObserverEvent(paths, 'spark', 'eros-os', 'action', 'watchdog_auto_restart', 'warning', { attempt: 1 });

      const today = new Date().toISOString().split('T')[0];
      const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
      const rows = readFileSync(eventFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ event: 'watchdog_auto_restart', observer: true });

      const hb = JSON.parse(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8')) as Heartbeat;
      expect(hb.last_heartbeat).toBe(FROZEN_HB.last_heartbeat); // untouched
    });

    it('plain logEvent stays unchanged: no observer stamp, heartbeat bumped', async () => {
      writeFileSync(join(paths.stateDir, 'heartbeat.json'), JSON.stringify(FROZEN_HB));
      await new Promise((resolve) => setTimeout(resolve, 2));

      logEvent(paths, 'spark', 'eros-os', 'action', 'agent_heartbeat', 'info');

      const today = new Date().toISOString().split('T')[0];
      const eventFile = join(paths.analyticsDir, 'events', 'spark', `${today}.jsonl`);
      const rows = readFileSync(eventFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
      expect(rows[0].observer).toBeUndefined();

      const hb = JSON.parse(readFileSync(join(paths.stateDir, 'heartbeat.json'), 'utf-8')) as Heartbeat;
      expect(new Date(hb.last_heartbeat).getTime()).toBeGreaterThan(
        new Date(FROZEN_HB.last_heartbeat).getTime(),
      );
    });
  });
});
