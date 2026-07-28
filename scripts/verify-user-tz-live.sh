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
# agent in that org MUST carry CTX_USER_TIMEZONE in its /proc/<pid>/environ, AND that
# injected value MUST equal the EFFECTIVE clock (the raw field, expiry-honoured against
# user_timezone_until, exactly as contact-clock.sh:53 resolves it).
#   · ABSENT              = the arm-4 no-op (env built, context not applied).
#   · PRESENT but != EFF  = the frozen-env divergence: the daemon injects the RAW field
#                           at spawn and it does not re-honour user_timezone_until, so once
#                           the override lapses a raw $CTX_USER_TIMEZONE reader (e.g. a cron
#                           STEP 0) computes off the wrong clock. Comparing against the RAW
#                           field (the pre-2026-07-28 behaviour) went BLIND at exactly that
#                           moment: London==London while the effective clock was already Dubai.
# Read-only. Exit 0 = live+correct; exit 2 = an agent is absent OR diverged from effective.
set -uo pipefail

ROOT="${CTX_FRAMEWORK_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ORGS_DIR="$ROOT/orgs"
fail=0
checked=0

# Which orgs are user-tz-configured, and what is each org's EFFECTIVE clock right now?
# effective = raw user_timezone, but if user_timezone_until is set and TODAY (UTC) is past
# it, the override has lapsed and the effective clock is the base `timezone` — the SAME
# resolution contact-clock.sh:53 does. We compare the injected env against EFFECTIVE, not
# the raw field, so this arm does not go blind the moment the override expires.
declare -A org_eff org_raw org_until org_expired
TODAY_UTC="$(date -u +%F)"
if [ -d "$ORGS_DIR" ]; then
  for ctx in "$ORGS_DIR"/*/context.json; do
    [ -f "$ctx" ] || continue
    org="$(basename "$(dirname "$ctx")")"
    # raw user_timezone, its expiry, and the base timezone — one read, '-' for absent.
    read -r raw until base < <(python3 -c "
import json
d=json.load(open('$ctx'))
print(d.get('user_timezone','') or '-', d.get('user_timezone_until','') or '-', d.get('timezone','') or '-')" 2>/dev/null)
    [ "${raw:--}" = "-" ] && continue          # no user_timezone override → nothing to verify
    org_raw["$org"]="$raw"; org_until["$org"]="$until"
    if [ "$until" != "-" ] && [[ "$TODAY_UTC" > "$until" ]]; then
      org_eff["$org"]="${base:-$raw}"; org_expired["$org"]=1   # override lapsed → base clock
    else
      org_eff["$org"]="$raw"; org_expired["$org"]=0
    fi
  done
fi

if [ ${#org_eff[@]} -eq 0 ]; then
  echo "verify-user-tz-live: no org sets user_timezone — nothing to verify (vacuously OK)."
  exit 0
fi

# For every running agent PTY, read CTX_ORG + CTX_USER_TIMEZONE from /proc.
# Agent PTYs are identified by their EXECUTABLE (the claude-code binary), NOT by comm:
# `pgrep -x claude` matched 0 after the 2026-07-28 claude->claude.exe comm rename
# (packaging), leaving this arm blind (checked=0 -> CANNOT-TELL) fleet-wide. The exe path
# is rename-proof (both live under .../claude-code/<ver>/); /proc/<pid>/exe is authoritative,
# not a cmdline guess. Same fix as release-window.sh:207.
for pid in $(pgrep -u "$(id -u)" 2>/dev/null); do
  case "$(readlink "/proc/$pid/exe" 2>/dev/null)" in
    */claude-code/*) : ;;
    *) continue ;;
  esac
  environ="/proc/$pid/environ"
  [ -r "$environ" ] || continue
  agent="$(tr '\0' '\n' < "$environ" | sed -n 's/^CTX_AGENT_NAME=//p' | head -1)"
  org="$(tr '\0' '\n' < "$environ" | sed -n 's/^CTX_ORG=//p' | head -1)"
  utz="$(tr '\0' '\n' < "$environ" | sed -n 's/^CTX_USER_TIMEZONE=//p' | head -1)"
  [ -n "$org" ] || continue
  eff="${org_eff[$org]:-}"
  [ -n "$eff" ] || continue        # org has no user_timezone override → agent correctly has none
  checked=$((checked+1))
  raw="${org_raw[$org]}"; until="${org_until[$org]}"
  if [ -z "$utz" ]; then
    echo "  ✖ $agent ($org): CTX_USER_TIMEZONE=<ABSENT> — CALL-SITE NO-OP (arm-4 regression: env built, context not applied)"
    fail=1
  elif [ "$utz" = "$eff" ]; then
    echo "  ✔ $agent ($org): CTX_USER_TIMEZONE=$utz (matches effective clock)"
  elif [ "${org_expired[$org]}" = "1" ]; then
    echo "  ✖ $agent ($org): CTX_USER_TIMEZONE='$utz' is the FROZEN RAW field, but the override EXPIRED (until=$until) so the effective clock is '$eff'. The daemon injects the raw field and never re-honours the expiry — any raw \$CTX_USER_TIMEZONE reader (cron STEP 0) is on the WRONG clock. Delegate such readers to contact-clock.sh."
    fail=1
  else
    echo "  ✖ $agent ($org): CTX_USER_TIMEZONE='$utz' but effective clock is '$eff' (raw='$raw', until=$until) — injected clock disagrees with context.json."
    fail=1
  fi
done

if [ "$checked" -eq 0 ]; then
  echo "verify-user-tz-live: no running agent in a user-tz-configured org — CANNOT-TELL (spawn one, then re-run)."
  exit 2   # cannot-tell is not a pass
fi
if [ "$fail" -ne 0 ]; then
  echo "verify-user-tz-live: FAIL — an agent's injected CTX_USER_TIMEZONE is ABSENT (call-site no-op) or DISAGREES with the effective, expiry-honoured clock (frozen raw env after an override lapse). See ✖ rows above; a diverged row means raw \$CTX_USER_TIMEZONE readers are on the wrong clock until context.json's field is changed or those readers delegate to contact-clock.sh."
  exit 2
fi
echo "verify-user-tz-live: PASS — every agent in a user-tz-configured org carries CTX_USER_TIMEZONE AND it matches the effective (expiry-honoured) clock."
exit 0
