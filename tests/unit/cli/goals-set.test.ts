/**
 * tests/unit/cli/goals-set.test.ts — `cortextos goals set` writer.
 *
 * The one property under guard: updated_at is CLOCK-AUTHORED at write time.
 * There is no flag to supply it, a stale hand-typed stamp in the existing
 * file is overwritten, and `generate-md` must NEVER refresh it (regenerating
 * GOALS.md without changing goals must not make stale goals look fresh).
 *
 * Same singleton strategy as bus-crons.test.ts: goalsCommand registers once
 * at module load, so option values persist across parseAsync calls. Every
 * test resets the `set` subcommand's option values in beforeEach.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { goalsCommand } from '../../../src/cli/goals';

const TEST_AGENT = 'boris';
const TEST_ORG = 'testorg';

let frameworkRoot: string;
let agentDir: string;
const originalFrameworkRoot = process.env.CTX_FRAMEWORK_ROOT;

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__PROCESS_EXIT_${code}__`);
  }) as never);
}

/** Reset persisted option values on the singleton subcommands between tests. */
function resetOptionValues(): void {
  for (const sub of goalsCommand.commands) {
    for (const opt of sub.options) {
      const key = opt.attributeName();
      sub.setOptionValueWithSource(key, key === 'goal' ? [] : undefined, 'default');
    }
  }
}

function readGoalsJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(agentDir, 'goals.json'), 'utf-8'));
}

function readGoalsMd(): string {
  return readFileSync(join(agentDir, 'GOALS.md'), 'utf-8');
}

const FIXTURE = {
  focus: 'Original focus',
  goals: ['first goal', 'second goal'],
  bottleneck: 'original bottleneck',
  updated_at: '2020-01-01T00:00:00.000Z',
  updated_by: 'someone',
  custom_note: 'unknown field that must survive a set',
};

beforeEach(() => {
  frameworkRoot = mkdtempSync(join(tmpdir(), 'goals-set-test-'));
  agentDir = join(frameworkRoot, 'orgs', TEST_ORG, 'agents', TEST_AGENT);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'goals.json'), JSON.stringify(FIXTURE), 'utf-8');
  process.env.CTX_FRAMEWORK_ROOT = frameworkRoot;
  resetOptionValues();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  rmSync(frameworkRoot, { recursive: true, force: true });
  if (originalFrameworkRoot === undefined) {
    delete process.env.CTX_FRAMEWORK_ROOT;
  } else {
    process.env.CTX_FRAMEWORK_ROOT = originalFrameworkRoot;
  }
  vi.restoreAllMocks();
});

async function runSet(...args: string[]): Promise<void> {
  await goalsCommand.parseAsync(['node', 'goals', 'set', ...args]);
}

const BASE = ['--agent', TEST_AGENT, '--org', TEST_ORG, '--by', 'chief'];

