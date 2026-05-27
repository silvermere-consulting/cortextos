#!/usr/bin/env bash
# Backfill content_hash metadata on every chromadb collection in the local
# cortextOS install. ZERO embed cost — operates on already-stored documents.
#
# Run once after deploying feat/kb-ingest-content-hash. Idempotent.
#
# Usage:
#   scripts/backfill-kb-hashes.sh             # all instances, all collections
#   scripts/backfill-kb-hashes.sh <instance>  # single instance (e.g. default)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$REPO_ROOT/knowledge-base/venv/bin/python3"
MMRAG="$REPO_ROOT/knowledge-base/scripts/mmrag.py"

if [[ ! -x "$PY" ]]; then
  echo "ERROR: knowledge-base venv not found at $PY" >&2
  exit 1
fi

instances=()
if [[ $# -gt 0 ]]; then
  instances=("$1")
else
  for d in "$HOME/.cortextos"/*/; do
    [[ -d "$d" ]] && instances+=("$(basename "$d")")
  done
fi

if [[ ${#instances[@]} -eq 0 ]]; then
  echo "No cortextOS instances found under $HOME/.cortextos/"
  exit 0
fi

total_collections=0
for instance in "${instances[@]}"; do
  orgs_dir="$HOME/.cortextos/$instance/orgs"
  [[ -d "$orgs_dir" ]] || continue

  for org_dir in "$orgs_dir"/*/; do
    [[ -d "$org_dir" ]] || continue
    org="$(basename "$org_dir")"
    chroma_dir="$org_dir/knowledge-base/chromadb"
    [[ -d "$chroma_dir" ]] || continue

    echo ""
    echo "=== instance=$instance org=$org ==="

    # Enumerate collections via mmrag collections (one per line, name only).
    CTX_ORG="$org" CTX_INSTANCE_ID="$instance" CTX_FRAMEWORK_ROOT="$REPO_ROOT" \
      MMRAG_DIR="$org_dir/knowledge-base" \
      "$PY" "$MMRAG" collections 2>/dev/null \
      | awk 'NR>1 && $1!="" {print $1}' \
      | while read -r col; do
          [[ -z "$col" ]] && continue
          echo "  → $col"
          CTX_ORG="$org" CTX_INSTANCE_ID="$instance" CTX_FRAMEWORK_ROOT="$REPO_ROOT" \
            MMRAG_DIR="$org_dir/knowledge-base" \
            "$PY" "$MMRAG" backfill-hashes --collection "$col" || \
            echo "    WARN: backfill failed for $col" >&2
          total_collections=$((total_collections + 1))
        done
  done
done

echo ""
echo "Backfill complete."
