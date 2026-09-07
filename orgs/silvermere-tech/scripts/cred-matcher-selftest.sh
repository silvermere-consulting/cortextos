#!/usr/bin/env bash
# cred-matcher-selftest.sh — both-direction control test for cred-matcher.sh (task_1784481320798).
#
# WHY THIS EXISTS: CRED_NEEDED was '^(BOT_TOKEN)=' for its whole life while one of its three call
# sites (fleet-health NEW-CREDENTIAL arm) strips '=' BEFORE filtering — the pattern could never
# match there, and BOT_TOKEN was suppressed only by squatting in the pinned baseline data file.
# A broken filter masked by data survives every reading; it dies only under a control test that
# replicates the REAL call-site input shapes. This file IS that test. Run it after ANY edit to
# cred-matcher.sh. Exit 0 = all arms proven both directions. Exit 2 = a call-site form is broken
# or the matcher did not load (CANNOT-TELL is a failure, never a pass).
#
# The three live input shapes replicated below (do not "simplify" them into one):
#   A. cred-scan.sh:28              — name is wrapped as 'NAME=x' then tested
#   B. fleet-health-check.sh:173    — raw 'NAME=value' env lines, filter-out
#   C. fleet-health-check.sh:564    — names STRIPPED of '=', filter wrapped as ^(...)$
#
# Override the matcher path with CRED_MATCHER=<path> to control-test the test itself against a
# known-bad matcher (the old trailing-'=' pattern MUST turn arm C red — if it does not, this
# selftest has lost its teeth).

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MATCHER="${CRED_MATCHER:-$SCRIPT_DIR/cred-matcher.sh}"

fail=0
say() { printf '%s\n' "$*"; }
bad() { say "  RED  $*"; fail=$((fail+1)); }
ok()  { say "  ok   $*"; }

# ---- Producer guard (the void-control lesson, fleet-health 2026-07-14): if the source failed or
# the var is empty, every grep below matches everything/nothing and both directions read green.
if [ ! -r "$MATCHER" ]; then say "CANNOT-TELL: matcher file unreadable: $MATCHER"; exit 2; fi
# shellcheck disable=SC1090
. "$MATCHER"
if [ -z "${CRED_NEEDED:-}" ] || [ -z "${CRED_SHAPE:-}" ]; then
  say "CANNOT-TELL: sourced $MATCHER but CRED_NEEDED/CRED_SHAPE empty — nothing below is meaningful"
  exit 2
fi
say "matcher: $MATCHER"
say "CRED_NEEDED: $CRED_NEEDED"

# Fixtures: the one legitimately-held name, and two that must NEVER be suppressed —
# a prefix-collision name and an ordinary cred-shaped name.
LEGIT='BOT_TOKEN'
COLLIDE='BOT_TOKEN_EXTRA'
ORDINARY='ZZQ_SELFTEST_API_KEY'
# Public-ID exemption fixtures (added 2026-08-20). PUBLICID is a real shape false-positive: it matches
# CRED_SHAPE only because the SITE name "ilham keynote" makes `_KEY` a substring of `_KEYNOTE`, yet it is
# a public Umami analytics site ID, not a secret. It MUST be suppressed. REALSECRET is a genuine UMAMI
# credential that shares the UMAMI_ prefix — the exemption is suffix-anchored on _WEBSITE_ID, so this
# MUST NOT be suppressed (proves the exemption did not over-reach the whole UMAMI_ class).
PUBLICID='UMAMI_ILHAM_KEYNOTE_WEBSITE_ID'
REALSECRET='UMAMI_CLOUD_API_KEY'
# Guard the fixture itself: PUBLICID is only a meaningful test if it actually matches CRED_SHAPE
# (else it "passes" for the wrong reason — it was never a candidate). CANNOT-TELL if it does not.
if ! printf '%s=x\n' "$PUBLICID" | grep -qE "^[A-Z0-9_]*${CRED_SHAPE}[A-Z0-9_]*="; then
  say "CANNOT-TELL: PUBLICID fixture ($PUBLICID) does not match CRED_SHAPE — the exemption test is vacuous"; exit 2
fi

