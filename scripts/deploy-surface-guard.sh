#!/usr/bin/env bash
# deploy-surface-guard.sh — CAPABILITY-SUBTRACTION guard for a rebuild/deploy.
#
# A rebuild does not only ADD the new source's commands; it SUBTRACTS every
# command present in the OLD artefact and absent from the NEW source — silently,
# with a clean exit code. 2026-08-02: building the approval night-gate from main
# removed `list-pending-approvals-unified` (the fleet's only unified approvals
# reader; it lived only on feat/approvals-union). The check-approvals cron's
# STEP 1 command ceased to exist and failed toward SILENCE over a real backlog.
# A deploy report that verifies what SHIPPED is blind to what the rebuild
# SUBTRACTED — nobody diffed the old command surface against the new.
#
# This is the obituary problem running the OTHER way: you grep for prose a fix
# FALSIFIES; nobody greps for a capability a rebuild REMOVES. REMOVAL is the only
# signal here — additions are expected on every feature build and are reported,
# not failed.
#
# TWO SURFACES, BOTH COVERED (chief, 2026-08-02): `cortextos --help` is the
# TOP-LEVEL commands (add-agent/start/stop/status/spawn-worker/goals/update/…);
# `cortextos bus --help` is the BUS verbs. A bus-scoped diff is BLIND to a
# subtraction in the top-level tree and would look exactly as clean. A check that
# silently covers less than its name is worse than no check — it retires the
# question. Each command is tagged by surface (top:/bus:) so a token that exists
# in both surfaces cannot let a removal in one hide behind the other.
#
# NORMALISED: only the COMMAND NAME (first token of each Commands: line) is
# compared, sorted. Version strings (--version, not --help), option ordering (the
# Options: block, outside our sed range) and terminal-width wrapping (piped
# --help does not wrap) cannot make it cry wolf.
#
# FAIL-CLOSED — a MISSING measurement is not a clean one (chief, 2026-08-02, the
# pii-gate fail-open: grep errored on an absent file, the `if` went false, it
# printed CLEAN over nothing, for its entire life). Every not-measured world
# exits NON-ZERO here; only a real, read, no-removal result exits 0.
#
# The check is a before/after PAIR, not a post-restart arm — release-verify.sh
# runs too late to hold the "before". Invoke around the build:
#   scripts/deploy-surface-guard.sh snapshot   # BEFORE build — capture OLD surface
#   npm run build
#   scripts/deploy-surface-guard.sh check      # AFTER build  — exit 2 on any REMOVED command
#
# Exit codes: 0 = read a real surface, nothing removed (PASS). 2 = a command was
# REMOVED, or the measurement could not be taken (CANNOT-TELL) — both abort the
# release; they are distinguished by message, never by a pass. 64 = usage error.
#
# Env seams:
#   CLI_ENTRY         cli.js to interrogate         (default dist/cli.js)
#   SURFACE_BASELINE  baseline file path            (default /tmp/.deploy-surface-baseline)
#   SURFACE_NOW_FILE  read the CURRENT surface from this file instead of invoking
#                     the CLI. Lets the self-test diff two captured surfaces
#                     offline (and reproduce a historical build), and lets an
#                     operator compare two saved captures. Defaults to live.
set -uo pipefail

BASE="${SURFACE_BASELINE:-/tmp/.deploy-surface-baseline}"
CLI="${CLI_ENTRY:-dist/cli.js}"

# Emit "<tag>:<command>" lines for one --help surface. The sed range is the
# Commands: block only; the token is the first 2-space-indented lowercase word.
emit_surface() {
  local tag="$1"; shift
  node "$CLI" "$@" --help 2>/dev/null \
    | sed -n '/^Commands:/,/^[[:space:]]*$/p' \
    | sed -n 's/^  \([a-z][a-z0-9-]*\).*/'"$tag"':\1/p'
}

# The current surface: from SURFACE_NOW_FILE if set (test/offline seam), else live.
current_surface() {
  if [ -n "${SURFACE_NOW_FILE:-}" ]; then
    sort -u "$SURFACE_NOW_FILE" 2>/dev/null
  else
    { emit_surface top; emit_surface bus bus; } | sort -u
  fi
}

case "${1:-}" in
  snapshot)
    tmp="$(current_surface)"
    n=$(printf '%s\n' "$tmp" | grep -c . || true)
    # An empty/near-empty surface means the CLI did not build/parse. Refuse to
    # write it — a false-clean baseline would make every later check PASS.
    if [ "${n:-0}" -lt 2 ]; then
      echo "SURFACE GUARD: CANNOT-TELL — surface has ${n:-0} commands (cli not built, or --help failed). Refusing to write a false-clean baseline." >&2
      exit 2
    fi
    printf '%s\n' "$tmp" > "$BASE"
    echo "surface baseline captured: $n commands (top+bus) -> $BASE"
    ;;
  check)
    if [ ! -f "$BASE" ]; then
      echo "SURFACE GUARD: CANNOT-TELL — no baseline at $BASE. Run 'snapshot' BEFORE the build; a subtraction check with no 'before' measured nothing." >&2
      exit 2
    fi
    if [ ! -s "$BASE" ]; then
      echo "SURFACE GUARD: CANNOT-TELL — baseline at $BASE is EMPTY (snapshot captured nothing). Measured nothing; not a pass." >&2
      exit 2
    fi
    base_n=$(grep -c . "$BASE" || true)
    if [ "${base_n:-0}" -lt 2 ]; then
      echo "SURFACE GUARD: CANNOT-TELL — baseline has only ${base_n:-0} command(s); unparseable/degenerate. Not a pass." >&2
      exit 2
    fi
    now="$(current_surface)"
    now_n=$(printf '%s\n' "$now" | grep -c . || true)
    if [ "${now_n:-0}" -lt 2 ]; then
      echo "SURFACE GUARD: CANNOT-TELL — post-build surface has ${now_n:-0} commands (build broken?). Not asserting PASS over an unreadable surface." >&2
      exit 2
    fi
    removed="$(comm -23 <(sort -u "$BASE") <(printf '%s\n' "$now"))"
    added="$(comm -13 <(sort -u "$BASE") <(printf '%s\n' "$now"))"
    [ -n "$added" ] && printf '%s\n' "$added" | sed 's/^/  + /'
    if [ -n "$removed" ]; then
      printf '%s\n' "$removed" | sed 's/^/  - /'
      echo "SURFACE GUARD: FAIL — the rebuild REMOVED the command(s) above. A subtraction is never expected on a deploy; abort the release and find the branch the capability lived on." >&2
      exit 2
    fi
    echo "SURFACE GUARD: PASS — no command removed across top+bus surfaces (additions, if any, shown above and are expected)."
    ;;
  *)
    echo "usage: $0 snapshot|check   (env: CLI_ENTRY, SURFACE_BASELINE, SURFACE_NOW_FILE)" >&2
    exit 64
    ;;
esac
