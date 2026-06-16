#!/usr/bin/env bash
# Memory-bounded driver for build_768_shadows.py: builds ONE collection per
# subprocess so the ~1.6G nomic model + chromadb per-collection index are fully
# reclaimed by the OS between collections. Bounds peak RSS to model + one
# collection (~2G) instead of the cumulative growth that OOM-killed the
# all-in-one-process run (2026-06-16). Idempotent: already-verified shadows
# SKIP in <1s, so this is also the resume path. shared-silvermere-tech LAST.
set -u
VENV=/home/cortext/cortextos/knowledge-base/venv/bin/python3
SCRIPT=/home/cortext/cortextos/knowledge-base/scripts/build_768_shadows.py
CHROMA=/home/cortext/.cortextos/default/orgs/silvermere-tech/knowledge-base/chromadb
TARGETS=(
  agent-analyst agent-business-analyst agent-chief agent-engineer
  agent-research agent-writer
  memory-analyst memory-business-analyst memory-chief
  memory-engineer memory-research memory-writer
  shared-silvermere-tech
)
echo "===== LOOP DRIVER start $(date -u +%H:%M:%S)UTC ($(printf '%s ' "${TARGETS[@]}")) ====="
for t in "${TARGETS[@]}"; do
  echo "----- target: $t -----"
  "$VENV" "$SCRIPT" "$CHROMA" --targets "$t"
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "LOOP_DRIVER_FAIL target=$t rc=$rc"
    exit 1
  fi
done
echo "LOOP_DRIVER_COMPLETE all=${#TARGETS[@]} $(date -u +%H:%M:%S)UTC"
