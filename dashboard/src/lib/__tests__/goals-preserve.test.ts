import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Regression pin for othe's bug (2026-07-28): the dashboard server-action path
// `getGoals -> mutate -> writeGoals` silently STRIPPED `north_star` (and never
// stamped `updated_at`) because GoalsData does not model those keys and the old
// writeGoals JSON.stringify'd only `data`. The fix makes writeGoals preserve-merge
// the existing file. This test drives the EXACT action that fired the bug
// (updateBottleneck) so a future full-replace refactor of writeGoals — or an
// action rewired off writeGoals — fails loudly here.

// Point the data layer at a per-test temp goals.json and satisfy the action's
// org validation + framework lookups. next/cache and child_process are stubbed so
// the action runs without a real Next runtime or a real bus spawn.
let goalsPath = '';

vi.mock('@/lib/config', () => ({
  getGoalsPath: () => goalsPath,
  getOrgs: () => ['testorg'],
  getFrameworkRoot: () => '/tmp/fake-framework-root',
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

import { updateBottleneck, updateGoals } from '@/lib/actions/goals';
import { getGoals, writeGoals } from '@/lib/data/goals';

const seed = (obj: Record<string, unknown>) =>
  fs.writeFileSync(goalsPath, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
const read = () => JSON.parse(fs.readFileSync(goalsPath, 'utf-8'));

describe('goals.json write preserves unmodelled keys', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goals-preserve-'));
    goalsPath = path.join(tmpDir, 'goals.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('updateBottleneck keeps north_star that GoalsData does not model', async () => {
    seed({
      north_star: 'TBD — Jen drives at /onboarding',
      bottleneck: 'old',
      goals: [],
      daily_focus: '',
      daily_focus_set_at: '',
    });

    const res = await updateBottleneck('testorg', 'Help Jen organise her ideas');
    expect(res.success).toBe(true);

    const after = read();
    // The fix: north_star survives the exact path that stripped it.
    expect(after.north_star).toBe('TBD — Jen drives at /onboarding');
    // The intended mutation still lands.
    expect(after.bottleneck).toBe('Help Jen organise her ideas');
    // And the dashboard path now stamps updated_at, matching CLI/PATCH writers.
    expect(typeof after.updated_at).toBe('string');
    expect(after.updated_at.length).toBeGreaterThan(0);
  });

  it('updateGoals keeps north_star and any future unmodelled key', async () => {
    seed({
      north_star: 'ship the thing',
      some_future_key: { nested: 42 },
      bottleneck: 'b',
      goals: [],
    });

    const res = await updateGoals('testorg', [
      { id: 'g1', title: 'first', progress: 10, order: 0 },
    ]);
    expect(res.success).toBe(true);

    const after = read();
    expect(after.north_star).toBe('ship the thing');
    expect(after.some_future_key).toEqual({ nested: 42 });
    expect(after.goals).toHaveLength(1);
    expect(after.goals[0].title).toBe('first');
  });

  it('writeGoals does not clobber an on-disk daily_focus with an undefined optional', () => {
    seed({
      north_star: 'x',
      bottleneck: 'b',
      goals: [],
      daily_focus: 'today: do the important thing',
      daily_focus_set_at: '2026-07-28T00:00:00.000Z',
    });

    // A caller that only carries the four core fields and leaves daily_focus
    // undefined must NOT wipe the daily_focus already on disk.
    writeGoals('testorg', {
      bottleneck: 'b2',
      goals: [],
      daily_focus: undefined,
      daily_focus_set_at: undefined,
    });

    const after = read();
    expect(after.north_star).toBe('x');
    expect(after.bottleneck).toBe('b2');
    expect(after.daily_focus).toBe('today: do the important thing');
    expect(after.daily_focus_set_at).toBe('2026-07-28T00:00:00.000Z');
  });

  it('getGoals still surfaces the four modelled fields (round-trip sanity)', () => {
    seed({
      north_star: 'x',
      bottleneck: 'b',
      goals: [{ id: 'g1', title: 't', progress: 0, order: 0 }],
      daily_focus: 'df',
      daily_focus_set_at: 'ts',
    });
    const g = getGoals('testorg');
    expect(g.bottleneck).toBe('b');
    expect(g.goals).toHaveLength(1);
    expect(g.daily_focus).toBe('df');
  });
});
