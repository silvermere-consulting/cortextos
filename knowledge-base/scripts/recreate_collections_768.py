#!/usr/bin/env python3
"""Recreate ChromaDB collections at 768-dim with nomic-embed-text-v1.5.

WHY (not reembed_collections.py): the silvermere-tech collections were created
at 3072-dim (Gemini-embedding-2 at full dimensionality). ChromaDB fixes a
collection's embedding dimension at creation, so an in-place upsert of 768-dim
nomic vectors is rejected ("expecting dimension 3072, got 768"). The only path
to 768 is DROP + RECREATE the collection.

Strategy (per collection): export all (id, document, metadata) -> delete the
collection -> recreate (same name + metadata) -> re-add in batches with nomic
768-dim vectors over each entry's stored TEXT. Unlike the in-place reembed, we
do NOT skip multimodal entries: in a recreated 768 collection a skipped 3072
vector cannot coexist, so dropping them would lose data. Multimodal entries
carry a text 'document' (the Gemini-generated description) — we nomic-embed THAT
(768). Lower fidelity than native multimodal, but lossless and the accepted
text-only tradeoff (measured in eval-v2).

SAFETY: caller must back up the chromadb dir first. This DROPS collections.

CLI:
  python3 recreate_collections_768.py <chromadb_dir> <col1> [col2 ...]
  python3 recreate_collections_768.py <chromadb_dir> --dummy-selftest
"""
from __future__ import annotations
import sys
from pathlib import Path
import chromadb

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))
from local_embedder import embed_texts, warmup, EMBED_DIM  # noqa: E402

BATCH = 64


def export_all(col):
    """Page out every (id, doc, meta) in the collection."""
    out_ids, out_docs, out_metas = [], [], []
    n = col.count()
    off = 0
    while off < n:
        b = col.get(limit=BATCH, offset=off, include=["documents", "metadatas"])
        ids = b.get("ids", [])
        if not ids:
            break
        docs = b.get("documents", []) or []
        metas = b.get("metadatas", []) or [None] * len(ids)
        out_ids += ids
        out_docs += docs
        out_metas += metas
        off += len(ids)
    return out_ids, out_docs, out_metas


def recreate(client, name, dry_run=False):
    col = client.get_collection(name)
    meta = col.metadata or None
    ids, docs, metas = export_all(col)
    total = len(ids)
    # only entries with usable text can be re-embedded; entries with empty
    # document text (rare) are dropped + reported rather than silently kept.
    keep = [(i, d, m) for i, d, m in zip(ids, docs, metas) if isinstance(d, str) and d.strip()]
    dropped = total - len(keep)
    if dry_run:
        return {"name": name, "total": total, "keep": len(keep), "dropped": dropped, "recreated": False}

    client.delete_collection(name)
    new = client.create_collection(name, metadata=meta) if meta else client.create_collection(name)
    for s in range(0, len(keep), BATCH):
        chunk = keep[s:s + BATCH]
        cids = [c[0] for c in chunk]
        cdocs = [c[1] for c in chunk]
        cmetas = [c[2] for c in chunk]
        embs = embed_texts(cdocs, task_type="RETRIEVAL_DOCUMENT", batch_size=BATCH)
        new.add(ids=cids, documents=cdocs, metadatas=cmetas, embeddings=embs)
    # verify
    vc = new.count()
    r = new.get(limit=1, include=["embeddings"])
    dim = len(r["embeddings"][0]) if r.get("embeddings") is not None and len(r["embeddings"]) else None
    return {"name": name, "total": total, "keep": len(keep), "dropped": dropped,
            "recreated": True, "new_count": vc, "new_dim": dim}


def dummy_selftest(client):
    """Prove the mechanic without touching real data: make a 3072 dummy, recreate at 768."""
    name = "recreate-selftest-3072"
    try:
        client.delete_collection(name)
    except Exception:
        pass
    col = client.create_collection(name)
    # add 3 docs with fake 3072 vectors (simulating Gemini collection)
    col.add(
        ids=["a", "b", "c"],
        documents=["alpha doc text", "beta doc text", "gamma doc text"],
        metadatas=[{"k": 1}, {"k": 2}, {"media_type": "image"}],  # incl a 'multimodal' entry
        embeddings=[[0.1] * 3072, [0.2] * 3072, [0.3] * 3072],
    )
    before = col.count()
    bdim = len(col.get(limit=1, include=["embeddings"])["embeddings"][0])
    warmup()
    res = recreate(client, name)
    client.delete_collection(name)
    ok = (res["recreated"] and res["new_count"] == before and res["new_dim"] == EMBED_DIM and res["dropped"] == 0)
    print(f"SELFTEST: before={before}@{bdim}dim -> after={res['new_count']}@{res['new_dim']}dim "
          f"dropped={res['dropped']} (incl multimodal entry kept via text) -> {'PASS' if ok else 'FAIL'}")
    return ok


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    chroma = sys.argv[1]
    client = chromadb.PersistentClient(path=chroma)
    if sys.argv[2] == "--dummy-selftest":
        return 0 if dummy_selftest(client) else 1
    targets = sys.argv[2:]
    warmup()
    print(f"Recreating {len(targets)} collection(s) at {EMBED_DIM}-dim:")
    for name in targets:
        r = recreate(client, name)
        print(f"  [{r['name']}] {r['total']} -> {r['new_count']} docs @ {r['new_dim']}dim "
              f"(dropped {r['dropped']} empty-text)")
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
