#!/usr/bin/env bash
# Decoupled flip orchestrator for the local-embedder @768 cutover.
# MUST run as a systemd --user unit (NOT an agent-PTY child): the pm2 stop below
# kills the agent PTYs incl. the engineer session that launches this, but a
# user-manager unit (user@1001.service cgroup) survives it. Sequence:
#   stop daemon -> cutover rename-swap -> set EMBEDDING_BACKEND flag -> start daemon
# All-or-nothing: cutover preflight fail => no swap + no flag + daemon restarted
# => clean original @3072 state. Flag is set ONLY after a confirmed swap.
set -u
export PATH="/home/cortext/.npm-global/bin:/usr/bin:/usr/local/bin:$PATH"
export HOME=/home/cortext
PM2=/home/cortext/.npm-global/bin/pm2
VENV=/home/cortext/cortextos/knowledge-base/venv/bin/python3
CUTOVER=/home/cortext/cortextos/knowledge-base/scripts/cutover_768.py
CHROMA=/home/cortext/.cortextos/default/orgs/silvermere-tech/knowledge-base/chromadb
SECRETS=/home/cortext/cortextos/orgs/silvermere-tech/secrets.env
LOG=/home/cortext/cortextos/knowledge-base/scripts/cutover_flip.log

exec >> "$LOG" 2>&1
echo "===== FLIP start $(date -u +%FT%TZ) ====="

echo "[1] pm2 stop cortextos-daemon (fleet down ~now)"
$PM2 stop cortextos-daemon
sleep 4

echo "[2] cutover_768.py --confirm (all-or-nothing preflight + atomic rename-swap)"
$VENV "$CUTOVER" "$CHROMA" --confirm
rc=$?
echo "cutover rc=$rc"

if [ $rc -ne 0 ]; then
  echo "[2!] cutover FAILED rc=$rc — NO flag set; rolling back any partial + restarting daemon (clean @3072)"
  $VENV "$CUTOVER" "$CHROMA" --rollback --confirm || true
  $PM2 start cortextos-daemon
  echo "FLIP_FAILED_CLEAN $(date -u +%FT%TZ)"
  exit 1
fi

echo "[3] cutover OK — set EMBEDDING_BACKEND=local in secrets.env"
if ! grep -q '^EMBEDDING_BACKEND=' "$SECRETS"; then
  echo 'EMBEDDING_BACKEND=local' >> "$SECRETS"
  echo "flag added"
else
  echo "flag already present: $(grep '^EMBEDDING_BACKEND=' "$SECRETS")"
fi

echo "[4] pm2 start cortextos-daemon (agents respawn @768 via --continue)"
$PM2 start cortextos-daemon
echo "FLIP_COMPLETE $(date -u +%FT%TZ)"
