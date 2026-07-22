import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveEnv, refuseMintedIdentity } from '../../../src/utils/env';

// Identity-provenance class fix (design: workspace/resolveenv-class-design-2026-07-22.md,
// chief-approved fork (b)). Three measured incidents in one day came from consumers
// treating a minted default as a fact: phantom cwd-named identities with unread
// inboxes, and empty-org writes collapsing org-scoped paths to instance root.
// The resolver marks provenance and never refuses; write chokepoints refuse.

const CLEAN_KEYS = ['CTX_AGENT_NAME', 'CTX_ORG', 'CTX_INSTANCE_ID', 'CTX_ROOT', 'CTX_FRAMEWORK_ROOT', 'CTX_PROJECT_ROOT', 'CTX_AGENT_DIR'];

describe('resolveEnv provenance', () => {
  let saved: Record<string, string | undefined>;
  let savedCwd: string;
  let scratch: string;

  beforeEach(() => {
    saved = Object.fromEntries(CLEAN_KEYS.map((k) => [k, process.env[k]]));
    for (const k of CLEAN_KEYS) delete process.env[k];
    savedCwd = process.cwd();
    scratch = mkdtempSync(join(tmpdir(), 'cortextos-prov-'));
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    process.chdir(savedCwd);
    rmSync(scratch, { recursive: true, force: true });
  });

  it('explicit env vars mark source env', () => {
    process.env.CTX_AGENT_NAME = 'engineer';
    process.env.CTX_ORG = 'acme';
    const env = resolveEnv();
    expect(env.agentNameSource).toBe('env');
    expect(env.orgSource).toBe('env');
  });

  it('overrides mark source override', () => {
    const env = resolveEnv({ agentName: 'chief', org: 'acme' });
    expect(env.agentNameSource).toBe('override');
    expect(env.orgSource).toBe('override');
  });

  it('cwd .cortextos-env is a LEGITIMATE source, distinct from minting — agent dirs deliberately carry it', () => {
    writeFileSync(join(scratch, '.cortextos-env'), 'CTX_AGENT_NAME=engineer\nCTX_ORG=acme\n');
    process.chdir(scratch);
    const env = resolveEnv();
    expect(env.agentName).toBe('engineer');
    expect(env.agentNameSource).toBe('cortextos-env');
    expect(env.orgSource).toBe('cortextos-env');
  });

  it('the exact conditions that produced the cortext phantom mark minted-cwd + absent', () => {
    // A lowercase dir name, like the real /home/cortext that minted the phantom
    // (mkdtemp suffixes can carry uppercase, which validateAgentName rejects —
    // a DIFFERENT, louder failure; the dangerous case is the plausible name).
    const bare = join(scratch, 'cortext');
    mkdirSync(bare);
    process.chdir(bare); // no env, no .cortextos-env — the bare-shell case
    const env = resolveEnv();
    expect(env.agentName).toBe('cortext');
    expect(env.agentNameSource).toBe('minted-cwd');
    expect(env.org).toBe('');
    expect(env.orgSource).toBe('absent');
  });
});

describe('refuseMintedIdentity (the write-chokepoint guard)', () => {
  const real = { agentName: 'engineer', agentNameSource: 'env', org: 'acme', orgSource: 'env' } as Parameters<typeof refuseMintedIdentity>[0];
  const minted = { agentName: 'cortext', agentNameSource: 'minted-cwd', org: '', orgSource: 'absent' } as Parameters<typeof refuseMintedIdentity>[0];
  const fileSourced = { agentName: 'engineer', agentNameSource: 'cortextos-env', org: 'acme', orgSource: 'cortextos-env' } as Parameters<typeof refuseMintedIdentity>[0];

  it('known-positive: a real identity passes every shape of the guard', () => {
    expect(refuseMintedIdentity(real, 'send-message')).toBeNull();
    expect(refuseMintedIdentity(real, 'create-task', { needsOrg: true })).toBeNull();
    expect(refuseMintedIdentity(fileSourced, 'create-task', { needsOrg: true })).toBeNull();
  });

  it('known-negative: a minted identity refuses, and the refusal names the fix', () => {
    const r = refuseMintedIdentity(minted, 'send-message');
    expect(r).toContain('REFUSED');
    expect(r).toContain('minted');
    expect(r).toContain('CTX_AGENT_NAME'); // the fix travels with the refusal
  });

  it('org-scoped writes additionally refuse an absent org — the audit-split mechanism', () => {
    const envOkNameNoOrg = { agentName: 'engineer', agentNameSource: 'env', org: '', orgSource: 'absent' } as Parameters<typeof refuseMintedIdentity>[0];
    const r = refuseMintedIdentity(envOkNameNoOrg, 'create-task', { needsOrg: true });
    expect(r).toContain('org-scoped');
    expect(r).toContain('instance root'); // names the failure it prevents
    // ...but the same env passes a non-org action (send-message inboxes are flat):
    expect(refuseMintedIdentity(envOkNameNoOrg, 'send-message')).toBeNull();
  });
});
