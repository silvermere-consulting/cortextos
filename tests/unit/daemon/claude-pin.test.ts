import { describe, it, expect } from 'vitest';
import {
  evaluateClaudePin,
  parseClaudeVersion,
  readClaudeVersion,
  checkClaudePinFromEnv,
  AUTHORISED_CLAUDE_VERSION,
} from '../../../src/daemon/claude-pin';

/**
 * Boot-time pin guard (task_1785377221211).
 *
 * The revert this guards: an inherited CTX_CLAUDE_BIN beat the ecosystem pin and
 * the whole fleet ran 2.1.141 (no registry entry for opus-4-8/sonnet-5/opus-5)
 * for hours, unseen. The known-positive here is the MATCH case returning ok with
 * a readable reason — proving the guard can say YES — so that a suppressed/absent
 * alarm is distinguishable from a broken one.
 */
describe('claude pin guard (evaluateClaudePin)', () => {
  const BIN = '/home/x/.local/share/claude-code/2.1.219/claude.exe';

  // KNOWN-POSITIVE: the guard must be able to say YES. A guard only ever
  // observed to fire is indistinguishable from one wired to always fire.
  it('ok when the resolved version matches the authorised pin', () => {
    const r = evaluateClaudePin(BIN, '2.1.219', '2.1.219');
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('2.1.219');
    expect(r.reason).toContain('== authorised');
  });

  // The revert condition itself.
  it('not ok when the resolved version differs from the authorised pin', () => {
    const r = evaluateClaudePin('/usr/bin/claude', '2.1.141', '2.1.219');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('PIN MISMATCH');
    expect(r.reason).toContain('2.1.141');
    expect(r.reason).toContain('2.1.219');
  });

  // A binary we cannot interrogate is not a pass — silence is not a green.
  it('not ok when the version could not be read', () => {
    const r = evaluateClaudePin('/usr/bin/claude', null, '2.1.219');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('could not read');
  });

  // No pin configured => observability only, never a false alarm.
  it('ok (observability only) when no expected version is pinned', () => {
    const r = evaluateClaudePin(BIN, '2.1.219', null);
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('no CTX_CLAUDE_VERSION_EXPECTED');
  });
});

describe('parseClaudeVersion', () => {
  it('extracts the bare version from `X.Y.Z (Claude Code)`', () => {
    expect(parseClaudeVersion('2.1.219 (Claude Code)')).toBe('2.1.219');
    expect(parseClaudeVersion('  2.1.141 (Claude Code)\n')).toBe('2.1.141');
  });
  it('returns null when there is no version token', () => {
    expect(parseClaudeVersion('command not found')).toBeNull();
  });
});

describe('readClaudeVersion (injectable runner)', () => {
  it('parses the runner output', () => {
    expect(readClaudeVersion('/x/claude', () => '2.1.219 (Claude Code)')).toBe('2.1.219');
  });
  it('returns null when the runner throws (missing binary / non-zero exit)', () => {
    expect(readClaudeVersion('/x/claude', () => { throw new Error('ENOENT'); })).toBeNull();
  });
});

describe('checkClaudePinFromEnv (env wiring)', () => {
  it('reads the bin UNDER TEST from env and matches the hardcoded reference (boot known-positive)', () => {
    const env = {
      CTX_CLAUDE_BIN: '/home/x/.local/share/claude-code/2.1.231/claude.exe',
    } as NodeJS.ProcessEnv;
    const r = checkClaudePinFromEnv(env, () => '2.1.231 (Claude Code)');
    expect(r.ok).toBe(true);
    expect(r.resolvedBin).toBe(env.CTX_CLAUDE_BIN);
    expect(r.expectedVersion).toBe(AUTHORISED_CLAUDE_VERSION);
  });

  it('flags the exact 2026-07-29 revert: stale bin resolves to 2.1.141', () => {
    const env = {
      CTX_CLAUDE_BIN: '/usr/bin/claude',
    } as NodeJS.ProcessEnv;
    const r = checkClaudePinFromEnv(env, () => '2.1.141 (Claude Code)');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('PIN MISMATCH');
  });

  // DEFECT 1 (env on both sides): a stale dump.pm2 carrying BOTH a wrong bin AND
  // a matching wrong CTX_CLAUDE_VERSION_EXPECTED must NOT satisfy the guard. The
  // expectation is the hardcoded constant, so env cannot forge agreement.
  it('env cannot supply a fake expectation: stale bin + matching stale expected still fails', () => {
    const env = {
      CTX_CLAUDE_BIN: '/usr/bin/claude',
      CTX_CLAUDE_VERSION_EXPECTED: '2.1.141',
    } as NodeJS.ProcessEnv;
    const r = checkClaudePinFromEnv(env, () => '2.1.141 (Claude Code)');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('PIN MISMATCH');
    expect(r.expectedVersion).toBe(AUTHORISED_CLAUDE_VERSION);
  });

  // DEFECT 2 (unset disarms): absence is the default state of an env var nobody
  // exported — it must NOT drop the guard to observability-only. The guard stays
  // armed on the hardcoded reference regardless of what env omits.
  it('stays armed when CTX_CLAUDE_VERSION_EXPECTED is absent from env', () => {
    const env = {
      CTX_CLAUDE_BIN: '/usr/bin/claude',
    } as NodeJS.ProcessEnv;
    const r = checkClaudePinFromEnv(env, () => '2.1.141 (Claude Code)');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('PIN MISMATCH');
    expect(r.expectedVersion).toBe(AUTHORISED_CLAUDE_VERSION);
  });
});
