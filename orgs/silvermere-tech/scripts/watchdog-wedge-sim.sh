#!/usr/bin/env bash
# watchdog-wedge-sim.sh — LIVE verify-by-effect for the freeze-escalation fix (task_1784498912934).
#
# WHAT IT PROVES: with the wedged agent being the ORCHESTRATOR itself (chief), the rung-3
# escalation pages the operator Telegram chat — the branch that was a silent early-return until
# commit 6f1df99. Verified by EFFECT (a real alert a human can see), never by reading the branch.
#
# ⚠️ RUNS ONLY AT AN ANNOUNCED DEPLOY WINDOW (Steve-cleared, daylight). It restarts the daemon
# twice, restarts chief 2-3 times (rung 2 wipes chief's context BY DESIGN — chief must checkpoint
# memory first, and running right after the deploy restart makes the wipe nearly free), and lands
# one 🚨 test page on the operator chat. Requires --announced to do anything.
#
# DESIGN RULES BAKED IN (all from 2026-07-19/20 rulings, do not relax):
#   R1  STRUCTURAL RESTORE: restore runs in an EXIT trap — it happens even if the sim dies mid-way.
#       PASS is only printable after restore asserts; a missed restore cannot exit 0.
#   R2  ABSENCE ASSERTS GO THROUGH resolve-probe.sh (sourced, not copied): an unreadable /proc,
#       wrong pid, or vanished process is TARGET-UNRESOLVABLE(2), never ABSENT. The failure string
#       of a bare grep is identical to its success string; the probe is what separates them.
#   R3  KNOWN-GOOD CONTROL BEFORE ANY ABSENCE VERDICT: the env probe must first FIRE on a process
#       we know carries CTX_WATCHDOG_* — a check never seen firing proves nothing by silence.
#   R4  dump.pm2 BYTE CHECK: pm2 persists the calling shell's env; a sim var that leaked into the
#       saved dump would resurrect the short profile on any later pm2 resurrect. Assert absence at
#       the BYTE layer of the dump file, control-tested (R3 applies).
#   R5  ALL STIMULUS IS REAL: real scheduler fires (temporary 2m heartbeat schedule on chief),
#       real SIGSTOP wedge, real daemon, real Telegram. No synthetic rows in any daemon-owned log
#       (test-cron-fire does NOT write fired-rows — verified in src/daemon/ipc-server.ts:67-110 —
#       so manual fires are invisible to the watchdog and are NOT used here).
#   R6  CLOSURE = HUMAN CONFIRMATION. The harness can prove the daemon SENT (log line + curl rc);
#       only a human can prove it ARRIVED where humans look. Final verdict is PASS-PENDING-HUMAN
#       until the operator confirms the 🚨 message; hold the ticket open until then.
#
# Usage:  bash watchdog-wedge-sim.sh --announced [--agent chief] [--timeout-min 20]
#         CTX_ROOT must be the instance root (defaults to ~/.cortextos/default).

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRAMEWORK_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CTX_ROOT="${CTX_ROOT:-$HOME/.cortextos/default}"
SUBJECT="chief"
TIMEOUT_MIN=20
ANNOUNCED=0
for a in "$@"; do case "$a" in
  --announced) ANNOUNCED=1;;
  --agent) :;; --agent=*) SUBJECT="${a#*=}";;
  --timeout-min=*) TIMEOUT_MIN="${a#*=}";;
esac; done

say(){ printf '[wedge-sim] %s\n' "$*"; }
die(){ say "ABORT: $*"; exit 2; }

[ "$ANNOUNCED" = 1 ] || die "refusing to run without --announced (deployment protocol: pre-notice + Steve ack first)"

# R2: the org probe predicate. Sourcing failure is itself a die — a missing probe must not
# degrade into bare greps.
PROBE="$SCRIPT_DIR/resolve-probe.sh"
[ -r "$PROBE" ] || die "resolve-probe.sh missing/unreadable at $PROBE — absence asserts have no instrument"
# shellcheck disable=SC1090
. "$PROBE" || die "sourcing resolve-probe.sh failed"

