/**
 * credential-refresh.ts — F1: daemon-owned proactive OAuth refresh.
 *
 * GOAL (2026-07-20 outage): the fleet's shared Claude credential must never
 * expire while the daemon lives. Expiry at ~21:20Z logged out all 8 agents
 * for 8h; ~16 clean respawns could not help because a restart cannot mint a
 * credential. Design doc (chief-reviewed, deadline fork pinned):
 * orgs/silvermere-tech/agents/engineer/workspace/f1-proactive-refresh-design.md
 *
 * THE LADDER (each tick):
 *  1. Read BOTH stores (accounts.json + ~/.claude/.credentials.json).
 *     NEWEST-FAMILY-WINS: if they disagree, sync older←newer and stop —
 *     the daemon never exchanges a refresh token when a newer family exists
 *     anywhere on disk (single-exchanger discipline; defuses the suspected
 *     multi-process refresh race by construction).
 *  2. Lead > 30 min → nothing.
 *  3. Lead ≤ 30 min → exchange the refresh token INTO A TEMP OBJECT.
 *  4. Validate with probeAccessToken(candidate) — a validator that CAN check:
 *     candidate token passed BY ARGUMENT, direct HTTPS, no cache path by
 *     construction (checkUsageApi is disqualified twice: 3-min cache, and it
 *     reads its token FROM the store, so it cannot probe an unwritten
 *     candidate). Three verdicts, never two: VALID / TOKEN_BAD (401/403 —
 *     evidence about the token) / CANNOT_TELL (429/5xx/timeout — evidence
 *     about the probe, NOT the token).
 *  5. Swap BOTH stores atomically only on VALID.
 *  6. Failure branches (each page names its branch, plain words):
 *     TOKEN_BAD → keep old, page immediately.
 *     CANNOT_TELL → keep old, NOT token-evidence, no page until T-15.
 *     Exchange/write failure → keep old, page on 60-min cooldown.
 *     Booted into already-dead credential → exchange; on failure page
 *     immediately, no cooldown — that IS last night.
 *  7. DEADLINE BRANCH (pinned by chief — adopt-unproven): at ≤T-2 with a
 *     successful exchange but CANNOT_TELL, adopt the unproven token —
 *     never-clobber CORRECTLY SCOPED: at T-2 the old credential is already
 *     worth almost nothing; holding preserves two minutes of a dying token
 *     then guarantees the outage; adopting a bad token produces the SAME
 *     outage as holding plus a retained rollback (≥ holding in every
 *     branch). Three conditions, all enforced here:
 *       (a) the .prev sidecar is written AND READ BACK before the swap —
 *           if the old family cannot be proven recoverable, HOLD;
 *       (b) the unvalidated state is not terminal: re-probe each tick and
 *           page the RESOLUTION either way (validated / still unverified);
 *       (c) the page says what happened in plain words.
 *     This branch is not gold-plating: the degraded-probe state was
 *     OBSERVED the day this was designed (429 at 08:12Z, cached read at
 *     08:56Z).
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';

// --- tunables (ms) ---
export const REFRESH_LEAD_MS = 30 * 60_000;        // start refreshing at T-30
export const WARN_LEAD_MS = 15 * 60_000;           // first CANNOT_TELL page at T-15
export const DEADLINE_LEAD_MS = 2 * 60_000;        // adopt-unproven at T-2
export const EXCHANGE_FAIL_PAGE_COOLDOWN_MS = 60 * 60_000;

export type ProbeVerdict = 'VALID' | 'TOKEN_BAD' | 'CANNOT_TELL';

export interface TokenFamily {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}

export interface ProbeResult {
  verdict: ProbeVerdict;
  detail: string;
}

export type ProbeFn = (accessToken: string) => Promise<ProbeResult>;
export type ExchangeFn = (refreshToken: string) => Promise<TokenFamily>;

/**
 * Probe a CANDIDATE access token against the usage endpoint. The token is an
 * ARGUMENT — this function has no cache and no store access by construction.
 * Control-tested with a known-bad token (must be TOKEN_BAD) and a mocked 429
 * (must be CANNOT_TELL, not TOKEN_BAD).
 */
