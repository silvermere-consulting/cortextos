import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// foundry.ts module-level state (resolvedSecret cache) means every test that
// touches secret resolution must run against a fresh import. We use dynamic
// imports + vi.resetModules() so the cache resets between scenarios.

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-test-'));
const orgsDir = path.join(tmpRoot, 'orgs', 'silvermere-tech');
fs.mkdirSync(orgsDir, { recursive: true });

function writeSecretsFile(content: string) {
  fs.writeFileSync(path.join(orgsDir, 'secrets.env'), content);
}

function removeSecretsFile() {
  const p = path.join(orgsDir, 'secrets.env');
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

async function importFreshFoundry() {
  vi.resetModules();
  return await import('../foundry');
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.CTX_FRAMEWORK_ROOT = tmpRoot;
  // Strip variables that the SUT reads so we get deterministic starts.
  delete process.env.FOUNDRY_TOKEN_SECRET;
  delete process.env.FOUNDRY_APPROVALS_URL;
  delete process.env.FOUNDRY_DASHBOARD_TENANT;
  delete process.env.FOUNDRY_DASHBOARD_APPROVER;
  removeSecretsFile();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe('getFoundryTokenSecret (env / secrets.env fallback)', () => {
  it('uses process.env.FOUNDRY_TOKEN_SECRET when present', async () => {
    process.env.FOUNDRY_TOKEN_SECRET = 'env-secret-xyz';
    writeSecretsFile('FOUNDRY_TOKEN_SECRET=file-secret-should-be-ignored');

    const f = await importFreshFoundry();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ approval_id: 'a1', token: 't', jti: 'j', issued_at: 'i', expires_at: 'e' }), { status: 200 }),
    ));
    await f.issueFoundryToken('a1');

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const authHeader = call[1].headers.Authorization as string;
    const body = authHeader.replace('Bearer ', '').split('.')[0];
    const sig = authHeader.split('.')[1];
    const expected = crypto.createHmac('sha256', 'env-secret-xyz').update(body).digest('hex');
    expect(sig).toBe(expected);
  });

  it('falls back to orgs/<tenant>/secrets.env when env var absent', async () => {
    writeSecretsFile('FOUNDRY_TOKEN_SECRET=file-secret-abc\n');

    const f = await importFreshFoundry();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ approval_id: 'a1', token: 't', jti: 'j', issued_at: 'i', expires_at: 'e' }), { status: 200 }),
    ));
    await f.issueFoundryToken('a1');

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const authHeader = call[1].headers.Authorization as string;
    const body = authHeader.replace('Bearer ', '').split('.')[0];
    const sig = authHeader.split('.')[1];
    const expected = crypto.createHmac('sha256', 'file-secret-abc').update(body).digest('hex');
    expect(sig).toBe(expected);
  });

  it('strips surrounding double-quotes from secrets.env value', async () => {
    writeSecretsFile('FOUNDRY_TOKEN_SECRET="quoted-secret"\n');

    const f = await importFreshFoundry();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ approval_id: 'a1', token: 't', jti: 'j', issued_at: 'i', expires_at: 'e' }), { status: 200 }),
    ));
    await f.issueFoundryToken('a1');

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const sig = (call[1].headers.Authorization as string).split('.')[1];
    const body = (call[1].headers.Authorization as string).replace('Bearer ', '').split('.')[0];
    expect(sig).toBe(crypto.createHmac('sha256', 'quoted-secret').update(body).digest('hex'));
  });

  it('strips surrounding single-quotes from secrets.env value', async () => {
    writeSecretsFile("FOUNDRY_TOKEN_SECRET='single-quoted'\n");

    const f = await importFreshFoundry();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ approval_id: 'a1', token: 't', jti: 'j', issued_at: 'i', expires_at: 'e' }), { status: 200 }),
    ));
    await f.issueFoundryToken('a1');

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const sig = (call[1].headers.Authorization as string).split('.')[1];
    const body = (call[1].headers.Authorization as string).replace('Bearer ', '').split('.')[0];
    expect(sig).toBe(crypto.createHmac('sha256', 'single-quoted').update(body).digest('hex'));
  });

  it('skips comment lines and blank lines when reading secrets.env', async () => {
    writeSecretsFile(
      '# this is a comment\n' +
      '\n' +
      'OTHER_KEY=other-value\n' +
      'FOUNDRY_TOKEN_SECRET=real-secret\n' +
      '# trailing comment\n',
    );

    const f = await importFreshFoundry();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ approval_id: 'a1', token: 't', jti: 'j', issued_at: 'i', expires_at: 'e' }), { status: 200 }),
    ));
    await f.issueFoundryToken('a1');

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const sig = (call[1].headers.Authorization as string).split('.')[1];
    const body = (call[1].headers.Authorization as string).replace('Bearer ', '').split('.')[0];
    expect(sig).toBe(crypto.createHmac('sha256', 'real-secret').update(body).digest('hex'));
  });

  it('throws a clear error when neither env var nor secrets.env provides the secret', async () => {
    // No env var, no file
    const f = await importFreshFoundry();
    await expect(f.issueFoundryToken('a1')).rejects.toThrow(/FOUNDRY_TOKEN_SECRET not set/);
  });

  it('throws when secrets.env exists but does not define FOUNDRY_TOKEN_SECRET', async () => {
    writeSecretsFile('UNRELATED_KEY=something-else\n');
    const f = await importFreshFoundry();
    await expect(f.issueFoundryToken('a1')).rejects.toThrow(/FOUNDRY_TOKEN_SECRET not set/);
  });

  it('caches a successfully-resolved secret across calls (single file read)', async () => {
    writeSecretsFile('FOUNDRY_TOKEN_SECRET=cached-secret\n');

    const f = await importFreshFoundry();
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ approval_id: 'a1', token: 't', jti: 'j', issued_at: 'i', expires_at: 'e' }), { status: 200 }),
    ));
    vi.stubGlobal('fetch', fetchMock);

    await f.issueFoundryToken('a1');
    // Mutate the file — cached value should still be used
    writeSecretsFile('FOUNDRY_TOKEN_SECRET=different-secret\n');
    await f.issueFoundryToken('a2');

    const sig1 = (fetchMock.mock.calls[0][1].headers.Authorization as string).split('.')[1];
    const sig2 = (fetchMock.mock.calls[1][1].headers.Authorization as string).split('.')[1];
    const body1 = (fetchMock.mock.calls[0][1].headers.Authorization as string).replace('Bearer ', '').split('.')[0];
    const body2 = (fetchMock.mock.calls[1][1].headers.Authorization as string).replace('Bearer ', '').split('.')[0];
    // Both signed with the same (original) secret
    expect(sig1).toBe(crypto.createHmac('sha256', 'cached-secret').update(body1).digest('hex'));
    expect(sig2).toBe(crypto.createHmac('sha256', 'cached-secret').update(body2).digest('hex'));
  });

  it('caches the null result so missing-secret throws on every subsequent call without re-reading disk', async () => {
    const f = await importFreshFoundry();
    await expect(f.issueFoundryToken('a1')).rejects.toThrow(/FOUNDRY_TOKEN_SECRET not set/);
    // Now write a valid secret — should NOT be picked up due to negative cache
    writeSecretsFile('FOUNDRY_TOKEN_SECRET=now-present\n');
    await expect(f.issueFoundryToken('a2')).rejects.toThrow(/FOUNDRY_TOKEN_SECRET not set/);
  });

  it('process.env wins even after a successful file resolution', async () => {
    writeSecretsFile('FOUNDRY_TOKEN_SECRET=file-secret\n');
    const f = await importFreshFoundry();
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ approval_id: 'a1', token: 't', jti: 'j', issued_at: 'i', expires_at: 'e' }), { status: 200 }),
    ));
    vi.stubGlobal('fetch', fetchMock);

    // First call: file
    await f.issueFoundryToken('a1');
    // Now set env var; subsequent calls must prefer env over cached file value
    process.env.FOUNDRY_TOKEN_SECRET = 'env-secret-overrides';
    await f.issueFoundryToken('a2');

    const body2 = (fetchMock.mock.calls[1][1].headers.Authorization as string).replace('Bearer ', '').split('.')[0];
    const sig2 = (fetchMock.mock.calls[1][1].headers.Authorization as string).split('.')[1];
    expect(sig2).toBe(crypto.createHmac('sha256', 'env-secret-overrides').update(body2).digest('hex'));
  });
});

