#!/usr/bin/env python3
"""Build @768 nomic SHADOW collections for the local-embedder cutover.

SAFE / DECOUPLED / RESUMABLE. Writes ONLY shadow collections named
``<name>__768shadow``. It NEVER drops or modifies the live @3072 collections and
NEVER touches secrets.env, so the live KB stays clean @3072 throughout the run.
A surprise daemon restart costs only in-flight shadow progress — re-run and it
skips already-verified shadows (idempotent).

WHY shadows instead of in-place recreate_collections_768:
  In-place DROPs + recreates each live collection @768. The moment a live
  collection flips to 768, every agent (PTYs embed queries @3072 with no flag)
  gets a dim-mismatch on it — so an in-place run breaks the fleet progressively,
  collection-by-collection, for the WHOLE run, and any interruption leaves a
  split @768/@3072 query-broken state. Building into shadow names leaves the live
  collections untouched; the fast rename-swap cutover (see cutover_768.py) flips
  the whole fleet in one short window while the daemon is stopped — zero
  progressive-breakage window.

Mechanic reused from recreate_collections_768 (proven, dummy-selftested):
  multimodal entries are KEPT via their stored text 'document' (the Gemini
  description), nomic-embedded @768; only entries with empty/no text are dropped.

Per collection:
  1. export all (id, doc, meta) from the live collection
  2. keep = entries with usable text  (same rule as recreate_collections_768)
  3. if shadow exists AND verified (dim==768 and count==len(keep)) -> SKIP
  4. else drop any partial shadow, embed keep-docs @768, create shadow + add
  5. verify dim==768 and shadow.count()==len(keep); STOP-ON-FIRST-FAIL

shared-silvermere-tech is processed LAST (longest pole, ~3827 docs).

CLI:
  build_768_shadows.py <chromadb_dir>                       # default 13 real targets
  build_768_shadows.py <chromadb_dir> --targets c1 c2 ...   # explicit subset
  build_768_shadows.py <chromadb_dir> --suffix __768shadow  # shadow name suffix
  build_768_shadows.py <chromadb_dir> --selftest            # isolated mechanic proof
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import chromadb

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

from local_embedder import embed_texts, warmup, EMBED_DIM  # noqa: E402
from recreate_collections_768 import export_all  # reuse the proven exporter

# The 13 real collections to migrate. shared LAST. Excludes burst-test-*,
# business-in-a-box (0 docs), and eval-*-nomic (already @768 eval shadows).
DEFAULT_TARGETS = [
    "agent-analyst", "agent-business-analyst", "agent-chief",
    "agent-engineer", "agent-research", "agent-writer",
    "memory-analyst", "memory-business-analyst", "memory-chief",
    "memory-engineer", "memory-research", "memory-writer",
    "shared-silvermere-tech",  # longest pole — last
]
DEFAULT_SUFFIX = "__768shadow"
EMBED_BATCH = 64
ADD_BATCH = 256


def _keep_entries(ids, docs, metas):
    """Same keep rule as recreate_collections_768: usable text only."""
    return [(i, d, m) for i, d, m in zip(ids, docs, metas)
            if isinstance(d, str) and d.strip()]


def _shadow_dim(col):
    r = col.get(limit=1, include=["embeddings"])
    embs = r.get("embeddings")
    if embs is not None and len(embs):
        return len(embs[0])
    return None


def build_one(client, name, suffix):
    """Build/verify a single shadow. Returns a result dict; raises on failure."""
    shadow_name = f"{name}{suffix}"
    live = client.get_collection(name)
    meta = live.metadata or None
    ids, docs, metas = export_all(live)
    keep = _keep_entries(ids, docs, metas)
    want = len(keep)
    dropped = len(ids) - want

    # Resumable skip: shadow already exists and matches.
    existing = {c.name for c in client.list_collections()}
    if shadow_name in existing:
        sh = client.get_collection(shadow_name)
        if sh.count() == want and (want == 0 or _shadow_dim(sh) == EMBED_DIM):
            print(f"  [{name} -> {shadow_name}] SKIP (verified {want} docs @ {EMBED_DIM})", flush=True)
            return {"name": name, "shadow": shadow_name, "live": len(ids),
                    "keep": want, "dropped": dropped, "count": sh.count(),
                    "dim": EMBED_DIM if want else None, "action": "skip", "ok": True}
        # stale/partial — drop and rebuild
        print(f"  [{name} -> {shadow_name}] partial/stale (count {sh.count()} != {want}) — rebuilding", flush=True)
        client.delete_collection(shadow_name)

    print(f"  [{name} -> {shadow_name}] {len(ids)} live -> embedding {want} "
          f"(dropped {dropped} empty-text)...", flush=True)
    t0 = time.time()
    sh = client.create_collection(shadow_name, metadata=meta) if meta \
        else client.create_collection(shadow_name)
    for s in range(0, want, ADD_BATCH):
        chunk = keep[s:s + ADD_BATCH]
        cids = [c[0] for c in chunk]
        cdocs = [c[1] for c in chunk]
        cmetas = [c[2] for c in chunk]
        embs = embed_texts(cdocs, task_type="RETRIEVAL_DOCUMENT", batch_size=EMBED_BATCH)
        sh.add(ids=cids, documents=cdocs, metadatas=cmetas, embeddings=embs)
    embed_s = time.time() - t0

    # Verify
    count = sh.count()
    dim = _shadow_dim(sh) if count else None
    ok = (count == want) and (want == 0 or dim == EMBED_DIM)
    rate = want / embed_s if embed_s > 0 else 0
    status = "OK" if ok else "FAIL"
    print(f"    {status}: {count}/{want} docs @ {dim}dim in {embed_s:.1f}s ({rate:.0f}/s)", flush=True)
    if not ok:
        raise RuntimeError(
            f"verify failed for {shadow_name}: count={count} want={want} dim={dim} expected={EMBED_DIM}")
    return {"name": name, "shadow": shadow_name, "live": len(ids), "keep": want,
            "dropped": dropped, "count": count, "dim": dim,
            "embed_s": round(embed_s, 2), "action": "built", "ok": True}


def selftest(client, suffix):
    """Prove the shadow mechanic on an isolated dummy 3072 collection."""
    name = "shadow-selftest-3072"
    for n in (name, f"{name}{suffix}"):
        try:
            client.delete_collection(n)
        except Exception:
            pass
    col = client.create_collection(name)
    col.add(
        ids=["a", "b", "c", "d"],
        documents=["alpha text", "beta text", "gamma text", ""],  # one empty -> dropped
        metadatas=[{"k": 1}, {"k": 2}, {"media_type": "image"}, {"k": 4}],
        embeddings=[[0.1] * 3072, [0.2] * 3072, [0.3] * 3072, [0.4] * 3072],
    )
    warmup()
    r1 = build_one(client, name, suffix)            # build
    r2 = build_one(client, name, suffix)            # idempotent skip
    ok = (r1["action"] == "built" and r1["count"] == 3 and r1["dropped"] == 1
          and r1["dim"] == EMBED_DIM and r2["action"] == "skip")
    for n in (name, f"{name}{suffix}"):
        try:
            client.delete_collection(n)
        except Exception:
            pass
    print(f"SELFTEST: build={r1['action']}({r1['count']}@{r1['dim']},drop {r1['dropped']}) "
          f"rerun={r2['action']} -> {'PASS' if ok else 'FAIL'}")
    return ok


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2
    chroma = args[0]
    rest = args[1:]
    suffix = DEFAULT_SUFFIX
    if "--suffix" in rest:
        i = rest.index("--suffix")
        suffix = rest[i + 1]
        del rest[i:i + 2]

    client = chromadb.PersistentClient(path=chroma)

    if rest[:1] == ["--selftest"]:
        return 0 if selftest(client, suffix) else 1

    if rest[:1] == ["--targets"]:
        targets = rest[1:]
    else:
        targets = DEFAULT_TARGETS

    existing = {c.name for c in client.list_collections()}
    missing = [t for t in targets if t not in existing]
    if missing:
        print(f"WARNING: targets not found, skipping: {missing}")
    targets = [t for t in targets if t in existing]

    print(f"ChromaDB: {chroma}")
    print(f"Shadow suffix: {suffix}")
    print(f"Targets ({len(targets)}): {targets}")
    print("Warming up nomic embedder...")
    warmup()

    results = []
    print("\nBuilding shadows (STOP-ON-FIRST-FAIL):")
    for name in targets:
        try:
            results.append(build_one(client, name, suffix))
        except Exception as e:
            print(f"\nFAIL on {name}: {e}")
            print(json.dumps({"failed": name, "error": str(e),
                              "completed": results}, indent=2))
            print("BUILD_768_SHADOWS_FAIL")
            return 1

    built = sum(1 for r in results if r["action"] == "built")
    skipped = sum(1 for r in results if r["action"] == "skip")
    docs = sum(r["count"] for r in results)
    print(f"\nDONE: {len(results)} shadows ({built} built, {skipped} skipped), "
          f"{docs} docs @ {EMBED_DIM}dim.")
    print("\nPer-collection:")
    for r in results:
        print(f"  {r['shadow']:54s} {r['count']:>6d} @ {r['dim']}  [{r['action']}]")
    print(json.dumps({"results": results, "total_docs": docs}, indent=2))
    print("BUILD_768_SHADOWS_COMPLETE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
