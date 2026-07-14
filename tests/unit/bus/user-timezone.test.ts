import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectDayNightMode, resolveUserTimezone } from '../../../src/bus/heartbeat.js';

// The user's timezone is a MUTABLE FACT with a dated expiry (2026-07-14: Steve on a
// UK trip 12-21 Jul; a bare Europe/London override would be correct until the 21st
// and silently wrong forever after). These tests pin the exact edges that make the
// override fail SAFE: the date flips in the OVERRIDE tz (the user's own calendar),
// not in UTC and not in the org tz.

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveUserTimezone', () => {
  it('returns the fallback when no override is configured', () => {
    const r = resolveUserTimezone('Asia/Dubai', {});
    expect(r).toEqual({ timezone: 'Asia/Dubai', source: 'default' });
  });

  it('returns the override when configured with no expiry', () => {
    const r = resolveUserTimezone('Asia/Dubai', { userTimezone: 'Europe/London' });
    expect(r).toEqual({ timezone: 'Europe/London', source: 'override' });
  });

  it('honours the override THROUGH the until-date in the override tz (23:30 London on the 21st)', () => {
    vi.useFakeTimers();
    // 2026-07-21T22:30Z = 23:30 BST, still 2026-07-21 in London
    vi.setSystemTime(new Date('2026-07-21T22:30:00Z'));
    const r = resolveUserTimezone('Asia/Dubai', {
      userTimezone: 'Europe/London',
      userTimezoneUntil: '2026-07-21',
    });
    expect(r).toEqual({ timezone: 'Europe/London', source: 'override' });
  });

  it('expires at the first LONDON midnight after the until-date, even while UTC is still on the date', () => {
    vi.useFakeTimers();
    // 2026-07-21T23:30Z = 00:30 BST on the 22nd in London; UTC date is still the 21st.
    // The user's calendar owns the flip — this is the decisive edge.
    vi.setSystemTime(new Date('2026-07-21T23:30:00Z'));
    const r = resolveUserTimezone('Asia/Dubai', {
      userTimezone: 'Europe/London',
      userTimezoneUntil: '2026-07-21',
    });
    expect(r).toEqual({ timezone: 'Asia/Dubai', source: 'override-expired' });
  });

  it('fails safe to the fallback on a malformed until-date (an override whose end nobody can compute)', () => {
    const r = resolveUserTimezone('Asia/Dubai', {
      userTimezone: 'Europe/London',
      userTimezoneUntil: '21-07-2026',
    });
    expect(r).toEqual({ timezone: 'Asia/Dubai', source: 'override-expired' });
  });

  it('fails safe to the fallback on an unusable override timezone', () => {
    const r = resolveUserTimezone('Asia/Dubai', {
      userTimezone: 'Not/AZone',
      userTimezoneUntil: '2026-07-21',
    });
    expect(r).toEqual({ timezone: 'Asia/Dubai', source: 'override-expired' });
  });

  it('treats empty-string values as absent', () => {
    const r = resolveUserTimezone('Asia/Dubai', { userTimezone: '  ', userTimezoneUntil: '' });
    expect(r).toEqual({ timezone: 'Asia/Dubai', source: 'default' });
  });
});

describe('detectDayNightMode with a configured window', () => {
  it('keeps the historical 08:00-22:00 default when no window is passed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T07:59:00Z')); // 07:59 UTC
    expect(detectDayNightMode('UTC')).toBe('night');
    vi.setSystemTime(new Date('2026-07-15T08:00:00Z'));
    expect(detectDayNightMode('UTC')).toBe('day');
    vi.setSystemTime(new Date('2026-07-15T21:59:00Z'));
    expect(detectDayNightMode('UTC')).toBe('day');
    vi.setSystemTime(new Date('2026-07-15T22:00:00Z'));
    expect(detectDayNightMode('UTC')).toBe('night');
  });

  it('honours day_mode_start/day_mode_end minute-precise', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T06:29:00Z'));
    expect(detectDayNightMode('UTC', { start: '06:30', end: '22:00' })).toBe('night');
    vi.setSystemTime(new Date('2026-07-15T06:30:00Z'));
    expect(detectDayNightMode('UTC', { start: '06:30', end: '22:00' })).toBe('day');
  });

  it('answers in the USER tz: 05:00 Dubai = 08:00 London window edge', () => {
    vi.useFakeTimers();
    // 2026-07-15T07:00Z = 08:00 BST London = 11:00 Dubai.
    vi.setSystemTime(new Date('2026-07-15T07:00:00Z'));
    expect(detectDayNightMode('Europe/London', { start: '08:00', end: '22:00' })).toBe('day');
    // Same instant judged on the Dubai clock is mid-morning too — but at
    // 2026-07-15T03:00Z (07:00 Dubai, 04:00 London) the two clocks DISAGREE:
    vi.setSystemTime(new Date('2026-07-15T03:00:00Z'));
    expect(detectDayNightMode('Europe/London', { start: '08:00', end: '22:00' })).toBe('night'); // user asleep
    expect(detectDayNightMode('Asia/Dubai', { start: '06:00', end: '22:00' })).toBe('day');      // the old, wrong answer
  });

  it('falls back to the 08:00 default on a malformed window value', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T07:00:00Z'));
    expect(detectDayNightMode('UTC', { start: 'banana' })).toBe('night'); // default 08:00 still in force
    vi.setSystemTime(new Date('2026-07-15T09:00:00Z'));
    expect(detectDayNightMode('UTC', { start: 'banana' })).toBe('day');
  });
});
