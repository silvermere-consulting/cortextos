#!/usr/bin/env python3
"""Re-embed ChromaDB collections with nomic-embed-text-v1.5.

Strategy: walk each collection, batch-export (id, document, metadata) tuples,
re-embed documents with local nomic backend, upsert with new vectors. Same
collection name, same ids — vectors replaced in place. 768-dim matches
gemini-embedding-2-preview so no schema change needed.

CLI:
  python3 reembed_collections.py <chromadb_dir> [collection1 collection2 ...]
  python3 reembed_collections.py <chromadb_dir> --all
  python3 reembed_collections.py <chromadb_dir> --eval-only   # the 3 eval-target collections

Skip multimodal collections (those with metadata fields like 'media_type')
because nomic is text-only — multimodal stays on Gemini.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import chromadb

# Path setup
SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

from local_embedder import embed_texts, warmup

EVAL_TARGET_COLLECTIONS = ["memory-analyst", "memory-chief", "memory-engineer"]
BATCH_SIZE = 64
TASK_TYPE = "RETRIEVAL_DOCUMENT"


def reembed_collection(col, dry_run: bool = False) -> dict:
    """Re-embed all documents in a collection. Returns stats dict."""
    name = col.name
    count = col.count()
    if count == 0:
        return {"name": name, "count": 0, "elapsed": 0.0, "rate": 0, "skipped": True}

    print(f"  [{name}] {count} docs", flush=True)
    t0 = time.time()
    processed = 0
    offset = 0
    while offset < count:
        batch = col.get(
            limit=BATCH_SIZE,
            offset=offset,
            include=["documents", "metadatas"],
        )
        ids = batch.get("ids", [])
        docs = batch.get("documents", [])
        metas = batch.get("metadatas", []) or [None] * len(ids)
        if not ids:
            break

        # Filter out non-text entries (multimodal — has media_type or similar)
        text_idx = [i for i, d in enumerate(docs) if d and isinstance(d, str)]
        if not text_idx:
            offset += len(ids)
            continue
        text_ids = [ids[i] for i in text_idx]
        text_docs = [docs[i] for i in text_idx]
        text_metas = [metas[i] for i in text_idx]

        if not dry_run:
            vecs = embed_texts(text_docs, task_type=TASK_TYPE, batch_size=32)
            col.update(
                ids=text_ids,
                embeddings=vecs,
                documents=text_docs,
                metadatas=text_metas,
            )

        processed += len(text_ids)
        offset += len(ids)
        if processed % 256 == 0:
            elapsed = time.time() - t0
            rate = processed / elapsed if elapsed > 0 else 0
            print(f"    progress: {processed}/{count} ({rate:.0f} docs/sec)", flush=True)

    elapsed = time.time() - t0
    rate = processed / elapsed if elapsed > 0 else 0
    print(f"    ✓ done: {processed}/{count} in {elapsed:.1f}s ({rate:.0f} docs/sec)")
    return {"name": name, "count": count, "processed": processed,
            "elapsed": round(elapsed, 2), "rate": round(rate, 1),
            "skipped": False}


def main():
    if len(sys.argv) < 2:
        print("Usage: reembed_collections.py <chromadb_dir> [--all|--eval-only|<col1> ...]")
        sys.exit(1)

    chromadb_dir = sys.argv[1]
    args = sys.argv[2:]

    client = chromadb.PersistentClient(path=chromadb_dir)
    all_cols = client.list_collections()
    all_names = [c.name for c in all_cols]

    if not args or args == ["--all"]:
        targets = all_names
    elif args == ["--eval-only"]:
        targets = [n for n in EVAL_TARGET_COLLECTIONS if n in all_names]
    else:
        targets = [n for n in args if n in all_names]
        missing = [n for n in args if n not in all_names]
        if missing:
            print(f"WARN: collections not found: {missing}")

    if not targets:
        print("No matching collections; exiting.")
        sys.exit(2)

    print(f"Targets: {targets}")
    print(f"ChromaDB: {chromadb_dir}")
    print("Warming up embedder...")
    warmup()

    print("\nRe-embedding:")
    stats = []
    total_t0 = time.time()
    for name in targets:
        col = next((c for c in all_cols if c.name == name), None)
        if col is None:
            print(f"  [{name}] SKIP — not found")
            continue
        stats.append(reembed_collection(col))

    total_elapsed = time.time() - total_t0
    total_processed = sum(s.get("processed", 0) for s in stats)
    print()
    print(f"TOTAL: {total_processed} docs in {total_elapsed:.1f}s "
          f"({total_processed/total_elapsed:.0f} docs/sec across {len(targets)} collections)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
