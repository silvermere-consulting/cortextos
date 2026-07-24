#!/usr/bin/env bash
# contact-clock — resolve the USER-CONTACT day/night decision.
#
# WHICH CLOCK DECIDES WHAT (operating model §4, Steve 2026-07-23):
#   * USER-CONTACT decisions — "do I message Steve right now?", the boot ping,
#     any user-facing send — are keyed to the HUMAN's clock: context.json
#     `user_timezone`, read FRESH, honouring `user_timezone_until`.
#   * AGENT OPERATING HOURS — when an agent works, cron scheduling, infra
#     timing — stay keyed to $CTX_TIMEZONE. This script is NOT for those.
#
# WHY NOT $CTX_TIMEZONE FOR CONTACT: Dubai runs 3h ahead of London, so an
# 08:00-22:00 window keyed to Dubai is wrong in BOTH directions — day would
# start at 05:00 UK (a 5am boot ping) and night at 19:00 UK (silence while he
# is still working). That is the exact failure §4 was written to kill.
#
# WHY NOT $CTX_USER_TIMEZONE ALONE: it is captured into the PTY env at spawn and
# carries a dated expiry (user_timezone_until — the UK trip ends 2026-07-28).
# An agent running past that date would keep using a clock the user has left.
# This reads context.json fresh every call, so the expiry actually takes effect.
#
# FAIL-CLOSED: if the contact clock cannot be resolved, the answer is NIGHT.
# Staying silent when unsure is recoverable; a 3am ping is not.
#
# Usage:  bash "$CTX_FRAMEWORK_ROOT/scripts/contact-clock.sh"
# Output: "<HH:MM> <ZONE> <DAY|NIGHT>"  e.g. "11:24 BST DAY"
# Exit:   0 = DAY, 1 = NIGHT (including every fail-closed path)

set -uo pipefail
ROOT="${CTX_FRAMEWORK_ROOT:-/home/cortext/cortextos}"
ORG="${CTX_ORG:-}"
CTXFILE="$ROOT/orgs/$ORG/context.json"

DAY_START="${CONTACT_DAY_START:-08}"
DAY_END="${CONTACT_DAY_END:-22}"   # exclusive upper bound

fail_closed() {
  echo "unresolved - NIGHT (fail-closed: $1)"
  exit 1
}

[ -n "$ORG" ] || fail_closed "CTX_ORG unset"
[ -f "$CTXFILE" ] || fail_closed "no context.json at $CTXFILE"

# Resolve the contact zone: user_timezone if present and not expired, else the
# org timezone. Node is used for JSON so a malformed file fails loudly here
# rather than silently yielding an empty zone.
ZONE=$(node -e '
const fs = require("fs");
try {
  const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const today = new Date().toISOString().slice(0, 10);   // UTC date, stable
  let z = c.user_timezone || "";
  if (z && c.user_timezone_until && today > c.user_timezone_until) z = "";
  process.stdout.write(z || c.timezone || "");
} catch (e) { process.stdout.write(""); }
' "$CTXFILE" 2>/dev/null)

[ -n "$ZONE" ] || fail_closed "no user_timezone or timezone in context.json"

NOW=$(TZ="$ZONE" date +'%H:%M %Z' 2>/dev/null) || fail_closed "invalid zone '$ZONE'"
HOUR=$(TZ="$ZONE" date +'%H' 2>/dev/null) || fail_closed "invalid zone '$ZONE'"
HOUR=$((10#$HOUR))

if [ "$HOUR" -ge "$((10#$DAY_START))" ] && [ "$HOUR" -lt "$((10#$DAY_END))" ]; then
  echo "$NOW DAY"
  exit 0
fi
echo "$NOW NIGHT"
exit 1
