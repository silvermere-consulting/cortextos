---
name: file-ingest
description: "You have a file path (PDF, docx, xlsx, pptx, html, csv, json, eml, ipynb, audio/image, code) and you want to read its content as markdown — or you want to drop the converted content into the knowledge base in one shot. Reach for `cortextos bus convert-file <path>`: auto-detects the format, routes PDFs through Kreuzberg v4.9.9 (structural fidelity) and everything else through markitdown (Office sweet spot), prints markdown to stdout or pipes into kb-ingest with `--kb-ingest`. Do not read binary files directly — use this skill so the conversion is consistent and fingerprinted."
triggers: ["convert file", "convert to markdown", "read pdf", "read docx", "read xlsx", "read pptx", "extract pdf text", "ingest pdf", "ingest docx", "file to markdown", "office to markdown", "markitdown", "kreuzberg", "ocr pdf", "scanned pdf"]
---

# File Ingest — `cortextos bus convert-file`

One-shot file-to-markdown converter for agents who need to read or KB-ingest a file path. Auto-detects format and dispatches to the right extractor.

## When to reach for this

- You have a file path and need its content as text/markdown to read or pass to another tool.
- You want to drop a document (PDF report, docx spec, xlsx data, html scrape) directly into a KB collection without manual conversion + ingest steps.
- You are about to read a binary file (PDF/docx/xlsx/pptx) — STOP, use this command instead. Reading binaries with the Read tool produces garbage.

## Quick commands

```bash
# Convert to stdout markdown
cortextos bus convert-file ./path/to/report.pdf

# Convert + ingest in one shot (shared collection)
cortextos bus convert-file ./report.pdf --kb-ingest --org $CTX_ORG

# Convert + ingest into private agent collection
cortextos bus convert-file ./spec.docx --kb-ingest --scope private --agent $CTX_AGENT_NAME --org $CTX_ORG

# Force OCR on a scanned PDF (requires tesseract-ocr installed)
cortextos bus convert-file ./scan.pdf --ocr

# JSON envelope with extractor metadata (useful for scripting)
cortextos bus convert-file ./report.pdf --json
```

## Routing

| Extension | Extractor | Notes |
|---|---|---|
| `.pdf` | Kreuzberg v4.9.9 | Best structural fidelity. Add `--ocr` for image-only / scanned PDFs (needs tesseract). |
| `.docx`, `.xlsx`, `.pptx`, `.xls`, `.doc`, `.ppt` | markitdown | Office sweet spot. Tables come through as markdown tables. |
| `.html`, `.htm`, `.xml`, `.json`, `.csv`, `.tsv` | markitdown | Structured text. CSV → markdown table. |
| `.eml`, `.msg`, `.tex`, `.ipynb` | markitdown | Email, papers, notebooks. |
| `.txt`, `.md`, `.rst` + common code (`.py`/`.js`/`.ts`/...) | markitdown | Mostly pass-through. |
| `.png`/`.jpg`/`.mp3`/etc | markitdown | OCR/transcribe with the `[all]` extras (already installed). |
| Other | markitdown (fallback) | Best-effort. |

## Flags

| Flag | Purpose |
|---|---|
| `--kb-ingest` | Pipe converted markdown into `cortextos bus kb-ingest` instead of stdout. |
| `--scope shared\|private` | `--kb-ingest` scope. Default `shared`. `private` requires `--agent`. |
| `--collection <name>` | Override auto-derived collection (e.g. `memory-{agent}`). |
| `--org <org>` | Required for `--kb-ingest`; inherits `$CTX_ORG` if set. |
| `--agent <name>` | Required for `--kb-ingest --scope private`. |
| `--force` | Re-ingest even if path-id already present. |
| `--ocr` | Force Kreuzberg OCR path on PDFs (requires `tesseract-ocr`). |
| `--json` | Stdout envelope `{ok, extractor, source_path, source_bytes, content_chars, content}`. |

## Error guidance

- **Empty markdown from a scanned/image-only PDF + tesseract missing:** the command exits non-zero with `Install tesseract for OCR: sudo apt-get install -y tesseract-ocr`. Do this once on the host (root/sudo only) — then `--ocr` works.
- **`kreuzberg import failed` / `markitdown import failed`:** the framework `knowledge-base/venv` is missing the Python deps. Re-run `pip install markitdown[all] kreuzberg==4.9.9` inside that venv.
- **`framework venv python not found`:** the KB setup has not been run for this instance. Run `cortextos kb setup` or check the path.

## License note (READ before embedding)

**Kreuzberg v4.9.9 is licensed ELv2 (Elastic License v2) — internal use only.** cortextos itself ships MIT. This command is an **internal-tool surface only**:

- Do NOT wrap `convert-file` into a client-facing product or API where the customer pays for an Kreuzberg-powered feature.
- Do NOT re-export Kreuzberg outputs as part of a hosted service offered to third parties.
- DO use it freely for internal research, agent workflows, knowledge-base ingestion, and engineering tasks.

If a client-facing PDF path is needed in future, swap to a permissive-licensed PDF extractor (PyMuPDF MIT, pypdfium2 Apache-2.0) at the routing layer in `knowledge-base/scripts/file-convert.py`.

## Where it lives

- Python script: `knowledge-base/scripts/file-convert.py` (shares the KB venv)
- TS wrapper: `src/bus/convert-file.ts`
- CLI registration: `src/cli/bus.ts` (`busCommand.command('convert-file')`)
- Reuses `ingestKnowledgeBase` from `src/bus/knowledge-base.ts` for `--kb-ingest`

## Examples in context

```bash
# Agent recieves a PDF report path from chief — read it
cortextos bus convert-file ~/reports/q2-strategy.pdf | head -200

# Writer asks: "what's in this docx the client sent?"
cortextos bus convert-file ./inbox/client-brief.docx

# Research finishes — ingest its findings to shared org KB
cortextos bus convert-file ./out/research-findings.pdf \
  --kb-ingest --scope shared --org silvermere-tech

# Engineer's own private notes
cortextos bus convert-file ~/notes/design-thoughts.html \
  --kb-ingest --scope private --agent engineer --org silvermere-tech
```
