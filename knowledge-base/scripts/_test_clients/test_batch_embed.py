"""Behavioral tests for mmrag.embed_contents_batch + _retry_embed_content.

Run from knowledge-base/scripts:

    python -m _test_clients.test_batch_embed

Exits 0 on all-pass, 1 on any failure. Five scenarios:

  1. retry_embed_transient_then_success: 503 -> 200 -> returns response (SDK path)
  2. retry_embed_all_exhausted: 503 -> 503 -> 503 -> raises last APIError (SDK path)
  3. retry_embed_fail_fast: 403 -> raises immediately (SDK path)
  4. batch_happy_path: 250 chunks -> 3 batch calls of [100, 100, 50], 250 embeddings out
  5. batch_fallback_on_failure: 250 chunks; first batch FAILS all retries,
     falls back to per-item which succeeds. Other batches unaffected. Total: 250 out.

The batch tests monkey-patch _call_batch_embed_rest because it hits a real URL
via urllib — we replace it with an in-memory stub that simulates batch behavior.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
if PARENT not in sys.path:
    sys.path.insert(0, PARENT)

# These scenarios exercise the GEMINI batch-REST path (they monkey-patch _call_batch_embed_rest
# and assert on REST call counts). mmrag reads EMBEDDING_BACKEND ONCE at import, so it must be
# pinned BEFORE the import below.
#
# It used to be left ambient. That was invisible while the fleet default was 'gemini' — but the
# 2026-07-11 fleet flip to EMBEDDING_BACKEND=local exported 'local' into every agent's env, and
# embed_contents_batch then took its local ONNX branch: zero REST calls, so all five scenarios
# went red while testing a path they were never written to test. A test whose MEANING depends on
# ambient env is not a test. The local branch deserves its own coverage; it must not silently
# hijack this one.
os.environ["EMBEDDING_BACKEND"] = "gemini"

import mmrag
from _test_clients import fault_injection

assert mmrag.EMBEDDING_BACKEND == "gemini", (
    f"expected the gemini batch path, got EMBEDDING_BACKEND={mmrag.EMBEDDING_BACKEND!r} — "
    "these scenarios assert on REST calls the local ONNX branch never makes"
)


FAILURES = []
CONFIG = {
    "embedding_model": "gemini-embedding-2-preview",
    "embedding_dimensions": 768,
    "gemini_api_key": "fake-key-for-test",
}


def _check(label, cond, detail=""):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}: {detail}")
        FAILURES.append(label)


def test_retry_embed_transient_then_success():
    print("\n[test 1/5] retry_embed transient_then_success: 503 -> 200 (SDK path)")
    client = fault_injection.FaultInjectionClient(
        fault_injection._parse_script("503,200")
    )
    response = mmrag._retry_embed_content(
        client,
        model="x",
        contents="hello",
        output_dimensionality=768,
        task_type="RETRIEVAL_DOCUMENT",
        backoffs=(0, 0, 0),
    )
    _check("returns response after one transient", response is not None)
    _check(
        "response has exactly 1 embedding for single content",
        len(response.embeddings) == 1,
        detail=f"got {len(response.embeddings)}",
    )
    _check(
        "consumed exactly 2 attempts",
        client.models._index == 2,
        detail=f"got {client.models._index}",
    )


def test_retry_embed_all_exhausted():
    print("\n[test 2/5] retry_embed all_exhausted: 503 -> 503 -> 503 -> re-raise (SDK path)")
    client = fault_injection.FaultInjectionClient(
        fault_injection._parse_script("503,503,503")
    )
    raised = None
    try:
        mmrag._retry_embed_content(
            client,
            model="x",
            contents="hello",
            output_dimensionality=768,
            task_type="RETRIEVAL_DOCUMENT",
            backoffs=(0, 0, 0),
        )
    except Exception as e:
        raised = e
    _check("raises after all attempts exhausted", raised is not None)
    if raised is not None:
        _check("raised.code is 503", getattr(raised, "code", None) == 503)


def test_retry_embed_fail_fast():
    print("\n[test 3/5] retry_embed fail_fast_nontransient: 403 -> raises immediately (SDK path)")
    client = fault_injection.FaultInjectionClient(
        fault_injection._parse_script("403,200")
    )
    raised = None
    try:
        mmrag._retry_embed_content(
            client,
            model="x",
            contents="hello",
            output_dimensionality=768,
            task_type="RETRIEVAL_DOCUMENT",
            backoffs=(0, 0, 0),
        )
    except Exception as e:
        raised = e
    _check("raises immediately on non-transient", raised is not None)
    _check(
        "did NOT consume the 200 scripted attempt",
        client.models._index == 1,
        detail=f"got {client.models._index}",
    )


def test_batch_happy_path():
    print("\n[test 4/5] batch_happy_path: 250 chunks -> 3 batch calls of [100, 100, 50]")
    call_count = {"n": 0}
    call_sizes = []
    def stub_rest(api_key, model, contents_list, output_dimensionality, task_type, backoffs=None):
        call_count["n"] += 1
        call_sizes.append(len(contents_list))
        return [[0.1, 0.2, 0.3] for _ in contents_list]
    original = mmrag._call_batch_embed_rest
    mmrag._call_batch_embed_rest = stub_rest
    try:
        contents = [f"chunk-{i}" for i in range(250)]
        embeddings = mmrag.embed_contents_batch(None, CONFIG, contents)
    finally:
        mmrag._call_batch_embed_rest = original
    _check(
        "returned 250 embeddings",
        len(embeddings) == 250,
        detail=f"got {len(embeddings)}",
    )
    _check(
        "exactly 3 batch REST calls",
        call_count["n"] == 3,
        detail=f"got {call_count['n']}",
    )
    _check(
        "batch sizes are [100, 100, 50]",
        call_sizes == [100, 100, 50],
        detail=f"got {call_sizes}",
    )
    _check(
        "each embedding has the expected stub shape",
        all(e == [0.1, 0.2, 0.3] for e in embeddings),
        detail="some embedding did not match stub vector",
    )


def test_batch_fallback_on_failure():
    print("\n[test 5/5] batch_fallback_on_failure: batch 1 fails, falls back per-item via SDK")
    rest_call_count = {"n": 0}
    def stub_rest_first_fails(api_key, model, contents_list, output_dimensionality, task_type, backoffs=None):
        rest_call_count["n"] += 1
        if rest_call_count["n"] == 1:
            raise RuntimeError("simulated batch failure on first batch")
        return [[0.1, 0.2, 0.3] for _ in contents_list]
    original_rest = mmrag._call_batch_embed_rest
    mmrag._call_batch_embed_rest = stub_rest_first_fails

    # For the per-item fallback path, FaultInjectionClient.embed_content returns
    # _StubEmbedResponse(1) per call. Script enough 200s for the 100 fallback calls.
    client = fault_injection.FaultInjectionClient(
        fault_injection._parse_script(",".join(["200"] * 100))
    )
    try:
        contents = [f"chunk-{i}" for i in range(250)]
        embeddings = mmrag.embed_contents_batch(client, CONFIG, contents)
    finally:
        mmrag._call_batch_embed_rest = original_rest

    _check(
        "returned 250 embeddings despite first-batch failure",
        len(embeddings) == 250,
        detail=f"got {len(embeddings)}",
    )
    _check(
        "made 3 REST attempts (batch 1 failed, batches 2 + 3 succeeded)",
        rest_call_count["n"] == 3,
        detail=f"got {rest_call_count['n']}",
    )
    _check(
        "fallback fired 100 per-item SDK calls for batch 1",
        client.models._index == 100,
        detail=f"got {client.models._index}",
    )


def main():
    test_retry_embed_transient_then_success()
    test_retry_embed_all_exhausted()
    test_retry_embed_fail_fast()
    test_batch_happy_path()
    test_batch_fallback_on_failure()
    if FAILURES:
        print(f"\n{len(FAILURES)} FAILED: {FAILURES}")
        sys.exit(1)
    print("\nALL PASS (5 scenarios)")
    sys.exit(0)


if __name__ == "__main__":
    main()
