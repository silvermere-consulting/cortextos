#!/usr/bin/env python3
"""Orchestrate 768-dim recreate across the 13 real silvermere-tech collections.

Wraps recreate_collections_768.recreate() with operational safety rails the bare
script lacks: idempotent skip-if-already-768, per-collection verify+assert,
stop-on-first-fail (blast radius <= 1 collection, restorable from backup), and
shared-silvermere-tech LAST (the 3827-doc long pole).

Preserves the eval-*-nomic shadow collections (William's eval-v2 baselines) and
skips the burst-test-* cruft + empty business-in-a-box by simply not targeting them.

Markers (for the watcher): RECREATE_ALL_COMPLETE on full success, RECREATE_ALL_FAIL
on any failure. Backup at chromadb.gemini-backup-2026-06-15 is the rollback.
"""
from __future__ import annotations
import sys
import time
import traceback
from pathlib import Path

import chromadb

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
from local_embedder import warmup, EMBED_DIM  # noqa: E402
from recreate_collections_768 import recreate  # noqa: E402

CHROMA = "/home/cortext/.cortextos/default/orgs/silvermere-tech/knowledge-base/chromadb"

# 13 real collections, shared LAST. eval-*-nomic preserved, burst-test-*/empty skipped.
TARGETS = [
    "agent-analyst", "agent-business-analyst", "agent-chief", "agent-engineer",
    "agent-research", "agent-writer",
    "memory-analyst", "memory-business-analyst", "memory-chief", "memory-engineer",
    "memory-research", "memory-writer",
    "shared-silvermere-tech",  # LAST — long pole (~8.5 min)
]


def cur_dim(col):
    if col.count() == 0:
        return None
    r = col.get(limit=1, include=["embeddings"])
    e = r.get("embeddings")
    return len(e[0]) if e is not None and len(e) else None


def ts():
    return time.strftime("%H:%M:%S")


def main():
    client = chromadb.PersistentClient(path=CHROMA)
    print(f"[{ts()}] warmup local embedder...", flush=True)
    warmup()
    print(f"[{ts()}] START recreate-all — EMBED_DIM={EMBED_DIM}, {len(TARGETS)} targets", flush=True)
    results = []
    for name in TARGETS:
        t0 = time.time()
        try:
            col = client.get_collection(name)
        except Exception as e:
            print(f"[{ts()}] FAIL open {name}: {e}", flush=True)
            print("RECREATE_ALL_FAIL", flush=True)
            return 1
        before = col.count()
        d = cur_dim(col)
        if d == EMBED_DIM:
            print(f"[{ts()}] SKIP {name}: already {d}dim ({before} docs)", flush=True)
            results.append((name, before, before, d, "skip"))
            continue
        print(f"[{ts()}] RECREATE {name}: {before} docs @ {d}dim -> 768 ...", flush=True)
        try:
            r = recreate(client, name)
        except Exception as e:
            print(f"[{ts()}] FAIL recreate {name}: {e}", flush=True)
            traceback.print_exc()
            print("RECREATE_ALL_FAIL", flush=True)
            return 1
        if not r.get("recreated") or r.get("new_dim") != EMBED_DIM:
            print(f"[{ts()}] FAIL verify-dim {name}: {r}", flush=True)
            print("RECREATE_ALL_FAIL", flush=True)
            return 1
        if r["new_count"] != r["keep"]:
            print(f"[{ts()}] FAIL verify-count {name}: kept {r['keep']} but new_count {r['new_count']}", flush=True)
            print("RECREATE_ALL_FAIL", flush=True)
            return 1
        dt = time.time() - t0
        print(f"[{ts()}] OK {name}: {before} -> {r['new_count']} docs @ {r['new_dim']}dim "
              f"(dropped {r['dropped']} empty-text, {dt:.0f}s)", flush=True)
        results.append((name, before, r["new_count"], r["new_dim"], f"{dt:.0f}s"))

    print("\n=== SUMMARY (all 13 real collections) ===", flush=True)
    for name, b, a, dim, note in results:
        print(f"  {name:40s} {b:5d} -> {a:5d} @ {dim}dim  {note}", flush=True)
    print("RECREATE_ALL_COMPLETE", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
