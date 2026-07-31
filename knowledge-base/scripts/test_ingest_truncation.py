#!/usr/bin/env python3
"""Hermetic regression test for the kb-ingest truncation guard (mmrag.py).

Proves the post-ingest self-verify (layer 3) BOTH ways, against a REAL local
ChromaDB temp collection with the REAL local nomic embedder — no network, no API
keys, deterministic:

  known-POSITIVE : a complete ingest exits 0 and the verify reports every text
                   source fully indexed (prove the matcher can say YES).
  known-NEGATIVE : after artificially deleting one chunk doc_id from the
                   collection, running ONLY the post-verify path prints
                   'KB-INGEST TRUNCATED ...' LOUD to stderr and exits 3.

Everything lives under a throwaway temp dir (MMRAG_DIR / CHROMADB_DIR / CONFIG),
so it never touches a real collection. Run directly:

    knowledge-base/venv/bin/python3 test_ingest_truncation.py

Requires: chromadb + onnxruntime + the local nomic model (all present in the
knowledge-base venv). If the local backend is unavailable the test SKIPS loudly
rather than faking a pass.
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
MMRAG_PY = SCRIPTS_DIR / "mmrag.py"
PY = sys.executable  # the venv python running this test

# A fixed, collision-proof temp collection name (never a real collection).
COLLECTION = "test-ingest-trunc-fixture"

# Multi-chunk fixture: ~6 KB of paragraph-delimited text. At chunk_size=1500 /
# overlap=200 this yields several chunks (verified at runtime, asserted >= 3).
_PARA = (
    "Silvermere operational note paragraph {n}. This block exists purely to give "
    "chunk_text a paragraph boundary to snap to, so the fixture deterministically "
    "splits into multiple overlapping windows rather than a single chunk. It "
    "repeats enough filler prose to comfortably exceed the fifteen-hundred "
    "character chunk window when several of these paragraphs are concatenated "
    "together with double-newline separators between them."
)
FIXTURE_TEXT = "\n\n".join(_PARA.format(n=i) for i in range(12)) + "\n"


def _env(tmp):
    e = dict(os.environ)
    e["MMRAG_DIR"] = str(tmp)
    e["MMRAG_CHROMADB_DIR"] = str(tmp / "chromadb")
    e["MMRAG_CONFIG"] = str(tmp / "config.json")
    e["EMBEDDING_BACKEND"] = "local"          # default anyway; pinned for hermeticity
    e["NONTEXT_BACKEND"] = "deterministic"
    e["PYTHONPATH"] = str(SCRIPTS_DIR) + os.pathsep + e.get("PYTHONPATH", "")
    # Keep the real on-box nomic model (no download / network).
    e.setdefault("NOMIC_MODEL_DIR",
                 "/home/cortext/cortextos/knowledge-base/models/nomic-embed-text-v1.5")
    return e


def _expected_chunk_count(text):
    """Re-derive expected chunks with the SAME predicate the tool uses."""
    sys.path.insert(0, str(SCRIPTS_DIR))
    import mmrag  # noqa: E402
    return len(mmrag.chunk_text(text, mmrag.DEFAULT_TEXT_CHUNK_SIZE,
                                mmrag.DEFAULT_TEXT_CHUNK_OVERLAP))


def _local_backend_available():
    model = Path(os.environ.get(
        "NOMIC_MODEL_DIR",
        "/home/cortext/cortextos/knowledge-base/models/nomic-embed-text-v1.5")) / "model.onnx"
    try:
        import chromadb  # noqa: F401
        import onnxruntime  # noqa: F401
    except Exception as exc:  # pragma: no cover - env-dependent
        return False, f"missing dep: {exc}"
    if not model.exists():
        return False, f"nomic model.onnx not found at {model}"
    return True, "ok"


# --- the negative-path harness, run in its own subprocess so we assert a REAL
#     process exit code (3) from the REAL verify_indexed_counts + exit convention.
_VERIFY_ONLY = r"""
import sys
import mmrag
config = mmrag.load_config()
coll = mmrag.get_chroma_collection(sys.argv[1])
src = sys.argv[2]
truncated = mmrag.verify_indexed_counts(coll, config, [src])
sys.exit(3 if truncated else 0)
"""

# --- helper to delete exactly one chunk doc_id from the collection, in-process
#     inside a subprocess (avoids cross-process sqlite contention).
_DELETE_ONE = r"""
import sys
import mmrag
coll = mmrag.get_chroma_collection(sys.argv[1])
doc_id = sys.argv[2]
before = coll.get(ids=[doc_id])
assert before and before.get("ids"), f"doc_id {doc_id} not present pre-delete"
coll.delete(ids=[doc_id])
after = coll.get(ids=[doc_id])
assert not (after and after.get("ids")), "delete did not remove the chunk"
print(f"deleted {doc_id}")
"""


def run():
    ok, why = _local_backend_available()
    if not ok:
        print(f"SKIP: local embedding backend unavailable ({why}).")
        print("      This test requires chromadb + onnxruntime + the nomic model; "
              "not faking a pass.")
        return 0

    n_expected = _expected_chunk_count(FIXTURE_TEXT)
    assert n_expected >= 3, f"fixture must be multi-chunk; got {n_expected}"
    print(f"Fixture: {len(FIXTURE_TEXT)} chars -> {n_expected} chunks expected")

    with tempfile.TemporaryDirectory(prefix="mmrag-trunc-test-") as td:
        tmp = Path(td)
        (tmp / "chromadb").mkdir(parents=True, exist_ok=True)
        (tmp / "config.json").write_text(json.dumps({"default_collection": "default"}))
        fixture = tmp / "fixture.md"
        fixture.write_text(FIXTURE_TEXT)
        src_resolved = str(fixture.resolve())
        env = _env(tmp)

        # doc_id of chunk 0 == md5(resolved path)[:12] + "_chunk0"  (file_id scheme)
        h = hashlib.md5(src_resolved.encode()).hexdigest()[:12]
        target_doc_id = f"{h}_chunk0"

        # ---------------- KNOWN-POSITIVE: complete ingest, exit 0 ----------------
        print("\n=== [A] KNOWN-POSITIVE: complete ingest should exit 0 + verify OK ===")
        r = subprocess.run(
            [PY, str(MMRAG_PY), "ingest", src_resolved, "-c", COLLECTION],
            env=env, capture_output=True, text=True,
        )
        print("--- stdout ---\n" + r.stdout.strip())
        if r.stderr.strip():
            print("--- stderr ---\n" + r.stderr.strip())
        print(f"--- exit code: {r.returncode} ---")
        assert r.returncode == 0, f"expected exit 0 on clean ingest, got {r.returncode}"
        assert "Verify:" in r.stdout, "expected a 'Verify:' pass line on stdout"
        assert "TRUNCATED" not in r.stderr, "clean ingest must NOT report TRUNCATED"
        print("PASS [A]: clean ingest exited 0 and self-verify passed.")

        # ---------------- inject truncation: delete one chunk doc_id ------------
        print("\n=== [B0] Injecting truncation: delete one chunk doc_id ===")
        d = subprocess.run([PY, "-c", _DELETE_ONE, COLLECTION, target_doc_id],
                           env=env, capture_output=True, text=True)
        print((d.stdout + d.stderr).strip())
        assert d.returncode == 0, f"delete harness failed: {d.stderr}"

        # ---------------- KNOWN-NEGATIVE: verify-only path, exit 3 --------------
        print("\n=== [B] KNOWN-NEGATIVE: post-verify only should exit 3 LOUD ===")
        v = subprocess.run([PY, "-c", _VERIFY_ONLY, COLLECTION, src_resolved],
                           env=env, capture_output=True, text=True)
        print("--- stdout ---\n" + v.stdout.strip())
        print("--- stderr ---\n" + v.stderr.strip())
        print(f"--- exit code: {v.returncode} ---")
        assert v.returncode == 3, f"expected exit 3 on truncation, got {v.returncode}"
        assert "KB-INGEST TRUNCATED" in v.stderr, "truncation must print LOUD to stderr"
        assert f"indexed {n_expected - 1} != expected {n_expected}" in v.stderr, \
            "loud line must report the actual vs expected counts"
        print("PASS [B]: truncated collection exited 3 with the LOUD TRUNCATED line.")

        # ---------------- REMEDIATION: plain re-run heals (the fleet-notice advice) --
        # The fleet notice tells 8 agents "a new exit 3 is a PRE-EXISTING truncation;
        # re-run to heal." That advice is a claim the whole fleet will EXECUTE, so it
        # is verified here rather than reasoned: a plain re-run (NO --force) against the
        # truncated collection must re-embed ONLY the missing chunk (dedup skips the
        # rest) and come back exit 0 with verify passing.
        print("\n=== [C] REMEDIATION: plain re-run of the truncated collection heals -> exit 0 ===")
        c = subprocess.run(
            [PY, str(MMRAG_PY), "ingest", src_resolved, "-c", COLLECTION],
            env=env, capture_output=True, text=True,
        )
        print("--- stdout ---\n" + c.stdout.strip())
        if c.stderr.strip():
            print("--- stderr ---\n" + c.stderr.strip())
        print(f"--- exit code: {c.returncode} ---")
        assert c.returncode == 0, f"expected exit 0 after heal re-run, got {c.returncode}"
        assert "TRUNCATED" not in c.stderr, "healed re-run must NOT report TRUNCATED"
        assert "Verify:" in c.stdout, "healed re-run must show the verify pass line"
        # dedup should re-embed ONLY the one deleted chunk, not all N — proves the heal
        # is cheap and the mechanism is dedup-fills-the-gap, exactly as the notice says.
        assert "Added 1 chunk(s)" in c.stdout, \
            "heal should re-embed exactly the 1 missing chunk (dedup skips the rest)"
        print("PASS [C]: re-run re-embedded only the missing chunk and returned exit 0 — "
              "remediation advice verified, not reasoned.")

        # clean up the temp collection inside the temp chromadb (dir is discarded anyway)
    print("\nALL PASS: truncation guard proven known-positive (exit 0), "
          "known-negative (exit 3), and remediation-re-run-heals (exit 0).")
    return 0


if __name__ == "__main__":
    sys.exit(run())