describe('mintDashboardToken (envelope shape + HMAC determinism)', () => {
  it('produces a token of the form <base64url-body>.<hex-sig>', async () => {
    process.env.FOUNDRY_TOKEN_SECRET = 'test-secret';
    const f = await importFreshFoundry();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ approval_id: 'a1', token: 't', jti: 'j', issued_at: 'i', expires_at: 'e' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await f.issueFoundryToken('a1');

    const auth = fetchMock.mock.calls[0][1].headers.Authorization as string;
    expect(auth.startsWith('Bearer ')).toBe(true);
    const token = auth.replace('Bearer ', '');
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    // base64url body (no padding, only [A-Za-z0-9_-])
    expect(parts[0]).toMatch(/^[A-Za-z0-9_-]+$/);
    // hex signature, 64 chars (sha256)
    expect(parts[1]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('envelope carries caller_id, caller_class, tenant_id, issued_at, expires_at', async () => {
    process.env.FOUNDRY_TOKEN_SECRET = 'test-secret';
    process.env.FOUNDRY_DASHBOARD_TENANT = 'custom-tenant';
    const f = await importFreshFoundry();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ approval_id: 'a1', token: 't', jti: 'j', issued_at: 'i', expires_at: 'e' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await f.issueFoundryToken('a1');

    const body = (fetchMock.mock.calls[0][1].headers.Authorization as string).replace('Bearer ', '').split('.')[0];
    const envelope = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
    expect(envelope.caller_id).toBe('dashboard');
    expect(envelope.caller_class).toBe('internal_agent');
    expect(envelope.tenant_id).toBe('custom-tenant');
    expect(typeof envelope.issued_at).toBe('string');
    expect(typeof envelope.expires_at).toBe('string');
    // 60-second TTL by default
    const ttlMs = new Date(envelope.expires_at).getTime() - new Date(envelope.issued_at).getTime();
    expect(ttlMs).toBe(60_000);
  });

  it('default tenant is silvermere-tech when env var unset', async () => {
    process.env.FOUNDRY_TOKEN_SECRET = 'test-secret';
    const f = await importFreshFoundry();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ approval_id: 'a1', token: 't', jti: 'j', issued_at: 'i', expires_at: 'e' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await f.issueFoundryToken('a1');

    const body = (fetchMock.mock.calls[0][1].headers.Authorization as string).replace('Bearer ', '').split('.')[0];
    const envelope = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
    expect(envelope.tenant_id).toBe('silvermere-tech');
  });
});

describe('issueFoundryToken (happy path + error shapes)', () => {
  it('POSTs to /v1/approvals/:id/issue with default approver and returns the parsed result', async () => {
    process.env.FOUNDRY_TOKEN_SECRET = 'test-secret';
    const f = await importFreshFoundry();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        approval_id: 'app_abc',
        token: 'jwt-token-string',
        jti: 'jti-uuid',
        issued_at: '2026-06-05T18:00:00Z',
        expires_at: '2026-06-05T18:05:00Z',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await f.issueFoundryToken('app_abc');
    expect(result.ok).toBe(true);
    expect(result.approval_id).toBe('app_abc');
    expect(result.token).toBe('jwt-token-string');
    expect(result.jti).toBe('jti-uuid');
    expect(result.issued_at).toBe('2026-06-05T18:00:00Z');
    expect(result.expires_at).toBe('2026-06-05T18:05:00Z');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:7113/v1/approvals/app_abc/issue');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ approver: 'human:steven' });
  });

  it('forwards a custom approver argument in the POST body', async () => {
    process.env.FOUNDRY_TOKEN_SECRET = 'test-secret';
    const f = await importFreshFoundry();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ approval_id: 'a1', token: 't', jti: 'j', issued_at: 'i', expires_at: 'e' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await f.issueFoundryToken('a1', 'human:alice');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ approver: 'human:alice' });
  });

  it('honours FOUNDRY_APPROVALS_URL when set', async () => {
    process.env.FOUNDRY_TOKEN_SECRET = 'test-secret';
    process.env.FOUNDRY_APPROVALS_URL = 'https://foundry.example.com:9443';
    const f = await importFreshFoundry();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ approval_id: 'a1', token: 't', jti: 'j', issued_at: 'i', expires_at: 'e' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await f.issueFoundryToken('a1');
    expect(fetchMock.mock.calls[0][0]).toBe('https://foundry.example.com:9443/v1/approvals/a1/issue');
  });

  it('throws with status + body when Foundry returns non-2xx with a JSON error', async () => {
    process.env.FOUNDRY_TOKEN_SECRET = 'test-secret';
    const f = await importFreshFoundry();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'approval already resolved' }), { status: 409 }),
    ));

    await expect(f.issueFoundryToken('a1')).rejects.toThrow(/409.*approval already resolved/);
  });

  it('throws with status_<code> when Foundry returns non-2xx without an error field', async () => {
    process.env.FOUNDRY_TOKEN_SECRET = 'test-secret';
    const f = await importFreshFoundry();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 500 }),
    ));

    await expect(f.issueFoundryToken('a1')).rejects.toThrow(/500.*status_500/);
  });

  it('throws a non-JSON error when Foundry returns malformed JSON', async () => {
    process.env.FOUNDRY_TOKEN_SECRET = 'test-secret';
    const f = await importFreshFoundry();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('<html>nginx 502</html>', { status: 502 }),
    ));

    await expect(f.issueFoundryToken('a1')).rejects.toThrow(/non-JSON.*502.*nginx/);
  });

  it('treats an empty 200 body as parsed {} (no throw — Foundry contract bug surface)', async () => {
    process.env.FOUNDRY_TOKEN_SECRET = 'test-secret';
    const f = await importFreshFoundry();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));

    // Resolves but result fields are undefined casts — the caller (resolveApproval)
    // weaves them into the resolution note as `foundry_token=undefined`. That's a
    // subtle bug surface, intentionally surfaced here so future tightening (require
    // result.token) is anchored to a test rather than a hidden contract assumption.
    const result = await f.issueFoundryToken('a1');
    expect(result.ok).toBe(true);
    expect(result.token).toBeUndefined();
  });

  it('propagates network failures from fetch', async () => {
    process.env.FOUNDRY_TOKEN_SECRET = 'test-secret';
    const f = await importFreshFoundry();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    await expect(f.issueFoundryToken('a1')).rejects.toThrow(/fetch failed/);
  });
});

