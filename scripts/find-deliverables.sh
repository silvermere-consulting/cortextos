#!/usr/bin/env bash
# find-deliverables.sh — Find files matching a hint with prefix variants.
#
# Lesson banked 2026-06-04 (chief audit miss): when checking whether a stale
# task already has a shipped deliverable, the literal hint (e.g. "issy")
# misses prefix-variant filenames the agent emitted (e.g. "issy-grad",
# "Iss-issy-graduate-papers"). This script sweeps the common patterns.
#
# Usage:
#   find-deliverables.sh <hint> [<root>]
#
# Examples:
#   find-deliverables.sh issy                        # default root = cwd
#   find-deliverables.sh issy /home/cortext/cortextos/orgs/silvermere-tech
#   find-deliverables.sh pylot orgs/silvermere-tech  # scoped scan
#
# Patterns swept (case-insensitive):
#   *<hint>*                — direct contains
#   *<hint>-*               — hint as prefix to suffix variant ("issy-grad")
#   *-<hint>*               — hint as suffix or middle ("memo-issy", "draft-issy-v2")
#   <project_code>-*<hint>* — project-code prefixed (BiB-*, Hba-*, Iss-*, etc. — picks ALL caps-prefix dashes)
#
# Filters:
#   - skips .git/, node_modules/, .next/, dist/, .pm2/, .docker/
#   - filename only (not contents) — fast sweep, not a content search
#   - reports relative paths
#
# Exit 0 if any match found; 1 if no matches.

set -euo pipefail

hint="${1:-}"
root="${2:-.}"

if [[ -z "$hint" ]]; then
  echo "usage: find-deliverables.sh <hint> [<root>]" >&2
  exit 2
fi

if [[ ! -d "$root" ]]; then
  echo "find-deliverables: root not a directory: $root" >&2
  exit 2
fi

# Normalise hint
lc_hint="$(printf '%s' "$hint" | tr '[:upper:]' '[:lower:]')"

# Find all candidate files (case-insensitive name match)
matches=$(
  find "$root" -type f \
    \( -ipath "*${lc_hint}*" \) \
    -not -path "*/.git/*" \
    -not -path "*/node_modules/*" \
    -not -path "*/.next/*" \
    -not -path "*/dist/*" \
    -not -path "*/.pm2/*" \
    -not -path "*/.docker/*" \
    -not -path "*/cache/*" \
    -not -path "*/coverage/*" \
    2>/dev/null \
  | sort -u
)

if [[ -z "$matches" ]]; then
  echo "(no matches for '${hint}' under ${root})"
  exit 1
fi

# Group by prefix-variant class to surface what kind of name is hit.
echo "Matches for hint '${hint}' under ${root}:"
echo ""

# Direct contains (everything found, broken into variants for clarity)
direct=$(echo "$matches" | grep -iE "/[^/]*${lc_hint}[^/]*\$" | grep -ivE "/[^/]*-${lc_hint}-[^/]*\$" | grep -ivE "/[^/]*${lc_hint}-[^/]*\$" || true)
suffix_dash=$(echo "$matches" | grep -iE "/[^/]*${lc_hint}-[^/]*\$" || true)
prefix_dash=$(echo "$matches" | grep -iE "/[^/]*-${lc_hint}[^/]*\$" | grep -ivE "/[^/]*${lc_hint}-[^/]*\$" || true)
code_prefixed=$(echo "$matches" | grep -iE "/[A-Z][A-Za-z]+-[^/]*${lc_hint}[^/]*\$" || true)

print_group() {
  local label="$1"; shift
  local content="$1"; shift
  [[ -z "$content" ]] && return
  echo "  ${label}:"
  echo "$content" | sed 's|^|    |'
  echo ""
}

print_group "Direct ('${hint}' in filename, no variant)" "$direct"
print_group "Suffix-variant ('${hint}-...' — most common audit miss)" "$suffix_dash"
print_group "Prefix-variant ('...-${hint}' or '...-${hint}-...')" "$prefix_dash"
print_group "Project-code prefixed (CC-... pattern)" "$code_prefixed"

total=$(echo "$matches" | wc -l)
echo "Total: ${total} match(es)"
exit 0
