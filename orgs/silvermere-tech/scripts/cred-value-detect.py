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
cred-matcher.sh CRED_SHAPE  OR  VALUE flags here. The two axes are sourced, not
merged — cred-matcher.sh stays the one canonical NAME predicate.

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
# hostname/domain: dot-separated lowercase labels ending in a TLD, no secret chars
_HOSTNAME = re.compile(r'^[a-z0-9]([a-z0-9\-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9\-]*'
                       r'[a-z0-9])?)+$', re.IGNORECASE)
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


def shannon(s):
    if not s:
        return 0.0
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in Counter(s).values())


def charset_classes(s):
    return (bool(re.search(r'[a-z]', s)) + bool(re.search(r'[A-Z]', s)) +
            bool(re.search(r'[0-9]', s)) + bool(re.search(r'[^a-zA-Z0-9]', s)))


def classify(value):
    """Return (is_secret: bool, reason: str). reason names the benign shape when
    benign, or the firing criteria when flagged."""
    v = value
    if len(v) < MIN_LEN:
        return False, "too-short"
    # benign closed set — order cheapest first
    if '/' in v or v.startswith('~'):
        return False, "path"
    if _URL.match(v):
        return False, "url"
    if _EMAIL.match(v):
        return False, "email"
    if _UUID.match(v):
        return False, "uuid"
    if _NUMERIC.match(v):
        return False, "numeric-id"
    if _NUMLIST.match(v):
        return False, "numeric-list"
    if _VERSION.match(v):
        return False, "version"
    if _SLUG.match(v) and shannon(v) < SLUG_ENTROPY_MAX:
        return False, "identifier-slug"
    if _HOSTNAME.match(v) and ' ' not in v:
        # a domain/hostname: dotted lowercase labels + TLD. A secret does not
        # look like this. (Real: HOSTINGER_SMTP_HOST, UMAMI_*_URL host part.)
        return False, "hostname"
    # entropy / charset gate on the remainder
    e = shannon(v)
    cls = charset_classes(v)
    if e < MIN_ENTROPY:
        return False, f"low-entropy({e:.2f})"
    if cls < MIN_CLASSES:
        return False, f"single-class({cls})"
    return True, f"entropy={e:.2f} len={len(v)} classes={cls}"


def _redact(v):
    if len(v) <= 8:
        return "*" * len(v)
    return v[:3] + "…" + v[-2:] + f"({len(v)})"


def scan_stream(fh):
    flagged = 0
    for line in fh:
        line = line.rstrip("\n")
        if "=" not in line:
            continue
        name, _, value = line.partition("=")
        is_secret, why = classify(value)
        if is_secret:
            flagged += 1
            print(f"VALUE-CRED  {name}  [{why}]  {_redact(value)}")
    return flagged


def selftest():
    """Two-sided, and it ASSERTS THE VALUE not just a verdict (chief's warning:
    an annotation that cannot fail is a decoration). POS: a generated secret
    under no particular name must fire. NEG: every benign high-entropy shape
    observed in live envs must stay silent. Uses a fixed high-entropy POS so
    there is no RNG in the test."""
    # POS — generated-secret-shaped values (base64, hex, mixed) that match NO
    # cred name. These MUST flag.
    pos = [
        "kJ8fQ2mZ7pR4vX1nL9wB6tY3cH5dG0aS",             # 32 mixed
        "aGVsbG8td29ybGQtc2VjcmV0LTEyMzQ1Njc4OTA=",     # base64 blob
        "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928",  # 48 hex
        "Xq2!vR9@mK4#pL7$wZ1&nB6%tY3^cH5",              # mixed+symbols
    ]
    # NEG — benign high-entropy values ACTUALLY seen in agent envs. MUST stay silent.
    neg = [
        "/home/cortext/cortextos/orgs/silvermere-tech/scripts",   # path
        "https://umami.silvermere.tech/api",                       # url
        "2ee0a4c2-2cba-4ed3-b95b-c2f90a7470ed",                    # uuid (website id)
        "steven.barker@silvermereconsulting.com",                  # email
        "smtp.hostinger.com",                                      # hostname
        "clearspeak-dev.silvermere.tech",                          # hostname
        "8145720394857203",                                        # numeric id
        "20260719.1",                                              # version
        "restarting",                                              # low-entropy word
        "Asia/Dubai",                                              # tz (has /)
        "business-analyst",                                        # agent-name slug (CTX_AGENT_NAME)
        "claude-sonnet-4-5-20250929",                              # model-name slug (AI_AGENT)
        "8701234567,8709876543,8705551212",                        # ALLOWED_USERS id list
    ]
    fails = []
    for v in pos:
        ok, why = classify(v)
        if not ok:
            fails.append(f"POS MISSED (should flag): {_redact(v)} -> {why}")
    for v in neg:
        ok, why = classify(v)
        if ok:
            fails.append(f"NEG FALSE-POSITIVE (should be silent): {_redact(v)} -> {why}")
    # value-assertion guard: prove the detector actually discriminates, i.e. it
    # is not a constant. If every POS and NEG returned the same verdict, the
    # thing is a decoration regardless of pass/fail above.
    verdicts = {classify(v)[0] for v in pos} | {classify(v)[0] for v in neg}
    if verdicts != {True, False}:
        fails.append("DECORATION: detector returned a single verdict for all "
                     "inputs — it does not discriminate")
    if fails:
        print("SELFTEST FAIL:")
        for f in fails:
            print("  " + f)
        return 2
    print(f"SELFTEST PASS: {len(pos)}/{len(pos)} POS flagged, "
          f"{len(neg)}/{len(neg)} NEG silent, detector discriminates both ways.")
    return 0


def main(argv):
    if "--selftest" in argv:
        return selftest()
    if "--value" in argv:
        v = argv[argv.index("--value") + 1]
        ok, why = classify(v)
        print(("SECRET " if ok else "benign:") + why)
        return 0
    n = scan_stream(sys.stdin)
    print(f"--- {n} value-credential(s) flagged ---", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
