import { describe, it, expect, vi, beforeEach } from 'vitest';

let capturedOnExit: ((exitCode: number, signal?: number) => void) | null = null;

const mockCodexAppServerPty = {
  spawn: vi.fn().mockResolvedValue(undefined),
  kill: vi.fn(),
  write: vi.fn(),
  getPid: vi.fn().mockReturnValue(24680),
  isAlive: vi.fn().mockReturnValue(true),
  onExit: vi.fn().mockImplementation((cb: (exitCode: number, signal?: number) => void) => {
    capturedOnExit = cb;
  }),
  getOutputBuffer: vi.fn().mockReturnValue({ isBootstrapped: vi.fn().mockReturnValue(true) }),
  setTelegramHandle: vi.fn(),
};

const mockAgentPty = {
  ...mockCodexAppServerPty,
  setTelegramHandle: undefined,
};

vi.mock('../../../src/pty/agent-pty.js', () => ({
  AgentPTY: function AgentPTY() { return mockAgentPty; },
}));

vi.mock('../../../src/pty/codex-app-server-pty.js', () => ({
  CodexAppServerPTY: function CodexAppServerPTY() { return mockCodexAppServerPty; },
}));

vi.mock('../../../src/pty/hermes-pty.js', () => ({
  HermesPTY: function HermesPTY() { return mockAgentPty; },
  hermesDbExists: vi.fn().mockReturnValue(false),
}));

const mockInjectMessage = vi.fn();
vi.mock('../../../src/pty/inject.js', () => ({
  injectMessage: mockInjectMessage,
  MessageDedup: class { isDuplicate() { return false; } },
}));

vi.mock('../../../src/utils/atomic.js', () => ({
  ensureDir: vi.fn(),
  atomicWriteSync: vi.fn(),
}));

vi.mock('../../../src/utils/env.js', () => ({
  writeCortextosEnv: vi.fn(),
  resolveEnv: vi.fn().mockReturnValue({ instanceId: 'test', ctxRoot: '/tmp/test' }),
}));

// Mutable holder (fsMocks pattern) so individual tests can arm overdue
// reminders — see the create-reminder injection tests (task_1784533197259).
const reminderMocks = {
  getOverdueReminders: vi.fn().mockReturnValue([]),
};
vi.mock('../../../src/bus/reminders.js', () => ({
  get getOverdueReminders() { return reminderMocks.getOverdueReminders; },
}));

vi.mock('../../../src/utils/paths.js', () => ({
  resolvePaths: vi.fn().mockReturnValue({}),
}));

const fsMocks = {
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  statSync: vi.fn(),
};

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    get existsSync() { return fsMocks.existsSync; },
    get readFileSync() { return fsMocks.readFileSync; },
    get writeFileSync() { return fsMocks.writeFileSync; },
    get appendFileSync() { return fsMocks.appendFileSync; },
    get statSync() { return fsMocks.statSync; },
  };
});

const { AgentProcess } = await import('../../../src/daemon/agent-process.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'codex-app-agent',
  agentDir: '/tmp/fw/orgs/acme/agents/codex-app-agent',
  org: 'acme',
  projectRoot: '/tmp/fw',
};

beforeEach(() => {
  capturedOnExit = null;
  for (const pty of [mockCodexAppServerPty, mockAgentPty]) {
    pty.spawn.mockClear();
    pty.kill.mockClear();
    pty.write.mockClear();
    pty.getPid.mockClear();
    pty.isAlive.mockReset().mockReturnValue(true);
    pty.onExit.mockClear();
    pty.getOutputBuffer.mockClear();
  }
  mockCodexAppServerPty.setTelegramHandle.mockClear();
  mockInjectMessage.mockClear();
  fsMocks.existsSync.mockReset().mockReturnValue(false);
  reminderMocks.getOverdueReminders.mockReset().mockReturnValue([]);
  fsMocks.readFileSync.mockReset();
  fsMocks.writeFileSync.mockReset();
  fsMocks.appendFileSync.mockReset();
  fsMocks.statSync.mockReset();
});