say "--- Form A: cred-scan.sh shape — printf 'NAME=x' | grep -qE \$CRED_NEEDED ---"
if printf '%s=x\n' "$LEGIT" | grep -qE "$CRED_NEEDED"; then ok "known-positive: $LEGIT skipped"; else bad "known-positive: $LEGIT NOT skipped (suppression dead at cred-scan site)"; fi
if printf '%s=x\n' "$COLLIDE" | grep -qE "$CRED_NEEDED"; then bad "known-negative: $COLLIDE wrongly skipped (over-suppression)"; else ok "known-negative: $COLLIDE not skipped"; fi
if printf '%s=x\n' "$ORDINARY" | grep -qE "$CRED_NEEDED"; then bad "known-negative: $ORDINARY wrongly skipped"; else ok "known-negative: $ORDINARY not skipped"; fi

say "--- Form B: fleet-health A1 shape — 'NAME=value' lines | grep -vE \$CRED_NEEDED ---"
r=$(printf '%s=tok123\n' "$LEGIT" | grep -vE "$CRED_NEEDED")
if [ -z "$r" ]; then ok "known-positive: $LEGIT line filtered out"; else bad "known-positive: $LEGIT line SURVIVED the filter"; fi
r=$(printf '%s=tok123\n' "$COLLIDE" | grep -vE "$CRED_NEEDED")
if [ -n "$r" ]; then ok "known-negative: $COLLIDE line survives"; else bad "known-negative: $COLLIDE line wrongly filtered"; fi

say "--- Form C: fleet-health NEW-CREDENTIAL shape — STRIPPED names | grep -vE \"^(\$CRED_NEEDED)\$\" ---"
# This is the arm that was dead from birth under the trailing-'=' pattern.
r=$(printf '%s\n' "$LEGIT" | grep -vE "^(${CRED_NEEDED})$")
if [ -z "$r" ]; then ok "known-positive: stripped $LEGIT filtered out"; else bad "known-positive: stripped $LEGIT SURVIVED — the 2026-07-19 defect shape is live"; fi
r=$(printf '%s\n' "$COLLIDE" | grep -vE "^(${CRED_NEEDED})$")
if [ -n "$r" ]; then ok "known-negative: stripped $COLLIDE survives"; else bad "known-negative: stripped $COLLIDE wrongly filtered"; fi
r=$(printf '%s\n' "$ORDINARY" | grep -vE "^(${CRED_NEEDED})$")
if [ -n "$r" ]; then ok "known-negative: stripped $ORDINARY survives (detection alive)"; else bad "known-negative: stripped $ORDINARY wrongly filtered (detection dead)"; fi

say "--- Public-ID exemption (2026-08-20): _WEBSITE_ID suffix suppressed, real UMAMI cred NOT ---"
# Form A/B/C all three, the arm that fires is C.
if printf '%s=x\n' "$PUBLICID" | grep -qE "$CRED_NEEDED"; then ok "A: public $PUBLICID skipped"; else bad "A: public $PUBLICID NOT skipped (exemption dead at cred-scan site)"; fi
r=$(printf '%s\n' "$PUBLICID" | grep -vE "^(${CRED_NEEDED})$")
if [ -z "$r" ]; then ok "C: stripped $PUBLICID filtered out (the NEW-CREDENTIAL arm that was firing)"; else bad "C: stripped $PUBLICID SURVIVED — exemption broken under ^(...)\$ anchoring"; fi
r=$(printf '%s\n' "$REALSECRET" | grep -vE "^(${CRED_NEEDED})$")
if [ -n "$r" ]; then ok "C: real $REALSECRET survives (exemption did not over-reach UMAMI_ class)"; else bad "C: real $REALSECRET wrongly filtered — a genuine UMAMI secret is now invisible"; fi

say "--- Form C end-to-end: full derive pipeline over a synthetic environ (all three fixtures) ---"
# Replicates fleet-health:562-565 byte-for-byte on a synthetic environ blob: shape-match, strip,
# CRED_NEEDED filter, baseline subtract (empty baseline => everything credential-shaped that is
# not CRED_NEEDED must emerge as "new").
derived=$(printf 'BOT_TOKEN=1:x\nBOT_TOKEN_EXTRA=y\nZZQ_SELFTEST_API_KEY=z\nUMAMI_ILHAM_KEYNOTE_WEBSITE_ID=id\nUMAMI_CLOUD_API_KEY=sek\nPATH=/usr/bin\n' \
  | grep -oE "^[A-Z0-9_]*${CRED_SHAPE}[A-Z0-9_]*=" | sed 's/=$//' \
  | grep -vE "^(${CRED_NEEDED})$" | sort -u)
