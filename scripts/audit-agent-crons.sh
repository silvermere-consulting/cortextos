#!/usr/bin/env bash
# audit-agent-crons.sh — Fleet-wide cron coverage check.
#
# Walks every enabled agent's config.json and reports missing required crons
# (heartbeat, daily-restart). Companion to the agent template grandparent fix
# from 2026-05-23 — templates now include daily-restart, but this script
# catches regressions in case a config is hand-edited or a template drifts.
#
# Required crons are configurable via REQUIRED_CRONS env var (default below).
#
# Usage:
#   scripts/audit-agent-crons.sh             # scan default ctx root
#   CTX_ROOT=/path scripts/audit-agent-crons.sh
#
# Exit codes:
#   0 — all enabled agents have all required crons
#   1 — at least one agent is missing a required cron (warning, not failure)
#
# Designed to be invoked from morning-review or as an on-demand chief check.
# Does NOT modify anything; read-only audit.

set -euo pipefail

REQUIRED_CRONS="${REQUIRED_CRONS:-heartbeat daily-restart}"
CTX_ROOT="${CTX_ROOT:-$HOME/cortextos}"
ORGS_DIR="${CTX_ROOT}/orgs"

if [ ! -d "$ORGS_DIR" ]; then
  echo "[audit-agent-crons] No orgs dir at $ORGS_DIR" >&2
  exit 0
fi

missing_total=0
ok_total=0

printf "%-12s %-20s %-10s %-30s\n" "ORG" "AGENT" "ENABLED" "MISSING_CRONS"
printf "%-12s %-20s %-10s %-30s\n" "---" "-----" "-------" "-------------"

for cfg in "$ORGS_DIR"/*/agents/*/config.json; do
  [ -f "$cfg" ] || continue
  org=$(echo "$cfg" | sed "s|^$ORGS_DIR/||; s|/agents/.*||")
  agent=$(echo "$cfg" | sed "s|.*/agents/||; s|/config.json||")

  enabled=$(python3 -c "
import json, sys
try:
    d = json.load(open('$cfg'))
    print(d.get('enabled', True))
except: print('?')
" 2>/dev/null)

  # Skip disabled agents — they're not in the fleet
  if [ "$enabled" = "False" ] || [ "$enabled" = "false" ]; then
    continue
  fi

  missing=""
  for req in $REQUIRED_CRONS; do
    has=$(python3 -c "
import json
d = json.load(open('$cfg'))
print(any(c.get('name')=='$req' for c in d.get('crons',[])))
" 2>/dev/null)
    if [ "$has" != "True" ]; then
      missing="${missing}${missing:+,}${req}"
    fi
  done

  if [ -n "$missing" ]; then
    missing_total=$((missing_total + 1))
    printf "%-12s %-20s %-10s %-30s\n" "$org" "$agent" "$enabled" "$missing"
  else
    ok_total=$((ok_total + 1))
  fi
done

echo ""
echo "Summary: ${ok_total} agents clean, ${missing_total} with missing required crons."
echo "Required crons: ${REQUIRED_CRONS}"

if [ "$missing_total" -gt 0 ]; then
  echo ""
  echo "To fix: cortextos bus add-cron <agent> <name> <schedule> '<prompt>'"
  echo "  e.g.: cortextos bus add-cron <agent> daily-restart '0 4 * * *' 'Daily scheduled hard restart...'"
  exit 1
fi
exit 0
