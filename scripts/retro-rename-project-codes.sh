#!/usr/bin/env bash
# retro-rename-project-codes.sh — rename existing project PDFs to the WoW project-code convention.
#
# Approved code list lives at orgs/silvermere-tech/docs/wow-project-codes.md.
# This script encodes the mapping (project-dir-name -> code) so it can run without
# parsing the doc. Update both when codes change.
#
# Targets: orgs/*/projects/*/docs/*.pdf and orgs/*/projects/*/docs/**/*.pdf
# Effect:  if dir matches a mapped project AND basename does NOT already start with
#          "<code>-", rename to "<code>-<basename>". Skips already-renamed files
#          (idempotent), unmapped projects (logged), and non-PDF files.
#
# Usage:
#   scripts/retro-rename-project-codes.sh             # dry-run (default)
#   scripts/retro-rename-project-codes.sh --apply     # actually rename
#
# Safe to re-run.

set -euo pipefail

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help)
      sed -n '2,/^set -euo/p' "$0" | sed 's/^# \?//' | head -25
      exit 0
      ;;
    *) echo "ERR: unknown arg $arg" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Map project directory name -> code. Keep in sync with
# orgs/silvermere-tech/docs/wow-project-codes.md.
declare -A CODES=(
  ["clearspeak-studio"]="ClSp"
  ["story-intelligence"]="Stry"
  ["kmi-logistics"]="KMIP"
  ["business-in-a-box"]="BiB"
  ["hiba-ventures"]="Hba"
  ["indoor-plants"]="Plnt"
  ["gamesonthemove"]="GOTM"
  ["wellspring"]="Wllsp"
  ["dog-supplements"]="Wllsp"
  ["server-reselling"]="SvrRs"
  ["family-minecraft-server"]="MCSv"
  ["actual-budget"]="Bud"
  ["home-org"]="HmOr"
)

CYAN='\033[0;36m'; YELLOW='\033[0;33m'; GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
log()  { printf '%b\n' "$*"; }
ok()   { printf "${GREEN}✓${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}!${NC} %s\n" "$*"; }
err()  { printf "${RED}✗${NC} %s\n" "$*"; }

RENAMED=0
SKIPPED_ALREADY=0
SKIPPED_UNMAPPED=0
WARNINGS=()

# Path-segment denylist: don't rename files inside these subdirs. They are external source
# documents or preserved bundles (e.g., design exports, third-party uploads, legal source
# scans). Match if any path segment equals one of these.
DENY_SEGMENTS=("design-mockup" "uploads" "attachments" "external" "source-docs"
               "dwtc-source-docs" "vendor" "raw" "third-party")

is_in_denylist() {
  local p="$1"
  local IFS='/'
  read -ra parts <<< "$p"
  for part in "${parts[@]}"; do
    for deny in "${DENY_SEGMENTS[@]}"; do
      if [[ "$part" == "$deny" ]]; then
        return 0
      fi
    done
  done
  return 1
}

# Find all PDFs under any orgs/*/projects/*/docs/ (recurse into nested subdirs).
while IFS= read -r -d '' pdf; do
  # Path looks like: orgs/<org>/projects/<project>/docs/<...>/file.pdf
  rel="${pdf#$REPO_ROOT/}"

  if is_in_denylist "$rel"; then
    warn "skip (denylisted path segment): $rel"
    SKIPPED_UNMAPPED=$((SKIPPED_UNMAPPED+1))
    continue
  fi

  # Extract <project> = the path segment after "projects/"
  project=$(echo "$rel" | awk -F/ '{ for (i=1; i<=NF; i++) if ($i=="projects") { print $(i+1); exit } }')
  base=$(basename "$pdf")
  dir=$(dirname "$pdf")

  if [[ -z "$project" ]]; then
    warn "  could not parse project from path: $rel"
    WARNINGS+=("unparseable: $rel")
    continue
  fi

  code="${CODES[$project]:-}"
  if [[ -z "$code" ]]; then
    # Unmapped project — skip with log
    warn "skip (unmapped project '$project'): $rel"
    SKIPPED_UNMAPPED=$((SKIPPED_UNMAPPED+1))
    continue
  fi

  prefix="${code}-"
  if [[ "$base" == ${prefix}* ]]; then
    # Already correctly prefixed
    SKIPPED_ALREADY=$((SKIPPED_ALREADY+1))
    continue
  fi

  new_base="${prefix}${base}"
  new_path="${dir}/${new_base}"

  if [[ -e "$new_path" ]]; then
    err "would-collide ($new_path already exists): $rel"
    WARNINGS+=("collision: $rel -> $new_base")
    continue
  fi

  if [[ "$APPLY" == "1" ]]; then
    mv -i "$pdf" "$new_path" </dev/null
    ok "renamed: $rel -> $new_base"
  else
    log "  ${YELLOW}(dry-run)${NC} $rel -> $new_base"
  fi
  RENAMED=$((RENAMED+1))
done < <(find "$REPO_ROOT/orgs" -path '*/projects/*/docs/*' -name '*.pdf' -type f -print0 2>/dev/null)

echo
log "${CYAN}== Summary ==${NC}"
log "Mode:                $([[ $APPLY == 1 ]] && echo APPLY || echo DRY-RUN)"
log "Would-rename:        $RENAMED"
log "Skipped (already):   $SKIPPED_ALREADY"
log "Skipped (unmapped):  $SKIPPED_UNMAPPED"
if [[ ${#WARNINGS[@]} -gt 0 ]]; then
  log "${YELLOW}Warnings:${NC}"
  for w in "${WARNINGS[@]}"; do
    log "  $w"
  done
fi

if [[ "$RENAMED" -eq 0 && "$APPLY" == "0" ]]; then
  ok "Nothing to do — fleet is in convention."
elif [[ "$APPLY" == "0" ]]; then
  log "Re-run with --apply to perform the renames."
fi