DAEMON_PM2_NAME="cortextos-daemon"
SHORT_PROFILE="CTX_WATCHDOG_CHECK_MS=10000 CTX_WATCHDOG_GRACE_MS=30000 CTX_WATCHDOG_VERIFY_MS=20000"
PROD_START_RE='started \(check 60s, grace 10m, N=2\)'
SHORT_START_RE='started \(check 10s, grace 0m, N=2\)|started \(check 10s'

daemon_pid(){ pm2 jlist 2>/dev/null | python3 -c "import json,sys; ps=[p for p in json.load(sys.stdin) if p['name']=='$DAEMON_PM2_NAME']; print(ps[0]['pid'] if ps and ps[0]['pid'] else '')"; }
subject_pid(){
  for p in $(pgrep -u "$(id -un)" -f claude 2>/dev/null); do
    if tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | /usr/bin/grep -qx "CTX_AGENT_NAME=$SUBJECT"; then echo "$p"; return 0; fi
  done; return 1
}
# env_has PID VARPREFIX -> 0 present, 1 absent, 2 unresolvable (R2 semantics via probe_cmd)
env_has(){
  local pid="$1" pref="$2"
  [ -n "$pid" ] || return 2
  [ -r "/proc/$pid/environ" ] || return 2
  local n
  n=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | /usr/bin/grep -c "^${pref}") || n=0
  [ "$n" -gt 0 ] && return 0 || return 1
}

