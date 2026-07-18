#!/usr/bin/env python3
"""cred-value-detect.py — the VALUE-side credential axis (engineer, 2026-07-19).

WHY THIS EXISTS (task_1784417082650): cred-matcher.sh matches credential NAMES
(CRED_SHAPE regex). A name list cannot hold — `BACKUP_ENCRYPT_PASSPHRASE`
(the DR decryption key, the single most sensitive var in the R2 block) was
invisible to it because PASSPHRASE was not in the list, though PASSWORD and
PASSWD were. That was the SECOND such miss. A third unimagined name evades a
name list identically. The structural fix is to detect on the VALUE: a naming
choice can dodge a list; it cannot dodge the entropy of the secret itself.

THE METHOD IS *ENUMERATE THE BENIGN, ALARM ON THE REMAINDER* — not enumerate
secrets (that is the same open-set trap the name list fell into). Proven
necessary by real data: HOSTINGER_SMTP_HOST (a benign hostname) carries HIGHER
per-char entropy (3.61) than HOSTINGER_EMAIL_APP_PASSWORD (a real secret, 3.22).
So entropy alone cannot separate them. The BENIGN high-entropy set, by contrast,
is CLOSED and observable in live envs: paths, URLs, UUIDs, emails, hostnames,
pure numbers, version strings. Exclude those; flag the high-entropy remainder.

Every benign exclusion below was added because it ACTUALLY APPEARS in live agent
/proc envs (measured), never because it was imagined — that is the discipline
the name list violated.

This is the VALUE axis. It is NAME-FREE by construction (it never reads the var
name to decide). The combined credential predicate is: NAME matches
cred-matcher.sh CRED_SHAPE  OR  VALUE is SECRET here  OR the SHORT-AND-CRED-NAMED
arm fires (see combined_verdict). The two axes are sourced, not merged —
cred-matcher.sh stays the one canonical NAME predicate.

⚠️ THE VALUE AXIS ALONE IS ANTI-CORRELATED WITH CREDENTIAL STRENGTH (analyst,
measured on a live env, 2026-07-19). A 64-char hex key is strong AND detected;
a 12-char SSH password is weak AND invisible (below MIN_LEN). So the instrument
is LEAST sensitive exactly where the risk is HIGHEST — worse than a random blind
spot, because an audit resting on the value axis alone returns clean on the
weakest credentials and the clean READS AS EVIDENCE. MIN_LEN is a deliberate
anti-flood parameter, NOT a claim that short values are safe. This is the first
measured argument for LAYERING: the NAME side asserts "this is a password"; the
VALUE side cannot see a short one; the PAIR catches it (combined_verdict's
short-and-cred-named arm). Do not "simplify" MIN_LEN away and do not drop the
combined arm — the short weak creds are the ones that matter most.

ANALYST'S RULE (bank it): a layer gets commissioned against a class and then
never pointed at the specific string that caused it to be built. POINT IT AT THE
STRING — the base64 corpus is `openssl rand -base64 32` (the BACKUP_ENCRYPT_
PASSPHRASE recipe), and the NEG/POS fixtures are HARVESTED from the live estate,
not imagined (the hostname-shaped token and slug-shaped password are the two
nobody would have invented).

⚠️ MEASUREMENT LIMIT — READ BEFORE QUOTING ANY "N MISSES" NUMBER. The live
audits of this axis (2026-07-19) all defined "a credential" by NAME-MATCHING
first, i.e. they used the NAME axis to set the sample frame for an audit OF THE
VALUE AXIS. A real secret in a var named TENANT_REF / SESSION_ID / DATA_BLOB was
never eligible to be counted. So every "5 misses / 21%" is a FLOOR twice over:
once for the detector's own gaps, and once because the value axis has NEVER been
measured against a sample frame it didn't inherit from the name axis — which is
the exact class it exists to catch. A name-free audit frame (classify every var,
not only cred-named ones) is the missing measurement.

Usage:
  printf 'NAME=VALUE\n...' | cred-value-detect.py       # flag lines (values redacted)
  cred-value-detect.py --selftest                        # two-sided: POS fires, NEG silent
  cred-value-detect.py --value 'somevalue'               # test one value -> SECRET / benign:<why>
"""
import math
import re
import sys
from collections import Counter

