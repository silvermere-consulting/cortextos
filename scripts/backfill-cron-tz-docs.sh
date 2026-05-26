#!/usr/bin/env bash
# Backfill the agent-TZ-not-UTC docs note into existing agent HEARTBEAT.md / TOOLS.md.
#
# Template commit 17a3feb (2026-05-25) added a one-liner + Crons section to the agent /
# analyst / orchestrator templates, but existing rendered copies in orgs/*/agents/* were
# untouched. This script applies the same inserts to existing files when the anchor lines
# are present and the new note is missing.
#
# Idempotent — safe to re-run. Anchor-based insert preserves any customisations above /
# below the insert points.
#
# Usage:
#   scripts/backfill-cron-tz-docs.sh             # dry-run: show what would change
#   scripts/backfill-cron-tz-docs.sh --apply     # write changes
#   scripts/backfill-cron-tz-docs.sh --apply --commit  # write + git commit per agent
#
# Anchors:
#   HEARTBEAT.md: insert blockquote after the line "Skipping steps = broken system..."
#                 (and a trailing blank line that is already there)
#   TOOLS.md:     insert "### Crons" section immediately before "### Approvals"
#
# Affects: orgs/*/agents/*/HEARTBEAT.md and orgs/*/agents/*/TOOLS.md

set -euo pipefail

APPLY=0
COMMIT=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --commit) COMMIT=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

HB_MARKER="interpreted in the agent's local timezone"
HB_ANCHOR_RE='^Skipping steps = broken system'
HB_INSERT='
> **Cron schedules are interpreted in the agent'"'"'s local timezone (`CTX_TIMEZONE`), not UTC.** A cron of `0 2 * * *` fires at 02:00 *agent-local time* (e.g. 22:00 UTC for an Asia/Dubai agent). To confirm actual fire times, run `cortextos bus get-cron-log $CTX_AGENT_NAME`.
'

TOOLS_MARKER="Schedules are interpreted in the agent's local timezone"
TOOLS_ANCHOR_RE='^### Approvals'
TOOLS_INSERT='### Crons — full docs: `.claude/skills/cron-management/SKILL.md`

> **Schedules are interpreted in the agent'"'"'s local timezone (`CTX_TIMEZONE`), not UTC.** A cron of `0 2 * * *` fires at 02:00 *agent-local time*. Use `get-cron-log` to verify actual fire times if a cron looks off.

| Command | What it does |
|---|---|
| `list-crons <agent>` | List scheduled crons + next-fire times |
| `add-cron <agent> <name> <interval-or-cron-expr> "<prompt>"` | Add a recurring cron |
| `update-cron <agent> <name> --schedule <expr>` | Change schedule/prompt |
| `remove-cron <agent> <name>` | Remove a cron |
| `get-cron-log <agent>` | Show actual fire history |
| `test-cron-fire <agent> <name>` | Fire immediately to verify wiring |

'

# Insert content above the matched anchor line. Reads stdin, writes stdout.
# Args: anchor_regex, insert_text
insert_above() {
  local anchor="$1"
  local insert="$2"
  awk -v anchor="$anchor" -v insert="$insert" '
    $0 ~ anchor && !done { printf "%s", insert; done=1 }
    { print }
  '
}

# Insert content below the matched anchor line (after that line + the blank line that follows it).
# Anchor must be a single line. We insert after the first blank line that follows.
# Args: anchor_regex, insert_text
insert_after_blank() {
  local anchor="$1"
  local insert="$2"
  awk -v anchor="$anchor" -v insert="$insert" '
    { print }
    $0 ~ anchor && !found { found=1; next_blank=1; next }
    found && next_blank && $0=="" { printf "%s", insert; found=0; next_blank=0 }
  '
}

CHANGED_FILES=()
PER_AGENT_CHANGES=()

for dir in orgs/*/agents/*/; do
  agent=$(basename "$dir")
  org=$(basename "$(dirname "$(dirname "$dir")")")
  changed_for_agent=0
  agent_files=()

  hb="$dir/HEARTBEAT.md"
  if [[ -f "$hb" ]]; then
    if ! grep -qF "$HB_MARKER" "$hb"; then
      if grep -qE "$HB_ANCHOR_RE" "$hb"; then
        new_content=$(insert_after_blank "$HB_ANCHOR_RE" "$HB_INSERT" < "$hb")
        if [[ "$APPLY" == "1" ]]; then
          printf '%s' "$new_content" > "$hb"
          echo "WROTE  $hb"
        else
          echo "WOULD  $hb"
        fi
        CHANGED_FILES+=("$hb")
        agent_files+=("$hb")
        changed_for_agent=1
      else
        echo "SKIP   $hb (anchor not found)" >&2
      fi
    else
      echo "OK     $hb (already has note)"
    fi
  fi

  tools="$dir/TOOLS.md"
  if [[ -f "$tools" ]]; then
    if ! grep -qF "$TOOLS_MARKER" "$tools"; then
      if grep -qE "$TOOLS_ANCHOR_RE" "$tools"; then
        new_content=$(insert_above "$TOOLS_ANCHOR_RE" "$TOOLS_INSERT" < "$tools")
        if [[ "$APPLY" == "1" ]]; then
          printf '%s' "$new_content" > "$tools"
          echo "WROTE  $tools"
        else
          echo "WOULD  $tools"
        fi
        CHANGED_FILES+=("$tools")
        agent_files+=("$tools")
        changed_for_agent=1
      else
        echo "SKIP   $tools (anchor not found)" >&2
      fi
    else
      echo "OK     $tools (already has note)"
    fi
  fi

  if [[ "$changed_for_agent" == "1" && "$APPLY" == "1" && "$COMMIT" == "1" ]]; then
    git add "${agent_files[@]}"
    git commit -m "docs($org/$agent): backfill cron agent-TZ note (HEARTBEAT.md + TOOLS.md)

Sync existing $org/$agent files with template commit 17a3feb so the
cron-TZ clarification is present in already-rendered agent dirs.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>" >&2 || true
  fi
done

echo
if [[ "${#CHANGED_FILES[@]}" -eq 0 ]]; then
  echo "Summary: no files needed updates. Fleet is in sync."
elif [[ "$APPLY" == "1" ]]; then
  echo "Summary: ${#CHANGED_FILES[@]} file(s) changed."
else
  echo "Summary: ${#CHANGED_FILES[@]} file(s) would change. Re-run with --apply to write."
fi
