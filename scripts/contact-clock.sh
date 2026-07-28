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

# ── FLIP OBSERVABILITY ────────────────────────────────────────────────────────
# The expiry above is a DATED ASSUMPTION wearing the shape of a control: when
# `user_timezone_until` passes, the contact clock silently reverts to the org
# zone. That is correct only if the user is genuinely back by that date. If the
# trip extends by even a day, the fleet quietly resumes the exact bug removed on
# 2026-07-24 — pings at 05:00 their time, silence from 19:00 — and nothing says
# so, because from the script's point of view nothing is wrong. It keeps printing
# a healthy-looking DAY/NIGHT the entire time.
#
# So the flip ANNOUNCES ITSELF, once, the first time it is observed.
#
# Why compare-to-last-seen rather than fire-on-the-date: the announcement must
# survive nobody booting on the day it flips. Comparing the resolved zone to the
# last one recorded means the notice fires on the first observation AFTER the
# change, whenever that happens — a quiet weekend cannot swallow it.
#
# State is SHARED across agents (not per-agent) so the fleet announces once, not
# once per agent. The mkdir lock is the atomic compare-and-swap: whoever creates
# the directory owns the announcement, everyone else silently moves on.
#
# Every step here is best-effort and must never affect the exit code — this
# function's job is to be noticed, not to be load-bearing. A clock that refuses
# to tell the time because it could not send a message is worse than the drift.
announce_flip_if_changed() {
  # State dir is env-overridable so a CONTROL TEST of this alarming arm can point at a SCRATCH
  # dir and never consume/misfire the real one-shot (added 2026-07-28: chief's flip-simulation
  # wrote Asia/Dubai into the live .contact-clock-zone and, unrestored, tomorrow's genuine flip
  # would have found last==new and SILENTLY NOT FIRED — disarming the one-shot for the one day it
  # matters, while testing the fix for that day). Route the STATE away from live, not just the send.
  local statedir="${CONTACT_CLOCK_STATE_DIR:-${CTX_ROOT:-$HOME/.cortextos/default}/state}"
  local zonefile="$statedir/.contact-clock-zone"
  local lockdir="$statedir/.contact-clock-zone.lock"
  [ -d "$statedir" ] || return 0

  local last=""
  [ -f "$zonefile" ] && last=$(cat "$zonefile" 2>/dev/null)

  # First ever run: record silently. A "flip" from nothing is not a flip.
  if [ -z "$last" ]; then
    printf '%s' "$ZONE" > "$zonefile" 2>/dev/null
    return 0
  fi
  [ "$last" = "$ZONE" ] && return 0

  mkdir "$lockdir" 2>/dev/null || return 0   # someone else is announcing
  # Re-read under the lock — the winner may have already written it.
  last=$(cat "$zonefile" 2>/dev/null)
  if [ "$last" != "$ZONE" ]; then
    printf '%s' "$ZONE" > "$zonefile" 2>/dev/null
    local msg="CONTACT CLOCK FLIPPED: ${last} -> ${ZONE} (first observed $(date -u +%FT%TZ) by ${CTX_AGENT_NAME:-unknown}). This is the user_timezone_until expiry in orgs/*/context.json taking effect. It is CORRECT only if the user is actually in ${ZONE} now — if the trip moved, every user-facing day/night decision is now on the wrong clock and must be corrected in context.json."
    cortextos bus log-event action contact_clock_flip warning \
      --meta "{\"from\":\"${last}\",\"to\":\"${ZONE}\",\"agent\":\"${CTX_AGENT_NAME:-unknown}\"}" >/dev/null 2>&1
    cortextos bus send-message chief normal "$msg" >/dev/null 2>&1
    echo "$msg" >&2
  fi
  rmdir "$lockdir" 2>/dev/null
  return 0
}
announce_flip_if_changed || true

NOW=$(TZ="$ZONE" date +'%H:%M %Z' 2>/dev/null) || fail_closed "invalid zone '$ZONE'"
HOUR=$(TZ="$ZONE" date +'%H' 2>/dev/null) || fail_closed "invalid zone '$ZONE'"
HOUR=$((10#$HOUR))

if [ "$HOUR" -ge "$((10#$DAY_START))" ] && [ "$HOUR" -lt "$((10#$DAY_END))" ]; then
  echo "$NOW DAY"
  exit 0
fi
echo "$NOW NIGHT"
exit 1