# --- thresholds (tuned against live envs; see --measure output in the task) ---
MIN_LEN = 16          # shorter than this is not treated as a secret
MIN_ENTROPY = 3.0     # bits/char; below this is low-diversity text
MIN_CLASSES = 2       # must mix at least two of {lower, upper, digit, symbol}

# --- benign shapes (CLOSED set, each observed in real agent envs) ---
_UUID = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-'
                   r'[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
_EMAIL = re.compile(r'^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$')
_URL = re.compile(r'^[a-z][a-z0-9+.\-]*://', re.IGNORECASE)
# A URL that carries userinfo (scheme://[user]:pass@host) is a credential BY
# CONSTRUCTION — it has a password in the authority. Covers DATABASE_URL
# (postgres://u:p@h), redis://:p@h, mongodb+srv://u:p@h. The name axis is blind
# to DATABASE_URL (no KEY/TOKEN/PASS), so this is a second double-blind.
_URL_USERINFO = re.compile(r'^[a-z][a-z0-9+.\-]*://[^/@\s]*:[^/@\s]+@', re.IGNORECASE)
# PATH is an ANCHORED shape, not a bare "contains a slash" — that substring test
# silently benigned ~48% of base64 secrets (the base64 alphabet includes '/')
# and every connection string. A path STARTS with a path anchor.
_PATH_ANCHOR = re.compile(r'^(/|~|\.{1,2}/)')
# base64/base64url blob: the alphabet is [A-Za-z0-9+/_-], optional '=' padding.
# Used to stop a leading-'/' base64 value from being mistaken for a path.
_BASE64ISH = re.compile(r'^[A-Za-z0-9+/_-]{16,}={0,2}$')
# hostname/domain: dot-separated lowercase labels ending in a real TLD. Length-
# bounded (<= 63) and TLD-anchored so an 89-char dotted TOKEN (HOMARR_API_TOKEN,
# harvested live) is NOT swallowed as a "hostname" — a real hostname is short and
# ends in an alphabetic TLD; a long dotted high-entropy string is a token.
_HOSTNAME = re.compile(r'^(?=.{4,63}$)[a-z0-9]([a-z0-9\-]*[a-z0-9])?'
                       r'(\.[a-z0-9]([a-z0-9\-]*[a-z0-9])?)*\.[a-z]{2,24}$',
                       re.IGNORECASE)
_NUMERIC = re.compile(r'^-?\d+$')
_VERSION = re.compile(r'^v?\d+(\.\d+)+([.\-][0-9a-zA-Z]+)*$')
# comma/space-separated list of numbers — e.g. ALLOWED_USERS (telegram id list)
_NUMLIST = re.compile(r'^\d+([,\s]+\d+)+$')
# lowercase kebab/snake identifier with a separator — agent names
# ("business-analyst"), model slugs ("claude-sonnet-4-5-…"). A hex secret has NO
# separator so it never matches; a mixed-case token has uppercase so it never
# matches. Guarded by an entropy ceiling so a random all-lowercase-hyphen token
# (rare) still flags rather than hiding under "looks like a slug".
_SLUG = re.compile(r'^[a-z][a-z0-9]*([_-][a-z0-9]+)+$')
SLUG_ENTROPY_MAX = 3.9


_WORDS = None


def _load_words():
    """English wordlist for the random-vs-dictionary discriminator. Absent on
    some hosts (family/jones) — degrades to empty, and the ENTROPY FLOOR below
    is the primary separator so the rule still holds cross-org without it."""
    global _WORDS
    if _WORDS is None:
        try:
            with open("/usr/share/dict/words", encoding="utf-8", errors="ignore") as fh:
                _WORDS = {w.strip().lower() for w in fh if len(w.strip()) >= 3}
        except Exception:  # noqa: BLE001
            _WORDS = set()
    return _WORDS


