#!/usr/bin/env python3
"""
file-convert.py — markdown converter for cortextos bus convert-file.

Detects the input file's extension and dispatches:
  - .pdf                                 → Kreuzberg v4.9.9 (PDF structural fidelity)
  - .docx/.xlsx/.pptx/.html/.htm/.csv/   → markitdown (Office sweet spot)
    .json/.eml/.tex/.ipynb/.txt/.md/
    common code extensions (.py/.js/...)
  - other                                → markitdown best-effort (markitdown is
                                           extension-agnostic and will try a
                                           generic converter chain)

Output: markdown to stdout. Errors to stderr with a clear remediation message.

Usage:
    file-convert.py <path> [--ocr] [--format markdown|json]

Flags:
    --ocr     For PDFs: force OCR via Kreuzberg even when a text layer exists.
              Requires tesseract-ocr installed (apt-get install tesseract-ocr).
    --format  Default markdown. `json` emits a small envelope with content +
              extractor metadata for callers that want structured output.

License: cortextos ships under MIT, but Kreuzberg is ELv2 (internal use only).
Do not embed this converter in a client-facing product without re-evaluating
the license boundary.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shutil
import sys
import zipfile
from pathlib import Path

PDF_EXTS = {".pdf"}
# markitdown owns these — its converter chain is built around them.
MARKITDOWN_EXTS = {
    # Office
    ".docx", ".xlsx", ".pptx", ".xls", ".doc", ".ppt",
    # Web + structured text
    ".html", ".htm", ".xml", ".json", ".csv", ".tsv",
    # Email + papers + notebooks
    ".eml", ".msg", ".tex", ".ipynb",
    # Plain text + common code (markitdown returns these mostly as-is)
    ".txt", ".md", ".rst",
    ".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java", ".rb",
    ".sh", ".yaml", ".yml", ".toml", ".sql",
    # Audio/image — markitdown can OCR/transcribe with [all] extras
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp",
    ".mp3", ".wav", ".m4a", ".ogg",
}


def emit(content: str, *, extractor: str, path: Path, output_format: str) -> None:
    if output_format == "json":
        payload = {
            "ok": True,
            "extractor": extractor,
            "source_path": str(path),
            "source_bytes": path.stat().st_size if path.exists() else None,
            "content_chars": len(content),
            "content": content,
        }
        json.dump(payload, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
    else:
        sys.stdout.write(content)
        if not content.endswith("\n"):
            sys.stdout.write("\n")


def fail(message: str, *, code: int = 1) -> None:
    print(f"file-convert: {message}", file=sys.stderr)
    sys.exit(code)


def convert_pdf(path: Path, *, force_ocr: bool) -> str:
    """PDF → markdown via Kreuzberg v4.9.9.

    Kreuzberg uses pypdfium2 for the text layer and falls back to Tesseract
    when --ocr is set OR the document has no text layer. We surface a clear
    apt-get message when tesseract is missing on an empty-output PDF, so
    callers don't see a silent empty string.
    """
    try:
        from kreuzberg import extract_file_sync, ExtractionConfig  # type: ignore
    except Exception as exc:
        fail(f"kreuzberg import failed: {exc}", code=4)

    config = ExtractionConfig(force_ocr=force_ocr)
    try:
        result = extract_file_sync(str(path), config=config)
    except Exception as exc:
        # Kreuzberg raises its own MissingDependencyError / OCRError types;
        # we surface the message verbatim so the operator can act on it.
        msg = str(exc)
        # Tesseract hint when the message mentions it
        if "tesseract" in msg.lower():
            fail(
                f"kreuzberg needs tesseract for this PDF — "
                f"install with: sudo apt-get install -y tesseract-ocr\n  underlying: {msg}",
                code=5,
            )
        fail(f"kreuzberg extraction failed: {msg}", code=3)

    content = (getattr(result, "content", None) or "").strip()
    if not content:
        # Empty output from a PDF usually means scanned-only without OCR.
        tess = shutil.which("tesseract")
        if tess is None:
            fail(
                "PDF produced empty markdown (likely scanned/image-only). "
                "Install tesseract for OCR: sudo apt-get install -y tesseract-ocr, "
                "then re-run with --ocr.",
                code=5,
            )
        fail(
            "PDF produced empty markdown. Tesseract IS installed; "
            "try re-running with --ocr to force the OCR path.",
            code=6,
        )
    return content


def convert_markitdown(path: Path) -> str:
    """Everything-not-PDF → markdown via markitdown.

    markitdown auto-detects format from extension + magic bytes. The [all]
    extras (installed in the framework venv) cover Office + audio/image OCR.
    """
    try:
        from markitdown import MarkItDown  # type: ignore
    except Exception as exc:
        fail(f"markitdown import failed: {exc}", code=4)

    md = MarkItDown()
    try:
        result = md.convert(str(path))
    except Exception as exc:
        fail(f"markitdown conversion failed: {exc}", code=3)

    content = (getattr(result, "text_content", None) or "").strip()
    if not content:
        fail(
            f"markitdown produced empty output for {path.suffix or 'no-extension'} file. "
            "If this is a binary/format markitdown doesn't recognise, try forcing a different "
            "tool — Office/HTML/CSV/JSON are the sweet spot here.",
            code=6,
        )
    return enrich_office_images(content, path)


# Markitdown emits a literal `![](data:image/<type>;base64...)` placeholder for
# every embedded image in an Office document — the `...` is text, not a stream
# truncation. The filename is lost, so KB consumers can't tell which image was
# where. We post-process DOCX/PPTX output to substitute the source filename in
# document order. Fail-soft: any zip/XML hiccup leaves the original output
# untouched so conversion never breaks on enrichment.
_MD_IMG_PLACEHOLDER = re.compile(r"!\[\]\(data:image/[^;]+;base64\.\.\.\)")


def enrich_office_images(content: str, path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix not in {".docx", ".pptx"}:
        return content
    if not _MD_IMG_PLACEHOLDER.search(content):
        return content
    try:
        ordered = _ordered_office_media(path, suffix)
    except Exception:
        return content
    if not ordered:
        return content

    counter = {"i": 0}

    def _sub(_match: "re.Match[str]") -> str:
        i = counter["i"]
        counter["i"] += 1
        if i < len(ordered):
            return f"[image: {ordered[i]}]"
        return "[image: <unmatched>]"

    return _MD_IMG_PLACEHOLDER.sub(_sub, content)


def _parse_rels(xml_text: str) -> dict[str, str]:
    return dict(re.findall(r'Id="([^"]+)"\s+Type="[^"]+"\s+Target="([^"]+)"', xml_text))


def _ordered_office_media(path: Path, suffix: str) -> list[str]:
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        if suffix == ".docx":
            rels_name = "word/_rels/document.xml.rels"
            doc_name = "word/document.xml"
            if rels_name not in names or doc_name not in names:
                return []
            rels = _parse_rels(z.read(rels_name).decode("utf-8", "replace"))
            doc = z.read(doc_name).decode("utf-8", "replace")
            rids = re.findall(r'r:embed="(rId\d+)"', doc)
            return [os.path.basename(rels[r]) for r in rids if r in rels]

        if suffix == ".pptx":
            slide_rels = sorted(
                (n for n in names if re.match(r"ppt/slides/_rels/slide\d+\.xml\.rels$", n)),
                key=lambda n: int(re.search(r"slide(\d+)", n).group(1)),
            )
            ordered: list[str] = []
            for rels_name in slide_rels:
                num = re.search(r"slide(\d+)", rels_name).group(1)
                slide_name = f"ppt/slides/slide{num}.xml"
                if slide_name not in names:
                    continue
                rels = _parse_rels(z.read(rels_name).decode("utf-8", "replace"))
                doc = z.read(slide_name).decode("utf-8", "replace")
                rids = re.findall(r'r:embed="(rId\d+)"', doc)
                ordered.extend(os.path.basename(rels[r]) for r in rids if r in rels)
            return ordered
    return []


def main() -> int:
    p = argparse.ArgumentParser(prog="file-convert", description=__doc__.split("\n\n")[0])
    p.add_argument("path", help="File path to convert")
    p.add_argument("--ocr", action="store_true", help="Force OCR (PDF only, requires tesseract)")
    p.add_argument(
        "--format",
        choices=("markdown", "json"),
        default="markdown",
        help="Output shape — markdown to stdout (default) or json envelope",
    )
    args = p.parse_args()

    path = Path(args.path).expanduser()
    if not path.exists():
        fail(f"file not found: {args.path}", code=2)
    if not path.is_file():
        fail(f"not a regular file: {args.path}", code=2)

    suffix = path.suffix.lower()

    if suffix in PDF_EXTS:
        content = convert_pdf(path, force_ocr=args.ocr)
        extractor = "kreuzberg-4.9.9"
    elif suffix in MARKITDOWN_EXTS or suffix == "":
        content = convert_markitdown(path)
        extractor = "markitdown"
    else:
        # Unknown extension — give markitdown a shot (it has a generic chain).
        # If it fails, the operator gets a clear markitdown error message.
        content = convert_markitdown(path)
        extractor = "markitdown-fallback"

    emit(content, extractor=extractor, path=path, output_format=args.format)
    return 0


if __name__ == "__main__":
    sys.exit(main())
