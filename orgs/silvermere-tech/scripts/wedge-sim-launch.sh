#!/usr/bin/env bash
# wedge-sim-launch.sh — durable launcher for watchdog-wedge-sim.sh (task_1784538367178).
#
# WHY THIS EXISTS: the wedge-sim's Phase 1 restarts the daemon, which kills every agent PTY —
# including the shell that launched the sim. A plain `setsid bash sim &` from an agent PTY is
# still torn down when the daemon kills the PTY tree (proven twice, 2026-07-20: both live runs
# died at the Phase-1 daemon-restart boundary before the restore trap could fire, once stranding
# a short watchdog profile in pm2's stored env for ~93 min).
#
# THE FIX, PROVEN BY ANCESTRY (non-destructive test, 2026-07-20):
#   agent PTY:            systemd(1) -> PM2 God -> node daemon -> claude -> bash(sim)
#   systemd-run --user:   systemd(1) -> systemd --user -> sim
# A systemd-run --user transient unit is owned by the USER systemd manager, NOT the daemon's
# process tree, so the daemon's PTY-tree kill cannot reach it. It survives the Phase-1 restart
# and runs to completion (Phase 2 wedge + the EXIT-trap restore). Linger=yes (loginctl) means the
# user manager persists without a login session.
#
# ⚠️ RUNS ONLY AT AN ANNOUNCED, STEVE-CLEARED WINDOW — it restarts the daemon and cycles the fleet.
#    This wrapper does not relax that; watchdog-wedge-sim.sh still requires --announced.
#
# Usage:  bash wedge-sim-launch.sh --announced [--agent chief] [--timeout-min 20]
#   Then monitor:  journalctl --user -u <printed-unit> -f
#   The launching shell may die when the sim restarts the daemon — that is expected and is the
#   whole point; the sim keeps running under systemd --user. Read the journal on your next boot.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIM="$SCRIPT_DIR/watchdog-wedge-sim.sh"
[ -r "$SIM" ] || { echo "[launch] ABORT: sim not found at $SIM" >&2; exit 2; }

# systemd --user reachability (banked 2026-07-06: agent shells lack the DBus session address).
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/1001}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/1001/bus}"
if ! systemctl --user is-system-running >/dev/null 2>&1; then
  echo "[launch] ABORT: systemd --user not reachable (XDG_RUNTIME_DIR/DBUS). Cannot launch durably." >&2
  exit 2
fi

# The sim needs a real env inside the transient unit — a systemd-run unit starts near-empty, and
# a sim that cannot reach pm2/docker/cortextos would fail at Phase 1 (the env-hygiene lesson: the
# unit must CARRY what it needs, not inherit it). Pass exactly what the sim's commands require:
#   PATH (node/pm2/cortextos/docker/curl), HOME, DOCKER_HOST (rootless), CTX_ROOT, the systemd
#   --user address vars, and the two watchdog-relevant CTX vars the sim reads for org resolution.
UNIT="wedge-sim-$(date -u +%H%M%S 2>/dev/null || echo run)"
# NOTE: date is fine here (real launch, not a resumable workflow); the unit name only needs to be unique.

echo "[launch] starting wedge-sim under systemd --user as unit: $UNIT.service"
echo "[launch] it will survive the Phase-1 daemon restart that kills this shell — read progress with:"
echo "[launch]   journalctl --user -u $UNIT -f    (or -e after your session re-spawns)"

systemd-run --user --unit="$UNIT" \
  --property=Type=simple \
  --property=StandardOutput=journal \
  --property=StandardError=journal \
  --setenv=PATH="$PATH" \
  --setenv=HOME="$HOME" \
  --setenv=DOCKER_HOST="${DOCKER_HOST:-unix:///run/user/1001/docker.sock}" \
  --setenv=CTX_ROOT="${CTX_ROOT:-$HOME/.cortextos/default}" \
  --setenv=XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
  --setenv=DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" \
  /usr/bin/env bash "$SIM" "$@"
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "[launch] systemd-run failed (rc=$rc) — sim NOT started; nothing to clean up" >&2
  exit "$rc"
fi
echo "[launch] launched. The unit outlives this shell. After the run: journalctl --user -u $UNIT -e"
echo "[launch] and 'systemctl --user reset-failed $UNIT' once you have read the result."