ORIG_SCHEDULE=""   # captured before mutation, restored in trap
RESTORED=0
restore(){
  [ "$RESTORED" = 1 ] && return
  RESTORED=1
  say "=== STRUCTURAL RESTORE (EXIT trap — runs regardless of how the sim ended) ==="
  # 1. un-wedge: SIGCONT anything stopped, then a clean subject restart.
  local sp; sp=$(subject_pid || true)
  [ -n "${sp:-}" ] && kill -CONT "$sp" 2>/dev/null && say "SIGCONT sent to $SUBJECT pid $sp"
  cortextos restart "$SUBJECT" >/dev/null 2>&1 && say "$SUBJECT restarted clean"
  # 2. restore the heartbeat schedule from the value captured at start (never from memory).
  if [ -n "$ORIG_SCHEDULE" ]; then
    cortextos bus update-cron "$SUBJECT" heartbeat --schedule "$ORIG_SCHEDULE" >/dev/null 2>&1
    local now_sched
    now_sched=$(cortextos bus list-crons "$SUBJECT" 2>/dev/null | /usr/bin/grep -E '^\s*heartbeat' | awk '{print $2}')
    if [ "$now_sched" = "$ORIG_SCHEDULE" ]; then say "heartbeat schedule restored: $now_sched"; else say "RED: heartbeat schedule is '$now_sched', wanted '$ORIG_SCHEDULE' — FIX BY HAND NOW"; FAILED=1; fi
  fi
  # 3. daemon back to production profile: restart from a shell with the vars EXPLICITLY UNSET.
  env -u CTX_WATCHDOG_CHECK_MS -u CTX_WATCHDOG_GRACE_MS -u CTX_WATCHDOG_VERIFY_MS \
      -u CTX_WATCHDOG_WINDOW_MS -u CTX_WATCHDOG_FREEZE_N \
      pm2 restart "$DAEMON_PM2_NAME" --update-env >/dev/null 2>&1
  sleep 5
  local dp; dp=$(daemon_pid)
  # R3 known-good control FIRST: the probe must fire where the var is known present.
  ( CTX_WATCHDOG_CHECK_MS=99999 sleep 15 & echo $! > /tmp/wedge-ctrl.pid ) ; local cpid; cpid=$(cat /tmp/wedge-ctrl.pid)
  sleep 0.3
  env_has "$cpid" "CTX_WATCHDOG_"; local rc=$?
  kill "$cpid" 2>/dev/null
  if [ "$rc" != 0 ]; then say "RED: known-good control did NOT fire (rc=$rc) — absence verdicts below are VOID, treat profile as UNKNOWN"; FAILED=1; fi
  # absence assert on the live daemon (R2: 2 = unresolvable, never absent)
  env_has "$dp" "CTX_WATCHDOG_"; rc=$?
  case "$rc" in
    1) say "daemon env clean of CTX_WATCHDOG_* (pid $dp) — production profile";;
    0) say "RED: daemon pid $dp STILL carries CTX_WATCHDOG_* — short profile live, FIX BY HAND NOW"; FAILED=1;;
    2) say "RED: daemon env UNRESOLVABLE (pid '$dp') — cannot claim restored; treat as NOT restored"; FAILED=1;;
  esac
  # 4. R4 byte check on the pm2 dump (control-tested: the grep must find a known marker we add+remove).
  local dump="$HOME/.pm2/dump.pm2"
  if [ -r "$dump" ]; then
    if /usr/bin/grep -q 'CTX_WATCHDOG_' "$dump"; then
      say "RED: dump.pm2 carries CTX_WATCHDOG_* — a pm2 resurrect would resurrect the short profile. Clean-env 'pm2 save' needed, then re-check."
      FAILED=1
    else
      printf 'CTX_WATCHDOG_CANARY' | /usr/bin/grep -q 'CTX_WATCHDOG_' && say "dump.pm2 clean of CTX_WATCHDOG_* (byte layer, detector control fired)" \
        || { say "RED: dump byte-detector control failed — dump verdict VOID"; FAILED=1; }
    fi
  else
    say "RED: dump.pm2 unreadable — byte-layer verdict UNRESOLVABLE, not clean"; FAILED=1
  fi
  # 5. start-line echo (record of the running config — secondary to the /proc read, kept for humans)
  pm2 logs "$DAEMON_PM2_NAME" --lines 200 --nostream 2>/dev/null | /usr/bin/grep -E "$PROD_START_RE" | tail -1 \
    && say "start line shows production profile" || { say "RED: no production start line found in recent daemon log"; FAILED=1; }
  # 6. no collateral: no OTHER agent got watchdog-restarted during the sim window.
  say "collateral check: watchdog events for non-$SUBJECT agents since sim start:"
  local evroot="$CTX_ROOT/orgs"
  find "$evroot" -path '*analytics/events/*' -name "$(date -u +%Y-%m-%d).jsonl" 2>/dev/null \
    | /usr/bin/grep -v "/events/$SUBJECT/" \
    | xargs -r /usr/bin/grep -l 'watchdog_auto_restart' 2>/dev/null \
    | while read -r f; do say "RED: collateral watchdog restart in $f"; done
}
FAILED=0
trap restore EXIT

say "=== PREFLIGHT ==="
# P1: the running daemon must BE the fixed build (green tick on a different program = void).
DP=$(daemon_pid); [ -n "$DP" ] || die "no running $DAEMON_PM2_NAME"
DIST="$FRAMEWORK_ROOT/dist/daemon.js"
/usr/bin/grep -q 'deriveFrozenEscalationTarget' "$DIST" || die "dist/daemon.js lacks the fix symbol — deploy the build first (known-positive absent)"
/usr/bin/grep -q 'THIS_STRING_MUST_NOT_EXIST_ANYWHERE' "$DIST" && die "known-negative control matched — grep is void"
DIST_MTIME=$(stat -c %Y "$DIST"); DSTART=$(stat -c %Y "/proc/$DP" 2>/dev/null || echo 0)
[ "$DSTART" -gt "$DIST_MTIME" ] || die "daemon (proc start $DSTART) predates dist build ($DIST_MTIME) — it is running the OLD code; restart it via the announced deploy first"
say "preflight ok: daemon pid $DP runs a build containing the fix"

