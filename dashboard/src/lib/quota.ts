/**
 * Quota helpers for the dashboard's quota-usage indicator.
 *
 * Mirrors the OAuth-token fallback logic the bash watchdog uses
 * (`/root/cortextos/bin/quota-watchdog.sh`): read access token from
 * Claude Code's local credentials store, call Anthropic's OAuth usage API,
 * normalise to 0–1 utilization fractions.
 *
 * Adds a server-side last-good cache so transient 429s / network errors
 * don't blank the dashboard. On any failure we return the most recent
 * successful snapshot with `stale: true` and a `cache_age_ms` field;
 * the component renders an "Xm ago" suffix. Only when no cache exists
 * (cold boot) do we return null — that becomes "no data yet" in the UI.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_CREDS = path.join(os.homedir(), '.claude', '.credentials.json');

const CACHE_DIR = path.join(
  process.env.CTX_ROOT ?? path.join(os.homedir(), '.cortextos', 'default'),
  'state',
  'dashboard',
);
const CACHE_PATH = path.join(CACHE_DIR, 'quota-last-good.json');

export interface QuotaSnapshot {
  five_hour_remaining_pct: number;
  seven_day_remaining_pct: number;
  fetched_at: string;
  source: 'env' | 'credentials.json' | 'accounts.json';
}

export interface QuotaResponse extends QuotaSnapshot {
  /** True when the snapshot came from cache (API call failed). */
  stale: boolean;
  /** Milliseconds since the cached snapshot was originally fetched. 0 if fresh. */
  cache_age_ms: number;
}

function getOAuthToken(): { token: string; source: QuotaSnapshot['source'] } | null {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { token: process.env.CLAUDE_CODE_OAUTH_TOKEN, source: 'env' };
  }
  if (fs.existsSync(CLAUDE_CREDS)) {
    try {
      const raw = fs.readFileSync(CLAUDE_CREDS, 'utf-8');
      const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
      const token = parsed.claudeAiOauth?.accessToken;
      if (token) return { token, source: 'credentials.json' };
    } catch {
      /* fall through */
    }
  }
  return null;
}

function readCache(): QuotaSnapshot | null {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')) as QuotaSnapshot;
  } catch {
    return null;
  }
}

function writeCache(snapshot: QuotaSnapshot): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(snapshot, null, 2));
  } catch {
    /* Best-effort: cache write failure shouldn't break the request. */
  }
}

async function fetchFresh(): Promise<QuotaSnapshot | null> {
  const auth = getOAuthToken();
  if (!auth) return null;

  const response = await fetch(ANTHROPIC_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });
  if (!response.ok) return null;

  // The Anthropic OAuth usage API actually returns NESTED objects:
  //   { five_hour: { utilization: 77.0, resets_at: "..." }, seven_day: {...}, ... }
  // We previously parsed flat fields (five_hour_utilization) which always
  // returned undefined → normalize → 0 → "100% remaining" regardless of
  // real usage. Hence the "stuck at 100%" UX bug. Keep the flat fallbacks
  // in case the API ever returns either shape.
  const data = (await response.json()) as {
    five_hour?: { utilization?: number };
    seven_day?: { utilization?: number };
    five_hour_utilization?: number;
    seven_day_utilization?: number;
    fiveHourUtilization?: number;
    sevenDayUtilization?: number;
  };

  // ── DO NOT INFER A UNIT FROM A VALUE. ────────────────────────────────────
  // This used to read `v > 1 ? v / 100 : v` — guessing "is this a percent or a
  // fraction?" from the magnitude. THAT IS UNSOUND BY CONSTRUCTION: the two
  // ranges OVERLAP on [0,1]. `1.0` is both "1%" and "100%", and no threshold
  // can separate them.
  //
  // It failed exactly where it hurt most — when usage is LOW, which is the
  // normal state right after a window resets:
  //     utilization 1.0 (=1% used)   -> read as 100% used -> "0% REMAINING"
  //     utilization 0.8 (=0.8% used) -> read as  80% used -> "20% remaining"
  // i.e. the gauge screamed EMPTY on a quota that was untouched. A gauge that
  // panics at reset time is the same disease as one that flatters at exhaustion:
  // it is a number with no ground truth. We retired one of those tonight.
  //
  // Every field below comes from the Anthropic usage API, which reports a
  // PERCENTAGE (0–100): { five_hour: { utilization: 77.0 } }. So we convert by
  // SOURCE, which we know, rather than by magnitude, which we are guessing.
  // (Our own state/usage/api-latest.json stores a 0–1 FRACTION under the same
  // field NAME. Same name, different unit, different producer — which is the
  // trap that produced this bug. Do not read the two through one function.)
  //
  // Out of range => the shape is not what we think it is. REFUSE, do not guess:
  // a wrong quota number is worse than a missing one, because a missing one
  // gets investigated and a wrong one gets ACTED ON.
  const PCT_FROM_API = (v: number | undefined): number | null => {
    if (v === undefined || v === null || Number.isNaN(v)) return null;
    if (v < 0 || v > 100) return null;
    return v / 100;
  };

  const fiveH = PCT_FROM_API(
    data.five_hour?.utilization ?? data.five_hour_utilization ?? data.fiveHourUtilization,
  );
  const sevenD = PCT_FROM_API(
    data.seven_day?.utilization ?? data.seven_day_utilization ?? data.sevenDayUtilization,
  );

  // A missing number, never a wrong one. If either reading is unusable we return
  // null and the caller falls back to last-good / shows nothing — it does NOT
  // silently render 100% remaining, which is what the old `?? 0` default did and
  // is precisely the "stuck at 100%" bug the comment above describes.
  if (fiveH === null || sevenD === null) return null;

  return {
    five_hour_remaining_pct: Math.round((1 - fiveH) * 100),
    seven_day_remaining_pct: Math.round((1 - sevenD) * 100),
    fetched_at: new Date().toISOString(),
    source: auth.source,
  };
}

/**
 * Fetch a quota response. Always returns the freshest available data:
 * a fresh API call when it succeeds, the cached last-good when it
 * doesn't, or null when neither is available (cold-boot only).
 */
export async function fetchQuotaSnapshot(): Promise<QuotaResponse | null> {
  const fresh = await fetchFresh();
  if (fresh) {
    writeCache(fresh);
    return { ...fresh, stale: false, cache_age_ms: 0 };
  }

  const cached = readCache();
  if (cached) {
    const cacheAgeMs = Date.now() - new Date(cached.fetched_at).getTime();
    return { ...cached, stale: true, cache_age_ms: Math.max(0, cacheAgeMs) };
  }

  return null;
}