export async function probeAccessToken(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let res: Response;
    try {
      res = await fetchImpl('https://api.anthropic.com/api/oauth/usage', {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return { verdict: 'VALID', detail: `usage API ${res.status}` };
    if (res.status === 401 || res.status === 403) {
      return { verdict: 'TOKEN_BAD', detail: `usage API ${res.status} — the token itself was refused` };
    }
    return { verdict: 'CANNOT_TELL', detail: `usage API ${res.status} — probe could not answer (not token evidence)` };
  } catch (err) {
    return { verdict: 'CANNOT_TELL', detail: `probe unreachable: ${err instanceof Error ? err.message : String(err)} (not token evidence)` };
  }
}

/**
 * Exchange a refresh token for a new family. Returns the TEMP family only —
 * NO store writes here, ever.
 */
export async function exchangeRefreshToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenFamily> {
  const res = await fetchImpl('https://console.anthropic.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const t = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!t.access_token || !t.refresh_token) throw new Error('token exchange response missing access_token or refresh_token');
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + (t.expires_in ?? 3600) * 1000,
  };
}

// --- store IO ---

export interface StoreReadResult {
  family: TokenFamily | null;
  /** Raw parsed JSON, preserved so writes keep unrelated fields. */
  raw: Record<string, unknown> | null;
}

export function credentialsPath(homeDirPath: string): string {
  return join(homeDirPath, '.claude', '.credentials.json');
}

export function accountsPath(ctxRoot: string): string {
  return join(ctxRoot, 'state', 'oauth', 'accounts.json');
}

export function readCredentialsStore(homeDirPath: string): StoreReadResult {
  const p = credentialsPath(homeDirPath);
  if (!existsSync(p)) return { family: null, raw: null };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
    const o = raw.claudeAiOauth as { accessToken?: string; refreshToken?: string; expiresAt?: number } | undefined;
    if (!o?.accessToken || !o.refreshToken || typeof o.expiresAt !== 'number') return { family: null, raw };
    return { family: { access_token: o.accessToken, refresh_token: o.refreshToken, expires_at: o.expiresAt }, raw };
  } catch {
    return { family: null, raw: null };
  }
}

export function readAccountsStore(ctxRoot: string): StoreReadResult & { activeName: string | null } {
  const p = accountsPath(ctxRoot);
  if (!existsSync(p)) return { family: null, raw: null, activeName: null };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
    const active = raw.active as string | undefined;
    const accounts = raw.accounts as Record<string, { access_token?: string; refresh_token?: string; expires_at?: number }> | undefined;
    const a = active && accounts ? accounts[active] : undefined;
    if (!a?.access_token || !a.refresh_token || typeof a.expires_at !== 'number') {
      return { family: null, raw, activeName: active ?? null };
    }
    return {
      family: { access_token: a.access_token, refresh_token: a.refresh_token, expires_at: a.expires_at },
      raw,
      activeName: active ?? null,
    };
  } catch {
    return { family: null, raw: null, activeName: null };
  }
}

/** Write a family into accounts.json, preserving every unrelated field. */
export function writeAccountsStore(ctxRoot: string, family: TokenFamily): void {
  const cur = readAccountsStore(ctxRoot);
  const raw = (cur.raw ?? { active: 'primary', accounts: {}, rotation_log: [] }) as {
    active?: string;
    accounts?: Record<string, Record<string, unknown>>;
  };
  const name = raw.active ?? 'primary';
  raw.accounts = raw.accounts ?? {};
  raw.accounts[name] = {
    ...(raw.accounts[name] ?? { label: name, five_hour_utilization: 0, seven_day_utilization: 0 }),
    access_token: family.access_token,
    refresh_token: family.refresh_token,
    expires_at: family.expires_at,
    last_refreshed: new Date().toISOString(),
  };
  ensureDir(join(ctxRoot, 'state', 'oauth'));
  atomicWriteSync(accountsPath(ctxRoot), JSON.stringify(raw, null, 2));
}

/** Write a family into ~/.claude/.credentials.json, preserving unrelated fields. */
export function writeCredentialsStore(homeDirPath: string, family: TokenFamily): void {
  const cur = readCredentialsStore(homeDirPath);
  const raw = (cur.raw ?? {}) as Record<string, unknown>;
  const o = (raw.claudeAiOauth ?? {}) as Record<string, unknown>;
  raw.claudeAiOauth = {
    ...o,
    accessToken: family.access_token,
    refreshToken: family.refresh_token,
    expiresAt: family.expires_at,
  };
  ensureDir(join(homeDirPath, '.claude'));
  atomicWriteSync(credentialsPath(homeDirPath), JSON.stringify(raw, null, 2));
}

