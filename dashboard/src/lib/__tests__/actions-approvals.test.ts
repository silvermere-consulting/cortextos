import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The action under test glues four moving parts together:
//   1. Input validation (id shape, decision, note length)
//   2. getApprovalById   (data layer; tells us whether it's a Foundry-bridged kind)
//   3. issueFoundryToken / rejectFoundryApproval  (bridge — the new G3 surface)
//   4. spawnSync('bash bus/update-approval.sh ...) (cortextos write-side)
//   5. revalidatePath + syncAll                   (Next.js cache + dashboard sync)
//
// We mock 2–5 at the module boundary, then exercise the action and assert that:
//   - Foundry call ordering is BEFORE the bash spawn (any Foundry failure must NOT
//     resolve the cortextos record)
//   - The minted JWT is woven into the resolution note in the documented shape
//     (foundry_token=<jwt>\nfoundry_token_expires_at=<iso>\nfoundry_jti=<jti>)
//   - When the user passes a note, it is preserved as a prefix on the woven blob
//   - A pure-cortextos approval (no metadata.foundry_approval_id) skips the bridge
//   - A Foundry failure short-circuits with success:false and never spawns bash
//   - revalidatePath('/approvals') and revalidatePath('/') fire on success

const issueFoundryToken = vi.fn();
const rejectFoundryApproval = vi.fn();
const getApprovalById = vi.fn();
const syncAll = vi.fn();
const revalidatePath = vi.fn();
const spawnSync = vi.fn();

vi.mock('@/lib/foundry', () => ({
  issueFoundryToken: (...args: unknown[]) => issueFoundryToken(...args),
  rejectFoundryApproval: (...args: unknown[]) => rejectFoundryApproval(...args),
}));

vi.mock('@/lib/data/approvals', () => ({
  getApprovalById: (...args: unknown[]) => getApprovalById(...args),
}));

vi.mock('@/lib/sync', () => ({
  syncAll: (...args: unknown[]) => syncAll(...args),
}));

vi.mock('@/lib/config', () => ({
  getFrameworkRoot: () => '/tmp/fake-framework-root',
  getCTXRoot: () => '/tmp/fake-ctx-root',
}));

vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args),
}));

vi.mock('child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSync(...args),
}));

// Import AFTER mocks so module resolution picks up the stubs
let resolveApproval: typeof import('../actions/approvals').resolveApproval;

beforeEach(async () => {
  vi.clearAllMocks();
  spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  syncAll.mockReturnValue(undefined);

  // Re-import the SUT after mocks reset so the action re-binds to fresh mock fns
  vi.resetModules();
  const mod = await import('../actions/approvals');
  resolveApproval = mod.resolveApproval;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('resolveApproval — input validation', () => {
  it('rejects an empty id', async () => {
    const result = await resolveApproval('', 'approved');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid approval ID/);
  });

  it('rejects an id with disallowed characters', async () => {
    const result = await resolveApproval('approval_1 OR 1=1', 'approved');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid approval ID/);
  });

  it('rejects an unknown decision', async () => {
    const result = await resolveApproval('approval_123', 'maybe' as 'approved');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Decision must be/);
  });

  it('rejects a note longer than 1000 chars', async () => {
    const longNote = 'x'.repeat(1001);
    const result = await resolveApproval('approval_123', 'approved', longNote);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/1000 characters or fewer/);
  });

  it('accepts the exact-1000-char boundary as valid', async () => {
    getApprovalById.mockReturnValue({ id: 'approval_123', metadata: undefined });
    const note = 'x'.repeat(1000);
    const result = await resolveApproval('approval_123', 'approved', note);
    expect(result.success).toBe(true);
  });
});

