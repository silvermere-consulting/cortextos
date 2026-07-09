#!/usr/bin/env python3
"""Run the embed-eval-v2 quality gate against the LIVE @768 local-embedder corpus.

Built per analyst spec workspace/embed-eval-v2-spec-2026-06-16.md (+ methodology
notes 2026-06-09). Differs from v1:
  - TOP_K = 10 (recall-focused); rank recorded separately as secondary metric.
  - Match = strict case-insensitive SUBSTRING of expected_anchor_phrase in the
    chunk doc. The v1 8-char overlap heuristic is DROPPED. Same rule for hits and
    misses (no asymmetric scoring).
  - config-value tier: scoring_strategy "exact-token" — the config string must
    appear as a standalone token in the chunk doc; gated separately.
  - PINNED authoritative collection per query (target_collection). Query ONLY
    that collection's top-K — no cross-collection merge (kills v1 routing
    ambiguity). Queries the LIVE collections (now @768 local post-cutover), NOT
    the eval-*-nomic shadows v1 used.
  - Tiered gate: critical 0 misses @K=10; standard <=25% misses; config-value
    <=20% misses (exact-token); overall hit-rate >=75%.

Quantisation: --quant fp32 (default, the SHIPPED config) | int8 (EVAL DELTA only,
never a default change without Steve). int8 dynamically quantises model.onnx to
model_int8.onnx (cached) and embeds queries through it; the corpus stays as-is
(this measures query-side quantisation sensitivity vs the fp32-built corpus,
per the pre-registered int8 acceptance criteria).

Output: workspace/embed-eval-v2-results-<quant>-<UTC>.json.

CLI:
  run_embed_eval_v2.py                  # fp32 gate
  run_embed_eval_v2.py --quant int8     # int8 delta pass
  EVAL_FILE / CHROMADB_DIR / EVAL_OUTPUT_DIR env overrides honoured.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

import numpy as np
import chromadb

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

import local_embedder as le
from local_embedder import embed_text, warmup, _prefix, _mean_pool, MODEL_DIR, EMBED_DIM

EVAL_FILE = Path(os.environ.get(
    "EVAL_FILE",
    "/home/cortext/cortextos/orgs/silvermere-tech/agents/analyst/workspace/embed-eval-v2.json",
))
CHROMADB_DIR = Path(os.environ.get(
    "CHROMADB_DIR",
    "/home/cortext/.cortextos/default/orgs/silvermere-tech/knowledge-base/chromadb",
))
OUTPUT_DIR = Path(os.environ.get(
    "EVAL_OUTPUT_DIR",
    "/home/cortext/cortextos/orgs/silvermere-tech/agents/analyst/workspace",
))
DEFAULT_TOP_K = 10

# Gate thresholds (per spec / methodology notes)
GATE = {
    "critical_max_misses": 0,
    "standard_max_miss_rate": 0.25,
    "config_value_max_miss_rate": 0.20,
    "overall_min_hit_rate": 0.75,
}


# ---- scoring ---------------------------------------------------------------

def semantic_match(doc: str, anchor: str) -> bool:
    """Strict case-insensitive substring of the anchor phrase in the chunk doc."""
    if not doc or not anchor:
        return False
    return anchor.lower().strip() in doc.lower()


def exact_token_match(doc: str, token: str) -> bool:
    """Exact-token match: the config string appears as a standalone token
    (word-boundary delimited), not merely as a loose substring."""
    if not doc or not token:
        return False
    return re.search(r"(?<![\w-])" + re.escape(token.strip()) + r"(?![\w-])", doc, re.IGNORECASE) is not None


def score(doc: str, anchor: str, strategy: str) -> bool:
    return exact_token_match(doc, anchor) if strategy == "exact-token" else semantic_match(doc, anchor)


# ---- int8 query embedding (delta mode) -------------------------------------

_int8_session = None


def _ensure_int8_session():
    """Dynamically quantise model.onnx -> model_int8.onnx (cached) and open a
    session. Tokeniser + pooling are reused from local_embedder so fp32/int8
    differ ONLY in model weights — the clean delta."""
    global _int8_session
    if _int8_session is not None:
        return _int8_session
    import onnxruntime as ort
    from onnxruntime.quantization import quantize_dynamic, QuantType
    fp32 = MODEL_DIR / "model.onnx"
    int8 = MODEL_DIR / "model_int8.onnx"
    if not int8.exists():
        print(f"  quantising {fp32.name} -> {int8.name} (one-time, dynamic int8)...", flush=True)
        # resolve symlink to a real path for the quantiser input
        quantize_dynamic(str(Path(fp32).resolve()), str(int8), weight_type=QuantType.QInt8)
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = int(os.environ.get("NOMIC_INTRA_THREADS", "4"))
    _int8_session = ort.InferenceSession(str(int8), sess_options=opts, providers=["CPUExecutionProvider"])
    return _int8_session


def embed_query_int8(text: str) -> list:
    """Embed a query through the int8 model, reusing local_embedder tokeniser+pool."""
    le._ensure_loaded()
    sess = _ensure_int8_session()
    enc = le._tokenizer.encode(_prefix(text, "RETRIEVAL_QUERY"))
    ids = np.array([enc.ids], dtype=np.int64)
    mask = np.array([enc.attention_mask], dtype=np.int64)
    tok_type = np.zeros_like(ids, dtype=np.int64)
    feeds = {"input_ids": ids, "attention_mask": mask, "token_type_ids": tok_type}
    try:
        out = sess.run(None, feeds)
    except Exception:
        out = sess.run(None, {"input_ids": ids, "attention_mask": mask})
    vec = _mean_pool(out[0], mask)[0]
    return vec.tolist()


def embed_query(text: str, quant: str) -> list:
    if quant == "int8":
        return embed_query_int8(text)
    return embed_text(text, task_type="RETRIEVAL_QUERY")


# ---- main ------------------------------------------------------------------

def main():
    quant = "fp32"
    if "--quant" in sys.argv:
        quant = sys.argv[sys.argv.index("--quant") + 1]
    assert quant in ("fp32", "int8"), f"bad --quant {quant}"
    # --full-docs: store the FULL chunk text per top-10 result (not a 160-char
    # preview) so adjudication can honestly judge "concept surfaced but lacked the
    # long-signature" (artifact) vs "answering chunk never ranked top-10" (real miss).
    full_docs = "--full-docs" in sys.argv

    spec = json.loads(EVAL_FILE.read_text())
    queries = spec["queries"]
    print(f"embed-eval-v2 [{quant}]  {len(queries)} queries  file={EVAL_FILE.name}")
    print(f"gate: crit<= {GATE['critical_max_misses']} miss, std<= {GATE['standard_max_miss_rate']:.0%}, "
          f"config<= {GATE['config_value_max_miss_rate']:.0%}, overall>= {GATE['overall_min_hit_rate']:.0%}")

    client = chromadb.PersistentClient(path=str(CHROMADB_DIR))
    live = {c.name for c in client.list_collections()}

    print("warmup...")
    warmup()
    if quant == "int8":
        _ensure_int8_session()

    results = []
    # per-tier tallies
    tally = {"critical": [0, 0], "standard": [0, 0], "config-value": [0, 0]}  # [hits, total]

    for q in queries:
        qid, qtext = q["id"], q["query"]
        target = q["target_collection"]
        anchor = q["expected_anchor_phrase"]
        tier = q["tier"]
        strategy = q.get("scoring_strategy", "semantic")
        top_k = int(q.get("match_at_top_k", DEFAULT_TOP_K))
        tally.setdefault(tier, [0, 0])
        tally[tier][1] += 1

        if target not in live:
            print(f"  ✗ [{tier}] {qid}: TARGET COLLECTION MISSING ({target})")
            results.append({"id": qid, "tier": tier, "target": target, "hit": False,
                            "reason": "collection_not_found", "strategy": strategy})
            continue

        t0 = time.time()
        qvec = embed_query(qtext, quant)
        embed_ms = (time.time() - t0) * 1000
        col = client.get_collection(target)
        r = col.query(query_embeddings=[qvec], n_results=top_k,
                      include=["documents", "distances"])
        docs = r.get("documents", [[]])[0]
        dists = r.get("distances", [[]])[0]

        hit, rank = False, None
        for i, d in enumerate(docs):
            if score(d, anchor, strategy):
                hit, rank = True, i + 1
                break
        if hit:
            tally[tier][0] += 1

        marker = "✓" if hit else "✗"
        print(f"  {marker} [{tier:11s}/{strategy:10s}] {qid:34s} {'HIT rank '+str(rank) if hit else 'MISS':10s} embed={embed_ms:.0f}ms @{target}")
        if not hit:
            print(f"      anchor: {anchor!r}  top1: {(docs[0][:110] if docs else '').strip()!r}")

        results.append({
            "id": qid, "tier": tier, "scoring_strategy": strategy, "target": target,
            "expected_anchor_phrase": anchor, "hit": hit, "rank": rank,
            "top_k": top_k, "embed_ms": round(embed_ms, 1),
            "top_results": [{"preview": ((docs[i] if full_docs else docs[i][:160].replace("\n", " "))
                                          if i < len(docs) else ""),
                             "distance": round(dists[i], 4) if i < len(dists) else None}
                            for i in range(min(len(docs), top_k))],
        })

    # ---- aggregate + gate ----
    def miss_rate(tier):
        h, t = tally.get(tier, [0, 0])
        return (t - h) / t if t else 0.0, (t - h), t

    crit_mr, crit_miss, crit_tot = miss_rate("critical")
    std_mr, std_miss, std_tot = miss_rate("standard")
    cfg_mr, cfg_miss, cfg_tot = miss_rate("config-value")
    total_hits = sum(v[0] for v in tally.values())
    total = sum(v[1] for v in tally.values())
    overall = total_hits / total if total else 0.0

    fail_crit = crit_miss > GATE["critical_max_misses"]
    fail_std = std_mr > GATE["standard_max_miss_rate"]
    fail_cfg = cfg_mr > GATE["config_value_max_miss_rate"]
    fail_overall = overall < GATE["overall_min_hit_rate"]
    gate_pass = not (fail_crit or fail_std or fail_cfg or fail_overall)
    verdict = "PASS" if gate_pass else ("VETO_HALT" if (fail_crit or fail_overall) else "CONDITIONAL")

    reasons = []
    if fail_crit: reasons.append(f"{crit_miss} critical miss(es) (max {GATE['critical_max_misses']})")
    if fail_overall: reasons.append(f"overall hit {overall:.0%} < {GATE['overall_min_hit_rate']:.0%}")
    if fail_std: reasons.append(f"standard miss {std_mr:.0%} > {GATE['standard_max_miss_rate']:.0%}")
    if fail_cfg: reasons.append(f"config-value miss {cfg_mr:.0%} > {GATE['config_value_max_miss_rate']:.0%}")

    summary = {
        "model": "nomic-embed-text-v1.5", "quant": quant, "eval_set": "embed-eval-v2",
        "ran_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "top_k": DEFAULT_TOP_K, "gate": GATE,
        "totals": {"queries": total, "hits": total_hits, "overall_hit_rate": round(overall, 4)},
        "by_tier": {
            "critical": {"hits": crit_tot - crit_miss, "total": crit_tot, "misses": crit_miss, "miss_rate": round(crit_mr, 4)},
            "standard": {"hits": std_tot - std_miss, "total": std_tot, "misses": std_miss, "miss_rate": round(std_mr, 4)},
            "config-value": {"hits": cfg_tot - cfg_miss, "total": cfg_tot, "misses": cfg_miss, "miss_rate": round(cfg_mr, 4)},
        },
        "gate_conditions": {"critical_0_miss": not fail_crit, "standard_le_25pct": not fail_std,
                            "config_le_20pct": not fail_cfg, "overall_ge_75pct": not fail_overall},
        "verdict": verdict, "reasons": reasons, "results": results,
    }
    ts = time.strftime("%Y-%m-%dT%H%M%SZ", time.gmtime())
    out_path = OUTPUT_DIR / f"embed-eval-v2-results-{quant}-{ts}.json"
    out_path.write_text(json.dumps(summary, indent=2))

    print()
    print(f"  OVERALL:  {total_hits}/{total} ({overall:.1%})")
    print(f"  CRITICAL: {crit_miss}/{crit_tot} miss")
    print(f"  STANDARD: {std_miss}/{std_tot} miss ({std_mr:.0%}; gate <=25%)")
    print(f"  CONFIG:   {cfg_miss}/{cfg_tot} miss ({cfg_mr:.0%}; gate <=20%, exact-token)")
    print(f"  VERDICT:  {verdict}" + (f"  reasons: {reasons}" if reasons else ""))
    print(f"  -> {out_path}")
    return 0 if gate_pass else 1


if __name__ == "__main__":
    sys.exit(main())