// --- the refresher ---

export interface CredentialRefresherOptions {
  ctxRoot: string;
  homeDir?: string;
  probe?: ProbeFn;
  exchange?: ExchangeFn;
  /** F3 pager (requireExplicit at the wiring). Returns confirmed delivery. */
  page: (message: string) => boolean;
  log?: (msg: string) => void;
  now?: () => number;
}

export type TickAction =
  | 'noop'
  | 'synced-stores'
  | 'swapped'
  | 'adopted-unproven'
  | 'adoption-held-sidecar-unproven'
  | 'kept-old-token-bad'
  | 'kept-old-cannot-tell'
  | 'kept-old-exchange-failed'
  | 'post-adopt-validated'
  | 'post-adopt-still-unverified'
  | 'no-credentials';

export class CredentialRefresher {
  private readonly ctxRoot: string;
  private readonly homeDir: string;
  private readonly probe: ProbeFn;
  private readonly exchange: ExchangeFn;
  private readonly page: (message: string) => boolean;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;

  private lastExchangeFailPageAt = 0;
  private warnedThisFamily = false;
  /** Set after adopt-unproven; cleared when a re-probe resolves. */
  private pendingAdoptedValidation: string | null = null;

  constructor(opts: CredentialRefresherOptions) {
    this.ctxRoot = opts.ctxRoot;
    this.homeDir = opts.homeDir ?? homedir();
    this.probe = opts.probe ?? ((t) => probeAccessToken(t));
    this.exchange = opts.exchange ?? ((r) => exchangeRefreshToken(r));
    this.page = opts.page;
    this.log = opts.log ?? ((m) => console.log(`[cred-refresh] ${m}`));
    this.now = opts.now ?? (() => Date.now());
  }