def _is_vendor_app_password(v):
    """Vendor app-passwords are UNIFORM hyphenated groups of RANDOM characters:
    Apple issues xxxx-xxxx-xxxx-xxxx, Hostinger the same shape. Systematic
    _SLUG collision, measured live across orgs (HOSTINGER_EMAIL_APP_PASSWORD,
    jones/ICLOUD_APP_PASSWORD). Named for the FAMILY (the vendor we haven't
    adopted is the point), not for Apple/Hostinger.

    Three conjoined discriminators, because uniform-width ALONE false-positives
    on real strings (measured: 'test-data-prod-main', 'node-pool-prod-main' —
    uniform 4x4 dictionary-word branch/label names). A credential's groups are
    RANDOM; a name's groups are WORDS:
      1. >=3 groups, ALL EQUAL WIDTH (4-6) alnum — the format;
      2. ENTROPY FLOOR >= 3.7 — random groups measure ~4.0, dictionary-word
         names ~3.1-3.6 (the 5 measured collisions were all < 3.6); PRIMARY,
         works without the wordlist;
      3. NOT majority dictionary words — belt to the entropy suspenders, skipped
         cleanly if no wordlist."""
    parts = v.split('-')
    if len(parts) < 3:
        return False
    if not all(re.fullmatch(r'[a-z0-9]{4,6}', p) for p in parts):
        return False
    if len({len(p) for p in parts}) != 1:      # uniform width
        return False
    if shannon(v) < 3.7:                        # random, not dictionary-low
        return False
    words = _load_words()
    if words:
        dict_groups = sum(1 for p in parts if p in words)
        if dict_groups > len(parts) // 2:      # majority real words -> a name
            return False
    return True


def shannon(s):
    if not s:
        return 0.0
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in Counter(s).values())


def charset_classes(s):
    return (bool(re.search(r'[a-z]', s)) + bool(re.search(r'[A-Z]', s)) +
            bool(re.search(r'[0-9]', s)) + bool(re.search(r'[^a-zA-Z0-9]', s)))


# Three verdicts, because a UUID is not benign — it is UNDECIDABLE from the value
# alone (a website-id and a session/bearer token are the SAME 122-bit string;
# formatting decides detection, not secrecy). Folding undecidable into "benign"
# is the empty-as-absence collapse — a value we COULD NOT determine reported as
# one we determined negative, the same silence a missing name has. So:
#   SECRET      — alarm (high-entropy remainder after the benign set is removed)
#   BENIGN      — silent (structurally cannot be a secret: path/url/email/…)
#   UNDECIDABLE — neither: a shape genuinely used for BOTH ids and tokens. Does
#                 not alarm, does not flood — goes to a COUNTABLE review bucket,
#                 so the residue is named instead of invisible.
SECRET = "SECRET"
BENIGN = "BENIGN"
UNDECIDABLE = "UNDECIDABLE"


def _url_secretish_segment(v):
    """After scheme://host, is there a path/query segment long + high-entropy
    enough to be a bearer token (webhook, one-time link, presigned URL)?"""
    after = re.sub(r'^[a-z][a-z0-9+.\-]*://[^/]*', '', v, flags=re.IGNORECASE)
    for seg in re.split(r'[/?&=;]', after):
        if len(seg) >= 16 and shannon(seg) >= 3.3 and charset_classes(seg) >= 2:
            return True
    return False


