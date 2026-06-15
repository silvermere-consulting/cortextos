#!/usr/bin/env python3
"""Build/refresh the nomic eval-shadow collections used by run_embed_eval.py.

The eval validates retrieval quality on SHADOW collections (eval-<target>-nomic)
so production Gemini-embedded collections are never touched. This script makes
that shadow build REPRODUCIBLE — previously the shadows were created by a
one-off manual step, so the eval couldn't be re-run against fresh content
(stale shadows were confounding the verdict).

For each source collection it:
  1. Reads all (id, document, metadata) tuples (text only — multimodal skipped,
     nomic is text-only).
  2. Embeds documents with the local nomic backend (RETRIEVAL_DOCUMENT prefix).
  3. Drops any existing shadow and recreates it fresh with the nomic vectors.

The shadow always passes explicit embeddings on add and the eval passes explicit
query_embeddings on query, so ChromaDB's own embedding function is never invoked
on these collections (dimension stays 768, consistent with the query path).

CLI:
  build_eval_shadows.py <chromadb_dir> [--targets memory-a memory-b ...]
  build_eval_shadows.py <chromadb_dir>            # default 3 eval targets
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import chromadb

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

from local_embedder import embed_texts, warmup
# Production chunker + chunk-id scheme, reused so the source-built shadow matches
# what mmrag would actually ingest (fidelity — same boundaries, same ids).
from mmrag import chunk_text, file_id, DEFAULT_TEXT_CHUNK_SIZE, DEFAULT_TEXT_CHUNK_OVERLAP

DEFAULT_TARGETS = ["memory-analyst", "memory-chief", "memory-engineer"]
READ_BATCH = 64
EMBED_BATCH = 32
TASK_TYPE = "RETRIEVAL_DOCUMENT"

# memory-<agent> collection ← that agent's MEMORY.md + memory/*.md daily files.
REPO_ROOT = Path("/home/cortext/cortextos")
SOURCE_MAP = {
    "memory-analyst": REPO_ROOT / "orgs/silvermere-tech/agents/analyst",
    "memory-chief": REPO_ROOT / "orgs/silvermere-tech/agents/chief",
    "memory-engineer": REPO_ROOT / "orgs/silvermere-tech/agents/engineer",
}


def _source_files(agent_dir: Path):
    """MEMORY.md + all daily memory files, mirroring the heartbeat ingest set."""
    files = []
    mem = agent_dir / "MEMORY.md"
    if mem.exists():
        files.append(mem)
    mem_dir = agent_dir / "memory"
    if mem_dir.is_dir():
        files.extend(sorted(mem_dir.glob("*.md")))
    return files


def build_shadow_from_source(client, source_name: str) -> dict:
    """Build eval-<source_name>-nomic by RE-CHUNKING the agent's source .md files
    with the production chunker and nomic-embedding them. This reflects what the
    local backend would actually ingest from current source — used when the
    embedded collection lags disk (ingestion gap)."""
    shadow_name = f"eval-{source_name}-nomic"
    agent_dir = SOURCE_MAP.get(source_name)
    if not agent_dir or not agent_dir.exists():
        print(f"  [{source_name}] SKIP — no source dir mapped")
        return {"source": source_name, "shadow": shadow_name, "docs": 0, "skipped": True}

    files = _source_files(agent_dir)
    ids_all, docs_all, metas_all = [], [], []
    for fp in files:
        text = fp.read_text(errors="replace")
        chunks = chunk_text(text, chunk_size=DEFAULT_TEXT_CHUNK_SIZE,
                            overlap=DEFAULT_TEXT_CHUNK_OVERLAP)
        for idx, ch in enumerate(chunks):
            if not ch.strip():
                continue
            ids_all.append(file_id(fp, idx))
            docs_all.append(ch)
            metas_all.append({"source": str(fp), "chunk_index": idx,
                              "total_chunks": len(chunks), "_shadow": "nomic-source"})

    print(f"  [{source_name} -> {shadow_name}] {len(files)} files → {len(ids_all)} chunks", flush=True)
    if not ids_all:
        print("    (no chunks — skipping)")
        return {"source": source_name, "shadow": shadow_name, "docs": 0, "skipped": True}

    t0 = time.time()
    vecs = embed_texts(docs_all, task_type=TASK_TYPE, batch_size=EMBED_BATCH)
    embed_s = time.time() - t0

    try:
        client.delete_collection(shadow_name)
    except Exception:
        pass
    shadow = client.create_collection(shadow_name)
    for s in range(0, len(ids_all), 256):
        e = s + 256
        shadow.add(ids=ids_all[s:e], embeddings=vecs[s:e],
                   documents=docs_all[s:e], metadatas=metas_all[s:e])
    rate = len(ids_all) / embed_s if embed_s > 0 else 0
    print(f"    ✓ {len(ids_all)} chunks embedded in {embed_s:.1f}s ({rate:.0f}/s) "
          f"→ shadow count {shadow.count()}")
    return {"source": source_name, "shadow": shadow_name,
            "docs": len(ids_all), "embed_s": round(embed_s, 2), "skipped": False}


def _sanitize_meta(meta):
    """ChromaDB rejects per-item None inside a metadatas list. Replace with a
    minimal non-empty dict so every shadow entry carries valid metadata."""
    if isinstance(meta, dict) and meta:
        return meta
    return {"_shadow": "nomic"}


def build_shadow(client, source_name: str) -> dict:
    shadow_name = f"eval-{source_name}-nomic"
    src = client.get_collection(source_name)
    total = src.count()
    print(f"  [{source_name} -> {shadow_name}] {total} docs", flush=True)

    ids_all, docs_all, metas_all = [], [], []
    offset = 0
    while offset < total:
        batch = src.get(limit=READ_BATCH, offset=offset,
                        include=["documents", "metadatas"])
        ids = batch.get("ids", [])
        docs = batch.get("documents", [])
        metas = batch.get("metadatas", []) or [None] * len(ids)
        if not ids:
            break
        for i, d in enumerate(docs):
            if d and isinstance(d, str):  # text only — skip multimodal/empty
                ids_all.append(ids[i])
                docs_all.append(d)
                metas_all.append(_sanitize_meta(metas[i]))
        offset += len(ids)

    if not ids_all:
        print("    (no text docs — skipping)")
        return {"source": source_name, "shadow": shadow_name, "docs": 0, "skipped": True}

    t0 = time.time()
    vecs = embed_texts(docs_all, task_type=TASK_TYPE, batch_size=EMBED_BATCH)
    embed_s = time.time() - t0

    # Drop + recreate the shadow for a clean, deterministic rebuild.
    try:
        client.delete_collection(shadow_name)
    except Exception:
        pass  # didn't exist yet
    shadow = client.create_collection(shadow_name)

    # Add in chunks to keep request sizes sane.
    for s in range(0, len(ids_all), 256):
        e = s + 256
        shadow.add(ids=ids_all[s:e], embeddings=vecs[s:e],
                   documents=docs_all[s:e], metadatas=metas_all[s:e])

    rate = len(ids_all) / embed_s if embed_s > 0 else 0
    print(f"    ✓ {len(ids_all)} docs embedded in {embed_s:.1f}s ({rate:.0f}/s) "
          f"→ shadow count {shadow.count()}")
    return {"source": source_name, "shadow": shadow_name,
            "docs": len(ids_all), "embed_s": round(embed_s, 2), "skipped": False}


def main():
    if len(sys.argv) < 2:
        print("Usage: build_eval_shadows.py <chromadb_dir> [--targets <c1> <c2> ...]")
        sys.exit(1)
    chromadb_dir = sys.argv[1]
    rest = sys.argv[2:]
    if rest[:1] == ["--targets"]:
        targets = rest[1:]
    else:
        targets = DEFAULT_TARGETS

    client = chromadb.PersistentClient(path=chromadb_dir)
    existing = {c.name for c in client.list_collections()}
    targets = [t for t in targets if t in existing] or DEFAULT_TARGETS

    print(f"ChromaDB: {chromadb_dir}")
    print(f"Targets:  {targets}")
    print("Warming up embedder...")
    warmup()

    print("\nBuilding shadows:")
    stats = [build_shadow(client, t) for t in targets if t in existing]
    total = sum(s["docs"] for s in stats)
    print(f"\nTOTAL: {total} docs across {len(stats)} shadow(s) rebuilt.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
