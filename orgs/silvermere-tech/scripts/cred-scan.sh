#!/usr/bin/env bash
# cred-scan.sh — the COMBINED credential predicate (engineer, 2026-07-19).
#
# Layers the two axes that each miss a different class:
#   NAME  axis: cred-matcher.sh CRED_SHAPE  (a name that says "credential")
#   VALUE axis: cred-value-detect.py        (a value that looks like a secret)
#   + the SHORT-AND-CRED-NAMED arm: a short value under a cred-shaped name is a
#     WEAK credential — invisible to the value axis (below MIN_LEN) and the first
#     class the value axis is ANTI-CORRELATED against.
#
# SOURCES cred-matcher.sh — the name predicate is never forked. Reads NAME=VALUE
# on stdin (e.g. `tr '\0' '\n' < /proc/PID/environ`). Emits SECRET / UNDECIDABLE
# lines; BENIGN is silent. UNDECIDABLE is the countable review bucket, not an
# alarm and not a silent benign.
#
# Usage:  tr '\0' '\n' < /proc/PID/environ | cred-scan.sh
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
. "$DIR/cred-matcher.sh"

NAME_RE="^[A-Z0-9_]*${CRED_SHAPE}[A-Z0-9_]*="

while IFS= read -r line; do
  [[ "$line" == *=* ]] || continue
  name="${line%%=*}"
  value="${line#*=}"
  # legitimately-needed creds (BOT_TOKEN) are suppressed, same as the name axis
  if printf '%s=x\n' "$name" | grep -qE "$CRED_NEEDED"; then continue; fi
  name_is_cred=false
  if printf '%s=x\n' "$name" | grep -qE "$NAME_RE"; then name_is_cred=true; fi
  # value axis + combined arm, delegated to the python engine (name-free core;
  # combined_verdict takes the sourced name_is_cred boolean)
  printf '%s' "$value" | python3 "$DIR/cred-value-detect.py" --combined "$name_is_cred" "$name"
done
