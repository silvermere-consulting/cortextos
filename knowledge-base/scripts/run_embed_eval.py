#!/usr/bin/env python3
"""Run the embed-eval-v1 quality gate against nomic-embed-text-v1.5.

For each query:
  1. Embed query text via local backend (nomic, RETRIEVAL_QUERY prefix)
  2. Query the expected_collection (or all collections if 'any') with top-K=5
  3. Check if any retrieved chunk's text contains the expected_chunk_signature
     (case-insensitive, >= 8 char overlap)
  4. Mark as PASS or FAIL with details

CRITICAL TIER: any miss = veto. Halt + Gemini-restore path.
STANDARD TIER: counted toward overall hit rate (>= 0.70 required).

Output: JSON results file in workspace/embed-eval-v1-results-<UTC>.json.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import chromadb

# Path setup
SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

from local_embedder import embed_text, warmup

EVAL_FILE = Path(os.environ.get(
    "EVAL_FILE",
    "/home/cortext/cortextos/orgs/silvermere-tech/agents/analyst/workspace/embed-eval-v1.json",
))
CHROMADB_DIR = Path(os.environ.get(
    "CHROMADB_DIR",
    "/home/cortext/.cortextos/default/orgs/silvermere-tech/knowledge-base/chromadb",
))
TOP_K = 5
MIN_OVERLAP_CHARS = 8

OUTPUT_DIR = Path(os.environ.get(
    "EVAL_OUTPUT_DIR",
    "/home/cortext/cortextos/orgs/silvermere-tech/agents/analyst/workspace",
))


def signature_match(retrieved_text: str, signature: str) -> bool:
    """Substring match, case-insensitive, requires >= 8 char overlap with the
    signature. Matches the eval set's scoring spec.
    """
    if not retrieved_text or not signature:
        return False
    rt = retrieved_text.lower()
    sig = signature.lower().strip()
    # Direct substring of full signature
    if sig in rt:
        return True
    # Longest matching prefix (>= 8 chars) — handles signatures slightly
    # longer than the chunked-up text
    if len(sig) >= MIN_OVERLAP_CHARS:
        for start in range(0, len(sig) - MIN_OVERLAP_CHARS + 1):
            end = len(sig)
            substr = sig[start:end]
            if len(substr) >= MIN_OVERLAP_CHARS and substr in rt:
                return True
    return False


def collections_for_target(target: str, all_cols: list) -> list:
    """Map target name → shadow collection (eval-<target>-nomic) if it exists.
    Falls back to the direct-named collection. 'any' → all shadow collections.

    We must query the shadow (nomic-embedded at 768-dim) NOT the production
    Gemini-embedded collection (3072-dim, incompatible vector space). The
    shadow lets us validate retrieval quality WITHOUT touching prod.
    """
    if target == "any":
        # Use all shadows for "any" — that's the eval-relevant population
        return [c for c in all_cols if c.name.startswith("eval-") and c.name.endswith("-nomic")]
    shadow_name = f"eval-{target}-nomic"
    shadows = [c for c in all_cols if c.name == shadow_name]
    if shadows:
        return shadows
    # Fallback: direct match (e.g. for non-memory-* targets in the eval set)
    return [c for c in all_cols if c.name == target]


def query_collection(col, query_embedding, top_k=TOP_K):
    """Query a single collection with the query embedding. Returns list of
    (chunk_id, document_text, distance) tuples."""
    try:
        result = col.query(
            query_embeddings=[query_embedding],
            n_results=top_k,
            include=["documents", "distances", "metadatas"],
        )
        ids = result.get("ids", [[]])[0]
        docs = result.get("documents", [[]])[0]
        dists = result.get("distances", [[]])[0]
        return list(zip(ids, docs, dists))
    except Exception as e:
        print(f"  ERR querying {col.name}: {e}")
        return []


def main():
    print(f"Loading eval set from {EVAL_FILE}...")
    spec = json.loads(EVAL_FILE.read_text())
    queries = spec["queries"]
    print(f"  {len(queries)} queries  pass-gate: {spec['pass_gate']}")

    print(f"Loading ChromaDB from {CHROMADB_DIR}...")
    client = chromadb.PersistentClient(path=str(CHROMADB_DIR))
    all_cols = client.list_collections()
    print(f"  {len(all_cols)} collections available")

    print("Warming up embedder...")
    t0 = time.time()
    warmup()
    print(f"  warmup: {time.time() - t0:.2f}s")

    results = []
    pass_count = 0
    critical_miss = 0
    standard_miss = 0
    excluded = []

    for q in queries:
        # Excluded items: answer is ABSENT from the indexed corpus (count-verified,
        # invalid for ALL models incl Gemini) — skipped from scoring, never silent.
        # NEVER exclude items the model merely failed to retrieve.
        if q.get("excluded"):
            excluded.append({"id": q["id"], "tier": q.get("tier"),
                             "verification": q.get("exclude_verification", "corpus-absent")})
            print(f"  ⊘ EXCLUDED [{q.get('tier','?')}] {q['id']}: "
                  f"{q.get('exclude_verification', 'corpus-absent')}")
            continue
        qid = q["id"]
        qtext = q["query_text"]
        target = q["expected_collection"]
        sig = q["expected_chunk_signature"]
        tier = q["tier"]

        # Embed query with RETRIEVAL_QUERY prefix (nomic convention)
        t0 = time.time()
        q_embed = embed_text(qtext, task_type="RETRIEVAL_QUERY")
        embed_ms = (time.time() - t0) * 1000

        # Get target collection(s)
        cols = collections_for_target(target, all_cols)
        if not cols:
            print(f"  [{tier}] {qid}: COLLECTION NOT FOUND ({target})")
            results.append({
                "id": qid, "query": qtext, "target": target,
                "tier": tier, "pass": False,
                "reason": "collection_not_found",
                "embed_ms": round(embed_ms, 1),
            })
            if tier == "critical": critical_miss += 1
            else: standard_miss += 1
            continue

        # Query all candidate collections, merge results, take top-K overall
        all_hits = []
        for col in cols:
            hits = query_collection(col, q_embed, top_k=TOP_K)
            for chunk_id, doc, dist in hits:
                all_hits.append((col.name, chunk_id, doc, dist))
        # Sort by distance ASC (lower = closer for cosine distance)
        all_hits.sort(key=lambda x: x[3])
        all_hits = all_hits[:TOP_K]

        # Check signature match in any of top-K
        matched = False
        match_idx = -1
        match_col = None
        for idx, (col_name, chunk_id, doc, dist) in enumerate(all_hits):
            if signature_match(doc, sig):
                matched = True
                match_idx = idx
                match_col = col_name
                break

        status = "PASS" if matched else "FAIL"
        marker = "✓" if matched else "✗"
        rank_str = f" (rank {match_idx + 1})" if matched else ""
        print(f"  {marker} [{tier}] {qid}: {status}{rank_str} embed={embed_ms:.0f}ms target={target}")
        if not matched:
            preview = (all_hits[0][2] if all_hits else "")[:120].replace("\n", " ")
            print(f"     expected sig: {sig[:80]!r}")
            print(f"     top-1 chunk:  {preview!r}")

        result = {
            "id": qid, "query": qtext, "target": target,
            "expected_signature": sig, "tier": tier,
            "pass": matched, "match_rank": match_idx + 1 if matched else None,
            "match_collection": match_col,
            "embed_ms": round(embed_ms, 1),
            "top_k": [
                {"collection": h[0], "chunk_id": h[1],
                 "preview": h[2][:160].replace("\n", " "), "distance": round(h[3], 4)}
                for h in all_hits
            ],
        }
        results.append(result)
        if matched:
            pass_count += 1
        elif tier == "critical":
            critical_miss += 1
        else:
            standard_miss += 1

    valid_n = len(queries) - len(excluded)
    std_valid = sum(1 for x in results if x["tier"] == "standard")
    crit_valid = sum(1 for x in results if x["tier"] == "critical")
    hit_rate = pass_count / valid_n if valid_n else 0.0
    std_miss_rate = standard_miss / std_valid if std_valid else 0.0

    # Enforce ALL THREE pass_gate conditions. The original script silently checked
    # only 2 (0-critical + overall>=70%) and skipped the standard-tier sub-gate —
    # which is why a 50% standard-miss run wrongly reported PASS_PROCEED.
    STD_MISS_ALLOWED = 0.30
    fail_critical = critical_miss > 0
    fail_overall = hit_rate < 0.70
    fail_standard = std_miss_rate > STD_MISS_ALLOWED
    if fail_critical or fail_overall:
        verdict = "VETO_HALT"          # fails a hard bar
    elif fail_standard:
        verdict = "CONDITIONAL"        # clears critical + overall; standard sub-gate breached
    else:
        verdict = "PASS_PROCEED"

    summary = {
        "model": "nomic-embed-text-v1.5",
        "eval_set": "embed-eval-v1",
        "ran_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "total_queries": len(queries),
        "valid_queries": valid_n,
        "excluded_count": len(excluded),
        "excluded": excluded,
        "exclusion_criterion": spec.get("exclusion_criterion",
            "Exclusion permitted ONLY for items whose answer is absent from the indexed "
            "corpus (count-verified, invalid for all models). Never for retrieval misses."),
        "passed": pass_count,
        "critical_valid": crit_valid,
        "critical_misses": critical_miss,
        "standard_valid": std_valid,
        "standard_misses": standard_miss,
        "standard_miss_rate": round(std_miss_rate, 4),
        "standard_miss_allowed": STD_MISS_ALLOWED,
        "hit_rate": round(hit_rate, 4),
        "hit_rate_basis": f"{pass_count}/{valid_n} valid ({len(excluded)} excluded for corpus-absence, disclosed)",
        "pass_gate": spec["pass_gate"],
        "gate_conditions": {
            "critical_misses_0": not fail_critical,
            "overall_hit_rate_ge_0.70": not fail_overall,
            "standard_miss_le_0.30": not fail_standard,
        },
        "verdict": verdict,
        "veto_reasons": [],
        "results": results,
    }
    if fail_critical:
        summary["veto_reasons"].append(f"{critical_miss} critical-tier miss(es)")
    if fail_overall:
        summary["veto_reasons"].append(f"overall hit rate {hit_rate:.2%} < 70%")
    if fail_standard:
        summary["veto_reasons"].append(
            f"standard-tier miss {std_miss_rate:.0%} > 30% sub-gate (CONDITIONAL, not VETO)")

    ts = time.strftime("%Y-%m-%dT%H%M%SZ", time.gmtime())
    out_path = OUTPUT_DIR / f"embed-eval-v1-results-{ts}.json"
    out_path.write_text(json.dumps(summary, indent=2))

    print()
    print(f"  VALID:    {pass_count}/{valid_n} pass ({hit_rate:.1%})  "
          f"[{len(excluded)} excluded for corpus-absence, disclosed]")
    print(f"  CRITICAL: {critical_miss}/{crit_valid} miss")
    print(f"  STANDARD: {standard_miss}/{std_valid} miss ({std_miss_rate:.0%}; sub-gate <=30%)")
    if excluded:
        print(f"  EXCLUDED: {', '.join(e['id'] for e in excluded)}")
    print(f"  GATE:     crit0={not fail_critical}  overall>=70%={not fail_overall}  std<=30%={not fail_standard}")
    print(f"  VERDICT:  {summary['verdict']}")
    if summary["veto_reasons"]:
        print(f"  reasons:  {summary['veto_reasons']}")
    print(f"  results written to: {out_path}")
    return 0 if verdict == "PASS_PROCEED" else 1


if __name__ == "__main__":
    sys.exit(main())
