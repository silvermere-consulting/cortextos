#!/usr/bin/env bash
# backup-minecraft.sh — daily Minecraft world + plugin-config backup
#
# Spec: orgs/silvermere-tech/projects/family-minecraft-server/docs/spec.md §9
# Cron: daily 04:00 Dubai (00:00 UTC). 14-day retention.
#
# Flow:
#   1. RCON save-all (flush in-memory world to disk)
#   2. tar.gz /data/{world,world_nether,world_the_end,plugins,whitelist.json,ops.json,banned-*.json,server.properties}
#   3. Write to /home/cortext/backups/minecraft/YYYY-MM-DD.tar.gz
#   4. Purge tarballs older than 14 days

set -euo pipefail

CONTAINER="${MC_CONTAINER:-silvermere-minecraft}"
# Known data volume — used as a container-less fallback. Minecraft is off-permanently
# (compose profiles:[disabled]); a docker prune can legitimately remove the STOPPED
# container while the named volume is retained, so the backup must not depend on the
# container existing. (Removed-container incident 2026-06-30: prune took the container,
# volume + data were intact; backup now self-heals via this volume.)
MC_VOLUME="${MC_VOLUME:-silvermere_minecraft_data}"
BACKUP_DIR="${MC_BACKUP_DIR:-/home/cortext/backups/minecraft}"
RETENTION_DAYS="${MC_RETENTION_DAYS:-14}"
DOCKER_HOST="${DOCKER_HOST:-unix:///run/user/1001/docker.sock}"
export DOCKER_HOST

mkdir -p "$BACKUP_DIR"

log() { printf '[minecraft-backup] %s\n' "$*" >&2; }

# Surface stderr even when the run SUCCEEDS (task_1783627493915 gap 1): every
# failure path already quotes $ERRLOG, but an rc==0 run with a warning on
# stderr passed unseen. The benign set is ENUMERATED (closed, listable) and
# everything else alarms — a WARN that fires on the known docker
# IPv4-forwarding notice every run would be furniture within a week.
surface_success_stderr() {
  [[ -s "$ERRLOG" ]] || return 0
  local residual
  residual=$(grep -v -e 'IPv4 forwarding is disabled' "$ERRLOG" || true)
  if [[ -n "$residual" ]]; then
    log "WARN: non-benign stderr captured on SUCCESS path (previously passed unseen):"
    log "  $(printf '%s' "$residual" | tail -n 5 | tr '\n' '|')"
  else
    log "stderr this run: $(wc -c < "$ERRLOG") bytes, all known-benign (docker IPv4-forwarding notice)"
  fi
}