# Exact-line matches (grep -x): a substring test here false-fires on BOT_TOKEN_EXTRA, which
# legitimately emerges and CONTAINS "BOT_TOKEN" — caught by this selftest's own first run.
if printf '%s\n' "$derived" | /usr/bin/grep -qx "$LEGIT"; then
  bad "pipeline: $LEGIT emerged as NEW-CREDENTIAL (would red-storm on clean baseline)"
else
  ok "pipeline: $LEGIT suppressed"
fi
if printf '%s\n' "$derived" | /usr/bin/grep -qx "$COLLIDE"; then
  ok "pipeline: $COLLIDE emerges (prefix-collision not over-suppressed)"
else
  bad "pipeline: $COLLIDE did NOT emerge — over-suppression at the pipeline layer"
fi
if printf '%s\n' "$derived" | /usr/bin/grep -qx "$ORDINARY"; then
  ok "pipeline: $ORDINARY emerges (known-positive for detection)"
else
  bad "pipeline: $ORDINARY did NOT emerge — pipeline is blind, not clean"
fi
if printf '%s\n' "$derived" | /usr/bin/grep -qx "$PUBLICID"; then
  bad "pipeline: $PUBLICID emerged as NEW-CREDENTIAL — public-ID exemption not applied end-to-end"
else
  ok "pipeline: $PUBLICID suppressed (public-ID exemption holds end-to-end)"
fi
if printf '%s\n' "$derived" | /usr/bin/grep -qx "$REALSECRET"; then
  ok "pipeline: $REALSECRET emerges (real UMAMI secret still detected)"
else
  bad "pipeline: $REALSECRET did NOT emerge — exemption swallowed a genuine credential"
fi

say "--- Coverage: call sites derived by GREP at selftest time, not carried as a number ---"
# The three forms above were enumerated from the call sites as of 2026-07-20. An enumerated list
# rots the day a fourth site is added, and the selftest would then report full coverage of a set
# that has grown (chief, tonight, four instances of exactly this). So: derive the live call sites
# here, and go RED on ANY drift from the pinned set — the RED means "a call site changed; read it,
# extend the forms above, then re-pin". /usr/bin/grep because orgs/ is gitignored and the ugrep
# shim silently skips it (banked 2026-07-09).
ORG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
sites=$(find "$ORG_ROOT" -name '*.sh' -not -name 'cred-matcher.sh' -not -name 'cred-matcher-selftest.sh' -print0 2>/dev/null \
  | xargs -0 /usr/bin/grep -l '\${\?CRED_NEEDED' 2>/dev/null | sort)
expected_sites="$ORG_ROOT/agents/analyst/workspace/fleet-health-check.sh
$ORG_ROOT/scripts/cred-scan.sh"
if [ "$sites" = "$expected_sites" ]; then
  ok "call-site files match pinned set (cred-scan.sh, fleet-health-check.sh)"
else
  bad "call-site DRIFT — files consuming CRED_NEEDED no longer match the pinned set."
  say "       found:    $(printf '%s' "$sites" | tr '\n' ' ')"
  say "       expected: $(printf '%s' "$expected_sites" | tr '\n' ' ')"
  say "       => read the new/changed site, add its input shape as a form above, re-pin this list."
fi
# Per-file functional-use counts (a NEW use inside a known file must also trip):
n_scan=$(/usr/bin/grep -c '\${\?CRED_NEEDED' "$ORG_ROOT/scripts/cred-scan.sh" 2>/dev/null || echo 0)
n_fh=$(/usr/bin/grep -c '\${\?CRED_NEEDED' "$ORG_ROOT/agents/analyst/workspace/fleet-health-check.sh" 2>/dev/null || echo 0)
if [ "$n_scan" = "1" ] && [ "$n_fh" = "3" ]; then
  ok "per-file use counts match pinned (cred-scan 1; fleet-health 3 = A1 filter, stripped filter, display)"
else
  bad "use-count DRIFT (cred-scan $n_scan want 1; fleet-health $n_fh want 3) — a use was added/removed; re-derive the forms."
fi
# Control the coverage detector itself: it must be able to see a use at all.
if printf 'x | grep -vE "$CRED_NEEDED" |\n' | /usr/bin/grep -q '\${\?CRED_NEEDED'; then
  ok "coverage detector control: fires on a known use-shaped line"
else
  bad "coverage detector control FAILED — the grep sees nothing; all coverage verdicts above are void"
fi

say "---"
if [ "$fail" -gt 0 ]; then say "SELFTEST: $fail RED"; exit 2; fi
say "SELFTEST: ALL PASS (3 forms both directions, pipeline end-to-end, coverage derived by grep)"
