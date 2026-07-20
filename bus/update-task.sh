#!/usr/bin/env bash
# update-task.sh — wrapper for Node.js CLI
# Usage: update-task.sh <id> <status> [note] [blocked_by]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

ID="${1:-}"
STATUS="${2:-}"
NOTE="${3:-}"

if [[ -z "$ID" || -z "$STATUS" ]]; then
  echo "Usage: update-task.sh <id> <status> [note] [blocked_by]" >&2
  exit 1
fi

# Forward the documented [note] positional as --note — the wrapper previously
# accepted it in its usage line and then discarded it (exec'd only id+status),
# so dashboard notes on Block/Back-to-Pending were silently dropped
# (Steve-authorised fix 2026-07-20). NOTE: [blocked_by] (arg 4) is still not
# forwarded — that is a separate silent-data-loss bug, reported, not fixed here.
ARGS=("$ID" "$STATUS")
[[ -n "$NOTE" ]] && ARGS+=(--note "$NOTE")

exec node "$CLI" bus update-task "${ARGS[@]}"
