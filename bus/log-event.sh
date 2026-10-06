#!/usr/bin/env bash
# log-event.sh — wrapper for Node.js CLI
# Usage: log-event.sh <category> <event> <severity> [metadata_json]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="${SCRIPT_DIR}/../dist/cli.js"

CATEGORY="${1:-action}"
EVENT="${2:-}"
SEVERITY="${3:-info}"
# NOTE: do NOT write `META="${4:-{}}"` — bash closes the ${...} at the FIRST `}`, so the
# default word is `{` and a literal `}` is appended, corrupting EVERY provided meta
# (`{"k":1}` -> `{"k":1}}`). This was masked for as long as logEvent silently replaced
# invalid JSON with {}; the 2026-10-05 --meta fail-close exposes it as a hard reject.
META="${4:-}"
[[ -z "$META" ]] && META='{}'

if [[ -z "$EVENT" ]]; then
  echo "Usage: log-event.sh <category> <event> <severity> [metadata_json]" >&2
  exit 1
fi

exec node "$CLI" bus log-event "$CATEGORY" "$EVENT" "$SEVERITY" --meta "$META"