describe('rejectFoundryApproval (happy path + body shape)', () => {
  it('POSTs to /v1/approvals/:id/reject with approver + reason', async () => {
    process.env.FOUNDRY_TOKEN_SECRET = 'test-secret';
    const f = await importFreshFoundry();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ approval_id: 'a1', status: 'rejected' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await f.rejectFoundryApproval('a1', 'price too high');
    expect(result.ok).toBe(true);
    expect(result.approval_id).toBe('a1');
    expect(result.status).toBe('rejected');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:7113/v1/approvals/a1/reject');
    expect(JSON.parse(init.body)).toEqual({ approver: 'human:steven', reason: 'price too high' });
  });

  it('substitutes an empty-string reason when none provided', async () => {
    process.env.FOUNDRY_TOKEN_SECRET = 'test-secret';
    const f = await importFreshFoundry();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ approval_id: 'a1', status: 'rejected' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await f.rejectFoundryApproval('a1', undefined);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      approver: 'human:steven',
      reason: '',
    });
  });

  it('throws on Foundry non-2xx', async () => {
    process.env.FOUNDRY_TOKEN_SECRET = 'test-secret';
    const f = await importFreshFoundry();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'not found' }), { status: 404 }),
    ));

    await expect(f.rejectFoundryApproval('missing_id', 'reason')).rejects.toThrow(/404.*not found/);
  });
});