# Retention that can never delete the last copy. Before skip-if-unchanged this
# was a plain `-mtime +N -delete`; with skipping, a static world's NEWEST
# archive ages past the cutoff while remaining the ONLY copy — the purge would
# have deleted the very backup the skip logic was preserving.
purge_old() {
  log "purging tarballs older than $RETENTION_DAYS days (newest always kept)…"
  local newest purged=0
  # LC_ALL=C: locale collation can ignore punctuation and reorder names; the
  # newest-guard must sort bytewise (date-named files are then chronological).
  newest=$(ls -1 "$BACKUP_DIR"/*.tar.gz 2>/dev/null | LC_ALL=C sort | tail -1 | xargs -r -n1 basename)
  if [[ -n "$newest" ]]; then
    purged=$(find "$BACKUP_DIR" -maxdepth 1 -name '*.tar.gz' ! -name "$newest" -mtime "+$RETENTION_DAYS" -print -delete | wc -l)
  fi
  log "  purged $purged old backup(s)"
}

# Skip-if-unchanged (task_1783627493915 gap 2): the world has been static since
# the container exited, and a daily 110MB archive of an unchanging world was
# ~1.3G of duplicates. Skip ONLY on positive proof: non-empty manifest AND
# stored-hash match AND the referenced archive still exists non-empty. Every
# failure of proof falls through to a normal backup — never skip on silence.
# Always returns 0 (set -e); a skip exits 0 here after purge + stderr surface.
CUR_MANIFEST_HASH=""
skip_if_unchanged() {
  local manifest="$1" prev_hash prev_archive age_days
  if [[ -z "$manifest" ]]; then
    log "WARN: source manifest empty — cannot prove unchanged, backing up anyway"
    return 0
  fi
  CUR_MANIFEST_HASH=$(printf '%s\n' "$manifest" | md5sum | cut -d' ' -f1)
  [[ -f "$MANIFEST_FILE" ]] || return 0
  read -r prev_hash prev_archive < "$MANIFEST_FILE" || return 0
  [[ "$CUR_MANIFEST_HASH" == "$prev_hash" ]] || return 0
  if [[ ! -s "$BACKUP_DIR/$prev_archive" ]]; then
    log "WARN: manifest matches but archive $prev_archive is missing/empty — backing up anyway"
    return 0
  fi
  age_days=$(( ( $(date +%s) - $(stat -c %Y "$BACKUP_DIR/$prev_archive") ) / 86400 ))
  log "SKIP: world unchanged since $prev_archive (source-manifest match, archive ${age_days}d old) — not writing a duplicate"
  surface_success_stderr
  purge_old
  log "done (skip-unchanged; newest archive is retained regardless of age)."
  exit 0
}

VOLUME=""
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  if [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER")" != "true" ]]; then
    RUNNING=false
    log "WARN: container not running — backing up volume state via tmp container"
  else
    RUNNING=true
    log "RCON save-all (flush world to disk)…"
    docker exec "$CONTAINER" rcon-cli save-all >/dev/null || log "WARN: save-all failed; continuing with on-disk state"
    # Give the flush time to settle to disk before tar reads it. Bumped 3s → 5s
    # after the 2026-06-11 failure where tar started while the world was still
    # being written (tar exit 1 "file changed as we read it"). 5s reduces the race
    # window; the tar-exit-1 handling below is the belt-and-braces guard.
    sleep 5
  fi
else
  # Container absent entirely (e.g. removed by a docker prune — minecraft is
  # off-permanently with profiles:[disabled], so this is a legitimate state).
  # Self-heal: if the known data volume still exists, back it up directly via the
  # stopped-container (volume) path. Only fail if there is genuinely nothing to back up.
  if docker volume inspect "$MC_VOLUME" >/dev/null 2>&1; then
    RUNNING=false
    VOLUME="$MC_VOLUME"
    log "WARN: container '$CONTAINER' absent — backing up volume '$MC_VOLUME' directly (container-less fallback)"
  else
    log "ERROR: container '$CONTAINER' not found AND volume '$MC_VOLUME' not found — nothing to back up"
    exit 1
  fi
fi

# tar exit-1 means "some files changed as we read them" — a warning for a live
# world, NOT corruption. Exit >=2 is a real fatal error. We tolerate exit 1 but
# then verify the resulting archive is fully readable before promoting it.
ERRLOG="$BACKUP_DIR/.last-tar-stderr.log"
: > "$ERRLOG"

# Source-state manifest for skip-if-unchanged (task_1783627493915). Hash of
# every target file's path+size+mtime, computed INSIDE the volume before any
# tar work. NOT a hash of the tarball: gzip embeds a timestamp, so identical
# worlds produce different archive bytes — the manifest reads the layer that
# actually answers "did the world change".
MANIFEST_FILE="$BACKUP_DIR/.last-source-manifest"

TS=$(date -u +%Y-%m-%d)
OUT="$BACKUP_DIR/$TS.tar.gz"

# Neutral fact, not an action claim — the skip decision hasn't happened yet,
# and a "creating tarball" line above a SKIP line reads as a contradiction.
log "target archive: $OUT"

# Fixed core targets + dynamic banned-*.json discovery. Probe inside the volume
# (whether or not the container is running) and only tar entries that exist —
# avoids relying on GNU tar --ignore-failed-read (BusyBox tar in the stopped-
# container path lacks that flag).
CORE_TARGETS="world world_nether world_the_end plugins whitelist.json ops.json server.properties"

if [[ "$RUNNING" == "true" ]]; then
  EXISTING=$(docker exec "$CONTAINER" sh -c '
    for t in '"$CORE_TARGETS"'; do [ -e "/data/$t" ] && printf "%s\n" "$t"; done
    ls /data 2>/dev/null | grep -E "^banned-.*\.json$" || true
  ')
  [[ -z "$EXISTING" ]] && { log "ERROR: no backup targets found in /data"; exit 1; }
  # Source manifest AFTER the save-all flush (flushed mtimes must defeat a skip).
  # shellcheck disable=SC2086
  MANIFEST=$(docker exec "$CONTAINER" sh -c "cd /data && find $(echo $EXISTING) -type f -exec stat -c '%n %s %Y' {} + | sort" 2>>"$ERRLOG" || true)
  skip_if_unchanged "$MANIFEST"
  rc=0
  # shellcheck disable=SC2086
  docker exec "$CONTAINER" tar -czf - -C /data $EXISTING > "$OUT.tmp" 2>"$ERRLOG" || rc=$?
  if [[ $rc -ge 2 ]]; then
    log "ERROR: docker exec tar failed (running path, exit $rc); aborting"
    [[ -s "$ERRLOG" ]] && log "tar stderr: $(tail -n 5 "$ERRLOG" | tr '\n' '|')"
    rm -f "$OUT.tmp"; exit 1
  elif [[ $rc -eq 1 ]]; then
    log "WARN: tar exit 1 (files changed during read — expected for live world); keeping tarball, will verify integrity"
    [[ -s "$ERRLOG" ]] && log "tar stderr: $(tail -n 3 "$ERRLOG" | tr '\n' '|')"
  fi
else
  # Stopped-container path: read-only volume mount into a throwaway alpine,
  # probe existence first (BusyBox tar errors out on missing entries), then tar.
  # VOLUME may already be set by the container-less fallback above; otherwise resolve it.
  [[ -z "$VOLUME" ]] && VOLUME=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$CONTAINER")
  [[ -z "$VOLUME" ]] && { log "ERROR: could not resolve /data volume name for $CONTAINER"; exit 1; }
  EXISTING=$(docker run --rm -v "$VOLUME:/data:ro" alpine sh -c '
    for t in '"$CORE_TARGETS"'; do [ -e "/data/$t" ] && printf "%s\n" "$t"; done
    ls /data 2>/dev/null | grep -E "^banned-.*\.json$" || true
  ' 2>/dev/null)
  [[ -z "$EXISTING" ]] && { log "ERROR: no backup targets found in volume $VOLUME"; exit 1; }
  # BusyBox-compatible manifest (alpine find has no -printf; stat -c works).
  # shellcheck disable=SC2086
  MANIFEST=$(docker run --rm -v "$VOLUME:/data:ro" alpine sh -c "cd /data && find $(echo $EXISTING) -type f -exec stat -c '%n %s %Y' {} + | sort" 2>>"$ERRLOG" || true)
  skip_if_unchanged "$MANIFEST"
  rc=0
  # shellcheck disable=SC2086
  docker run --rm -v "$VOLUME:/data:ro" alpine tar -czf - -C /data $EXISTING > "$OUT.tmp" 2>"$ERRLOG" || rc=$?
  # Stopped container + read-only mount: files are static, so exit 1 is not
  # expected here, but tolerate it symmetrically and rely on the integrity check.
  if [[ $rc -ge 2 ]]; then
    log "ERROR: alpine tar failed (stopped path, exit $rc); aborting"
    [[ -s "$ERRLOG" ]] && log "tar stderr: $(tail -n 5 "$ERRLOG" | tr '\n' '|')"
    rm -f "$OUT.tmp"; exit 1
  elif [[ $rc -eq 1 ]]; then
    log "WARN: tar exit 1 (stopped path); keeping tarball, will verify integrity"
    [[ -s "$ERRLOG" ]] && log "tar stderr: $(tail -n 3 "$ERRLOG" | tr '\n' '|')"
  fi
fi

# Sanity check before promoting tmp → final
if [[ ! -s "$OUT.tmp" ]]; then
  log "ERROR: tarball is empty; aborting"; rm -f "$OUT.tmp"; exit 1
fi

# Integrity check: validate the gzip stream + tar structure end-to-end. This is
# what makes tolerating tar exit 1 above safe — a genuinely corrupt archive
# (truncated gzip, broken tar) fails here and we abort rather than promote it.
if ! gzip -t "$OUT.tmp" 2>>"$ERRLOG" || ! tar -tzf "$OUT.tmp" >/dev/null 2>>"$ERRLOG"; then
  log "ERROR: tarball failed integrity check (gzip/tar listing); aborting"
  [[ -s "$ERRLOG" ]] && log "integrity stderr: $(tail -n 5 "$ERRLOG" | tr '\n' '|')"
  rm -f "$OUT.tmp"; exit 1
fi
log "integrity check passed (gzip + tar listing OK)"
mv "$OUT.tmp" "$OUT"

SIZE=$(du -h "$OUT" | cut -f1)
log "tarball written: $SIZE"

# Persist the manifest hash ONLY when we have one — a stale manifest must
# never vouch for a skip against a world it didn't describe.
if [[ -n "$CUR_MANIFEST_HASH" ]]; then
  printf '%s %s\n' "$CUR_MANIFEST_HASH" "$TS.tar.gz" > "$MANIFEST_FILE"
else
  rm -f "$MANIFEST_FILE"
fi

surface_success_stderr
purge_old
log "done."
