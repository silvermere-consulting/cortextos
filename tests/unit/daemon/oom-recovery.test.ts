import { describe, it, expect, vi, beforeEach } from 'vitest';

// OOM circuit-breaker (startup-path) recovery + self-declaration notice.
// Verifies the emission chief required be VERIFIED not inferred: the countable
// restarts.log signal, the agent-facing recoverable notice, fail-closed on a
// non-OOM pid, and — condition 1 — that an emission failure never blocks the
// force-fresh recovery.

const mockPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(), forceKill: vi.fn(), write: vi.fn(),
  getPid: vi.fn().mockReturnValue(3588109),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn(),
};
vi.mock('../../../src/pty/agent-pty.js', () => ({ AgentPTY: function AgentPTY() { return mockPty; } }));
vi.mock('../../../src/pty/inject.js', () => ({ injectMessage: vi.fn(), MessageDedup: class { isDuplicate() { return false; } } }));
vi.mock('../../../src/utils/atomic.js', () => ({ ensureDir: vi.fn(), atomicWriteSync: vi.fn() }));
vi.mock('../../../src/utils/env.js', () => ({ writeCortextosEnv: vi.fn(), resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }) }));
vi.mock('../../../src/bus/reminders.js', () => ({ getOverdueReminders: vi.fn().mockReturnValue([]) }));
vi.mock('../../../src/utils/paths.js', () => ({ resolvePaths: vi.fn().mockReturnValue({ stateDir: '/tmp/test-ctx/state/alice' }) }));
vi.mock('../../../src/bus/heartbeat.js', () => ({ detectDayNightMode: vi.fn().mockReturnValue('day'), resolveUserTimezone: vi.fn().mockReturnValue('UTC') }));

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
};
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
    get readdirSync() { return fsMocks.readdirSync; },
  };
});

const execFileSyncMock = vi.fn();
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFileSync: (...args: unknown[]) => execFileSyncMock(...args) };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

const mockEnv = {
  instanceId: 'test', ctxRoot: '/tmp/test-ctx', frameworkRoot: '/tmp/fw',
  agentName: 'alice', agentDir: '/tmp/fw/orgs/acme/agents/alice', org: 'acme', projectRoot: '/tmp/fw',
};

const OOM_LINE = 'Out of memory: Killed process 3588109 (claude.exe) total-vm:10791656kB, anon-rss:8776524kB';

beforeEach(() => {
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  fsMocks.readFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
  fsMocks.readdirSync.mockReset().mockReturnValue([]);
  execFileSyncMock.mockReset();
});

// session.pid present, holds `pid`, mtime recent (so the LATER(mtime, now-300) bound is recent).
function stageSessionPid(pid: string) {
  fsMocks.existsSync.mockImplementation((p: string) => String(p).endsWith('session.pid'));
  fsMocks.readFileSync.mockReturnValue(pid);
  fsMocks.statSync.mockReturnValue({ mtimeMs: Date.now() - 30_000 });
}

describe('OOM circuit-breaker — recovery + self-declaration', () => {
  it('buildStartupPrompt SELF-DECLARES the recovery (parked-not-lost) and CLEARS the field', () => {
    const ap = new AgentProcess('alice', mockEnv, {}) as unknown as { oomRecovery: unknown; buildStartupPrompt(): string };
    ap.oomRecovery = { line: OOM_LINE, transcript: '/home/x/.claude/projects/-a/sess.jsonl' };
    const prompt = ap.buildStartupPrompt();
    expect(prompt).toContain('OOM-RECOVERY');
    expect(prompt).toContain('PARKED, NOT LOST');
    expect(prompt).toContain('--fork-session');
    expect(prompt).toContain('sess.jsonl');
    expect(prompt).toContain('oom_recovery');          // the countable bus-event instruction
    expect(ap.oomRecovery).toBeNull();                 // consume-and-clear: no phantom on a later boot
  });

  it('buildStartupPrompt emits NO recovery notice when there is none', () => {
    const ap = new AgentProcess('alice', mockEnv, {}) as unknown as { oomRecovery: unknown; buildStartupPrompt(): string };
    ap.oomRecovery = null;
    expect(ap.buildStartupPrompt()).not.toContain('OOM-RECOVERY');
  });

  it('shouldContinue force-freshes + records OOM_RECOVERY when the prior pid was OOM-killed', () => {
    const ap = new AgentProcess('alice', mockEnv, {}) as unknown as { oomRecovery: { line: string } | null; shouldContinue(): boolean };
    stageSessionPid('3588109');
    execFileSyncMock.mockReturnValue(OOM_LINE + '\n');  // journalctl -k names this pid
    expect(ap.shouldContinue()).toBe(false);             // force-fresh
    expect(ap.oomRecovery).not.toBeNull();
    expect(ap.oomRecovery!.line).toContain('3588109');
    const appended = fsMocks.appendFileSync.mock.calls.map((c: unknown[]) => String(c[1])).join('');
    expect(appended).toContain('OOM_RECOVERY');          // durable, countable restarts.log signal
  });

  it('shouldContinue does NOT self-declare when the prior pid was not OOM-killed (fail-closed, no phantom)', () => {
    const ap = new AgentProcess('alice', mockEnv, {}) as unknown as { oomRecovery: unknown; shouldContinue(): boolean };
    stageSessionPid('999999');
    execFileSyncMock.mockReturnValue('');                // no oom-kill line for this pid
    ap.shouldContinue();
    expect(ap.oomRecovery).toBeNull();
    const appended = fsMocks.appendFileSync.mock.calls.map((c: unknown[]) => String(c[1])).join('');
    expect(appended).not.toContain('OOM_RECOVERY');
  });

  it('CONDITION 1: a throwing log at ANY OOM call site (incl the UPSTREAM check-log) does NOT block force-fresh', () => {
    // Throws on BOTH the "OOM-recovery check" log (which sits UPSTREAM of `return false` — an
    // unwrapped throw there would propagate out of shouldContinue and the force-fresh would never
    // happen; chief's finding) AND the "OOM auto-recovery" log inside the emission try. Neither may
    // block the recovery. Against the unwrapped code this test throws out of shouldContinue and
    // fails; against the fix it returns false.
    const throwingLog = vi.fn((msg: string) => { if (msg.includes('OOM')) throw new Error('log sink down'); });
    const ap = new AgentProcess('alice', mockEnv, {}, throwingLog) as unknown as { oomRecovery: unknown; shouldContinue(): boolean };
    stageSessionPid('3588109');
    execFileSyncMock.mockReturnValue(OOM_LINE + '\n');
    expect(ap.shouldContinue()).toBe(false);             // recovery STILL happens despite BOTH logs throwing
    // NON-VACUOUS: proves the OOM branch was actually taken (field set before the recovery log),
    // not that shouldContinue returned false for the unrelated no-conversation reason.
    expect(ap.oomRecovery).not.toBeNull();
  });
});
