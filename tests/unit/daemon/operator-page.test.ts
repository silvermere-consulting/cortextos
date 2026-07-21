import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getOperatorChatCreds,
  pageOperator,
  validateOperatorChat,
  type PageTransport,
  type ValidationTransport,
} from '../../../src/daemon/operator-page';

// The operator page is the fleet's ONLY alert path with no Claude turn in it
// (2026-07-21, the 8h outage). Its success verdict must be Telegram's
// {"ok":true}, never curl's exit code — curl exits 0 on HTTP 4xx, so the old
// check reported "sent" forever on a bad chat_id or revoked token: a
// check-that-cannot-fail in the one alarm that must never be one.

let frameworkRoot: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  frameworkRoot = mkdtempSync(join(tmpdir(), 'op-page-'));
  for (const k of ['CTX_OPERATOR_CHAT_ID', 'CTX_OPERATOR_BOT_TOKEN']) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  rmSync(frameworkRoot, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function writeAgentEnv(org: string, agent: string, content: string): void {
  const dir = join(frameworkRoot, 'orgs', org, 'agents', agent);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.env'), content);
}

describe('getOperatorChatCreds', () => {
  it('prefers explicit CTX_OPERATOR_* env over agent .env', () => {
    process.env.CTX_OPERATOR_CHAT_ID = '111';
    process.env.CTX_OPERATOR_BOT_TOKEN = '123:abcDEF_-xyz';
    writeAgentEnv('o', 'a', 'BOT_TOKEN=999:other\nCHAT_ID=222\n');
    expect(getOperatorChatCreds(frameworkRoot)).toEqual({ chatId: '111', botToken: '123:abcDEF_-xyz', source: 'env' });
  });

  it('falls back to the first agent .env with BOT_TOKEN + CHAT_ID', () => {
    writeAgentEnv('o', 'a', 'BOT_TOKEN=123:abcDEF\nCHAT_ID=42\n');
    expect(getOperatorChatCreds(frameworkRoot)).toEqual({ chatId: '42', botToken: '123:abcDEF', source: 'fallback' });
  });

  it('rejects malformed bot tokens; returns null when nothing resolves', () => {
    writeAgentEnv('o', 'a', 'BOT_TOKEN=not-a-token\nCHAT_ID=42\n');
    expect(getOperatorChatCreds(frameworkRoot)).toBeNull();
  });
});

describe('pageOperator', () => {
  const creds = () => writeAgentEnv('o', 'a', 'BOT_TOKEN=123:abc\nCHAT_ID=42\n');

  it('returns true ONLY on transport-confirmed delivery', () => {
    creds();
    const ok: PageTransport = () => ({ delivered: true, detail: 'telegram ok:true' });
    expect(pageOperator(frameworkRoot, 'msg', 'test', { transport: ok, log: () => {} })).toBe(true);
  });

  it('returns false when Telegram refuses, even though the transport ran cleanly (the curl-exit-0 trap)', () => {
    creds();
    const refused: PageTransport = () => ({ delivered: false, detail: 'telegram refused: {"ok":false,"error_code":400}' });
    const logs: string[] = [];
    expect(pageOperator(frameworkRoot, 'msg', 'test', { transport: refused, log: (m) => logs.push(m) })).toBe(false);
    expect(logs.join('\n')).toContain('NOT delivered');
  });

  it('returns false with a loud log when no creds resolve', () => {
    const logs: string[] = [];
    const never: PageTransport = () => { throw new Error('must not be called'); };
    expect(pageOperator(frameworkRoot, 'msg', 'test', { transport: never, log: (m) => logs.push(m) })).toBe(false);
    expect(logs.join('\n')).toContain('no operator chat configured');
  });

  it('never throws: a throwing transport degrades to false', () => {
    creds();
    const boom: PageTransport = () => { throw new Error('network down'); };
    expect(pageOperator(frameworkRoot, 'msg', 'test', { transport: boom, log: () => {} })).toBe(false);
  });

  // 2026-07-20: 24 rung-3 pages targeted a non-operator chat via the fallback
  // walk. A NEW alert capability shipped before the env config would have
  // multiplied them. requireExplicit makes that state inert-and-loud: the
  // transport must never even be invoked on fallback-resolved creds.
  it('requireExplicit: refuses fallback-resolved creds WITHOUT invoking the transport', () => {
    creds(); // fallback only
    let transportCalls = 0;
    const counting: PageTransport = () => { transportCalls++; return { delivered: true, detail: 'ok' }; };
    const logs: string[] = [];
    const sent = pageOperator(frameworkRoot, 'msg', 'test', { transport: counting, requireExplicit: true, log: (m) => logs.push(m) });
    expect(sent).toBe(false);
    expect(transportCalls).toBe(0);
    expect(logs.join('\n')).toContain('REFUSING to page');
  });

  it('requireExplicit: env-resolved creds still send', () => {
    process.env.CTX_OPERATOR_CHAT_ID = '8704100535';
    process.env.CTX_OPERATOR_BOT_TOKEN = '123:abc';
    const ok: PageTransport = () => ({ delivered: true, detail: 'telegram ok:true' });
    expect(pageOperator(frameworkRoot, 'msg', 'test', { transport: ok, requireExplicit: true, log: () => {} })).toBe(true);
  });
});

describe('validateOperatorChat (boot self-test)', () => {
  const creds = () => writeAgentEnv('o', 'a', 'BOT_TOKEN=123:abc\nCHAT_ID=42\n');

  it('ok when getMe and getChat both return ok:true', () => {
    creds();
    const t: ValidationTransport = () => ({ status: 0, body: '{"ok":true,"result":{}}' });
    const v = validateOperatorChat(frameworkRoot, t);
    expect(v).toMatchObject({ ok: true, failed: 'none' });
  });

  it('names getMe as the failure on an invalid token (HTTP-level failure still exits 0)', () => {
    creds();
    const t: ValidationTransport = (url) =>
      url.includes('/getMe')
        ? { status: 0, body: '{"ok":false,"error_code":401,"description":"Unauthorized"}' }
        : { status: 0, body: '{"ok":true}' };
    const v = validateOperatorChat(frameworkRoot, t);
    expect(v.ok).toBe(false);
    expect(v.failed).toBe('getMe');
    expect(v.detail).toContain('Unauthorized');
  });

  it('names getChat as the failure when the bot cannot reach the chat', () => {
    creds();
    const t: ValidationTransport = (url) =>
      url.includes('/getChat')
        ? { status: 0, body: '{"ok":false,"error_code":400,"description":"chat not found"}' }
        : { status: 0, body: '{"ok":true,"result":{}}' };
    const v = validateOperatorChat(frameworkRoot, t);
    expect(v.ok).toBe(false);
    expect(v.failed).toBe('getChat');
    expect(v.detail).toContain('chat not found');
  });

  it('reports no-creds distinctly (misconfiguration, not network)', () => {
    const t: ValidationTransport = () => { throw new Error('must not be called'); };
    const v = validateOperatorChat(frameworkRoot, t);
    expect(v.ok).toBe(false);
    expect(v.failed).toBe('no-creds');
  });

  // DELIVERABILITY IS NOT ADDRESSEE: measured 2026-07-21, the fallback chat
  // was reachable, getMe+getChat green — and the wrong human. Under
  // requireExplicit (how the daemon boot calls this), a fallback-resolved
  // chat must FAIL even though every network probe would pass.
  it('requireExplicit: fallback-resolved creds fail as not-explicit even when fully reachable', () => {
    creds(); // agent .env fallback only — no CTX_OPERATOR_* env
    const allGreen: ValidationTransport = () => ({ status: 0, body: '{"ok":true,"result":{}}' });
    const v = validateOperatorChat(frameworkRoot, allGreen, { requireExplicit: true });
    expect(v.ok).toBe(false);
    expect(v.failed).toBe('not-explicit');
    expect(v.detail).toContain('CTX_OPERATOR_CHAT_ID');
  });

  it('requireExplicit: env-resolved creds pass (the chosen chat, asserted by config)', () => {
    process.env.CTX_OPERATOR_CHAT_ID = '8704100535';
    process.env.CTX_OPERATOR_BOT_TOKEN = '123:abcDEF';
    const allGreen: ValidationTransport = () => ({ status: 0, body: '{"ok":true,"result":{}}' });
    const v = validateOperatorChat(frameworkRoot, allGreen, { requireExplicit: true });
    expect(v).toMatchObject({ ok: true, failed: 'none' });
  });

  it('creds carry their source: env vs fallback are distinguishable', () => {
    creds();
    expect(getOperatorChatCreds(frameworkRoot)?.source).toBe('fallback');
    process.env.CTX_OPERATOR_CHAT_ID = '1';
    process.env.CTX_OPERATOR_BOT_TOKEN = '123:abc';
    expect(getOperatorChatCreds(frameworkRoot)?.source).toBe('env');
  });
});