def classify(value):
    """Return (verdict, reason). verdict in {SECRET, BENIGN, UNDECIDABLE}."""
    v = value
    if len(v) < MIN_LEN:
        return BENIGN, "too-short"
    # --- URL family FIRST (URLs contain slashes; must beat the path check) ---
    if _URL_USERINFO.match(v):
        return SECRET, "url-with-userinfo (password in the authority)"
    if _URL.match(v):
        if _url_secretish_segment(v):
            return UNDECIDABLE, "url with high-entropy segment (webhook/one-time/presigned?)"
        return BENIGN, "url"
    # --- PATH: anchored AND low-entropy. A real path (dictionary segments) sits
    # well below a base64 blob that merely happens to start with '/': measured
    # paths run 3.3-3.9, base64 32-byte runs 4.5+. Entropy alone separates them,
    # so no base64-shape test is needed here (and one would misfire — a path is a
    # subset of the base64 alphabet). ---
    if _PATH_ANCHOR.match(v) and shannon(v) < 4.0:
        return BENIGN, "path"
    # --- other structurally-benign shapes (a secret cannot look like these) ---
    if _EMAIL.match(v):
        return BENIGN, "email"
    if _NUMLIST.match(v):
        return BENIGN, "numeric-list"   # a list of ids, not a single secret
    if _VERSION.match(v):
        return BENIGN, "version"
    # vendor app-password BEFORE _SLUG — both are lowercase-hyphenated, and the
    # app-password is the credential the slug rule was silently swallowing.
    if _is_vendor_app_password(v):
        return SECRET, "vendor app-password format (uniform hyphenated groups)"
    if _SLUG.match(v) and shannon(v) < SLUG_ENTROPY_MAX:
        return BENIGN, "identifier-slug"
    if _HOSTNAME.match(v) and ' ' not in v:
        # a domain/hostname: dotted lowercase labels + TLD. A secret does not
        # look like this. (Real: HOSTINGER_SMTP_HOST, UMAMI_*_URL host part.)
        return BENIGN, "hostname"
    # --- UNDECIDABLE closed set — the SAME string serves ids AND tokens ---
    if _UUID.match(v):
        return UNDECIDABLE, "uuid (website-id or session token — value can't tell)"
    if _NUMERIC.match(v):
        return UNDECIDABLE, "numeric (account-id or numeric token — value can't tell)"
    # --- entropy / charset gate on the remainder ---
    e = shannon(v)
    cls = charset_classes(v)
    if e < MIN_ENTROPY:
        return BENIGN, f"low-entropy({e:.2f})"
    if cls < MIN_CLASSES:
        return BENIGN, f"single-class({cls})"
    return SECRET, f"entropy={e:.2f} len={len(v)} classes={cls}"


def combined_verdict(value, name_is_cred):
    """The LAYERED predicate — the first layering earned by measurement, not
    asserted. `name_is_cred` is supplied by the caller from cred-matcher.sh's
    CRED_SHAPE (sourced, never forked here). It exists to catch the class the
    value axis is ANTI-CORRELATED against: a SHORT weak credential.

    The value axis can't see a short value (MIN_LEN floods otherwise); the name
    axis can't tell a password from a label. But a short value UNDER a
    credential-shaped name is a different, stronger signal than either alone:
    the name asserts 'password', the value is short = weak/short credential.
    Neither layer catches the 12-char SSH password; the PAIR does.
    Returns (verdict, reason)."""
    verdict, why = classify(value)
    if verdict == SECRET:
        return SECRET, "value:" + why
    if name_is_cred:
        # name says credential. A short/low-entropy value here is not benign —
        # it is a WEAK credential the value axis is structurally blind to.
        if why.startswith("too-short") or why.startswith("low-entropy") \
                or why.startswith("single-class"):
            return SECRET, f"short-and-cred-named (weak credential; value axis blind: {why})"
        return SECRET, "name:cred-shape"  # name axis carries it (uuid/etc under a cred name)
    return verdict, "value:" + why


def _redact(v):
    if len(v) <= 8:
        return "*" * len(v)
    return v[:3] + "…" + v[-2:] + f"({len(v)})"