describe('goals set — clock-stamped writer', () => {
  it('stamps updated_at from the clock, not from the file', async () => {
    const before = Date.now();
    await runSet(...BASE, '--focus', 'New focus');
    const after = Date.now();

    const data = readGoalsJson();
    expect(data.focus).toBe('New focus');
    expect(data.updated_by).toBe('chief');
    // The seeded 2020 stamp must be gone; the new one is from the clock.
    expect(data.updated_at).not.toBe(FIXTURE.updated_at);
    const stamp = Date.parse(data.updated_at as string);
    expect(stamp).toBeGreaterThanOrEqual(before - 1000);
    expect(stamp).toBeLessThanOrEqual(after + 1000);
  });

  it('preserves fields it was not asked to change, including unknown ones', async () => {
    await runSet(...BASE, '--focus', 'New focus');
    const data = readGoalsJson();
    expect(data.goals).toEqual(FIXTURE.goals);
    expect(data.bottleneck).toBe(FIXTURE.bottleneck);
    expect(data.custom_note).toBe(FIXTURE.custom_note);
  });

  it('regenerates GOALS.md with the new content and stamp', async () => {
    await runSet(...BASE, '--focus', 'Rendered focus');
    const md = readGoalsMd();
    const data = readGoalsJson();
    expect(md).toContain('Rendered focus');
    expect(md).toContain(`${data.updated_at} (by chief)`);
    expect(md).not.toContain(FIXTURE.updated_at);
  });

  it('rejects a caller-supplied updated_at (no such flag exists)', async () => {
    const exitSpy = mockExit();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      runSet(...BASE, '--focus', 'x', '--updated-at', '2030-01-01T00:00:00Z'),
    ).rejects.toThrow(/__PROCESS_EXIT_/);
    expect(exitSpy).toHaveBeenCalled();
    // File untouched.
    expect(readGoalsJson().updated_at).toBe(FIXTURE.updated_at);
  });

  it('CONTROL: generate-md alone must NOT refresh the stamp', async () => {
    await runSet(...BASE, '--focus', 'Set once');
    const stamped = readGoalsJson().updated_at as string;

    await new Promise((r) => setTimeout(r, 15));
    await goalsCommand.parseAsync([
      'node', 'goals', 'generate-md', '--agent', TEST_AGENT, '--org', TEST_ORG,
    ]);

    expect(readGoalsJson().updated_at).toBe(stamped);
    expect(readGoalsMd()).toContain(`${stamped} (by chief)`);
  });

  it('replaces goals via --goals JSON array', async () => {
    await runSet(...BASE, '--goals', '["only goal"]');
    const data = readGoalsJson();
    expect(data.goals).toEqual(['only goal']);
    expect(readGoalsMd()).toContain('1. only goal');
  });

  it('collects repeated --goal flags in order', async () => {
    await runSet(...BASE, '--goal', 'alpha', '--goal', 'beta');
    expect(readGoalsJson().goals).toEqual(['alpha', 'beta']);
  });

  it('errors on invalid --goals JSON', async () => {
    mockExit();
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runSet(...BASE, '--goals', 'not json')).rejects.toThrow('__PROCESS_EXIT_1__');
    expect(String(errSpy.mock.calls[0][0])).toContain('--goals must be valid JSON');
    expect(readGoalsJson()).toEqual(FIXTURE);
  });

  it('errors on --goals that is not an array of strings', async () => {
    mockExit();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runSet(...BASE, '--goals', '{"a":1}')).rejects.toThrow('__PROCESS_EXIT_1__');
    expect(readGoalsJson()).toEqual(FIXTURE);
  });

  it('errors when both --goals and --goal are passed', async () => {
    mockExit();
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      runSet(...BASE, '--goals', '["a"]', '--goal', 'b'),
    ).rejects.toThrow('__PROCESS_EXIT_1__');
    expect(String(errSpy.mock.calls[0][0])).toContain('not both');
    expect(readGoalsJson()).toEqual(FIXTURE);
  });

  it('errors when nothing is being set (a no-op must not refresh the stamp)', async () => {
    mockExit();
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runSet(...BASE)).rejects.toThrow('__PROCESS_EXIT_1__');
    expect(String(errSpy.mock.calls[0][0])).toContain('nothing to set');
    expect(readGoalsJson()).toEqual(FIXTURE);
  });

  it('errors when the agent directory does not exist', async () => {
    mockExit();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      runSet('--agent', 'ghost', '--org', TEST_ORG, '--by', 'chief', '--focus', 'x'),
    ).rejects.toThrow('__PROCESS_EXIT_1__');
  });

  it('creates goals.json when the agent dir exists but the file does not', async () => {
    rmSync(join(agentDir, 'goals.json'));
    await runSet(...BASE, '--focus', 'Fresh start', '--goal', 'first');
    const data = readGoalsJson();
    expect(data.focus).toBe('Fresh start');
    expect(data.goals).toEqual(['first']);
    expect(data.updated_by).toBe('chief');
    expect(typeof data.updated_at).toBe('string');
    expect(existsSync(join(agentDir, 'GOALS.md'))).toBe(true);
  });

  it('refuses to overwrite a corrupt goals.json', async () => {
    writeFileSync(join(agentDir, 'goals.json'), '{not json', 'utf-8');
    mockExit();
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runSet(...BASE, '--focus', 'x')).rejects.toThrow('__PROCESS_EXIT_1__');
    expect(String(errSpy.mock.calls[0][0])).toContain('refusing to overwrite');
    expect(readFileSync(join(agentDir, 'goals.json'), 'utf-8')).toBe('{not json');
  });

  it('rejects a --by value outside the agent-name charset', async () => {
    mockExit();
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(
      runSet('--agent', TEST_AGENT, '--org', TEST_ORG, '--by', 'not a name!', '--focus', 'x'),
    ).rejects.toThrow('__PROCESS_EXIT_1__');
    expect(String(errSpy.mock.calls[0][0])).toContain('--by');
    expect(readGoalsJson()).toEqual(FIXTURE);
  });
});
