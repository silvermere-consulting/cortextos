#!/usr/bin/env bash
# Gathered-release POST-RESTART live verify.
#
# Run this AFTER the release daemon restart. It exercises the live fleet — the
# layer unit tests structurally cannot reach — and blocks (exit 2) if any arm is
# not actually live. It is the standing home for checks that must fire EVERY
# release: a runnable-but-uncalled guard is furniture, so the call-site guard
# (verify-user-tz-live.sh) lives HERE, in the verify path, where its exit-2
# blocks a bad release rather than sitting invoked-by-nobody.
#
# Aggregation is DERIVED, not asserted: each arm increments `fail` on failure and
# the verdict reads `fail` — never a hardcoded green beside checks it did not read
# (the 2026-07-14 release-window false-green lesson). CANNOT-TELL counts as fail.
#
# Read-only / side-effect-free except collect-memory-sample (appends one history
# row — benign). Exit 0 = release live+verified; exit 2 = a check failed / could
# not be told.
set -uo pipefail
ROOT="${CTX_FRAMEWORK_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
fail=0
arm() { # arm "<name>" <exit-code-of-check> "<detail>"
  if [ "$2" -eq 0 ]; then echo "  ✔ $1: $3"; else echo "  ✖ $1: $3"; fail=$((fail+1)); fi
}

echo "═══ GATHERED-RELEASE VERIFY (post-restart, live) ═══"

# 1. Daemon health — online + no boot-loop.
dstat="$(pm2 jlist 2>/dev/null | python3 -c "
import json,sys
p=[x for x in json.load(sys.stdin) if x['name']=='cortextos-daemon']
if not p: print('MISSING 0'); sys.exit()
e=p[0]['pm2_env']; print(e.get('status','?'), e.get('unstable_restarts', e.get('restart_time',0)))" 2>/dev/null)"
read -r dstatus dunstable <<<"${dstat:-MISSING 0}"
[ "$dstatus" = "online" ]; arm "daemon" $? "status=$dstatus unstable_restarts=${dunstable}"

# 2. user-tz CALL-SITE — the arm-4 residual guard, WIRED here so it fires every release.
CTX_FRAMEWORK_ROOT="$ROOT" bash "$ROOT/scripts/verify-user-tz-live.sh" >/tmp/.rv-utz 2>&1
arm "user-tz call-site" $? "$(tail -1 /tmp/.rv-utz)"; rm -f /tmp/.rv-utz

# 3. slope arm — feed is live+accruing. READ-ONLY (does NOT run collect-memory-sample:
#    that WRITES to the shared history file, which analyst solely owns since 2026-07-15;
#    a release-verify must not become a second writer). Assert the history JSONL exists
#    and is non-empty = the analyst-owned sampler is feeding the arm.
python3 -c "
import os,sys
p=os.path.join(os.environ.get('CTX_ROOT', os.path.expanduser('~/.cortextos/default')),'analytics','memory-history.jsonl')
sys.exit(0 if os.path.exists(p) and os.path.getsize(p)>0 else 1)" 2>/dev/null
arm "slope-arm (feed accruing)" $? "history JSONL present + non-empty (analyst-owned feed live)"

# 4. allowlist — auto-commit --dry-run carries blocked_text (the incident-signal field).
cortextos bus auto-commit --dry-run 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if 'blocked_text' in d else 1)" 2>/dev/null
arm "allowlist (blocked_text)" $? "incident-signal field present"

# 5. goal-staleness — never-certify-fresh shape live.
cortextos bus check-goal-staleness 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if 'unverified' in d.get('summary',{}) else 1)" 2>/dev/null
arm "goal-staleness (never-fresh)" $? "refusal-state shape live"

echo "───────────────────────────────────────────────────"
if [ "$fail" -eq 0 ]; then
  echo "RELEASE VERIFY: PASS — all $(( 5 )) arms live (verdict derived from the checks above)."
  exit 0
else
  echo "RELEASE VERIFY: FAIL — $fail arm(s) not live. Do NOT declare the release verified. See ✖ above."
  exit 2
fi
