import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';
import { resolvePaths, resolveCtxRoot, getIpcPath } from '../../../src/utils/paths';
import { resolveEnv } from '../../../src/utils/env';

/**
 * Regression for task_1785666893799: resolveEnv honoured CTX_ROOT while
 * resolvePaths ignored it, so a caller who set CTX_ROOT expecting isolation
 * got isolated env values but writes that landed in the live store. Both now
 * route through the shared resolveCtxRoot(); these tests pin that they agree.
 *
 * NOTE: tests/isolate-home.setup.ts sets process.env.CTX_ROOT to the isolated
 * home. Each test here saves and restores it so it controls the value directly.
 */
describe('ctxRoot resolution (resolveCtxRoot / resolvePaths / resolveEnv agreement)', () => {
  let savedCtxRoot: string | undefined;

  beforeEach(() => {
    savedCtxRoot = process.env.CTX_ROOT;
  });
  afterEach(() => {
    if (savedCtxRoot === undefined) delete process.env.CTX_ROOT;
    else process.env.CTX_ROOT = savedCtxRoot;
  });

  it('resolveCtxRoot precedence: process.env.CTX_ROOT > envFile > derived', () => {
    process.env.CTX_ROOT = '/tmp/proc-root';
    expect(resolveCtxRoot('default', '/tmp/envfile-root')).toBe('/tmp/proc-root');

    delete process.env.CTX_ROOT;
    expect(resolveCtxRoot('default', '/tmp/envfile-root')).toBe('/tmp/envfile-root');

    expect(resolveCtxRoot('inst-x')).toBe(join(homedir(), '.cortextos', 'inst-x'));
  });

  it('resolvePaths HONOURS CTX_ROOT (regression: it used to ignore it)', () => {
    process.env.CTX_ROOT = '/tmp/custom-root';
    const p = resolvePaths('agent-a', 'default', 'org-a');
    expect(p.ctxRoot).toBe('/tmp/custom-root');
    // Every derived path must sit UNDER the override — the write-to-live-store bug
    // was precisely that these landed under homedir instead.
    expect(p.stateDir).toBe('/tmp/custom-root/state/agent-a');
    expect(p.inbox).toBe('/tmp/custom-root/inbox/agent-a');
    expect(p.taskDir).toBe('/tmp/custom-root/orgs/org-a/tasks');
    expect(p.approvalDir).toBe('/tmp/custom-root/orgs/org-a/approvals');
  });

  it('resolvePaths falls back to homedir-derived when CTX_ROOT is unset (unchanged behaviour)', () => {
    delete process.env.CTX_ROOT;
    const p = resolvePaths('agent-b', 'default');
    expect(p.ctxRoot).toBe(join(homedir(), '.cortextos', 'default'));
    expect(p.stateDir).toBe(join(homedir(), '.cortextos', 'default', 'state', 'agent-b'));
  });

  it('resolveEnv and resolvePaths AGREE on ctxRoot under a CTX_ROOT override (anti-divergence)', () => {
    process.env.CTX_ROOT = '/tmp/agree-root';
    const env = resolveEnv({ agentName: 'agent-c', org: 'org-c', instanceId: 'default' });
    const paths = resolvePaths('agent-c', 'default', 'org-c');
    expect(env.ctxRoot).toBe('/tmp/agree-root');
    expect(paths.ctxRoot).toBe(env.ctxRoot); // the property the bug violated
  });

  it('resolveEnv and resolvePaths AGREE on ctxRoot with NO override (derived path)', () => {
    delete process.env.CTX_ROOT;
    const env = resolveEnv({ agentName: 'agent-d', org: 'org-d', instanceId: 'default' });
    const paths = resolvePaths('agent-d', 'default', 'org-d');
    expect(paths.ctxRoot).toBe(env.ctxRoot);
    expect(paths.ctxRoot).toBe(join(homedir(), '.cortextos', 'default'));
  });

  it('getIpcPath honours CTX_ROOT (socket follows the same ctxRoot authority)', () => {
    if (process.platform === 'win32') return; // named-pipe path is instance-based, not ctxRoot-based
    process.env.CTX_ROOT = '/tmp/sock-root';
    expect(getIpcPath('default')).toBe('/tmp/sock-root/daemon.sock');
    delete process.env.CTX_ROOT;
    expect(getIpcPath('default')).toBe(join(homedir(), '.cortextos', 'default', 'daemon.sock'));
  });
});
