#!/usr/bin/env bash
# render-with-images.sh — render a markdown doc to PDF with file:// images inlined as base64.
#
# Why: scripts/doc-to-pdf.js loads HTML via page.setContent which uses about:blank as
# baseURL — file:// <img> srcs do not load. This wrapper substitutes file://path/to/img.jpg
# inline as data:image/jpeg;base64,... before rendering, so the source markdown stays lean
# (file:// references, ~kb) but the rendered PDF still gets full images.
#
# Usage:
#   scripts/render-with-images.sh <input.md> [output.pdf]
#
# If output is omitted, writes <input-basename>.pdf alongside the input.

set -euo pipefail

INPUT="${1:?Usage: render-with-images.sh <input.md> [output.pdf]}"
OUTPUT="${2:-${INPUT%.*}.pdf}"

if [[ ! -f "$INPUT" ]]; then
  echo "Input not found: $INPUT" >&2
  exit 1
fi

TMP=$(mktemp --suffix=.md)
trap 'rm -f "$TMP"' EXIT

# Substitute every file:// reference with a data: URI containing the base64-encoded image.
node -e '
const fs = require("fs");
const inputPath = process.argv[1];
const tmpPath = process.argv[2];
let md = fs.readFileSync(inputPath, "utf-8");
const re = /file:\/\/(\/[^"\s]+\.(jpg|jpeg|png|gif|webp))/gi;
md = md.replace(re, (m, p, ext) => {
  if (!fs.existsSync(p)) { console.error("Image missing, leaving file://: " + p); return m; }
  const mime = ext.toLowerCase() === "png"  ? "image/png"
             : ext.toLowerCase() === "gif"  ? "image/gif"
             : ext.toLowerCase() === "webp" ? "image/webp"
             : "image/jpeg";
  const b64 = fs.readFileSync(p).toString("base64");
  return "data:" + mime + ";base64," + b64;
});
fs.writeFileSync(tmpPath, md);
' "$INPUT" "$TMP"

# Render the substituted markdown via the existing renderer.
node "$(dirname "$0")/doc-to-pdf.js" "$TMP" "$OUTPUT"
