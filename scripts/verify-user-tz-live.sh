#!/usr/bin/env bash
# Deploy-verify: the user-tz call-site is LIVE on freshly-spawned agents.
#
# The unit test (tests/unit/utils/env-org-context.test.ts) guards the SEAM —
# readOrgContext/applyOrgContext — but it cannot harness the daemon's call SITE
# (agent-manager building each agent's env via applyOrgContext) without spinning
# the daemon. This script is that second layer: run it AFTER a gathered-release
# daemon restart to assert the call-site actually fires. It is the same
# fresh-spawn observation that caught the 2026-07-14 arm-4 silent no-op live,
# made STANDING so a future call-site deletion is caught every release, not by
# luck.
#
# Contract: for every org whose context.json sets `user_timezone`, every running
# agent in that org MUST carry CTX_USER_TIMEZONE in its /proc/<pid>/environ.
# Absent = the arm-4 no-op is back (env built, context not applied). Read-only.
# Exit 0 = live; exit 2 = a configured org has an agent missing the injection.
set -uo pipefail

ROOT="${CTX_FRAMEWORK_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ORGS_DIR="$ROOT/orgs"
fail=0
checked=0

# Which orgs are user-tz-configured? (only those have a call-site to verify)
declare -A org_utz
if [ -d "$ORGS_DIR" ]; then
  for ctx in "$ORGS_DIR"/*/context.json; do
    [ -f "$ctx" ] || continue
    org="$(basename "$(dirname "$ctx")")"
    utz="$(python3 -c "import json,sys; print(json.load(open('$ctx')).get('user_timezone','') or '')" 2>/dev/null)"
    [ -n "$utz" ] && org_utz["$org"]="$utz"
  done
fi

if [ ${#org_utz[@]} -eq 0 ]; then
  echo "verify-user-tz-live: no org sets user_timezone — nothing to verify (vacuously OK)."
  exit 0
fi

# For every running claude agent, read CTX_ORG + CTX_USER_TIMEZONE from /proc.
for pid in $(pgrep -u "$(id -u)" -x claude 2>/dev/null); do
  environ="/proc/$pid/environ"
  [ -r "$environ" ] || continue
  agent="$(tr '\0' '\n' < "$environ" | sed -n 's/^CTX_AGENT_NAME=//p' | head -1)"
  org="$(tr '\0' '\n' < "$environ" | sed -n 's/^CTX_ORG=//p' | head -1)"
  utz="$(tr '\0' '\n' < "$environ" | sed -n 's/^CTX_USER_TIMEZONE=//p' | head -1)"
  [ -n "$org" ] || continue
  expected="${org_utz[$org]:-}"
  [ -n "$expected" ] || continue   # org has no user_timezone → agent correctly has none
  checked=$((checked+1))
  if [ "$utz" = "$expected" ]; then
    echo "  ✔ $agent ($org): CTX_USER_TIMEZONE=$utz"
  else
    echo "  ✖ $agent ($org): CTX_USER_TIMEZONE='${utz:-<ABSENT>}' but context.json says '$expected' — CALL-SITE NO-OP (arm-4 regression)"
    fail=1
  fi
done

if [ "$checked" -eq 0 ]; then
  echo "verify-user-tz-live: no running agent in a user-tz-configured org — CANNOT-TELL (spawn one, then re-run)."
  exit 2   # cannot-tell is not a pass
fi
if [ "$fail" -ne 0 ]; then
  echo "verify-user-tz-live: FAIL — a configured org has an agent missing CTX_USER_TIMEZONE. The daemon call-site (applyOrgContext) did not fire."
  exit 2
fi
echo "verify-user-tz-live: PASS — every agent in a user-tz-configured org carries CTX_USER_TIMEZONE. Call-site live."
exit 0
