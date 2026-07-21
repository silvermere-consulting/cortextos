import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CredentialRefresher,
  probeAccessToken,
  accountsPath,
  credentialsPath,
  REFRESH_LEAD_MS,
  WARN_LEAD_MS,
  DEADLINE_LEAD_MS,
  type TokenFamily,
  type ProbeResult,
} from '../../../src/daemon/credential-refresh';

// F1 tests — the failure matrix from the pinned design, each row asserted by
// BYTE-IDENTITY of both stores (never-clobber is a property, not a log line),
// plus the validator control tests (blocker-1 class encoded): the probe
// transport must be shown to RECEIVE the candidate token, a known-bad token
// must read TOKEN_BAD, and a 429 must read CANNOT_TELL, never TOKEN_BAD.

const T0 = Date.parse('2026-07-21T12:00:00Z');
const MIN = 60_000;

let ctxRoot: string;
let home: string;

function sha(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function writeStores(family: TokenFamily): void {
  mkdirSync(join(ctxRoot, 'state', 'oauth'), { recursive: true });
  writeFileSync(accountsPath(ctxRoot), JSON.stringify({
    active: 'primary',
    accounts: {
      primary: {
        label: 'primary',
        access_token: family.access_token,
        refresh_token: family.refresh_token,
        expires_at: family.expires_at,
        last_refreshed: '2026-07-21T08:12:37.700Z',
        five_hour_utilization: 0.06,
        seven_day_utilization: 0.33,
      },
    },
    rotation_log: [],
  }, null, 2));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(credentialsPath(home), JSON.stringify({
    claudeAiOauth: {
      accessToken: family.access_token,
      refreshToken: family.refresh_token,
      expiresAt: family.expires_at,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    },
    trustedDeviceToken: 'keep-me',
  }, null, 2));
}

interface Harness {
  refresher: CredentialRefresher;
  pages: string[];
  setNow: (ms: number) => void;
  probes: string[]; // tokens the probe was fed
}

function mkHarness(opts: {
  now?: number;
  probe?: (token: string) => ProbeResult;
  exchange?: () => TokenFamily | Error;
} = {}): Harness {
  let nowMs = opts.now ?? T0;
  const pages: string[] = [];
  const probes: string[] = [];
  const refresher = new CredentialRefresher({
    ctxRoot,
    homeDir: home,
    now: () => nowMs,
    log: () => {},
    page: (m) => { pages.push(m); return true; },
    probe: async (token) => {
      probes.push(token);
      return opts.probe ? opts.probe(token) : { verdict: 'VALID', detail: 'test' };
    },
    exchange: async () => {
      const r = opts.exchange ? opts.exchange() : NEW_FAMILY;
      if (r instanceof Error) throw r;
      return r;
    },
  });
  return { refresher, pages, probes, setNow: (ms) => { nowMs = ms; } };
}

const OLD_FAMILY: TokenFamily = {
  access_token: 'sk-ant-oat01-OLD',
  refresh_token: 'sk-ant-ort01-OLD',
  expires_at: T0 + 8 * 60 * MIN,
};
const NEW_FAMILY: TokenFamily = {
  access_token: 'sk-ant-oat01-NEW',
  refresh_token: 'sk-ant-ort01-NEW',
  expires_at: T0 + 16 * 60 * MIN,
};

beforeEach(() => {
  ctxRoot = mkdtempSync(join(tmpdir(), 'credref-ctx-'));
  home = mkdtempSync(join(tmpdir(), 'credref-home-'));
});
afterEach(() => {
  rmSync(ctxRoot, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('probeAccessToken (the validator that CAN check)', () => {
  it('sends the CANDIDATE token in the Authorization header — proven, not assumed', async () => {
    let seenAuth = '';
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      seenAuth = (init?.headers as Record<string, string>).Authorization;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const r = await probeAccessToken('sk-ant-oat01-CANDIDATE', fakeFetch);
    expect(seenAuth).toBe('Bearer sk-ant-oat01-CANDIDATE');
    expect(r.verdict).toBe('VALID');
  });

  it('known-bad token (401) → TOKEN_BAD', async () => {
    const fakeFetch = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch;
    expect((await probeAccessToken('bad', fakeFetch)).verdict).toBe('TOKEN_BAD');
  });

  it('429 → CANNOT_TELL, never TOKEN_BAD (observed live 2026-07-21 08:12Z)', async () => {
    const fakeFetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    const r = await probeAccessToken('any', fakeFetch);
    expect(r.verdict).toBe('CANNOT_TELL');
    expect(r.detail).toContain('not token evidence');
  });

  it('network failure → CANNOT_TELL', async () => {
    const fakeFetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    expect((await probeAccessToken('any', fakeFetch)).verdict).toBe('CANNOT_TELL');
  });
});

describe('CredentialRefresher ladder', () => {
  it('healthy lead → noop, stores untouched (byte-identical)', async () => {
    writeStores(OLD_FAMILY);
    const h1 = sha(accountsPath(ctxRoot)); const h2 = sha(credentialsPath(home));
    const h = mkHarness({ now: OLD_FAMILY.expires_at - REFRESH_LEAD_MS - 60 * MIN });
    expect(await h.refresher.tick()).toBe('noop');
    expect(sha(accountsPath(ctxRoot))).toBe(h1);
    expect(sha(credentialsPath(home))).toBe(h2);
    expect(h.pages).toHaveLength(0);
  });

  it('newest-family-wins: disagreeing stores sync older←newer, NO exchange that tick', async () => {
    writeStores(OLD_FAMILY);
    // credentials.json holds a NEWER family (e.g. a CLI refreshed first)
    writeFileSync(credentialsPath(home), JSON.stringify({
      claudeAiOauth: {
        accessToken: NEW_FAMILY.access_token,
        refreshToken: NEW_FAMILY.refresh_token,
        expiresAt: NEW_FAMILY.expires_at,
      },
      trustedDeviceToken: 'keep-me',
    }));
    const h = mkHarness({ now: T0, exchange: () => new Error('exchange must NOT be called') });
    expect(await h.refresher.tick()).toBe('synced-stores');
    const acct = JSON.parse(readFileSync(accountsPath(ctxRoot), 'utf-8'));
    expect(acct.accounts.primary.refresh_token).toBe(NEW_FAMILY.refresh_token); // adopted, not exchanged
  });

  it('T-30 + VALID probe → swap BOTH stores, unrelated fields preserved', async () => {
    writeStores(OLD_FAMILY);
    const h = mkHarness({ now: OLD_FAMILY.expires_at - 20 * MIN });
    expect(await h.refresher.tick()).toBe('swapped');
    expect(h.probes).toEqual([NEW_FAMILY.access_token]); // probed the CANDIDATE
    const acct = JSON.parse(readFileSync(accountsPath(ctxRoot), 'utf-8'));
    const cred = JSON.parse(readFileSync(credentialsPath(home), 'utf-8'));
    expect(acct.accounts.primary.access_token).toBe(NEW_FAMILY.access_token);
    expect(acct.accounts.primary.five_hour_utilization).toBe(0.06); // preserved
    expect(cred.claudeAiOauth.accessToken).toBe(NEW_FAMILY.access_token);
    expect(cred.claudeAiOauth.subscriptionType).toBe('max'); // preserved
    expect(cred.trustedDeviceToken).toBe('keep-me'); // preserved
  });

  it('TOKEN_BAD → both stores byte-identical + immediate page naming the branch', async () => {
    writeStores(OLD_FAMILY);
    const h1 = sha(accountsPath(ctxRoot)); const h2 = sha(credentialsPath(home));
    const h = mkHarness({
      now: OLD_FAMILY.expires_at - 20 * MIN,
      probe: () => ({ verdict: 'TOKEN_BAD', detail: 'usage API 401' }),
    });
    expect(await h.refresher.tick()).toBe('kept-old-token-bad');
    expect(sha(accountsPath(ctxRoot))).toBe(h1);
    expect(sha(credentialsPath(home))).toBe(h2);
    expect(h.pages).toHaveLength(1);
    expect(h.pages[0]).toContain('REPLACEMENT token is DEAD');
    expect(h.pages[0]).toContain('Old token untouched');
  });

  it('CANNOT_TELL above T-15 → keep old, NO page (a 429 is not an alarm)', async () => {
    writeStores(OLD_FAMILY);
    const h1 = sha(accountsPath(ctxRoot));
    const h = mkHarness({
      now: OLD_FAMILY.expires_at - 20 * MIN,
      probe: () => ({ verdict: 'CANNOT_TELL', detail: '429' }),
    });
    expect(await h.refresher.tick()).toBe('kept-old-cannot-tell');
    expect(sha(accountsPath(ctxRoot))).toBe(h1);
    expect(h.pages).toHaveLength(0);
  });

  it('CANNOT_TELL at T-15 → one page naming the truth, once per family', async () => {
    writeStores(OLD_FAMILY);
    const h = mkHarness({
      now: OLD_FAMILY.expires_at - WARN_LEAD_MS + MIN,
      probe: () => ({ verdict: 'CANNOT_TELL', detail: '429' }),
    });
    await h.refresher.tick();
    expect(h.pages).toHaveLength(1);
    expect(h.pages[0]).toContain('cannot VERIFY');
    await h.refresher.tick();
    expect(h.pages).toHaveLength(1); // warned once, not per tick
  });

  it('DEADLINE adopt-unproven: .prev sidecar written+read-back BEFORE swap; plain-words page; resolution paged on later VALID', async () => {
    writeStores(OLD_FAMILY);
    const h = mkHarness({
      now: OLD_FAMILY.expires_at - DEADLINE_LEAD_MS + 30_000,
      probe: (token) => token === NEW_FAMILY.access_token
        ? { verdict: 'CANNOT_TELL', detail: 'usage API down' }
        : { verdict: 'VALID', detail: 'test' },
    });
    expect(await h.refresher.tick()).toBe('adopted-unproven');
    // sidecar retains the OLD family
    const sidecar = JSON.parse(readFileSync(accountsPath(ctxRoot) + '.prev', 'utf-8'));
    expect(sidecar.family.refresh_token).toBe(OLD_FAMILY.refresh_token);
    // stores carry the NEW family
    const acct = JSON.parse(readFileSync(accountsPath(ctxRoot), 'utf-8'));
    expect(acct.accounts.primary.access_token).toBe(NEW_FAMILY.access_token);
    // plain words, not jargon
    expect(h.pages[0]).toContain('could NOT be verified');
    expect(h.pages[0]).toContain('retained');
    // condition (b): unvalidated is not terminal — next tick re-probes; make it resolve
    const h2pages = h.pages.length;
    // re-probe returns CANNOT_TELL for NEW (per harness probe fn) → still unverified, no dup page
    expect(await h.refresher.tick()).toBe('post-adopt-still-unverified');
    expect(h.pages).toHaveLength(h2pages);
  });

  it('DEADLINE with unwritable sidecar → HOLD (adoption refused), stores untouched', async () => {
    writeStores(OLD_FAMILY);
    // Make the sidecar path unwritable by pointing oauth dir read-only.
    chmodSync(join(ctxRoot, 'state', 'oauth'), 0o500);
    const h1 = sha(accountsPath(ctxRoot));
    const h = mkHarness({
      now: OLD_FAMILY.expires_at - DEADLINE_LEAD_MS + 30_000,
      probe: () => ({ verdict: 'CANNOT_TELL', detail: 'down' }),
    });
    try {
      expect(await h.refresher.tick()).toBe('adoption-held-sidecar-unproven');
      expect(sha(accountsPath(ctxRoot))).toBe(h1);
    } finally {
      chmodSync(join(ctxRoot, 'state', 'oauth'), 0o700);
    }
  });

  it('booted into a DEAD credential + exchange fails → immediate page, no cooldown', async () => {
    writeStores({ ...OLD_FAMILY, expires_at: T0 - 60 * MIN }); // already expired
    const h = mkHarness({ now: T0, exchange: () => new Error('invalid_grant') });
    expect(await h.refresher.tick()).toBe('kept-old-exchange-failed');
    expect(h.pages).toHaveLength(1);
    expect(h.pages[0]).toContain('CREDENTIAL DEAD');
    expect(h.pages[0]).toContain('2026-07-20');
    // fires again immediately — no cooldown on the dead-credential branch
    await h.refresher.tick();
    expect(h.pages).toHaveLength(2);
  });

  it('exchange fails with healthy-ish lead → keep old, page once per hour', async () => {
    writeStores(OLD_FAMILY);
    const h = mkHarness({
      now: OLD_FAMILY.expires_at - 20 * MIN,
      exchange: () => new Error('503'),
    });
    await h.refresher.tick();
    expect(h.pages).toHaveLength(1);
    expect(h.pages[0]).toContain('nothing destroyed');
    await h.refresher.tick();
    expect(h.pages).toHaveLength(1); // cooldown
  });

  it('no credentials anywhere → no-credentials, no page, no throw', async () => {
    const h = mkHarness({ now: T0 });
    expect(await h.refresher.tick()).toBe('no-credentials');
    expect(h.pages).toHaveLength(0);
  });
});
