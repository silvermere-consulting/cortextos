import { describe, it, expect } from 'vitest';
import {
  parseIntervalMs,
  stalenessThresholdMs,
  isHeartbeatStale,
} from '../../../src/utils/heartbeat-staleness';

describe('parseIntervalMs', () => {
  it('parses seconds', () => {
    expect(parseIntervalMs('30s')).toBe(30_000);
    expect(parseIntervalMs('1s')).toBe(1_000);
  });
  it('parses minutes', () => {
    expect(parseIntervalMs('15m')).toBe(15 * 60_000);
    expect(parseIntervalMs('1m')).toBe(60_000);
  });
  it('parses hours', () => {
    expect(parseIntervalMs('1h')).toBe(60 * 60_000);
    expect(parseIntervalMs('4h')).toBe(4 * 60 * 60_000);
    expect(parseIntervalMs('24h')).toBe(24 * 60 * 60_000);
  });
  it('parses days', () => {
    expect(parseIntervalMs('1d')).toBe(24 * 60 * 60_000);
    expect(parseIntervalMs('7d')).toBe(7 * 24 * 60 * 60_000);
  });
  it('is case-insensitive on the unit', () => {
    expect(parseIntervalMs('1H')).toBe(60 * 60_000);
    expect(parseIntervalMs('30M')).toBe(30 * 60_000);
  });
  it('returns null for unrecognised forms', () => {
    expect(parseIntervalMs('')).toBeNull();
    expect(parseIntervalMs(undefined)).toBeNull();
    expect(parseIntervalMs(null)).toBeNull();
    expect(parseIntervalMs('1 hour')).toBeNull();
    expect(parseIntervalMs('0 2 * * *')).toBeNull(); // cron expression
    expect(parseIntervalMs('1y')).toBeNull(); // unsupported unit
  });
});

describe('stalenessThresholdMs', () => {
  it('is 2x interval for parseable inputs', () => {
    expect(stalenessThresholdMs('1h')).toBe(2 * 60 * 60_000);
    expect(stalenessThresholdMs('4h')).toBe(8 * 60 * 60_000);
    expect(stalenessThresholdMs('30m')).toBe(60 * 60_000);
  });
  it('falls back to 5h when interval is missing/unparseable', () => {
    const fiveHours = 5 * 60 * 60_000;
    expect(stalenessThresholdMs('')).toBe(fiveHours);
    expect(stalenessThresholdMs(undefined)).toBe(fiveHours);
    expect(stalenessThresholdMs('0 2 * * *')).toBe(fiveHours);
  });
});

describe('isHeartbeatStale', () => {
  const now = new Date('2026-05-23T12:00:00Z').getTime();

  it('returns true when last_heartbeat is missing', () => {
    expect(isHeartbeatStale(undefined, '1h', now)).toBe(true);
    expect(isHeartbeatStale('', '1h', now)).toBe(true);
    expect(isHeartbeatStale(null, '1h', now)).toBe(true);
  });

  it('returns true when last_heartbeat is unparseable', () => {
    expect(isHeartbeatStale('not-a-date', '1h', now)).toBe(true);
  });

  it('1h agent: not stale at 1h59m, stale at 2h01m', () => {
    // 1h agent → threshold = 2h
    const oneHour59 = new Date(now - 119 * 60_000).toISOString();
    const twoHour01 = new Date(now - 121 * 60_000).toISOString();
    expect(isHeartbeatStale(oneHour59, '1h', now)).toBe(false);
    expect(isHeartbeatStale(twoHour01, '1h', now)).toBe(true);
  });

  it('4h agent: not stale at 7h, stale at 9h (resolves writer false-STALE)', () => {
    // 4h agent → threshold = 8h. Audit found writer (4h cadence) showed
    // STALE in the display at ~2h — this fix gates that off at 8h.
    const sevenHours = new Date(now - 7 * 60 * 60_000).toISOString();
    const nineHours = new Date(now - 9 * 60 * 60_000).toISOString();
    expect(isHeartbeatStale(sevenHours, '4h', now)).toBe(false);
    expect(isHeartbeatStale(nineHours, '4h', now)).toBe(true);
  });

  it('empty loop_interval falls back to flat 5h threshold', () => {
    const fourHours = new Date(now - 4 * 60 * 60_000).toISOString();
    const sixHours = new Date(now - 6 * 60 * 60_000).toISOString();
    expect(isHeartbeatStale(fourHours, '', now)).toBe(false);
    expect(isHeartbeatStale(sixHours, '', now)).toBe(true);
  });

  it('cron-expression loop_interval falls back to 5h threshold', () => {
    // Some agents may stamp a cron expression — the parser returns null so
    // the calculator falls back to the default instead of crashing.
    const fourHours = new Date(now - 4 * 60 * 60_000).toISOString();
    const sixHours = new Date(now - 6 * 60 * 60_000).toISOString();
    expect(isHeartbeatStale(fourHours, '0 2 * * *', now)).toBe(false);
    expect(isHeartbeatStale(sixHours, '0 2 * * *', now)).toBe(true);
  });
});
