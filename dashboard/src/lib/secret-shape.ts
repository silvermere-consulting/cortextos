// Secret-shape classifier for response/result fields (ticket task_1784717898925).
//
// SERVER-SIDE is the mechanism: API routes call this and refuse secret-shaped
// values fail-closed — a guard must not be predicated on the cooperation of the
// layer being guarded, so the client-side use of the same function is UX only.
//
// INTERIM (phase A, links-only): secret-shaped => REFUSED with guidance. Raw
// values with response_sensitive + 24h sweep arrive as ONE framework unit at
// the next daemon window (accept-raw is only acceptable because the sweep
// exists; the sweep is only reliable because the daemon tick fires it).

const KNOWN_SECRET_PREFIXES =
  /(?:^|[\s"'`=:])(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|sk-|sk_live_|sk_test_|rk_live_|xoxb-|xoxp-|xoxa-|xoxs-|AKIA[0-9A-Z]{16}|ya29\.|AIza[0-9A-Za-z_-]{35}|eyJhbGciOi)/;

// High-entropy token: one long unbroken run mixing character classes, not a URL.
const LONG_MIXED_TOKEN = /[A-Za-z0-9_\-+/=]{28,}/;

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

function hasMixedClasses(token: string): boolean {
  let classes = 0;
  if (/[a-z]/.test(token)) classes++;
  if (/[A-Z]/.test(token)) classes++;
  if (/[0-9]/.test(token)) classes++;
  return classes >= 2;
}

export interface SecretShapeVerdict {
  secretShaped: boolean;
  reason?: string;
}

/**
 * Classify a response/result value. URL-shaped values pass silently (one-time
 * share links are the intended shape). Known credential prefixes or a long
 * mixed-class unbroken token anywhere in a non-URL value are secret-shaped.
 */
export function classifyResponse(value: string): SecretShapeVerdict {
  const v = value.trim();
  if (!v) return { secretShaped: false };

  if (looksLikeUrl(v)) {
    // A bare link is the happy path. (A secret embedded in a URL of a one-time
    // share service is that service's design, not a raw secret at rest here.)
    return { secretShaped: false };
  }

  if (KNOWN_SECRET_PREFIXES.test(v)) {
    return { secretShaped: true, reason: 'known credential prefix' };
  }

  const tokens = v.match(new RegExp(LONG_MIXED_TOKEN, 'g')) ?? [];
  for (const t of tokens) {
    if (hasMixedClasses(t)) {
      return { secretShaped: true, reason: 'high-entropy token' };
    }
  }

  return { secretShaped: false };
}

/** The refusal message routes return; names the alternative, not just the rule. */
export const SECRET_REFUSAL_MESSAGE =
  'This looks like a raw secret. Raw secret values are not accepted here yet — ' +
  'paste a one-time share link instead (it self-destructs on first read, so it is safe ' +
  'to store). Raw-value support with automatic redaction ships with the next daemon deploy.';