describe('AgentProcess codex-app-server runtime', () => {
  // task_1784533197259: agent-codex/AGENTS.md omits create-reminder. These two
  // tests settle the INJECTION half at the boundary the daemon controls: the
  // boot prompt handed to CodexAppServerPTY.spawn carries the overdue-reminder
  // block through the SAME shared buildBootPrompt path as claude-code. What
  // they deliberately do NOT settle: whether the codex runtime ACTS on the
  // inline block — issue #392 documents that codex-app-server executes inline
  // boot instructions unreliably (the back-online ping needed a daemon-side
  // compensation), and no such compensation exists for reminders. That half
  // needs a live codex boot, unavailable on a box with no codex binary.
  it('injects overdue reminders into the codex boot prompt (shared buildBootPrompt path)', async () => {
    reminderMocks.getOverdueReminders.mockReturnValue([
      { id: 'rem-test-1', fire_at: '2026-07-19T09:00:00Z', prompt: 'renew the TLS cert', status: 'pending' },
    ]);
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await ap.start();

    expect(mockCodexAppServerPty.spawn).toHaveBeenCalledTimes(1);
    const prompt = mockCodexAppServerPty.spawn.mock.calls[0][1] as string;
    expect(prompt).toContain('1 overdue persistent reminder(s)');
    expect(prompt).toContain('[rem-test-1] (due 2026-07-19T09:00:00Z): renew the TLS cert');
    expect(prompt).toContain('cortextos bus ack-reminder');
  });

  it('codex boot prompt carries NO reminder block when none are overdue (known-negative)', async () => {
    reminderMocks.getOverdueReminders.mockReturnValue([]);
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await ap.start();

    const prompt = mockCodexAppServerPty.spawn.mock.calls[0][1] as string;
    expect(prompt).not.toContain('overdue persistent reminder');
  });

  it('selects CodexAppServerPTY for runtime codex-app-server', async () => {
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await ap.start();

    expect(mockCodexAppServerPty.spawn).toHaveBeenCalledWith('fresh', expect.any(String));
    expect(ap.getStatus().pid).toBe(24680);
  });

  it('wires Telegram handle to CodexAppServerPTY before start', async () => {
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined) };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    expect(mockCodexAppServerPty.setTelegramHandle).toHaveBeenCalledWith(api, '12345');
  });

  it('sends back-online Telegram to the STATUS chat (not the conversational chat) in DAY mode (issue #392 + JEN-LEAK path D)', async () => {
    // Pin the clock to a day-mode instant (noon UTC → detectDayNightMode('UTC')
    // = day) so the boot-TG day/night gate is deterministic regardless of when
    // the suite runs. Fake only Date so session setTimeout timers are untouched.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-04T12:00:00Z'));
    try {
      const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const api = { sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage };

      // conversational chat 12345, STATUS chat 99999 — the notice must go to 99999.
      ap.setTelegramHandle(api as any, '12345', '99999');
      await ap.start();

      expect(sendMessage).toHaveBeenCalledWith('99999', 'Agent codex-app-agent is back online');
      // and NEVER the conversational chat (that is the leak this routing closes)
      expect(sendMessage).not.toHaveBeenCalledWith('12345', expect.any(String));
    } finally {
      vi.useRealTimers();
    }
  });

  it('SUPPRESSES back-online Telegram when no status chat is configured — never falls back to the conversational chat (JEN-LEAK path D)', async () => {
    // The refusal arm: an agent whose CHAT_ID is a client (no CTX_STATUS_CHAT_ID) must get NO
    // daemon-direct 'back online' ping in its user chat, even in day mode. Suppress, don't leak.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-04T12:00:00Z'));
    try {
      const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const api = { sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage };

      ap.setTelegramHandle(api as any, '12345'); // conversational chat only, no status chat
      await ap.start();

      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses daemon-direct back-online Telegram in NIGHT mode (boot-TG day/night gate)', async () => {
    // Night-mode silent boot: the day/night gate must suppress the codex
    // daemon-direct ping too, so it is not the one path that still wakes the
    // user at night. 03:00 UTC → detectDayNightMode('UTC') = night.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-04T03:00:00Z'));
    try {
      const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const api = { sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage };

      ap.setTelegramHandle(api as any, '12345');
      await ap.start();

      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips back-online Telegram on handoff restart (issue #392)', async () => {
    // Simulate handoff doc marker present at .handoff-doc-path so
    // consumeHandoffBlock() returns a non-empty fragment, marking the spawn
    // as a handoff restart that should suppress the daemon-direct ping.
    // existsSync must return true for BOTH the marker file and the doc path
    // it points at — consumeHandoffBlock checks both.
    const handoffDocPath = '/tmp/handoff-doc.md';
    fsMocks.existsSync.mockImplementation((path: string) =>
      typeof path === 'string'
      && (path.endsWith('.handoff-doc-path') || path === handoffDocPath),
    );
    fsMocks.readFileSync.mockReturnValue(handoffDocPath);

    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    const prompt = mockCodexAppServerPty.spawn.mock.calls[0]?.[1] ?? '';
    expect(prompt).toContain('CONTEXT HANDOFF');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not send daemon-direct back-online Telegram for claude-code runtime (issue #392)', async () => {
    // claude-code already executes the inline "Send a Telegram message..."
    // bootstrap instruction itself, so the daemon must not double up.
    const ap = new AgentProcess('claude-agent', mockEnv, { runtime: 'claude-code' });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const api = { sendChatAction: vi.fn().mockResolvedValue(undefined), sendMessage };

    ap.setTelegramHandle(api as any, '12345');
    await ap.start();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('uses direct kill path on stop, not Claude /exit choreography', async () => {
    const ap = new AgentProcess('codex-app-agent', mockEnv, { runtime: 'codex-app-server' });
    await ap.start();
    expect(capturedOnExit).not.toBeNull();

    const stopPromise = ap.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const writes = mockCodexAppServerPty.write.mock.calls.map((call: string[]) => call[0]);
    expect(writes).not.toContain('\x03');
    expect(writes).not.toContain('/exit\r\n');

    capturedOnExit!(0, 0);
    await stopPromise;
    expect(mockCodexAppServerPty.kill).toHaveBeenCalled();
  }, 10000);
});

