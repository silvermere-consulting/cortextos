#!/usr/bin/env bash
# daemon-clean-start.sh — start cortextos-daemon with a MINIMAL env, clean by construction.
#
# WHY (task_1784538367100): `pm2 start ecosystem.config.js` captures the launching shell's ENTIRE
# environment. Agents/operators start the daemon from a shell that has sourced secrets.env and
# carries agent CTX_ vars, so the daemon ends up holding ~23 infra secrets, CLAUDE_* session
# handles, and leaked agent identity (CTX_AGENT_NAME). Those are INERT for agent spawning
# (agent-pty.ts getBaseEnv() is an allowlist + disk secrets, NOT wholesale inheritance) but are a
# standing least-privilege violation, and they are the mechanism behind the 2026-07-20 watchdog
# contamination and the Jul-14 dashboard CTX_AGENT_NAME. On 2026-07-20 a pm2 resurrect happened to
# restore a clean daemon from a pre-contamination dump — clean by LUCK-OF-THE-DUMP, not by design.
#
# THIS makes it clean by CONSTRUCTION: the same env-i + explicit keep-list pattern that
# agent-pty.ts:445 getBaseEnv() already applies to the AGENT boundary, applied to the DAEMON/pm2
# boundary — the one boundary that was still un-allowlisted. Copies the proven in-repo pattern
# rather than inventing one.
#
# KEEP-LIST = only what the daemon + pm2 need to run. Everything else (secrets, CLAUDE_*,
# CTX_AGENT_* / CTX_TELEGRAM_* / CTX_ORCHESTRATOR_* / CTX_DAY_MODE_* and any inherited CTX_ORG) is
# DROPPED by starting from a clean env; ecosystem.config.js re-provides exactly the 6 CTX_ vars the
# daemon needs (CTX_INSTANCE_ID/ROOT/FRAMEWORK_ROOT/PROJECT_ROOT/ORG=''/DEBUG). pm2 adds its own
# internal descriptor fields regardless (harmless).
#
# ⚠️ USING THIS RESTARTS THE DAEMON = cycles the whole fleet = a GATED deploy. It does pm2 delete +
#    clean start (delete because a plain restart re-reads pm2's stored env, and env -u is INERT
#    against --update-env — measured 2026-07-20). Requires --confirm to actually run; without it,
#    it prints the env it WOULD launch with and exits (the non-destructive self-test).
#
# Usage:
#   bash daemon-clean-start.sh              # DRY: print the clean env + ecosystem CTX vars, no change
#   bash daemon-clean-start.sh --confirm    # GATED: pm2 delete + clean start (announce first!)

set -u
FRAMEWORK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ECO="$FRAMEWORK_ROOT/ecosystem.config.js"
DAEMON=cortextos-daemon
CONFIRM=0
[ "${1:-}" = "--confirm" ] && CONFIRM=1

[ -r "$ECO" ] || { echo "ABORT: ecosystem.config.js not found at $ECO" >&2; exit 2; }

# Runtime vars the daemon+pm2 need that an agent/cron shell often lacks — default them (uid 1001,
# banked 2026-07-06) so the clean start is robust regardless of the launching shell, rather than
# silently dropping them because the caller happened not to export them.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/1001}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/1001/bus}"
export PM2_HOME="${PM2_HOME:-$HOME/.pm2}"

# The minimal keep-list: OS/runtime essentials the daemon + pm2 need, and NOTHING credential- or
# identity-bearing. Derived from what the working clean daemon carries, minus pm2's own injected
# fields. Values are read from the CURRENT env but ONLY for these names.
keep() { for k in PATH HOME USER LOGNAME SHELL TERM LANG LANGUAGE LC_ALL TZ PWD \
                  XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS PM2_HOME; do
  # shellcheck disable=SC2163
  [ -n "${!k:-}" ] && printf '%s=%s\n' "$k" "${!k}"
done; }

echo "=== keep-list env the daemon would launch with (names; NO secrets, NO CTX_AGENT_*, NO CLAUDE_*):"
keep | cut -d= -f1 | sed 's/^/  /'
echo "=== ecosystem.config.js CTX_ vars it will ADD (evaluated under the clean env):"
# env -i with the keep-list, then evaluate ecosystem's env block — proves what the daemon gets.
# shellcheck disable=SC2046
env -i $(keep) node -e "
const a=require('$ECO').apps[0];
const e=a.env||{};
for (const k of Object.keys(e).sort()) console.log('  '+k+'='+(k==='CTX_ORG'?JSON.stringify(e[k]):e[k]));
" 2>&1 | head -12
echo "=== SELF-TEST: assert the resulting env carries NO credential- or identity-bearing var:"
# Simulate the launched env = keep-list + ecosystem env; check for the forbidden shapes.
LEAK=$( { keep; env -i $(keep) node -e "const e=require('$ECO').apps[0].env||{}; for(const k in e) console.log(k+'='+e[k]);" 2>/dev/null; } \
  | cut -d= -f1 | /usr/bin/grep -iE '^(BOT_TOKEN|GITHUB_PAT|.*_API_KEY|.*_SECRET|.*PASSWORD|CLAUDE_|CTX_AGENT_NAME|CTX_TELEGRAM|CTX_ORCHESTRATOR)' | sort -u)
if [ -z "$LEAK" ]; then echo "  CLEAN BY CONSTRUCTION — no forbidden var in the launch env ✓"; else echo "  ✗ LEAK: $LEAK"; fi

if [ "$CONFIRM" != 1 ]; then
  echo "=== DRY RUN (no --confirm) — nothing restarted. Add --confirm at an announced window to apply."
  exit 0
fi
echo "=== --confirm: pm2 delete + clean start (GATED — fleet cycles) ==="
env -i $(keep) pm2 delete "$DAEMON" 2>&1 | tail -1
sleep 2
env -i $(keep) pm2 start "$ECO" --only "$DAEMON" 2>&1 | tail -2
echo "=== verify stored env clean (pm2 env), then re-read after. Do NOT pm2 save until verified + decided."