describe('resolveApproval — pure cortextos path (no Foundry metadata)', () => {
  it('skips the Foundry bridge entirely when metadata is undefined', async () => {
    getApprovalById.mockReturnValue({ id: 'approval_1', metadata: undefined });

    const result = await resolveApproval('approval_1', 'approved');
    expect(result.success).toBe(true);
    expect(issueFoundryToken).not.toHaveBeenCalled();
    expect(rejectFoundryApproval).not.toHaveBeenCalled();
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it('skips the Foundry bridge when metadata has no foundry_approval_id', async () => {
    getApprovalById.mockReturnValue({
      id: 'approval_2',
      metadata: { kind: 'domain:buy', fqdn: 'x.com' }, // foundry_approval_id missing
    });

    const result = await resolveApproval('approval_2', 'approved');
    expect(result.success).toBe(true);
    expect(issueFoundryToken).not.toHaveBeenCalled();
  });

  it('skips the Foundry bridge when metadata.foundry_approval_id is an empty string', async () => {
    getApprovalById.mockReturnValue({
      id: 'approval_3',
      metadata: { foundry_approval_id: '' },
    });

    const result = await resolveApproval('approval_3', 'approved');
    expect(result.success).toBe(true);
    expect(issueFoundryToken).not.toHaveBeenCalled();
  });

  it('skips the Foundry bridge when metadata.foundry_approval_id is non-string', async () => {
    getApprovalById.mockReturnValue({
      id: 'approval_4',
      metadata: { foundry_approval_id: 123 },
    });

    const result = await resolveApproval('approval_4', 'approved');
    expect(result.success).toBe(true);
    expect(issueFoundryToken).not.toHaveBeenCalled();
  });

  it('passes the original note as the third bash arg unchanged', async () => {
    getApprovalById.mockReturnValue({ id: 'approval_5', metadata: undefined });
    await resolveApproval('approval_5', 'approved', 'looks good');
    // spawnSync(cmd, [scriptPath, ...args], opts) → [scriptPath, id, decision, note]
    const argv = spawnSync.mock.calls[0][1];
    expect(argv[0]).toMatch(/bus\/update-approval\.sh$/);
    expect(argv.slice(1)).toEqual(['approval_5', 'approved', 'looks good']);
  });
});

describe('resolveApproval — Foundry-bridged approve path', () => {
  it('calls issueFoundryToken with the foundry_approval_id from metadata, then bash', async () => {
    getApprovalById.mockReturnValue({
      id: 'approval_x',
      metadata: { foundry_approval_id: 'app_abc' },
    });
    issueFoundryToken.mockResolvedValue({
      ok: true,
      approval_id: 'app_abc',
      token: 'jwt-string',
      jti: 'jti-1',
      issued_at: '2026-06-05T18:00:00Z',
      expires_at: '2026-06-05T18:05:00Z',
    });

    const result = await resolveApproval('approval_x', 'approved');

    expect(result.success).toBe(true);
    expect(issueFoundryToken).toHaveBeenCalledWith('app_abc');
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(rejectFoundryApproval).not.toHaveBeenCalled();
  });

  it('weaves token/expires_at/jti into the bash note (no user note)', async () => {
    getApprovalById.mockReturnValue({
      id: 'approval_x',
      metadata: { foundry_approval_id: 'app_abc' },
    });
    issueFoundryToken.mockResolvedValue({
      ok: true,
      approval_id: 'app_abc',
      token: 'jwt-string',
      jti: 'jti-1',
      issued_at: '2026-06-05T18:00:00Z',
      expires_at: '2026-06-05T18:05:00Z',
    });

    await resolveApproval('approval_x', 'approved');
    // [scriptPath, id, decision, note]
    const argv = spawnSync.mock.calls[0][1];
    expect(argv[1]).toBe('approval_x');
    expect(argv[2]).toBe('approved');
    expect(argv[3]).toBe(
      'foundry_token=jwt-string\n' +
      'foundry_token_expires_at=2026-06-05T18:05:00Z\n' +
      'foundry_jti=jti-1',
    );
  });

  it('prefixes the user note before the woven foundry block', async () => {
    getApprovalById.mockReturnValue({
      id: 'approval_x',
      metadata: { foundry_approval_id: 'app_abc' },
    });
    issueFoundryToken.mockResolvedValue({
      ok: true,
      approval_id: 'app_abc',
      token: 'jwt-string',
      jti: 'jti-1',
      issued_at: '2026-06-05T18:00:00Z',
      expires_at: '2026-06-05T18:05:00Z',
    });

    await resolveApproval('approval_x', 'approved', 'looks fine to me');
    const note = spawnSync.mock.calls[0][1][3];
    expect(note).toBe(
      'looks fine to me\n' +
      'foundry_token=jwt-string\n' +
      'foundry_token_expires_at=2026-06-05T18:05:00Z\n' +
      'foundry_jti=jti-1',
    );
  });

  it('fails loudly with the Foundry error and does NOT spawn bash when issue throws', async () => {
    getApprovalById.mockReturnValue({
      id: 'approval_x',
      metadata: { foundry_approval_id: 'app_abc' },
    });
    issueFoundryToken.mockRejectedValue(new Error('foundry /v1/approvals/app_abc/issue → 409: already_resolved'));

    const result = await resolveApproval('approval_x', 'approved');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Foundry bridge:.*already_resolved/);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(syncAll).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('resolveApproval — Foundry-bridged reject path', () => {
  it('calls rejectFoundryApproval with the foundry_approval_id and the user note as reason', async () => {
    getApprovalById.mockReturnValue({
      id: 'approval_y',
      metadata: { foundry_approval_id: 'app_def' },
    });
    rejectFoundryApproval.mockResolvedValue({ ok: true, approval_id: 'app_def', status: 'rejected' });

    const result = await resolveApproval('approval_y', 'rejected', 'price too high');
    expect(result.success).toBe(true);
    expect(rejectFoundryApproval).toHaveBeenCalledWith('app_def', 'price too high');
    expect(issueFoundryToken).not.toHaveBeenCalled();
  });

  it('calls rejectFoundryApproval with undefined reason when no note', async () => {
    getApprovalById.mockReturnValue({
      id: 'approval_y',
      metadata: { foundry_approval_id: 'app_def' },
    });
    rejectFoundryApproval.mockResolvedValue({ ok: true, approval_id: 'app_def', status: 'rejected' });

    await resolveApproval('approval_y', 'rejected');
    expect(rejectFoundryApproval).toHaveBeenCalledWith('app_def', undefined);
  });

  it('does NOT weave token lines into the bash note on rejection (no token to weave)', async () => {
    getApprovalById.mockReturnValue({
      id: 'approval_y',
      metadata: { foundry_approval_id: 'app_def' },
    });
    rejectFoundryApproval.mockResolvedValue({ ok: true, approval_id: 'app_def', status: 'rejected' });

    await resolveApproval('approval_y', 'rejected', 'no');
    const note = spawnSync.mock.calls[0][1][3];
    expect(note).toBe('no');
    expect(note).not.toContain('foundry_token=');
  });

  it('fails loudly when Foundry reject throws', async () => {
    getApprovalById.mockReturnValue({
      id: 'approval_y',
      metadata: { foundry_approval_id: 'app_def' },
    });
    rejectFoundryApproval.mockRejectedValue(new Error('foundry /v1/approvals/app_def/reject → 503: upstream_down'));

    const result = await resolveApproval('approval_y', 'rejected', 'no');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Foundry bridge:.*upstream_down/);
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

describe('resolveApproval — cortextos write + revalidation', () => {
  it('returns success:false when bash exits non-zero, surfacing stderr', async () => {
    getApprovalById.mockReturnValue({ id: 'approval_z', metadata: undefined });
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'approval not found' });

    const result = await resolveApproval('approval_z', 'approved');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/approval not found/);
  });

  it('falls back to stdout when bash stderr is empty', async () => {
    getApprovalById.mockReturnValue({ id: 'approval_z', metadata: undefined });
    spawnSync.mockReturnValue({ status: 1, stdout: 'something went wrong', stderr: '' });

    const result = await resolveApproval('approval_z', 'approved');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/something went wrong/);
  });

  it('revalidates /approvals and / on success', async () => {
    getApprovalById.mockReturnValue({ id: 'approval_z', metadata: undefined });

    await resolveApproval('approval_z', 'approved');
    expect(revalidatePath).toHaveBeenCalledWith('/approvals');
    expect(revalidatePath).toHaveBeenCalledWith('/');
  });

  it('still succeeds when syncAll throws (best-effort)', async () => {
    getApprovalById.mockReturnValue({ id: 'approval_z', metadata: undefined });
    syncAll.mockImplementation(() => {
      throw new Error('sync exploded');
    });

    const result = await resolveApproval('approval_z', 'approved');
    expect(result.success).toBe(true);
  });

  it('threads CTX_FRAMEWORK_ROOT + CTX_ROOT + CTX_AGENT_NAME=dashboard into the bash env', async () => {
    getApprovalById.mockReturnValue({ id: 'approval_z', metadata: undefined });
    await resolveApproval('approval_z', 'approved');
    const env = spawnSync.mock.calls[0][2].env;
    expect(env.CTX_FRAMEWORK_ROOT).toBe('/tmp/fake-framework-root');
    expect(env.CTX_ROOT).toBe('/tmp/fake-ctx-root');
    expect(env.CTX_AGENT_NAME).toBe('dashboard');
  });
});
