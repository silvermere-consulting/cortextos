import { describe, it, expect } from 'vitest';
import { nextFireFromCron } from '../../../src/daemon/cron-scheduler.js';

// Proves the defect list-crons had: omitting the timezone interprets the cron
// expression in the CALLER's ambient zone, producing a different instant.
describe('nextFireFromCron timezone handling (list-crons defect)', () => {
  const from = Date.parse('2026-07-24T06:00:00Z');

  it('interprets 18:00 in the AGENT zone, not the caller ambient zone', () => {
    // 18:00 Asia/Dubai (+04) == 14:00Z
    const dubai = nextFireFromCron('0 18 * * *', from, 'Asia/Dubai');
    expect(new Date(dubai).toISOString()).toBe('2026-07-24T14:00:00.000Z');
  });

  it('a different zone yields a different instant for the SAME expression', () => {
    const dubai = nextFireFromCron('0 18 * * *', from, 'Asia/Dubai');
    const singapore = nextFireFromCron('0 18 * * *', from, 'Asia/Singapore');
    // +04 vs +08 -> exactly 4h apart. This 4h is the phantom "every cron is
    // scheduled 4 hours early" the old display produced on this box.
    expect(dubai - singapore).toBe(4 * 60 * 60 * 1000);
  });

  it('UTC fail-safe is explicit and correct', () => {
    const utc = nextFireFromCron('0 18 * * *', from, 'UTC');
    expect(new Date(utc).toISOString()).toBe('2026-07-24T18:00:00.000Z');
  });
});
