/**
 * task_1783951648376: `bus send-message` / `bus send-telegram` broke on
 * apostrophes — agents compose single-quoted shell args, and any apostrophe
 * in the text (Hiba's, wasn't, don't) terminates the quote. Three agents hit
 * it on 2026-07-13. Double quotes are no safer: backticks and $() inside
 * them command-substitute (guardrail 129).
 *
 * The structural fix is a text path that never transits shell quoting:
 * --stdin and --text-file. These tests cover the shared resolver and the
 * CLI wiring for both commands.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveMessageText } from '../../../src/cli/message-text';

// Reuse the send-telegram mock pattern from send-telegram-normalize.test.ts.
const sendMessageSpy = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
vi.mock('../../../src/telegram/api.js', () => ({
  TelegramAPI: class {
    constructor(_token: string) {}
    sendMessage(...args: unknown[]) {
      return sendMessageSpy(...args);
    }
    sendPhoto = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
    sendDocument = vi.fn().mockResolvedValue({ result: { message_id: 1 } });
  },
}));

// CRITICAL ISOLATION: resolvePaths() IGNORES CTX_ROOT — it always resolves
// ~/.cortextos/<instance>. An earlier version of this file set CTX_ROOT to a
// temp dir, assumed isolation, and wrote a REAL message into chief's LIVE
// inbox mid-test-run (2026-07-13; delivered before cleanup — with deliberately
// hostile-looking content, because that is the class under test). Mock the
// module: every path this suite touches must live under the temp ctx root.
let mockCtxRoot = '';
vi.mock('../../../src/utils/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/paths.js')>();
  return {
    ...actual,
    resolvePaths: (agentName: string, _instanceId?: string, org?: string) => {
      const orgBase = org ? join(mockCtxRoot, 'orgs', org) : mockCtxRoot;
      return {
        ctxRoot: mockCtxRoot,
        inbox: join(mockCtxRoot, 'inbox', agentName),
        inflight: join(mockCtxRoot, 'inflight', agentName),
        processed: join(mockCtxRoot, 'processed', agentName),
        logDir: join(mockCtxRoot, 'logs', agentName),
        stateDir: join(mockCtxRoot, 'state', agentName),
        taskDir: join(orgBase, 'tasks'),
        approvalDir: join(orgBase, 'approvals'),
        analyticsDir: join(orgBase, 'analytics'),
        deliverablesDir: join(orgBase, 'deliverables'),
      };
    },
  };
});

import { busCommand } from '../../../src/cli/bus';

// The exact class of text that broke the fleet: apostrophes, double quotes,
// backticks, $() — everything shell quoting can mangle.
const HOSTILE = `Hiba's review wasn't "simple" — don't run \`rm -rf\` or $(anything)`;

describe('resolveMessageText', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'msg-text-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes positional text through verbatim', () => {
    expect(resolveMessageText('hello', {})).toBe('hello');
  });

  it('reads --text-file content verbatim, including hostile quoting', () => {
    const f = join(dir, 'msg.txt');
    writeFileSync(f, HOSTILE + '\n');
    expect(resolveMessageText(undefined, { textFile: f })).toBe(HOSTILE);
  });

  it('reads stdin (injected) verbatim, including hostile quoting', () => {
    expect(resolveMessageText(undefined, { stdin: true }, () => HOSTILE + '\n')).toBe(HOSTILE);
  });

  it('trims exactly one trailing newline (heredoc artefact), preserving interior ones', () => {
    expect(resolveMessageText(undefined, { stdin: true }, () => 'a\n\nb\n')).toBe('a\n\nb');
    expect(resolveMessageText(undefined, { stdin: true }, () => 'a\n\n')).toBe('a\n');
  });

  it('rejects --stdin combined with --text-file', () => {
    expect(() => resolveMessageText(undefined, { stdin: true, textFile: 'x' }, () => 'y'))
      .toThrow(/not both/);
  });

  it('rejects a call with no text source', () => {
    expect(() => resolveMessageText(undefined, {})).toThrow(/No message text/);
  });

  it('rejects empty stdin', () => {
    expect(() => resolveMessageText(undefined, { stdin: true }, () => '\n')).toThrow(/empty/);
  });
});

describe('CLI wiring', () => {
  let tempCtx: string;
  let tempCwd: string;
  let saved: Record<string, string | undefined>;
  let originalCwd: string;

  beforeEach(() => {
    tempCtx = mkdtempSync(join(tmpdir(), 'msg-ctx-'));
    tempCwd = mkdtempSync(join(tmpdir(), 'msg-cwd-'));
    mkdirSync(join(tempCtx, 'logs', 'test-agent'), { recursive: true });
    saved = {
      CTX_ROOT: process.env.CTX_ROOT,
      CTX_AGENT_NAME: process.env.CTX_AGENT_NAME,
      BOT_TOKEN: process.env.BOT_TOKEN,
    };
    originalCwd = process.cwd();
    mockCtxRoot = tempCtx; // point the resolvePaths mock at this test's temp root
    process.env.CTX_ROOT = tempCtx;
    process.env.CTX_AGENT_NAME = 'test-agent';
    process.env.BOT_TOKEN = 'fake-token-for-test';
    process.chdir(tempCwd);
    sendMessageSpy.mockClear();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempCtx, { recursive: true, force: true });
    rmSync(tempCwd, { recursive: true, force: true });
  });

  it('send-telegram --text-file sends hostile text verbatim', async () => {
    const f = join(tempCwd, 'reply.txt');
    writeFileSync(f, HOSTILE + '\n');

    await busCommand.parseAsync(['send-telegram', '12345', '--text-file', f], { from: 'user' });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0][1]).toBe(HOSTILE);
  });

  it('send-telegram --text-file does NOT apply the argv-only \\n normalization', async () => {
    // A literal backslash-n in a FILE is deliberate content, not a
    // shell-quoting artefact — the codex normalization must not touch it.
    const f = join(tempCwd, 'reply.txt');
    writeFileSync(f, 'literal \\n stays\n');

    await busCommand.parseAsync(['send-telegram', '12345', '--text-file', f], { from: 'user' });

    expect(sendMessageSpy.mock.calls[0][1]).toBe('literal \\n stays');
  });

  it('send-telegram positional text still gets the codex \\n normalization', async () => {
    await busCommand.parseAsync(['send-telegram', '12345', 'a\\nb'], { from: 'user' });
    expect(sendMessageSpy.mock.calls[0][1]).toBe('a\nb');
  });

  it('send-message --text-file delivers hostile text verbatim, with positional reply-to shift', async () => {
    const f = join(tempCwd, 'reply.txt');
    writeFileSync(f, HOSTILE + '\n');

    // `send-message chief normal <reply-to> --text-file f`: with a non-argv
    // text source, the lone third positional is the reply-to id.
    await busCommand.parseAsync(
      ['send-message', 'chief', 'normal', '12345-chief-abcde', '--text-file', f],
      { from: 'user' },
    );

    // sendMessage writes the inbox file under the ctx root — find it and
    // assert on the persisted artefact, not on a spy.
    const findInbox = (base: string): string[] => {
      const out: string[] = [];
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.json') && p.includes('inbox')) out.push(p);
        }
      };
      walk(base);
      return out;
    };
    const files = findInbox(tempCtx);
    expect(files.length).toBe(1);
    const msg = JSON.parse(readFileSync(files[0], 'utf-8'));
    expect(msg.text).toBe(HOSTILE);
    expect(msg.to).toBe('chief');
    expect(msg.reply_to).toBe('12345-chief-abcde');
  });
});
