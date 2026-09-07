# cred-matcher.sh — THE ONE CANONICAL CREDENTIAL PREDICATE (analyst, 2026-07-12)
#
# SOURCE THIS. DO NOT COPY THE REGEX. A copied regex is a fork with a delay fuse: the day one side
# is widened (as CRED_SHAPE was, 07-12, when a bare `_KEY` was added after it under-counted 23 vs 25)
# the other silently disagrees, and two instruments on one object give two answers — the exact
# two-gates-on-one-question bug the fleet-health / chief-census cross-assertion exists to prevent.
#
# BOTH instruments MUST derive their credential verdict from these three lines and nothing else:
#   - workspace/fleet-health-check.sh  (VERDICT + alerts)   sources this
#   - chief-census                     (FACT TABLE, no alert) sources this
# The cross-assertion (same roster + same cred-count for same pids, divergence = RED both) is only
# meaningful if the predicate is IDENTICAL by construction. That is what sourcing — not copying — buys.
#
# Usage (bash):   . "$(dirname "$0")/cred-matcher.sh"   # or an absolute path
# Then: CRED_SHAPE, CRED_NEEDED, ANTHROPIC_KEYS are in scope. residual = env names matching
#       ^[A-Z0-9_]*${CRED_SHAPE}[A-Z0-9_]*=  minus CRED_NEEDED  minus ANTHROPIC_KEYS.

# ANTHROPIC/Claude provider credentials — their PRESENCE in an agent env is the incident invariant (RED).
ANTHROPIC_KEYS='^(ANTHROPIC_API_KEY|CLAUDE_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)='

# Credential-SHAPE (name-shapes, not identities). Strictly more general than a name list; still not
# airtight (a key named literally `ANTHROPIC_KEY` with no other token would slip it) — which is why
# the count is only ONE axis and the raw envvars count is carried alongside as the list-free axis.
# Widened 2026-07-12 (added bare _KEY etc.) after it reported 23 residual creds when the truth was 25.
#
# Widened AGAIN 2026-07-19 (added PASSPHRASE) — and the SECOND escape matters more than the first:
#   `BACKUP_ENCRYPT_PASSPHRASE` entered every agent env when the R2 off-box backup block landed in
#   secrets.env at 2026-07-18 22:27Z. It is the DR DECRYPTION KEY — engineer's own note calls it "the
#   weak point". The S3 keys reach the encrypted blobs; THIS one opens them. It was the single most
#   sensitive var in the block and it was the ONE the matcher could not see. PASSWORD and PASSWD were
#   both listed; PASSPHRASE was not. The two flanking names were imagined and the middle one was not.
#
#   ⚠️ THE COMMENT SIX LINES UP PREDICTED THIS EXACT FAILURE ("a key named literally ANTHROPIC_KEY
#   would slip it") AND THE PREDICTION DID NOT PREVENT IT. Reading the caveat installs nothing; the
#   gap was found by DIFFING two matchers against live /proc envs, not by re-reading this file.
#
#   ⚠️ AND BE HONEST ABOUT WHAT THIS EDIT IS: it is the same partial fix a second time. Adding the
#   missing literal removes THIS blind spot; it does NOT remove the DEPENDENCE ON LITERALS. A third
#   name I have not imagined evades the line below exactly as PASSPHRASE did. The structural fix is
#   value-side (entropy/shape of the VALUE, which no naming choice can dodge) and is NOT built —
#   filed, not silently assumed. Until then `infra-creds=N` is a FLOOR, never a count, and the
#   list-free `envvars=N` axis remains the only number that cannot be evaded by naming.
#
#   Blast radius MEASURED before shipping (diff of old vs new shape over all live agent /proc envs):
#   +1 name (BACKUP_ENCRYPT_PASSPHRASE) on the 2 agents restarted since 22:27Z; 0 new hits on the
#   other 6. Two-sided: it discriminates, and it does not storm.
CRED_SHAPE='(API_KEY|_KEY|KEY_|_TOKEN|TOKEN_|PASSWORD|PASSWD|PASSPHRASE|SECRET|_PAT|CREDENTIAL|PRIVATE|_PW)'

# Credentials an agent LEGITIMATELY holds — suppressed from the residual report (NOT an injection policy).
#   BOT_TOKEN = the agent's own Telegram bot token; without it the agent cannot reach Steven.
#
# ⚠️ INPUT-FORM CONTRACT (fixed 2026-07-20, task_1784481320798): call sites feed this pattern TWO
#   different shapes — `NAME=value` lines (cred-scan.sh, fleet-health A1 arm) AND bare stripped
#   names (fleet-health NEW-CREDENTIAL arm strips '=' before filtering, then wraps as ^(...)$ ).
#   The old '^(BOT_TOKEN)=' (trailing '=') could NEVER match the stripped form, so BOT_TOKEN was
#   suppressed only by living in the pinned baseline data file — a broken filter masked by data
#   (found by analyst 2026-07-19: a documented clean re-derive would have dropped BOT_TOKEN and
#   RED-stormed all six agents permanently). `(=|$)` matches both forms; `BOT_TOKEN_FOO` still
#   correctly fails both. DO NOT narrow this back to one form without running
#   cred-matcher-selftest.sh — it replicates every live call-site shape both directions.
#
# ⚠️ THIS SET HAS TWO DISTINCT REASONS, AND THEY ARE NOT THE SAME KIND OF THING (added 2026-08-20):
#   REASON 1 — LEGITIMATELY-HELD CREDENTIAL: it IS a secret, the agent genuinely needs it (BOT_TOKEN).
#   REASON 2 — SHAPE FALSE-POSITIVE: it is NOT a secret at all; CRED_SHAPE matched a SUBSTRING of a
#     public identifier. `UMAMI_*_WEBSITE_ID` is a public Umami analytics site ID (exposed in the
#     tracking snippet on every public page). It fired ONLY because a site NAMED "ilham keynote"
#     produced UMAMI_ILHAM_KEYNOTE_WEBSITE_ID, and `_KEY` is a substring of `_KEYNOTE`. The other five
#     UMAMI_*_WEBSITE_ID siblings do NOT match CRED_SHAPE at all — so this is a name-collision on the
#     SITE name, not "the WEBSITE_ID class alerts forever". The exemption is anchored on the SUFFIX
#     `_WEBSITE_ID(=|$)` (not on UMAMI_*, so UMAMI_ADMIN_PASSWORD and UMAMI_CLOUD_API_KEY still fire;
#     not on _ID generally). The `[A-Z0-9_]*` prefix is REQUIRED so it matches under the Form-C
#     `^(...)$` full-anchoring where the real name carries a prefix (UMAMI_ILHAM_KEYNOTE_). Blast
#     radius measured over live /proc envs before shipping: only the WEBSITE_ID names disappear; every
#     real credential (incl. the two UMAMI secrets) still emerges. Guarded by a fixture in
#     cred-matcher-selftest.sh — DO NOT ship a CRED_NEEDED change without it going green.
#   I did NOT narrow CRED_SHAPE to fix this — narrowing the load-bearing widened matcher is the
#   partial-fix regression this file is a monument to (23-vs-25, PASSPHRASE). A public-ID suppression
#   is the correct surface: it removes a false POSITIVE without blinding the matcher to any true one.
CRED_NEEDED='^(BOT_TOKEN)(=|$)|[A-Z0-9_]*_WEBSITE_ID(=|$)'