def scan_stream(fh):
    """SECRET lines alarm to stdout; UNDECIDABLE lines go to the countable
    review bucket (also stdout, distinct tag); BENIGN is silent. Returns
    (n_secret, n_undecidable)."""
    n_secret = n_undec = 0
    for line in fh:
        line = line.rstrip("\n")
        if "=" not in line:
            continue
        name, _, value = line.partition("=")
        verdict, why = classify(value)
        if verdict == SECRET:
            n_secret += 1
            print(f"VALUE-CRED   {name}  [{why}]  {_redact(value)}")
        elif verdict == UNDECIDABLE:
            n_undec += 1
            print(f"UNDECIDABLE  {name}  [{why}]  {_redact(value)}")
    return n_secret, n_undec


def selftest():
    """Two-sided, and it ASSERTS THE VALUE not just a verdict (chief's warning:
    an annotation that cannot fail is a decoration). POS: a generated secret
    under no particular name must fire. NEG: every benign high-entropy shape
    observed in live envs must stay silent. Uses a fixed high-entropy POS so
    there is no RNG in the test."""
    # POS — must be SECRET. Generated-secret shapes under NO cred name, PLUS the
    # credential-by-construction cases chief's review surfaced: connection
    # strings (password in the URL authority) and base64 secrets containing '/'.
    pos = [
        "kJ8fQ2mZ7pR4vX1nL9wB6tY3cH5dG0aS",                  # 32 mixed
        "aGVsbG8td29ybGQtc2VjcmV0LTEyMzQ1Njc4OTA=",          # base64 blob
        "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928",  # 48 hex
        "Xq2!vR9@mK4#pL7$wZ1&nB6%tY3^cH5",                   # mixed+symbols
        "6AQAzKeC+eWLnGUE1MifGTe0Em533UvwCk/oUnntDk4=",       # base64 secret WITH '/' (was 'path')
        "postgres://admin:Xk9dPq2mNv4wTz@db.internal:5432/prod",  # conn string, pw in authority
        "redis://:aB3xK9mQ7pL2@cache.internal:6379/0",       # conn string, empty user
        "mongodb+srv://root:Tq7mK2xP9d@cluster0.mongodb.net/db",  # conn string
        # HARVESTED vendor-app-password FAMILY (not imagined): the shape Apple +
        # Hostinger both issue, that _SLUG was silently swallowing across orgs
        # (HOSTINGER_EMAIL_APP_PASSWORD, jones/ICLOUD_APP_PASSWORD). RANDOM groups.
        "xkcd-9fpz-2wvt-mnbq",                               # Apple xxxx-xxxx-xxxx-xxxx (4x4 random)
        "7h3k-9m2p-4x8v-1qwe",                               # 4x4 alnum random
        "kM2pq-7wvtx-9nRcz-2Xy8b-qL4mn",                     # 5-group x5 uniform random
        # HARVESTED hostname-shaped token (89-char dotted) — must NOT read as a
        # hostname (HOMARR_API_TOKEN class).
        "6d." + "a1b2c3d4e5." * 7 + "9f8e7d6c5b4a3f2e1d0c",  # long dotted high-entropy token
    ]
    # NEG — benign high-entropy values ACTUALLY seen in agent envs. MUST be BENIGN.
    neg = [
        "/home/cortext/cortextos/orgs/silvermere-tech/scripts",   # path (anchored)
        "https://umami.silvermere.tech/api",                       # url, no userinfo/no hi-entropy seg
        "steven.barker@silvermereconsulting.com",                  # email
        "smtp.hostinger.com",                                      # hostname
        "clearspeak-dev.silvermere.tech",                          # hostname
        "20260719.1",                                              # version
        "restarting",                                              # low-entropy word
        "Asia/Dubai",                                              # tz (has /) — NOT path-anchored, low entropy
        "business-analyst",                                        # agent-name slug (CTX_AGENT_NAME)
        "claude-sonnet-4-5-20250929",                              # model-name slug (AI_AGENT)
        "8701234567,8709876543,8705551212",                        # ALLOWED_USERS id list
        # MEASURED app-password COLLISIONS — uniform-width dictionary-word
        # branch/label names. The width rule alone flagged these; the entropy
        # floor + wordlist must keep them BENIGN (regression guard).
        "test-data-prod-main",
        "node-pool-prod-main",
        "cell-0001-prod-main",
    ]
    # URL with a high-entropy path segment = bearer-token-shaped but could be a
    # deep link — UNDECIDABLE, not silently benign (webhooks, one-time links).
    # UNDECIDABLE — shapes genuinely used for both ids and tokens. Must NOT be
    # SECRET (would flood on real website-ids) and must NOT be BENIGN (that is
    # the empty-as-absence collapse this verdict exists to kill).
    undec = [
        "379a392d-b49b-40c2-add3-0ecfff19827d",   # our real umami website-id (benign use)
        "550e8400-e29b-41d4-a716-446655440000",   # uuid4 — could be a session/bearer token
        "8145720394857203412",                     # long bare numeric — id or numeric token
    ]
    fails = []
    for v in pos:
        verdict, why = classify(v)
        if verdict != SECRET:
            fails.append(f"POS MISSED (should be SECRET): {_redact(v)} -> {verdict}:{why}")
    for v in neg:
        verdict, why = classify(v)
        if verdict != BENIGN:
            fails.append(f"NEG WRONG (should be BENIGN): {_redact(v)} -> {verdict}:{why}")
    for v in undec:
        verdict, why = classify(v)
        if verdict != UNDECIDABLE:
            fails.append(f"UNDEC WRONG (should be UNDECIDABLE): {_redact(v)} -> {verdict}:{why}")
    # value-assertion / decoration guard: a detector that ever returns ONE
    # verdict for all inputs is a decoration. With three verdicts the guard is
    # ">1 distinct verdict observed", AND each verdict must actually occur — a
    # 2-of-3 that never emits UNDECIDABLE would pass a naive ">1" check while
    # the whole new verdict silently never fires (the exact bug being fixed).
    observed = {classify(v)[0] for v in pos + neg + undec}
    if len(observed) < 2:
        fails.append("DECORATION: detector returned a single verdict for all inputs")
    for required in (SECRET, BENIGN, UNDECIDABLE):
        if required not in observed:
            fails.append(f"VERDICT NEVER FIRES: {required} was not produced by any "
                         "test input — it is inert, not a real branch")

    # BASE64 CORPUS — the class the 'contains-a-slash' bug hid. Two assertions,
    # because INVARIANCE ALONE PASSES ON A DETECTOR THAT FLAGS NOTHING (0% with
    # slash / 0% without = invariant, useless — chief). So:
    #   (a) LEVEL: a base64'd 32-byte digest IS secret-strength; SECRET rate must
    #       be ~100%. Anything lower is a countable miss.
    #   (b) INVARIANCE: the SECRET rate must not differ between the with-'/' and
    #       without-'/' subsets — if re-rolling the same-strength secret flips the
    #       verdict, the detector measures formatting, not strength.
    # The corpus IS the shape that motivated this whole axis: 32 bytes ->
    # base64 = 44 chars with '=' padding, i.e. exactly `openssl rand -base64 32`,
    # the recipe that minted BACKUP_ENCRYPT_PASSPHRASE. Analyst's rule: a layer
    # commissioned against a class must be pointed at the SPECIFIC string that
    # caused it — not a representative one. 400 distinct draws, deterministic
    # (sha256 of a counter -> 32 bytes) so the test never flakes.
    import base64 as _b64
    import hashlib as _hl
    corpus = [_b64.b64encode(_hl.sha256(str(i).encode()).digest()).decode()
              for i in range(400)]
    assert all(len(c) == 44 and c.endswith("=") for c in corpus), \
        "corpus is not the openssl-rand-base64-32 shape (44 chars, '=' pad)"
    with_slash = [c for c in corpus if '/' in c]
    without_slash = [c for c in corpus if '/' not in c]
    sec = lambda xs: sum(classify(c)[0] == SECRET for c in xs) / len(xs) if xs else None
    rate_all = sec(corpus)
    rate_w, rate_wo = sec(with_slash), sec(without_slash)
    # LEVEL: 100%, not 99% — a base64'd 32 bytes is secret-strength EVERY draw,
    # so anything below 100% is an unidentified miss class (the next PASSPHRASE),
    # not tolerance. A budget for a blind spot is a converted defect.
    if rate_all < 1.0:
        missers = [c for c in corpus if classify(c)[0] != SECRET][:5]
        fails.append(f"BASE64 LEVEL: {rate_all:.2%} SECRET (must be 100%). "
                     f"Missers (INVESTIGATE, do not budget): "
                     + "; ".join(f"{_redact(c)}->{classify(c)[1]}" for c in missers))
    # INVARIANCE: the rate must not differ by slash content (else it measures
    # formatting, not strength). Kept beside the LEVEL bar — invariance alone
    # passes on a detector that flags nothing (0%/0% = invariant, useless).
    if rate_w is not None and rate_wo is not None and abs(rate_w - rate_wo) > 0.02:
        fails.append(f"BASE64 INVARIANCE: SECRET rate depends on slash content "
                     f"(with-'/' {rate_w:.1%} vs without {rate_wo:.1%})")
    # COMBINED (layering) arm — the short-and-cred-named cases the value axis is
    # anti-correlated against. HARVESTED shapes: the live SSH/app passwords that
    # were invisible (too-short). Under a cred-shaped NAME they must read SECRET
    # via the combined predicate; under a random name they correctly stay benign.
    short_secrets = ["coolpass12", "hard8pwd", "88trombones13"]  # 10/8/13-char, harvested widths
    for s in short_secrets:
        v, _ = combined_verdict(s, name_is_cred=True)
        if v != SECRET:
            fails.append(f"COMBINED MISSED (short+cred-named should be SECRET): {_redact(s)} -> {v}")
        v2, _ = combined_verdict(s, name_is_cred=False)
        if v2 == SECRET:
            fails.append(f"COMBINED OVER-FLAGS (short + random name should not alarm): {_redact(s)} -> {v2}")

    if fails:
        print("SELFTEST FAIL:")
        for f in fails:
            print("  " + f)
        return 2
    print(f"SELFTEST PASS: {len(pos)} POS->SECRET, {len(neg)} NEG->BENIGN, "
          f"{len(undec)} ->UNDECIDABLE; all three verdicts fire; "
          f"base64 corpus {rate_all:.0%} SECRET, slash-invariant "
          f"({rate_w:.0%}/{rate_wo:.0%}).")
    return 0


def main(argv):
    if "--selftest" in argv:
        return selftest()
    if "--value" in argv:
        v = argv[argv.index("--value") + 1]
        verdict, why = classify(v)
        print(f"{verdict}: {why}")
        return 0
    if "--combined" in argv:
        # cred-scan.sh calls this per var: --combined <name_is_cred> <name>,
        # value on stdin. name_is_cred comes from the SOURCED cred-matcher.sh.
        i = argv.index("--combined")
        name_is_cred = argv[i + 1].lower() in ("true", "1", "yes")
        name = argv[i + 2] if len(argv) > i + 2 else "?"
        value = sys.stdin.read().rstrip("\n")
        verdict, why = combined_verdict(value, name_is_cred)
        if verdict == SECRET:
            print(f"VALUE-CRED   {name}  [{why}]  {_redact(value)}")
        elif verdict == UNDECIDABLE:
            print(f"UNDECIDABLE  {name}  [{why}]  {_redact(value)}")
        return 0
    n_secret, n_undec = scan_stream(sys.stdin)
    print(f"--- {n_secret} SECRET, {n_undec} UNDECIDABLE (review bucket) ---",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