# P2: capture the real schedule BEFORE mutating (restore source of truth).
ORIG_SCHEDULE=$(cortextos bus list-crons "$SUBJECT" 2>/dev/null | /usr/bin/grep -E '^\s*heartbeat' | awk '{print $2}')
[ -n "$ORIG_SCHEDULE" ] || die "cannot read $SUBJECT heartbeat schedule — nothing to restore to"
say "captured $SUBJECT heartbeat schedule: $ORIG_SCHEDULE"

say "=== PHASE 1: short watchdog profile + fast stimulus ==="
cortextos bus update-cron "$SUBJECT" heartbeat --schedule 2m || die "failed to set 2m heartbeat schedule"
eval "env $SHORT_PROFILE pm2 restart $DAEMON_PM2_NAME --update-env" >/dev/null || die "daemon restart (short profile) failed"
sleep 5
DP=$(daemon_pid)
env_has "$DP" "CTX_WATCHDOG_"; rc=$?
[ "$rc" = 0 ] || die "short profile NOT present in daemon env (rc=$rc) — sim cannot proceed"
say "short profile live on daemon pid $DP"

say "=== PHASE 2: wedge $SUBJECT (SIGSTOP), re-wedge each respawn, await rung-3 ==="
SP=$(subject_pid) || die "no live $SUBJECT claude pid"
kill -STOP "$SP" || die "SIGSTOP failed"
say "wedged $SUBJECT pid $SP at $(date -u +%H:%M:%SZ)"
DEADLINE=$(( $(date +%s) + TIMEOUT_MIN*60 ))
EVFILE="$CTX_ROOT/orgs/silvermere-tech/analytics/events/$SUBJECT/$(date -u +%Y-%m-%d).jsonl"
ESCALATED=0
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  # rung-3 escalation event?
  if [ -f "$EVFILE" ] && /usr/bin/grep -q '"event":"watchdog_recovery_failed".*"escalated":true' "$EVFILE"; then ESCALATED=1; break; fi
  # respawned subject? re-wedge it (a restarted chief answers, and the ladder never reaches rung 3)
  NEWSP=$(subject_pid || true)
  if [ -n "${NEWSP:-}" ] && [ "$NEWSP" != "$SP" ]; then
    sleep 2; kill -STOP "$NEWSP" 2>/dev/null && { SP="$NEWSP"; say "re-wedged respawned $SUBJECT pid $SP"; }
  fi
  sleep 5
done
[ "$ESCALATED" = 1 ] || { say "FAIL: no rung-3 escalation within ${TIMEOUT_MIN}m — read $EVFILE and daemon log"; exit 2; }
say "rung-3 escalation event observed"

say "=== PHASE 3: the effect — did the operator page LEAVE the daemon? ==="
if pm2 logs "$DAEMON_PM2_NAME" --lines 300 --nostream 2>/dev/null | /usr/bin/grep -q 'Watchdog escalation sent to operator chat'; then
  say "daemon log confirms operator send (curl rc=0)"
else
  say "FAIL: no 'Watchdog escalation sent to operator chat' line — send did not happen or failed; check for 'OPERATOR PAGE FAILED' / creds"
  exit 2
fi

say "=== VERDICT: PASS-PENDING-HUMAN ==="
say "The machine half is proven: detection -> ladder -> subject==orchestrator branch -> operator send."
say "CLOSURE (R6): a human confirms the 🚨 WATCHDOG ESCALATION message is visible on the operator"
say "Telegram chat. Until that confirmation lands, the ticket stays open. Restore asserts follow."
# exit 0 only if restore (trap) also stays green — FAILED is evaluated after trap runs via exit code:
trap - EXIT; restore
[ "$FAILED" = 0 ] && { say "RESTORE ASSERTS ALL GREEN"; exit 0; } || { say "RESTORE HAD REDS — fix by hand before leaving the window"; exit 2; }