  /** One pass of the ladder. Returns what it did (for tests and logs). */
  async tick(): Promise<TickAction> {
    const now = this.now();

    // Post-adopt resolution (condition (b): unvalidated is not terminal).
    if (this.pendingAdoptedValidation) {
      const token = this.pendingAdoptedValidation;
      const r = await this.probe(token);
      if (r.verdict === 'VALID') {
        this.pendingAdoptedValidation = null;
        this.page('✅ Credential update: the replacement token installed under deadline has now been VERIFIED working. Nothing to do.');
        this.log('post-adopt probe: VALID — resolution paged');
        return 'post-adopt-validated';
      }
      if (r.verdict === 'TOKEN_BAD') {
        this.pendingAdoptedValidation = null;
        this.page('🚨 Credential update: the replacement token installed under deadline is DEAD (refused by the API). ' +
          'The previous token is retained in the .prev sidecar next to accounts.json. Interactive /login needed.');
        this.log('post-adopt probe: TOKEN_BAD — resolution paged');
        return 'post-adopt-still-unverified';
      }
      this.log(`post-adopt probe: still CANNOT_TELL (${r.detail}) — will retry`);
      return 'post-adopt-still-unverified';
    }

    // 1. Read both stores; newest family wins.
    const cred = readCredentialsStore(this.homeDir);
    const acct = readAccountsStore(this.ctxRoot);
    const a = cred.family;
    const b = acct.family;
    if (!a && !b) {
      this.log('no credentials in either store — nothing to refresh');
      return 'no-credentials';
    }
    if (a && b && a.expires_at !== b.expires_at) {
      const newer = a.expires_at > b.expires_at ? a : b;
      if (newer === a) writeAccountsStore(this.ctxRoot, newer);
      else writeCredentialsStore(this.homeDir, newer);
      this.log(`stores disagreed (${new Date(a.expires_at).toISOString()} vs ${new Date(b.expires_at).toISOString()}) — synced older from newer, no exchange this tick`);
      return 'synced-stores';
    }
    const family = (a ?? b) as TokenFamily;
    if (a && !b) { writeAccountsStore(this.ctxRoot, a); }
    if (b && !a) { writeCredentialsStore(this.homeDir, b); }

    const lead = family.expires_at - now;

    // 2. Healthy lead → nothing.
    if (lead > REFRESH_LEAD_MS) {
      this.warnedThisFamily = false;
      return 'noop';
    }

    // 3. Exchange into a temp family. (Includes the already-expired case —
    //    booted into a dead credential, i.e. last night's state.)
    let temp: TokenFamily;
    try {
      temp = await this.exchange(family.refresh_token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (lead <= 0) {
        // Dead credential and no replacement: page immediately, no cooldown.
        this.page(`🚨 CREDENTIAL DEAD: the fleet's Claude token expired at ${new Date(family.expires_at).toISOString()} ` +
          `and the refresh exchange FAILED (${msg.slice(0, 160)}). Every agent is (or will shortly be) logged out — ` +
          'this is the 2026-07-20 outage state. Interactive /login needed NOW.');
        this.log('exchange failed on a dead credential — paged immediately');
      } else if (now - this.lastExchangeFailPageAt >= EXCHANGE_FAIL_PAGE_COOLDOWN_MS) {
        const delivered = this.page(`⚠️ Credential refresh: token exchange FAILED (${msg.slice(0, 160)}). ` +
          `Old token still valid until ${new Date(family.expires_at).toISOString()} — nothing destroyed. Will keep retrying.`);
        if (delivered) this.lastExchangeFailPageAt = now;
      }
      return 'kept-old-exchange-failed';
    }

    // 4. Validate the CANDIDATE.
    const probe = await this.probe(temp.access_token);

    if (probe.verdict === 'VALID') {
      writeAccountsStore(this.ctxRoot, temp);
      writeCredentialsStore(this.homeDir, temp);
      this.warnedThisFamily = false;
      this.log(`refreshed: new family valid, both stores swapped (expires ${new Date(temp.expires_at).toISOString()})`);
      return 'swapped';
    }

    if (probe.verdict === 'TOKEN_BAD') {
      // Real evidence about the credential family — page immediately.
      this.page(`🚨 Credential refresh: the REPLACEMENT token is DEAD (${probe.detail}). ` +
        `Old token untouched, valid until ${new Date(family.expires_at).toISOString()}. ` +
        'The refresh-token family may be revoked — interactive /login likely needed before then.');
      this.log('probe TOKEN_BAD — kept old, paged');
      return 'kept-old-token-bad';
    }

    // CANNOT_TELL — not token evidence.
    if (lead <= DEADLINE_LEAD_MS) {
      // 7. Deadline branch: adopt-unproven (pinned). Condition (a): sidecar
      //    written AND read back before the swap, else hold.
      const sidecar = accountsPath(this.ctxRoot) + '.prev';
      try {
        ensureDir(join(this.ctxRoot, 'state', 'oauth'));
        atomicWriteSync(sidecar, JSON.stringify({ retained_at: new Date(now).toISOString(), family }, null, 2));
        const readBack = JSON.parse(readFileSync(sidecar, 'utf-8')) as { family?: TokenFamily };
        if (readBack.family?.refresh_token !== family.refresh_token) throw new Error('sidecar read-back mismatch');
      } catch (err) {
        this.log(`deadline: sidecar could not be proven recoverable (${err instanceof Error ? err.message : String(err)}) — HOLDING (honest loss)`);
        return 'adoption-held-sidecar-unproven';
      }
      writeAccountsStore(this.ctxRoot, temp);
      writeCredentialsStore(this.homeDir, temp);
      this.pendingAdoptedValidation = temp.access_token;
      // Condition (c): plain words.
      this.page('⚠️ Credential update: a replacement token was installed but could NOT be verified ' +
        `(the check API is unreachable: ${probe.detail}). The old token was about to expire anyway and is retained ` +
        'in accounts.json.prev. I will keep checking and message you either way. If agents go quiet, run /login.');
      this.log('deadline adopt-unproven: swapped with .prev sidecar, resolution pending');
      return 'adopted-unproven';
    }

    if (lead <= WARN_LEAD_MS && !this.warnedThisFamily) {
      const delivered = this.page(`⚠️ Credential refresh: cannot VERIFY a replacement token (${probe.detail}) ` +
        `and the current one dies at ${new Date(family.expires_at).toISOString()}. Old token untouched. ` +
        'Retrying every few minutes; if verification stays impossible I will install the unverified replacement just before expiry.');
      if (delivered) this.warnedThisFamily = true;
    }
    this.log(`probe CANNOT_TELL (${probe.detail}) — kept old, retrying (lead ${Math.round(lead / 60000)}m)`);
    return 'kept-old-cannot-tell';
  }
}
