"""Local ONNX embedder: nomic-embed-text-v1.5 → 768-dim vectors.

Drop-in replacement for the Gemini embed_content / embed_contents_batch path
in mmrag.py. Same dimensionality (768) as gemini-embedding-2-preview so
existing ChromaDB collections accept the vectors without rebuild.

Task-type mapping:
- RETRIEVAL_DOCUMENT → "search_document: " prefix (nomic v1.5 convention)
- RETRIEVAL_QUERY    → "search_query: " prefix
- (other)            → no prefix (raw)

CPU-only inference, ~50-150 docs/sec on a modern x86 server. Loaded once
per process and cached at module scope.
"""
from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import List, Union

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MODEL_DIR = Path(
    os.environ.get(
        "NOMIC_MODEL_DIR",
        "/home/cortext/cortextos/knowledge-base/models/nomic-embed-text-v1.5",
    )
)
MAX_SEQ_LEN = 512  # nomic-embed-text-v1.5 trained at 8192 but standard sequence-transformer convention
EMBED_DIM = 768

_TASK_TYPE_PREFIX = {
    "RETRIEVAL_DOCUMENT": "search_document: ",
    "RETRIEVAL_QUERY": "search_query: ",
    "CLASSIFICATION": "classification: ",
    "CLUSTERING": "clustering: ",
}

_session_lock = threading.Lock()
_session = None
_tokenizer = None


def _ensure_loaded():
    """Lazy-load ONNX session + tokenizer. Thread-safe."""
    global _session, _tokenizer
    if _session is not None and _tokenizer is not None:
        return
    with _session_lock:
        if _session is not None and _tokenizer is not None:
            return
        # CPU-only — no GPU on this stack
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = int(os.environ.get("NOMIC_INTRA_THREADS", "4"))
        opts.inter_op_num_threads = int(os.environ.get("NOMIC_INTER_THREADS", "1"))
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        _session = ort.InferenceSession(
            str(MODEL_DIR / "model.onnx"),
            sess_options=opts,
            providers=["CPUExecutionProvider"],
        )
        _tokenizer = Tokenizer.from_file(str(MODEL_DIR / "tokenizer.json"))
        _tokenizer.enable_truncation(max_length=MAX_SEQ_LEN)
        _tokenizer.enable_padding(length=None, pad_id=0, pad_token="[PAD]")


def _mean_pool(token_embeds: np.ndarray, attention_mask: np.ndarray) -> np.ndarray:
    """Standard sentence-transformer mean-pool: sum token vectors weighted by
    attention mask, divide by sum-of-mask. Then L2-normalize.
    """
    mask = attention_mask.astype(np.float32)[..., None]  # (B, L, 1)
    summed = (token_embeds * mask).sum(axis=1)  # (B, D)
    counts = np.clip(mask.sum(axis=1), a_min=1e-9, a_max=None)  # (B, 1)
    pooled = summed / counts
    # L2 normalize
    norms = np.linalg.norm(pooled, axis=1, keepdims=True)
    norms = np.clip(norms, a_min=1e-12, a_max=None)
    return pooled / norms


def _embed_batch(texts: List[str]) -> np.ndarray:
    """Tokenize → ONNX forward → mean-pool → L2-normalize. Returns (B, 768) float32."""
    _ensure_loaded()
    encodings = _tokenizer.encode_batch(texts)
    max_len = max(len(e.ids) for e in encodings)
    input_ids = np.array([e.ids + [0] * (max_len - len(e.ids)) for e in encodings], dtype=np.int64)
    attention_mask = np.array(
        [e.attention_mask + [0] * (max_len - len(e.attention_mask)) for e in encodings],
        dtype=np.int64,
    )
    token_type_ids = np.zeros_like(input_ids, dtype=np.int64)

    # ONNX model expects these three inputs
    feeds = {
        "input_ids": input_ids,
        "attention_mask": attention_mask,
        "token_type_ids": token_type_ids,
    }
    # Some BERT-family ONNX exports omit token_type_ids — try with, fall back without
    try:
        outputs = _session.run(None, feeds)
    except Exception:
        feeds = {"input_ids": input_ids, "attention_mask": attention_mask}
        outputs = _session.run(None, feeds)
    token_embeds = outputs[0]  # (B, L, D)
    return _mean_pool(token_embeds, attention_mask)


def _prefix(text: str, task_type: str) -> str:
    prefix = _TASK_TYPE_PREFIX.get(task_type, "")
    return prefix + text if prefix else text


def embed_text(text: str, task_type: str = "RETRIEVAL_DOCUMENT") -> List[float]:
    """Embed a single text string. Returns list[float] of length 768."""
    prefixed = _prefix(text, task_type)
    vec = _embed_batch([prefixed])[0]
    return vec.tolist()


def embed_texts(
    texts: List[str],
    task_type: str = "RETRIEVAL_DOCUMENT",
    batch_size: int = 32,
) -> List[List[float]]:
    """Embed a batch of text strings. Returns list[list[float]], one per input
    in order. Internally chunks to batch_size for memory control.
    """
    if not texts:
        return []
    prefixed = [_prefix(t, task_type) for t in texts]
    all_vecs: List[List[float]] = []
    for start in range(0, len(prefixed), batch_size):
        chunk = prefixed[start:start + batch_size]
        vecs = _embed_batch(chunk)
        all_vecs.extend(v.tolist() for v in vecs)
    return all_vecs


def warmup():
    """Pre-load model + run a tiny inference. Useful at process start so the
    first real request doesn't pay the ~3-5s ONNX session-init cost."""
    _ensure_loaded()
    _ = _embed_batch(["warmup"])


if __name__ == "__main__":
    # Smoke test
    import time, sys
    print("Loading model...")
    t0 = time.time()
    warmup()
    print(f"  load + warmup: {time.time() - t0:.2f}s")

    print("\nSingle embed:")
    t0 = time.time()
    v = embed_text("PYLOT helps UAE entrepreneurs navigate operations after starting a business.")
    print(f"  dim: {len(v)}  time: {(time.time() - t0) * 1000:.0f}ms")
    print(f"  first 5: {v[:5]}")
    print(f"  L2 norm: {np.linalg.norm(v):.6f} (should be ~1.0)")

    print("\nBatch embed (32 texts):")
    texts = ["test sentence " + str(i) for i in range(32)]
    t0 = time.time()
    vs = embed_texts(texts)
    elapsed = time.time() - t0
    print(f"  count: {len(vs)}  elapsed: {elapsed:.2f}s  rate: {len(vs)/elapsed:.1f} docs/sec")
    print(f"  all 768-dim: {all(len(v) == 768 for v in vs)}")

    print("\nQuery vs doc consistency (cosine similarity):")
    q = np.array(embed_text("UAE tax compliance", task_type="RETRIEVAL_QUERY"))
    d_match = np.array(embed_text("EmaraTax registration and quarterly VAT filings for UAE companies", task_type="RETRIEVAL_DOCUMENT"))
    d_off = np.array(embed_text("How to bake sourdough bread at home", task_type="RETRIEVAL_DOCUMENT"))
    print(f"  query vs related doc:   {float(q @ d_match):.4f}")
    print(f"  query vs unrelated doc: {float(q @ d_off):.4f}")
