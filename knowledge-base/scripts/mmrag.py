#!/usr/bin/env python3
"""
mmrag - Multimodal RAG Knowledge Base CLI

Ingest videos, images, audio, documents into a local ChromaDB vector database
using Gemini Embedding 2 for multimodal embeddings and Gemini Flash for
generating text descriptions of non-text media.

Usage:
    mmrag.py ingest <path> [<path>...] [--collection NAME]
    mmrag.py query <question> [--top-k N] [--threshold F] [--max-tokens N] [--collection NAME] [--json] [--full]
    mmrag.py status [--collection NAME]
    mmrag.py list [--collection NAME]
    mmrag.py collections
    mmrag.py delete <path> [--collection NAME]
    mmrag.py reset --confirm
"""

import argparse
import hashlib
import json
import mimetypes
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
# cortextOS env-var overrides (set by kb-*.sh scripts)
MMRAG_DIR = Path(os.environ.get("MMRAG_DIR", str(Path.home() / ".mmrag")))
CONFIG_FILE = Path(os.environ.get("MMRAG_CONFIG", str(MMRAG_DIR / "config.json")))
CHROMADB_DIR = Path(os.environ.get("MMRAG_CHROMADB_DIR", str(MMRAG_DIR / "chromadb")))
MEDIA_DIR = MMRAG_DIR / "media"
LOG_DIR = MMRAG_DIR / "logs"

VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".ogg", ".flac"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
DOC_EXTS = {".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls"}
TEXT_EXTS = {".txt", ".md", ".csv", ".json", ".py", ".js", ".ts", ".go",
             ".rs", ".java", ".cpp", ".c", ".sh", ".yaml", ".yml", ".toml",
             ".html", ".css", ".sql", ".rb", ".swift", ".kt", ".r", ".lua"}

# Non-content files/dirs skipped by ingest_file(). Lifted to module scope so the
# post-ingest self-verify (cmd_ingest) can mirror the EXACT same routing rules
# when deciding which sources are text-verifiable — a drifting copy would raise
# false TRUNCATED alarms on files ingest never indexed.
SKIP_FILE_NAMES = {".ds_store", "thumbs.db", ".gitignore", ".gitkeep",
                   "package-lock.json", "yarn.lock", "pnpm-lock.yaml", ".eslintcache"}
SKIP_DIR_NAMES = {".git", "node_modules", "__pycache__", ".venv", "venv", ".env",
                  ".next", ".nuxt", "dist", "build", ".cache", ".turbo",
                  "vendor", ".terraform", ".angular", ".svelte-kit", ".output",
                  "coverage", ".nyc_output", ".pytest_cache", ".mypy_cache"}

# Defaults
DEFAULT_TEXT_CHUNK_SIZE = 1500
DEFAULT_TEXT_CHUNK_OVERLAP = 200
DEFAULT_VIDEO_CHUNK_SECONDS = 60
DEFAULT_VIDEO_OVERLAP_SECONDS = 15
DEFAULT_AUDIO_CHUNK_SECONDS = 60
DEFAULT_AUDIO_OVERLAP_SECONDS = 10
DEFAULT_EMBEDDING_DIMENSIONS = 768
DEFAULT_SIMILARITY_THRESHOLD = 0.0  # return everything by default, let caller filter
DEFAULT_MAX_TOKENS = 0  # 0 = unlimited
DEFAULT_PREVIEW_CHARS = 300

# Pricing (per 1M tokens)
EMBEDDING_PRICE_PER_M = 0.20
FLASH_INPUT_PRICE_PER_M = 0.15
FLASH_OUTPUT_PRICE_PER_M = 0.60
# Claude Vision (Haiku 4.5) — the deterministic NONTEXT_BACKEND image-description path
# (describe_image_claude). Overridable if the vision model changes.
VISION_INPUT_PRICE_PER_M = float(os.environ.get("VISION_INPUT_PRICE_PER_M", "1.00"))
VISION_OUTPUT_PRICE_PER_M = float(os.environ.get("VISION_OUTPUT_PRICE_PER_M", "5.00"))

# model_tier taxonomy — Foundry usage-metering meta-spec §1a: WHAT COMPUTE RAN.
# Deliberately DISJOINT from plan_tier (free|subscriber|enhanced = what the tenant bought), so a
# server-side downgrade stays auditable instead of collapsing into one conflated field. Do not
# reintroduce "enhanced" here; it belongs to plan_tier alone.
MODEL_TIER_FAST = "fast"                    # Haiku-class / Gemini Flash — cheap cloud
MODEL_TIER_BALANCED = "balanced"            # Sonnet-class
MODEL_TIER_FRONTIER = "frontier"            # Opus-class
MODEL_TIER_DETERMINISTIC = "deterministic"  # Kreuzberg / markitdown / tesseract — no model, $0
MODEL_TIER_LOCAL = "local"                  # nomic ONNX on-box — $0
MODEL_TIER_UNKNOWN = "unknown"              # never silently guess a tier for an unrecognised model

# plan_tier = WHAT THE TENANT BOUGHT. This module is a producer of usage records, not an
# entitlement resolver: KB ingest is internal fleet work with no tenant behind it, so it stamps the
# `internal` sentinel rather than inventing a plan. A null would be ambiguous (absent vs
# not-applicable); `internal` says which. Real plan values are resolved at the Foundry-API layer,
# where a tenant actually exists — that is also where the downgrade audit becomes exercisable.
PLAN_TIER_INTERNAL = "internal"
PLAN_TIERS = frozenset({"free", "subscriber", "enhanced", PLAN_TIER_INTERNAL})
MODEL_TIERS = frozenset({
    MODEL_TIER_FAST, MODEL_TIER_BALANCED, MODEL_TIER_FRONTIER,
    MODEL_TIER_DETERMINISTIC, MODEL_TIER_LOCAL,
})
# Meta-spec §6 AC9, enforced at import: the two axes must never share a string.
assert not (MODEL_TIERS & PLAN_TIERS), "model_tier and plan_tier enums must stay disjoint"


def model_tier_for(model):
    """Map a concrete model/engine id to its model_tier (metering meta-spec §1a).

    Returns MODEL_TIER_UNKNOWN rather than guessing: an unrecognised model in the ledger is a
    visible gap, whereas a wrong tier is a silent mis-billing.
    """
    m = (model or "").lower()
    if not m:
        return MODEL_TIER_UNKNOWN
    if "opus" in m:
        return MODEL_TIER_FRONTIER
    if "sonnet" in m:
        return MODEL_TIER_BALANCED
    if "haiku" in m or "flash" in m:
        return MODEL_TIER_FAST
    if any(e in m for e in ("kreuzberg", "markitdown", "tesseract")):
        return MODEL_TIER_DETERMINISTIC
    if "nomic" in m or m.endswith("-local"):
        return MODEL_TIER_LOCAL
    if "embedding" in m:           # gemini-embedding-* — cheap cloud embed
        return MODEL_TIER_FAST
    return MODEL_TIER_UNKNOWN


# Retry classifier for the Gemini generate_content call inside ingest_pdf.
# Module-level so a fault-injection test client can reference the same set.
TRANSIENT_HTTP_CODES = {429, 500, 503}
TRANSIENT_STATUS_NAMES = {"UNAVAILABLE", "RESOURCE_EXHAUSTED"}

USAGE_FILE = MMRAG_DIR / "usage.json"

# ---------------------------------------------------------------------------
# Usage Tracker
# ---------------------------------------------------------------------------
_tracker = None  # module-level, set by cmd_ingest/cmd_query


class UsageTracker:
    def __init__(self, operation="unknown"):
        self.session = {
            "embedding_tokens": 0,
            "embedding_calls": 0,
            "generation_input_tokens": 0,
            "generation_output_tokens": 0,
            "generation_calls": 0,
            "vision_input_tokens": 0,
            "vision_output_tokens": 0,
            "vision_calls": 0,
            # Explicit model + model_tier per engine (metering meta-spec §1: every record carries
            # {model, model_tier}). Previously the model was only IMPLICIT in which price constant
            # was applied — so the ledger could not answer "what ran?", only "what did it cost?".
            # None until the corresponding engine is actually used in this session.
            "embedding_model": None,
            "embedding_model_tier": None,
            "generation_model": None,
            "generation_model_tier": None,
            "vision_model": None,
            "vision_model_tier": None,
            # Metering meta-spec §1: every record carries BOTH axes. KB ingest is internal fleet
            # work — no tenant, no plan — so the pair is stamped {actor: internal, plan_tier:
            # internal} rather than left absent. Stamping it here (where it is trivially known)
            # keeps the record schema uniform across internal + external producers, so AC9
            # disjointness is exercisable against REAL records instead of only the enum literals.
            "actor": "internal",
            "plan_tier": PLAN_TIER_INTERNAL,
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "operation": operation,
        }

    def _stamp(self, kind, model):
        """Record which model/engine served `kind` ('embedding'|'generation'|'vision').

        First writer wins per session; a differing later model is surfaced (not overwritten) so a
        mixed-model session is visible rather than silently attributed to one of them.
        """
        if not model:
            return
        key = f"{kind}_model"
        current = self.session.get(key)
        if current and current != model:
            if model not in current.split("+"):
                self.session[key] = f"{current}+{model}"
                self.session[f"{kind}_model_tier"] = "mixed"
            return
        self.session[key] = model
        self.session[f"{kind}_model_tier"] = model_tier_for(model)

    def track_embedding(self, content, model=None):
        self.session["embedding_calls"] += 1
        # nomic ONNX runs on-box ($0, tier=local); otherwise the Gemini embedding model.
        self._stamp("embedding", model or (
            "nomic-embed-text-v1.5-local" if EMBEDDING_BACKEND == "local"
            else "gemini-embedding-2-preview"
        ))
        if isinstance(content, str):
            self.session["embedding_tokens"] += int(len(content.split()) * 1.3)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, str):
                    self.session["embedding_tokens"] += int(len(part.split()) * 1.3)
                else:
                    try:
                        self.session["embedding_tokens"] += max(256, len(part.data) // 4)
                    except Exception:
                        self.session["embedding_tokens"] += 256

    def track_generation(self, response, model=None):
        self.session["generation_calls"] += 1
        um = getattr(response, "usage_metadata", None)
        if um:
            self.session["generation_input_tokens"] += getattr(um, "prompt_token_count", 0) or 0
            self.session["generation_output_tokens"] += getattr(um, "candidates_token_count", 0) or 0
        # Prefer the model the response reports; fall back to the configured default.
        self._stamp("generation", model or getattr(response, "model_version", None)
                    or "gemini-2.5-flash")

    def track_vision(self, input_tokens, output_tokens, model=None):
        """Claude Vision (Haiku) image-description usage — priced separately from
        Gemini generation. Called from the deterministic ingest_image path.

        `model` comes from the Anthropic response (describe_image_claude returns it in its usage
        dict), NOT from the request constant — so the ledger records what the API actually served,
        which is the only version that can be reconciled against a provider invoice.
        """
        self.session["vision_calls"] += 1
        self.session["vision_input_tokens"] += int(input_tokens or 0)
        self.session["vision_output_tokens"] += int(output_tokens or 0)
        self._stamp("vision", model)

    def cost(self):
        # Local embedder (nomic ONNX) runs on CPU = free; only Gemini embedding bills.
        # Generation (Flash media descriptions) still routes through Gemini even under
        # EMBEDDING_BACKEND=local, so gen_in/gen_out stay billed.
        if EMBEDDING_BACKEND == "local":
            emb = 0.0
        else:
            emb = (self.session["embedding_tokens"] / 1_000_000) * EMBEDDING_PRICE_PER_M
        gen_in = (self.session["generation_input_tokens"] / 1_000_000) * FLASH_INPUT_PRICE_PER_M
        gen_out = (self.session["generation_output_tokens"] / 1_000_000) * FLASH_OUTPUT_PRICE_PER_M
        # Claude Vision (Haiku) always bills — it is a real API call regardless of
        # EMBEDDING_BACKEND (which only governs the embedding step).
        vis_in = (self.session["vision_input_tokens"] / 1_000_000) * VISION_INPUT_PRICE_PER_M
        vis_out = (self.session["vision_output_tokens"] / 1_000_000) * VISION_OUTPUT_PRICE_PER_M
        return {
            "embedding": round(emb, 6),
            "generation_input": round(gen_in, 6),
            "generation_output": round(gen_out, 6),
            "vision_input": round(vis_in, 6),
            "vision_output": round(vis_out, 6),
            "total": round(emb + gen_in + gen_out + vis_in + vis_out, 6),
        }

    def persist(self):
        MMRAG_DIR.mkdir(parents=True, exist_ok=True)
        self.session["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        self.session["cost"] = self.cost()

        data = {"cumulative": {}, "sessions": []}
        if USAGE_FILE.exists():
            try:
                with open(USAGE_FILE) as f:
                    data = json.load(f)
            except (json.JSONDecodeError, KeyError):
                data = {"cumulative": {}, "sessions": []}

        data.setdefault("sessions", []).append(self.session)

        c = data.get("cumulative", {})
        for key in ["embedding_tokens", "embedding_calls",
                     "generation_input_tokens", "generation_output_tokens",
                     "generation_calls",
                     "vision_input_tokens", "vision_output_tokens", "vision_calls"]:
            c[key] = c.get(key, 0) + self.session[key]

        c["total_cost"] = round(sum(
            s.get("cost", {}).get("total", 0) for s in data["sessions"]
        ), 6)
        data["cumulative"] = c

        with open(USAGE_FILE, "w") as f:
            json.dump(data, f, indent=2)

    def summary_line(self):
        c = self.cost()
        vis = ""
        if self.session["vision_calls"]:
            vis = (f", {self.session['vision_input_tokens']:,} vision-in, "
                   f"{self.session['vision_output_tokens']:,} vision-out")
        return (f"  Tokens: {self.session['embedding_tokens']:,} embedding, "
                f"{self.session['generation_input_tokens']:,} gen-input, "
                f"{self.session['generation_output_tokens']:,} gen-output"
                f"{vis} | Cost: ${c['total']:.4f}")


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
def load_config():
    if not CONFIG_FILE.exists():
        print("ERROR: Config not found. Run setup first:")
        print(f"  bash {Path(__file__).parent / 'setup.sh'}")
        sys.exit(1)
    with open(CONFIG_FILE) as f:
        return json.load(f)


def get_api_key(config):
    key = os.environ.get("GEMINI_API_KEY") or config.get("gemini_api_key")
    if not key:
        print("ERROR: No Gemini API key. Set GEMINI_API_KEY or run setup.")
        sys.exit(1)
    return key

# ---------------------------------------------------------------------------
# Gemini clients
# ---------------------------------------------------------------------------
def _load_factory(dotted_path):
    """Resolve a dotted import path to a callable.

    Accepts 'pkg.mod.attr' or 'pkg.mod:attr'. The colon form is unambiguous when
    the attribute name collides with a submodule name, so it is preferred.
    """
    if ":" in dotted_path:
        module_path, _, attr_path = dotted_path.partition(":")
    else:
        module_path, _, attr_path = dotted_path.rpartition(".")
    if not module_path or not attr_path:
        raise ValueError(
            f"MMRAG_GEMINI_CLIENT_FACTORY {dotted_path!r} must be 'module.attr' or 'module:attr'"
        )
    import importlib
    obj = importlib.import_module(module_path)
    for part in attr_path.split("."):
        obj = getattr(obj, part)
    if not callable(obj):
        raise TypeError(
            f"MMRAG_GEMINI_CLIENT_FACTORY {dotted_path!r} resolved to non-callable {type(obj).__name__}"
        )
    return obj


def get_genai_client(api_key):
    """Construct a Gemini client.

    Default returns google.genai.Client(api_key=api_key) — byte-identical to
    the prior behavior. To inject a fake client (e.g. for testing the retry
    loop in ingest_pdf), set the env-var MMRAG_GEMINI_CLIENT_FACTORY to a
    dotted import path of a callable taking (api_key) and returning an object
    with .models.generate_content / .models.embed_content compatible shape.
    See knowledge-base/scripts/_test_clients/fault_injection.py for a reference.
    """
    factory_path = os.environ.get("MMRAG_GEMINI_CLIENT_FACTORY")
    if factory_path:
        return _load_factory(factory_path)(api_key)
    from google import genai
    return genai.Client(api_key=api_key)


class _LazyGenaiClient:
    """Defers Gemini client construction (and the API-key requirement) until a Gemini path is
    ACTUALLY taken.

    Why this exists (2026-07-11): `cmd_ingest`/`cmd_query` built the client eagerly, so
    `get_api_key()` ran on EVERY invocation and `sys.exit(1)`s without a key — even under
    EMBEDDING_BACKEND=local + NONTEXT_BACKEND=deterministic, where **no Gemini call is made at
    all**. Measured: a fully deterministic image ingest with no key anywhere died on
    "ERROR: No Gemini API key".

    So Gemini was retired for the WORK while remaining load-bearing as a DEPENDENCY: the KB was one
    revoked key away from total ingest+query failure, and the key was sitting in plaintext in
    ~/.mmrag/config.json precisely because nothing could run without it. Removing that key safely
    requires this first.

    Behaviour is unchanged for the gemini backends: the first attribute access builds the real
    client exactly as before (same factory hook, same error if the key is missing) — it just happens
    at point-of-use instead of at startup. A deterministic/local run never touches it, so it never
    needs a key.
    """

    __slots__ = ("_config", "_client")

    def __init__(self, config):
        self._config = config
        self._client = None

    def _resolve(self):
        if self._client is None:
            # get_api_key() still sys.exit(1)s with the same message if a Gemini path is genuinely
            # taken without a key — the failure is preserved, just moved to where it's real.
            self._client = get_genai_client(get_api_key(self._config))
        return self._client

    def __getattr__(self, name):
        return getattr(self._resolve(), name)


def _retry_generate_content(client, *, model, contents, backoffs=(5, 15, 45)):
    """Call client.models.generate_content with bounded retries on transient APIErrors.

    Retries on HTTP code in TRANSIENT_HTTP_CODES or status name in
    TRANSIENT_STATUS_NAMES; re-raises immediately on any other APIError (auth,
    malformed request, etc.); re-raises last_err after all attempts exhausted.

    backoffs is a tuple of sleep seconds between attempts. len(backoffs) is the
    attempt count. Tests pass (0, 0, 0) to skip sleeps.
    """
    from google.genai import errors as _genai_errors
    last_err = None
    for attempt, backoff in enumerate(backoffs, start=1):
        try:
            return client.models.generate_content(model=model, contents=contents)
        except _genai_errors.APIError as e:
            last_err = e
            is_transient = (e.code in TRANSIENT_HTTP_CODES) or (e.status in TRANSIENT_STATUS_NAMES)
            if not is_transient:
                raise
            if attempt < len(backoffs):
                print(f"    Transient error (HTTP {e.code} {e.status or ''}); retrying in {backoff}s (attempt {attempt}/{len(backoffs)})")
                time.sleep(backoff)
            else:
                print(f"    Exhausted retries on transient error: HTTP {e.code} {e.status or ''}")
    raise last_err if last_err else RuntimeError("retry loop completed without response or error")


def _retry_embed_content(client, *, model, contents, output_dimensionality, task_type, backoffs=(5, 15, 45)):
    """Call client.models.embed_content with bounded retries on transient APIErrors.

    `contents` is passed verbatim to the SDK:
      - single string  -> one embedding (result.embeddings has length 1)
      - list[str]      -> batch (result.embeddings has length == len(contents), input order)
      - list[Part]     -> one multimodal embedding (length 1)

    Retry semantics match _retry_generate_content: transient HTTP/status retried with
    bounded backoff; non-transient APIErrors re-raised immediately.

    Returns the raw EmbedContentResponse; callers extract .embeddings.
    """
    from google.genai import errors as _genai_errors
    from google.genai import types
    last_err = None
    for attempt, backoff in enumerate(backoffs, start=1):
        try:
            return client.models.embed_content(
                model=model,
                contents=contents,
                config=types.EmbedContentConfig(
                    output_dimensionality=output_dimensionality,
                    task_type=task_type,
                ),
            )
        except _genai_errors.APIError as e:
            last_err = e
            is_transient = (e.code in TRANSIENT_HTTP_CODES) or (e.status in TRANSIENT_STATUS_NAMES)
            if not is_transient:
                raise
            if attempt < len(backoffs):
                print(f"    Transient embed error (HTTP {e.code} {e.status or ''}); retrying in {backoff}s (attempt {attempt}/{len(backoffs)})")
                time.sleep(backoff)
            else:
                print(f"    Exhausted retries on transient embed error: HTTP {e.code} {e.status or ''}")
    raise last_err if last_err else RuntimeError("retry loop completed without response or error")


# EMBEDDING_BACKEND switch — 'local' (DEFAULT) | 'gemini' (legacy, being removed)
# Local path uses scripts/local_embedder.py (nomic-embed-text-v1.5 ONNX, 768-dim, on-box, $0).
#
# DEFAULT FLIPPED TO 'local' 2026-07-11 (analyst finding). It used to default to 'gemini', with
# 'local' set only by the kb-ingest WRAPPER on each call — so **any embed path that did not go
# through the wrapper silently reverted to a direct Gemini call with a per-service key**. The safe
# path must be the DEFAULT, not a thing the caller has to remember. A flag whose safe value depends
# on every caller opting in is not a safety control; it is a trap with good intentions.
#
# Same class as NONTEXT_BACKEND below, and the same reasoning as the ai-gateway rule: the secure
# route is the one you get by doing nothing.
EMBEDDING_BACKEND = os.environ.get("EMBEDDING_BACKEND", "local").lower()

# NONTEXT_BACKEND switch — 'deterministic' (DEFAULT) | 'gemini' (legacy, being removed)
# Controls how PDFs and images are turned INTO text before embedding (orthogonal to
# EMBEDDING_BACKEND, which controls how that text is embedded).
#   'deterministic' → PDFs via Kreuzberg text-layer extraction (scripts/file-convert.py);
#                     images via Claude Vision (Haiku) **through the ai-gateway**. No Gemini.
#   'gemini'        → LEGACY: Gemini Flash extracts PDFs and describes images (multimodal embed).
#                     Retired for the fleet; scheduled for removal (task_1783753475613).
#
# DEFAULT FLIPPED TO 'deterministic' 2026-07-11. Previously 'gemini' with the live value set only
# in secrets.env — so the on-disk default disagreed with what the fleet actually runs, and any
# invocation that missed the env var quietly took the retired path. Make the running configuration
# the default; an env var should express a DEVIATION, not carry the only safe setting.
NONTEXT_BACKEND = os.environ.get("NONTEXT_BACKEND", "deterministic").lower()


def _local_embed_text(text: str, task_type: str = "RETRIEVAL_DOCUMENT"):
    """Lazy-import the local embedder so the gemini path doesn't pay the
    onnxruntime + tokenizers + numpy import cost when not in use."""
    from local_embedder import embed_text
    return embed_text(text, task_type=task_type)


def _local_embed_texts(texts, task_type: str = "RETRIEVAL_DOCUMENT", batch_size: int = 32):
    from local_embedder import embed_texts
    return embed_texts(texts, task_type=task_type, batch_size=batch_size)


def embed_content(client, config, content, task_type="RETRIEVAL_DOCUMENT"):
    """Embed content. Routes via EMBEDDING_BACKEND env var:
      - 'local'  → nomic-embed-text-v1.5 ONNX (text only; multimodal falls
                   back to Gemini if requested but local is set)
      - 'gemini' → Gemini Embedding 2 (default)
    Content can be text string or list of Parts (Parts only supported on gemini)."""
    if EMBEDDING_BACKEND == "local":
        # Local path is text-only. If a list-of-Parts is passed (multimodal),
        # we can't handle it; fall through to gemini for that one call.
        if isinstance(content, str):
            # Track BEFORE the early return. This path used to return without ever reaching the
            # tracker below, so under EMBEDDING_BACKEND=local (the live fleet setting) a
            # single-content embed was structurally uncountable — embedding_calls was always 0.
            # $0 cost is not the same as unmetered: the ledger must still be able to say nomic ran.
            # (embed_contents_batch already tracked its local path; only this one had drifted.)
            if _tracker:
                _tracker.track_embedding(content)
            return _local_embed_text(content, task_type=task_type)
        # Non-string path → caller wants multimodal; gemini is the only option
        # for that today, so route through even if EMBEDDING_BACKEND=local.
    result = _retry_embed_content(
        client,
        model=config.get("embedding_model", "gemini-embedding-2-preview"),
        contents=content,
        output_dimensionality=config.get("embedding_dimensions", DEFAULT_EMBEDDING_DIMENSIONS),
        task_type=task_type,
    )
    if _tracker:
        _tracker.track_embedding(content)
    return result.embeddings[0].values


def _call_batch_embed_rest(api_key, model, contents_list, output_dimensionality, task_type, backoffs=(5, 15, 45)):
    """Direct POST to Gemini batchEmbedContents REST endpoint with bounded retries.

    Bypasses google.genai 2.2.0's embed_content() — that SDK method collapses a
    list of strings into ONE multimodal-style content and returns 1 embedding,
    not N (verified 2026-06-02). The REST endpoint with `requests[]` shape DOES
    return N embeddings for N requests, so we hit it directly via stdlib urllib.

    Returns list of embedding vectors in input order (one per input string).
    Retries on transient HTTP codes (in TRANSIENT_HTTP_CODES); re-raises
    immediately on other 4xx codes; re-raises last error after exhausting retries.
    """
    import urllib.request
    import urllib.error

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:batchEmbedContents?key={api_key}"
    body = {
        "requests": [
            {
                "model": f"models/{model}",
                "content": {"parts": [{"text": text}]},
                "taskType": task_type,
                "outputDimensionality": output_dimensionality,
            }
            for text in contents_list
        ]
    }
    payload = json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json"}

    last_err = None
    for attempt, backoff in enumerate(backoffs, start=1):
        try:
            req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=60) as resp:
                resp_body = resp.read().decode("utf-8")
            data = json.loads(resp_body)
            if "error" in data:
                code = data["error"].get("code", 0)
                status = data["error"].get("status", "")
                msg = data["error"].get("message", "")
                if code in TRANSIENT_HTTP_CODES or status in TRANSIENT_STATUS_NAMES:
                    last_err = RuntimeError(f"batch HTTP {code} {status}: {msg}")
                    if attempt < len(backoffs):
                        print(f"    Transient batch error (HTTP {code} {status}); retrying in {backoff}s (attempt {attempt}/{len(backoffs)})")
                        time.sleep(backoff)
                        continue
                    raise last_err
                raise RuntimeError(f"batch HTTP {code} {status}: {msg}")
            embeddings = [e["values"] for e in data.get("embeddings", [])]
            if len(embeddings) != len(contents_list):
                raise RuntimeError(
                    f"batchEmbedContents returned {len(embeddings)} embeddings for {len(contents_list)} inputs"
                )
            return embeddings
        except urllib.error.HTTPError as e:
            code = e.code
            try:
                err_body = e.read().decode("utf-8", errors="replace")
                err_data = json.loads(err_body)
                status = err_data.get("error", {}).get("status", "")
            except Exception:
                status = ""
            last_err = RuntimeError(f"batch HTTP {code} {status}: {e.reason}")
            is_transient = (code in TRANSIENT_HTTP_CODES) or (status in TRANSIENT_STATUS_NAMES)
            if not is_transient:
                raise last_err
            if attempt < len(backoffs):
                print(f"    Transient batch error (HTTP {code} {status}); retrying in {backoff}s (attempt {attempt}/{len(backoffs)})")
                time.sleep(backoff)
            else:
                print(f"    Exhausted retries on transient batch error: HTTP {code} {status}")
        except urllib.error.URLError as e:
            last_err = e
            if attempt < len(backoffs):
                print(f"    Network error ({e}); retrying in {backoff}s (attempt {attempt}/{len(backoffs)})")
                time.sleep(backoff)
            else:
                print(f"    Exhausted retries on network error: {e}")
    raise last_err if last_err else RuntimeError("batch retry loop completed without response or error")


def embed_contents_batch(client, config, contents_list, task_type="RETRIEVAL_DOCUMENT", batch_size=100):
    """Embed N text contents via Gemini batchEmbedContents (up to batch_size per request).

    Returns list of embedding vectors in input order. Bypasses the Vertex AI
    online_prediction_requests_per_base_model cap (~1-2 req/sec) because one
    batch call counts as one request regardless of how many contents it carries.

    Implementation note: google.genai 2.2.0's client.models.embed_content() does
    NOT batch when passed a list-of-strings (it collapses to one multimodal
    content and returns 1 embedding). We bypass the SDK and hit the
    batchEmbedContents REST endpoint directly via stdlib urllib — see
    _call_batch_embed_rest. The `client` parameter is retained for signature
    symmetry with embed_content() and for the fallback path (which uses the
    SDK's working single-content path).

    `contents_list` must be a list of strings.

    Fallback: if a batch call fails after all retries, that batch's items are
    re-embedded one at a time via embed_content (which has its own retry-with-backoff
    via _retry_embed_content). Other batches are unaffected. This preserves the
    per-chunk resilience option as a safety net under the batch path.
    """
    if not contents_list:
        return []
    if EMBEDDING_BACKEND == "local":
        # Local ONNX path — no API quota, no batch-vs-single shape issue.
        # 768-dim output is identical to gemini-embedding-2-preview.
        if _tracker:
            for item in contents_list:
                _tracker.track_embedding(item)
        # batch_size=32 is the local-embedder sweet spot (CPU-bound + memory)
        return _local_embed_texts(contents_list, task_type=task_type, batch_size=32)
    api_key = get_api_key(config)
    embeddings = []
    model = config.get("embedding_model", "gemini-embedding-2-preview")
    output_dimensionality = config.get("embedding_dimensions", DEFAULT_EMBEDDING_DIMENSIONS)
    for batch_start in range(0, len(contents_list), batch_size):
        batch = contents_list[batch_start:batch_start + batch_size]
        try:
            batch_embeddings = _call_batch_embed_rest(
                api_key=api_key,
                model=model,
                contents_list=batch,
                output_dimensionality=output_dimensionality,
                task_type=task_type,
            )
            if _tracker:
                for item in batch:
                    _tracker.track_embedding(item)
            embeddings.extend(batch_embeddings)
        except Exception as e:
            print(f"    Batch embed failed ({type(e).__name__}: {e}); falling back to per-item embed for {len(batch)} items")
            for item in batch:
                embeddings.append(embed_content(client, config, item, task_type=task_type))
    return embeddings


def embed_multimodal(client, config, description_text, media_bytes, mime_type):
    """
    Option B embedding: combine text description + raw media into one embedding.
    This captures both semantic text meaning AND visual/audio content.
    """
    from google.genai import types
    contents = [
        description_text,
        types.Part.from_bytes(data=media_bytes, mime_type=mime_type),
    ]
    return embed_content(client, config, contents)


def embed_query(client, config, query_text):
    """Embed a query string for retrieval."""
    return embed_content(client, config, query_text, task_type="RETRIEVAL_QUERY")


def describe_media(client, config, file_path, media_type="video"):
    """Use Gemini Flash to generate a text description of media."""
    from google.genai import types

    mime = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    with open(file_path, "rb") as f:
        data = f.read()

    prompts = {
        "video": (
            "Provide a detailed description of this video. Include:\n"
            "1. What is being shown/demonstrated\n"
            "2. Any text visible on screen\n"
            "3. Key concepts or topics discussed\n"
            "4. A transcript of any spoken words\n"
            "5. Step-by-step actions if it's a tutorial\n"
            "Be thorough - this description will be used for search and retrieval."
        ),
        "image": (
            "Describe this image in detail. Include:\n"
            "1. What is shown in the image\n"
            "2. Any text visible in the image\n"
            "3. Key concepts or topics depicted\n"
            "4. Colors, layout, and composition\n"
            "Be thorough - this description will be used for search and retrieval."
        ),
        "audio": (
            "Transcribe and describe this audio. Include:\n"
            "1. A full transcript of spoken words\n"
            "2. Description of any sounds or music\n"
            "3. Key topics discussed\n"
            "4. Speaker identification if possible\n"
            "Be thorough - this description will be used for search and retrieval."
        ),
    }

    response = client.models.generate_content(
        model=config.get("gemini_model", "gemini-2.5-flash"),
        contents=[
            types.Part.from_bytes(data=data, mime_type=mime),
            prompts.get(media_type, prompts["video"]),
        ],
    )
    if _tracker:
        _tracker.track_generation(response)
    return response.text, data, mime

# ---------------------------------------------------------------------------
# ChromaDB
# ---------------------------------------------------------------------------
def get_chroma_collection(collection_name="default"):
    import chromadb
    client = chromadb.PersistentClient(path=str(CHROMADB_DIR))
    return client.get_or_create_collection(
        name=collection_name,
        metadata={"hnsw:space": "cosine"},
    )


def get_chroma_client():
    import chromadb
    return chromadb.PersistentClient(path=str(CHROMADB_DIR))

# ---------------------------------------------------------------------------
# Text chunking
# ---------------------------------------------------------------------------
def chunk_text(text, chunk_size=DEFAULT_TEXT_CHUNK_SIZE, overlap=DEFAULT_TEXT_CHUNK_OVERLAP):
    """Split text into overlapping chunks, preferring paragraph/section boundaries."""
    if len(text) <= chunk_size:
        return [text] if text.strip() else []

    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size

        # Try to break at a paragraph boundary (double newline)
        if end < len(text):
            # Look backwards from end for a good break point
            search_zone = text[max(start + chunk_size // 2, start):end]
            # Prefer double newline (paragraph break)
            para_break = search_zone.rfind("\n\n")
            if para_break != -1:
                end = max(start + chunk_size // 2, start) + para_break + 2
            else:
                # Fall back to single newline
                line_break = search_zone.rfind("\n")
                if line_break != -1:
                    end = max(start + chunk_size // 2, start) + line_break + 1

        chunk = text[start:end]
        if chunk.strip():
            chunks.append(chunk.strip())
        start = end - overlap
        if start >= len(text):
            break

    return chunks

# ---------------------------------------------------------------------------
# Video chunking with FFmpeg
# ---------------------------------------------------------------------------
def get_media_duration(file_path):
    """Get duration of a media file in seconds. Returns 0 if unreadable."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(file_path)],
            capture_output=True, text=True,
        )
        val = result.stdout.strip()
        return float(val) if val else 0.0
    except (ValueError, subprocess.SubprocessError):
        return 0.0


def chunk_video(video_path, chunk_seconds=DEFAULT_VIDEO_CHUNK_SECONDS,
                overlap_seconds=DEFAULT_VIDEO_OVERLAP_SECONDS):
    """Split video into overlapping chunks using FFmpeg."""
    video_path = Path(video_path)
    output_dir = MEDIA_DIR / video_path.stem
    output_dir.mkdir(parents=True, exist_ok=True)

    duration = get_media_duration(video_path)

    chunks = []
    start = 0
    idx = 0
    step = chunk_seconds - overlap_seconds

    while start < duration:
        end = min(start + chunk_seconds, duration)
        # Skip tiny trailing chunks (< 5 seconds)
        if end - start < 5 and idx > 0:
            break

        output_file = output_dir / f"chunk_{idx:04d}.mp4"

        if not output_file.exists():
            subprocess.run(
                ["ffmpeg", "-y", "-i", str(video_path),
                 "-ss", str(start), "-t", str(end - start),
                 "-c", "copy", "-avoid_negative_ts", "1",
                 str(output_file)],
                capture_output=True,
            )

        chunks.append({
            "path": str(output_file),
            "start": start,
            "end": end,
            "index": idx,
        })

        start += step
        idx += 1

    return chunks


def chunk_audio(audio_path, chunk_seconds=DEFAULT_AUDIO_CHUNK_SECONDS,
                overlap_seconds=DEFAULT_AUDIO_OVERLAP_SECONDS):
    """Split audio into overlapping chunks using FFmpeg."""
    audio_path = Path(audio_path)
    output_dir = MEDIA_DIR / audio_path.stem
    output_dir.mkdir(parents=True, exist_ok=True)

    duration = get_media_duration(audio_path)

    ext = audio_path.suffix
    chunks = []
    start = 0
    idx = 0
    step = chunk_seconds - overlap_seconds

    while start < duration:
        end = min(start + chunk_seconds, duration)
        if end - start < 3 and idx > 0:
            break

        output_file = output_dir / f"chunk_{idx:04d}{ext}"

        if not output_file.exists():
            subprocess.run(
                ["ffmpeg", "-y", "-i", str(audio_path),
                 "-ss", str(start), "-t", str(end - start),
                 "-c", "copy", str(output_file)],
                capture_output=True,
            )

        chunks.append({
            "path": str(output_file),
            "start": start,
            "end": end,
            "index": idx,
        })

        start += step
        idx += 1

    return chunks

# ---------------------------------------------------------------------------
# File ID helper
# ---------------------------------------------------------------------------
def file_id(path, chunk_idx=None):
    """Generate a stable ID for a file or chunk."""
    h = hashlib.md5(str(path).encode()).hexdigest()[:12]
    if chunk_idx is not None:
        return f"{h}_chunk{chunk_idx}"
    return h


def compute_hash(payload):
    """sha256 of bytes or UTF-8 of a string. Used for content-aware skip."""
    if isinstance(payload, str):
        payload = payload.encode("utf-8", errors="replace")
    return hashlib.sha256(payload).hexdigest()

# ---------------------------------------------------------------------------
# Ingest logic
# ---------------------------------------------------------------------------
def should_skip(collection, doc_id, content_hash_value):
    """Decide whether to skip an embed call for this doc_id.

    Returns True (skip) only when the record already exists AND its stored
    content_hash matches the incoming content_hash. With --force, never skips.

    Backward-compat: if an existing record lacks content_hash metadata
    (entries embedded before this fix shipped), we treat it as "still fresh"
    AND opportunistically backfill the hash via collection.update — no embed
    call, just a metadata patch. Future ingests of changed content will then
    detect a hash mismatch correctly.
    """
    if args_force:
        return False

    existing = collection.get(ids=[doc_id], include=["metadatas"])
    if not (existing and existing.get("ids")):
        return False  # no record yet — embed needed

    metas = existing.get("metadatas") or [None]
    stored_meta = metas[0] or {}
    stored_hash = stored_meta.get("content_hash")

    if stored_hash == content_hash_value:
        return True  # same content already embedded

    if stored_hash is None:
        # Opportunistic backfill: stamp the hash so future runs use real check.
        stored_meta["content_hash"] = content_hash_value
        try:
            collection.update(ids=[doc_id], metadatas=[stored_meta])
        except Exception:
            # If chromadb version lacks update, swallow — backfill is best-effort.
            pass
        return True

    return False  # hash differs — content changed, re-embed


def already_exists(collection, doc_id):
    """Legacy path-only skip check. Retained for any external callers; the
    in-tree ingest_* functions all migrated to should_skip(). Respects --force."""
    if args_force:
        return False
    existing = collection.get(ids=[doc_id])
    return bool(existing and existing["ids"])


def ingest_text_file(client, config, collection, file_path):
    """Ingest a text-based file."""
    file_path = Path(file_path)
    text = file_path.read_text(errors="replace")
    if not text.strip():
        print(f"  SKIP (empty): {file_path}")
        return 0

    chunks = chunk_text(
        text,
        chunk_size=config.get("text_chunk_size", DEFAULT_TEXT_CHUNK_SIZE),
        overlap=config.get("text_chunk_overlap", DEFAULT_TEXT_CHUNK_OVERLAP),
    )

    # Filter pass: collect items that need embedding (skip those Chroma already has)
    pending = []
    for i, chunk in enumerate(chunks):
        doc_id = file_id(file_path, i)
        chunk_hash = compute_hash(chunk)
        if should_skip(collection, doc_id, chunk_hash):
            continue
        pending.append((i, chunk, doc_id, chunk_hash))

    if not pending:
        return 0

    # Batch embed all pending chunks (one API request per batch_size up to 100)
    pending_texts = [item[1] for item in pending]
    pending_embeddings = embed_contents_batch(client, config, pending_texts)

    # Bulk upsert
    ingested_at = time.strftime("%Y-%m-%dT%H:%M:%S")
    ids = [item[2] for item in pending]
    documents = [item[1] for item in pending]
    metadatas = [{
        "source": str(file_path.resolve()),
        "type": "text",
        "chunk_index": item[0],
        "total_chunks": len(chunks),
        "filename": file_path.name,
        "file_ext": file_path.suffix.lower(),
        "content_hash": item[3],
        "ingested_at": ingested_at,
    } for item in pending]
    collection.upsert(
        ids=ids,
        embeddings=pending_embeddings,
        documents=documents,
        metadatas=metadatas,
    )

    return len(pending)


def _pdf_has_embedded_images(file_path):
    """Does this PDF contain embedded images? (poppler `pdfimages -list`)

    This is the DISCRIMINATOR between the two reasons a PDF yields no text, which look
    identical from the outside and demand opposite responses:
      - a SCANNED page  -> no text layer, HAS images  -> OCR it.
      - a genuinely blank/broken PDF -> no text, NO images -> OCR would return nothing too.

    Returns True/False, or None if we cannot tell (poppler missing). None means UNKNOWN,
    and the caller must FAIL TOWARD EXTRACTION — trying OCR on a blank PDF costs nothing
    and returns nothing, whereas skipping a scan silently discards a customer's passport.
    """
    import subprocess
    try:
        proc = subprocess.run(["pdfimages", "-list", str(file_path)],
                              capture_output=True, text=True, timeout=60)
        if proc.returncode != 0:
            return None
        # header is 2 lines; any further line is an image
        rows = [l for l in proc.stdout.splitlines()[2:] if l.strip()]
        return len(rows) > 0
    except FileNotFoundError:
        return None
    except Exception:
        return None


def extract_pdf_text_deterministic(file_path):
    """Deterministic PDF text extraction via Kreuzberg (scripts/file-convert.py).

    ⚠️ 2026-07-11 — THE OCR FALL-THROUGH. Before this, a PDF with no text layer was simply
    SKIPPED, and the skip message itself said "likely a scanned PDF needing the tesseract
    OCR slice". The code named its own fix and did not take it: `--ocr` existed, worked, and
    was never passed by the ingest path. A SCANNED DOCUMENT WAS SILENTLY DISCARDED — zero
    chunks, no error, no cost, no record. The document just vanished.

    That is the worst failure a KYC product can have, because IT LOOKS LIKE IT WORKED: a
    customer uploads their passport, sees no error, and nothing was ingested. Strictly worse
    than a crash — a crash gets fixed.

    Now: empty text layer -> if the PDF carries embedded images (or we cannot tell), re-run
    the SAME proven converter with --ocr (tesseract, local, $0, no model call, no network).
    Never a silent zero.
    """
    import subprocess
    script = Path(__file__).with_name("file-convert.py")

    def _run(force_ocr):
        cmd = [sys.executable, str(script), str(file_path), "--format", "markdown"]
        if force_ocr:
            cmd.append("--ocr")
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            if proc.returncode != 0:
                print(f"    file-convert failed (rc={proc.returncode}{' --ocr' if force_ocr else ''}): "
                      f"{proc.stderr.strip()[:200]}", file=sys.stderr, flush=True)
                return ""
            return proc.stdout
        except Exception as e:
            print(f"    deterministic PDF extract error{' (--ocr)' if force_ocr else ''}: "
                  f"{type(e).__name__}: {e}", file=sys.stderr, flush=True)
            return ""

    text = _run(force_ocr=False)
    if text.strip():
        return text

    # ── No text layer. Scanned page, or genuinely empty? ────────────────────────
    has_images = _pdf_has_embedded_images(file_path)
    if has_images is False:
        # Truly nothing to read. Say so OUT LOUD — a returned "" used to become a silent skip.
        print(f"    no text layer AND no embedded images: {Path(file_path).name} — nothing to extract "
              f"(not a scan; OCR would return nothing either)", file=sys.stderr, flush=True)
        return ""

    why = "has embedded images" if has_images else "cannot determine (poppler unavailable) — failing TOWARD extraction"
    print(f"    no text layer, {why} -> OCR fall-through (tesseract, local, $0): {Path(file_path).name}",
          flush=True)
    text = _run(force_ocr=True)
    if text.strip():
        print(f"    OCR recovered {len(text.strip())} chars from a scanned PDF that would previously "
              f"have been SILENTLY DISCARDED", flush=True)
    else:
        print(f"    ⚠️ OCR ALSO RETURNED NOTHING for {Path(file_path).name} — this document is being "
              f"dropped, and you are being TOLD, rather than it vanishing quietly", file=sys.stderr, flush=True)
    return text


class GatewayUnavailable(RuntimeError):
    """The ai-gateway could not be reached or refused the call.

    Raised — never swallowed — so a gateway outage FAILS CLOSED and LOUD. The alternative (returning
    '' and letting ingest_image print "SKIP (no description produced)") would be a silent drop: the
    ingest reports success, the image is never indexed, and nobody finds out. A silent skip is the
    failure mode this whole rewire exists to eliminate, so it must not be reintroduced as the
    rewire's own error path.
    """


# ai-gateway — the ONLY route to a model. Standing fleet architecture rule (Steve, 2026-07-11):
# every model call goes through the gateway (central key, per-app AED budget with a hard 429, JSONL
# audit). NEVER api.anthropic.com directly; NEVER a per-service Anthropic key — a direct call is
# uncappable and unaudited, which is exactly what this path used to be.
AI_GATEWAY_URL = os.environ.get("AI_GATEWAY_URL", "http://127.0.0.1:7115/v1/messages")
# KB ingest has its OWN principal, not the invoking agent's: image spend is attributed to the KB
# service, not to whichever agent happened to trigger the ingest (chief/analyst/writer all call
# kb-ingest). Keeps the gateway's per-app budget meaningful. Grant: ai-gateway:call, nothing else.
AI_GATEWAY_CALLER_ID = os.environ.get("AI_GATEWAY_CALLER_ID", "kb-ingest")


def _mint_gateway_token(ttl_seconds=60):
    """Mint a short-lived RBAC token via the foundry rbac lib — the SAME issuer `bus foundry` uses.

    Shelling out to node is deliberate: re-implementing the token signing in Python would be a
    SECOND implementation of the auth contract, free to drift from the one the gateway validates
    against. One issuer, one contract. The token is per-call, 60s, never persisted.
    """
    import subprocess
    framework_root = os.environ.get("CTX_FRAMEWORK_ROOT", "/home/cortext/cortextos")
    org = os.environ.get("CTX_ORG", "silvermere-tech")
    rbac_lib = os.path.join(framework_root, "orgs", org, "projects", "foundry", "lib", "rbac")
    if not os.environ.get("FOUNDRY_TOKEN_SECRET"):
        raise GatewayUnavailable(
            "FOUNDRY_TOKEN_SECRET not in env — cannot mint an ai-gateway token. "
            "(It lives in orgs/<org>/secrets.env and is spread into the KB env by the bus.)")
    script = (
        "const rbac=require(process.argv[1]);"
        "process.stdout.write(rbac.issueAgentToken({caller_id:process.argv[2],"
        "tenant_id:process.argv[3],ttl_seconds:parseInt(process.argv[4],10)}));"
    )
    try:
        proc = subprocess.run(
            ["node", "-e", script, rbac_lib, AI_GATEWAY_CALLER_ID, org, str(ttl_seconds)],
            capture_output=True, text=True, timeout=20,
        )
    except Exception as e:
        raise GatewayUnavailable(f"could not mint gateway token: {type(e).__name__}: {e}")
    if proc.returncode != 0 or not proc.stdout.strip():
        raise GatewayUnavailable(
            f"token issuance failed (rc={proc.returncode}): {(proc.stderr or '').strip()[:200]}")
    return proc.stdout.strip()


def describe_image_claude(file_path):
    """Describe an image via Claude Vision (Haiku) **through the ai-gateway**.

    Returns (description_text, usage). `usage` is read from the GATEWAY'S RETURNED RESPONSE (the
    gateway proxies Anthropic's response verbatim, usage block included) — NOT from a count this
    module makes itself. That distinction is the whole point: the gateway's budget/audit and this
    ledger then read ONE measurement, so they cannot disagree. A locally-derived count would be a
    second accounting path, which is precisely what the metering meta-spec forbids.

    Raises GatewayUnavailable if the gateway is unreachable or refuses. There is deliberately NO
    fallback to a direct Anthropic key: a fallback would silently restore the uncapped, unaudited
    path this rewire removed, and it would do so exactly when the cap was least able to stop it.
    """
    import base64
    import json as _json
    import urllib.request
    import urllib.error
    mime = mimetypes.guess_type(str(file_path))[0] or "image/png"
    try:
        with open(file_path, "rb") as f:
            b64 = base64.standard_b64encode(f.read()).decode("utf-8")
    except Exception as e:
        print(f"    image read error: {e}", file=sys.stderr, flush=True)
        return "", {}
    model = os.environ.get("CLAUDE_VISION_MODEL", "claude-haiku-4-5")
    body = {
        "model": model,
        "max_tokens": 1024,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": mime, "data": b64}},
                {"type": "text", "text": (
                    "Describe this image thoroughly for search and retrieval. Include: any "
                    "visible text (transcribe it verbatim), what the image depicts, key "
                    "objects, people, charts, diagrams or tables, and the overall topic. Be "
                    "factual and specific; do not speculate beyond what is visible."
                )},
            ],
        }],
    }
    for attempt, backoff in enumerate((0, 5, 15), start=1):
        if backoff:
            time.sleep(backoff)
        # Fresh 60s token per attempt — a retry after a backoff must not present a token minted
        # before the previous attempt's wait (it could have expired mid-retry).
        token = _mint_gateway_token()
        req = urllib.request.Request(
            AI_GATEWAY_URL,
            data=_json.dumps(body).encode("utf-8"),
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {token}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                data = _json.loads(resp.read().decode("utf-8"))
            # The gateway returns Anthropic's response VERBATIM, usage block included. Reading the
            # counts from THIS response (rather than counting locally) is what keeps the ledger and
            # the gateway's budget/audit reading ONE measurement — no second accounting path.
            u = data.get("usage", {}) or {}
            # Prefer the model id the API RESOLVED (`data["model"]` — the dated
            # `claude-haiku-4-5-20251001`) over the alias we requested (`claude-haiku-4-5`). The
            # served id is the only one reconcilable against a provider invoice; the alias silently
            # re-points when Anthropic rolls a version, which would leave the ledger asserting a
            # model that never ran.
            usage = {"input_tokens": u.get("input_tokens", 0), "output_tokens": u.get("output_tokens", 0),
                     "model": data.get("model") or model}
            parts = [b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"]
            return "\n".join(p for p in parts if p).strip(), usage
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:200]
            # 429 from the gateway is the BUDGET CAP, not an Anthropic rate-limit. Retrying it is
            # pointless (the cap will not lift in 15s) and semantically wrong — the correct response
            # to "you are over budget" is to stop, loudly.
            if e.code == 429 and "budget" in detail.lower():
                raise GatewayUnavailable(f"ai-gateway budget cap hit (429): {detail}")
            if e.code in (401, 403):
                raise GatewayUnavailable(
                    f"ai-gateway refused the call (HTTP {e.code}): {detail} — "
                    f"caller_id={AI_GATEWAY_CALLER_ID} likely lacks ai-gateway:call")
            if e.code in (429, 500, 502, 503, 529) and attempt < 3:
                print(f"    ai-gateway transient HTTP {e.code}; retrying", file=sys.stderr, flush=True)
                continue
            raise GatewayUnavailable(f"ai-gateway HTTP {e.code}: {detail}")
        except GatewayUnavailable:
            raise                       # already a hard, loud failure — do not retry-swallow it
        except urllib.error.URLError as e:
            # Gateway process down / connection refused. FAIL CLOSED. The old code fell back to a
            # direct Anthropic key here; that fallback is exactly what made this path uncappable, so
            # it is gone. A KB image ingest now fails loudly rather than quietly buying an
            # unbudgeted, unaudited call.
            if attempt < 3:
                print(f"    ai-gateway unreachable ({e.reason}); retrying", file=sys.stderr, flush=True)
                continue
            raise GatewayUnavailable(
                f"ai-gateway unreachable at {AI_GATEWAY_URL}: {e.reason}. "
                f"FAILING CLOSED — no direct-key fallback by design (uncapped + unaudited).")
        except Exception as e:
            if attempt < 3:
                print(f"    ai-gateway transient error ({type(e).__name__}); retrying", file=sys.stderr, flush=True)
                continue
            raise GatewayUnavailable(f"ai-gateway call failed: {type(e).__name__}: {e}")
    raise GatewayUnavailable("ai-gateway call failed after all retries")


def ingest_image(client, config, collection, file_path):
    """Ingest an image. NONTEXT_BACKEND='gemini' (default): Gemini Flash describes it,
    then embed description + raw image together. NONTEXT_BACKEND='deterministic':
    Claude Vision (Haiku) describes it, then embed the description as text (no Gemini)."""
    file_path = Path(file_path)
    doc_id = file_id(file_path)

    with open(file_path, "rb") as _f:
        file_hash = compute_hash(_f.read())

    if should_skip(collection, doc_id, file_hash):
        print(f"  SKIP (exists, unchanged): {file_path}")
        return 0

    if NONTEXT_BACKEND == "deterministic":
        print(f"  Describing image via Claude Vision: {file_path.name}...")
        description, vusage = describe_image_claude(file_path)
        if not description.strip():
            print(f"  SKIP (no description produced): {file_path}")
            return 0
        # Record the real Haiku vision cost (was a $0 blind-spot) — priced separately
        # from Gemini generation; feeds the usage/metering ledger.
        if _tracker and vusage:
            _tracker.track_vision(vusage.get("input_tokens", 0), vusage.get("output_tokens", 0),
                                  model=vusage.get("model"))
        # Text-only embed through the normal path (local nomic when EMBEDDING_BACKEND=local).
        embedding = embed_content(client, config, description)
        mime = mimetypes.guess_type(str(file_path))[0] or "image/png"
    else:
        print(f"  Generating description for {file_path.name}...")
        description, media_bytes, mime = describe_media(client, config, file_path, "image")
        # Option B: embed text description + raw image together
        try:
            embedding = embed_multimodal(client, config, description, media_bytes, mime)
        except Exception:
            # Fallback to text-only embedding if multimodal fails (e.g., file too large)
            embedding = embed_content(client, config, description)

    collection.upsert(
        ids=[doc_id],
        embeddings=[embedding],
        documents=[description],
        metadatas=[{
            "source": str(file_path.resolve()),
            "type": "image",
            "filename": file_path.name,
            "file_ext": file_path.suffix.lower(),
            "mime_type": mime,
            "content_hash": file_hash,
            "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }],
    )
    return 1


def extract_audio_from_video(video_path, output_path):
    """Extract audio track from a video file as mp3."""
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(video_path),
         "-vn", "-acodec", "libmp3lame", "-q:a", "4",
         str(output_path)],
        capture_output=True,
    )
    return Path(output_path).exists()


def ingest_video(client, config, collection, file_path):
    """Ingest a video: chunk it, describe each chunk, embed.

    For large videos (chunks > 20MB), falls back to audio-only extraction
    since the video bytes would be too large for the embedding API.
    For small chunks, uses full multimodal embedding (description + video).
    """
    file_path = Path(file_path)
    size_mb = file_path.stat().st_size / (1024 * 1024)
    duration = get_media_duration(file_path)

    if duration <= 0:
        print(f"  SKIP (unreadable/zero duration): {file_path}")
        return 0

    print(f"  Video: {file_path.name} ({size_mb:.0f}MB, {duration:.0f}s)")

    # Chunk the video
    chunk_secs = config.get("video_chunk_seconds", DEFAULT_VIDEO_CHUNK_SECONDS)
    overlap_secs = config.get("video_overlap_seconds", DEFAULT_VIDEO_OVERLAP_SECONDS)

    print(f"  Chunking into {chunk_secs}s segments with {overlap_secs}s overlap...")
    chunks = chunk_video(file_path, chunk_seconds=chunk_secs, overlap_seconds=overlap_secs)
    total_chunks = len(chunks)
    print(f"  Created {total_chunks} chunks")

    count = 0
    for chunk in chunks:
        doc_id = file_id(file_path, chunk["index"])
        chunk_path = Path(chunk["path"])
        # Hash the chunk file bytes — if the source video changes, ffmpeg
        # produces different chunk bytes and we re-process.
        chunk_hash = compute_hash(chunk_path.read_bytes()) if chunk_path.exists() else compute_hash(
            f"{file_path}:{chunk['index']}"
        )
        if should_skip(collection, doc_id, chunk_hash):
            continue

        chunk_size_mb = chunk_path.stat().st_size / (1024 * 1024) if chunk_path.exists() else 0

        print(f"  Chunk {chunk['index'] + 1}/{total_chunks} "
              f"({chunk['start']:.0f}s-{chunk['end']:.0f}s, {chunk_size_mb:.1f}MB)")

        description = None
        media_bytes = None
        mime = None

        # Strategy: try video description first, fall back to audio-only for large chunks
        if chunk_size_mb <= 20:
            # Small enough for full video analysis
            try:
                description, media_bytes, mime = describe_media(client, config, chunk_path, "video")
                print(f"    Described via video")
            except Exception as e:
                print(f"    Video description failed ({e}), trying audio...")

        if description is None:
            # Large chunk or video failed: extract audio and describe that
            audio_path = chunk_path.with_suffix(".mp3")
            if not audio_path.exists():
                print(f"    Extracting audio track...")
                extract_audio_from_video(chunk_path, audio_path)

            if audio_path.exists() and audio_path.stat().st_size > 0:
                try:
                    description, media_bytes, mime = describe_media(client, config, audio_path, "audio")
                    # Prefix so the agent knows this came from a video's audio
                    description = (
                        f"[Audio extracted from video: {file_path.name}, "
                        f"{chunk['start']:.0f}s-{chunk['end']:.0f}s]\n\n{description}"
                    )
                    print(f"    Described via audio extraction")
                except Exception as e:
                    print(f"    Audio description also failed: {e}")

        if description is None:
            description = (
                f"Video chunk from {file_path.name}, "
                f"{chunk['start']:.0f}s to {chunk['end']:.0f}s. "
                f"(Description unavailable - file may be too large or corrupted)"
            )

        # Embed: try multimodal if we have small media bytes, else text-only
        if media_bytes and mime and len(media_bytes) < 20 * 1024 * 1024:
            try:
                embedding = embed_multimodal(client, config, description, media_bytes, mime)
            except Exception:
                embedding = embed_content(client, config, description)
        else:
            embedding = embed_content(client, config, description)

        collection.upsert(
            ids=[doc_id],
            embeddings=[embedding],
            documents=[description],
            metadatas=[{
                "source": str(file_path.resolve()),
                "type": "video_chunk",
                "chunk_index": chunk["index"],
                "total_chunks": total_chunks,
                "chunk_start_seconds": chunk["start"],
                "chunk_end_seconds": chunk["end"],
                "chunk_path": str(chunk_path),
                "filename": file_path.name,
                "file_ext": file_path.suffix.lower(),
                "duration_seconds": duration,
                "content_hash": chunk_hash,
                "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            }],
        )
        count += 1

    return count


def ingest_audio(client, config, collection, file_path):
    """Ingest audio: chunk if needed, describe, embed description + audio together."""
    file_path = Path(file_path)
    duration = get_media_duration(file_path)
    if duration <= 0:
        print(f"  SKIP (unreadable/zero duration): {file_path}")
        return 0
    max_chunk = config.get("audio_chunk_seconds", DEFAULT_AUDIO_CHUNK_SECONDS)

    if duration <= max_chunk:
        # Short enough to process as one piece
        doc_id = file_id(file_path)
        with open(file_path, "rb") as _f:
            file_hash = compute_hash(_f.read())
        if should_skip(collection, doc_id, file_hash):
            print(f"  SKIP (exists, unchanged): {file_path}")
            return 0

        print(f"  Transcribing {file_path.name}...")
        description, media_bytes, mime = describe_media(client, config, file_path, "audio")

        try:
            embedding = embed_multimodal(client, config, description, media_bytes, mime)
        except Exception:
            embedding = embed_content(client, config, description)

        collection.upsert(
            ids=[doc_id],
            embeddings=[embedding],
            documents=[description],
            metadatas=[{
                "source": str(file_path.resolve()),
                "type": "audio",
                "filename": file_path.name,
                "file_ext": file_path.suffix.lower(),
                "duration_seconds": duration,
                "content_hash": file_hash,
                "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            }],
        )
        return 1
    else:
        # Chunk the audio
        print(f"  Chunking audio: {file_path.name} ({duration:.0f}s)...")
        overlap = config.get("audio_overlap_seconds", DEFAULT_AUDIO_OVERLAP_SECONDS)
        chunks = chunk_audio(file_path, chunk_seconds=max_chunk, overlap_seconds=overlap)
        total_chunks = len(chunks)
        count = 0

        for chunk in chunks:
            doc_id = file_id(file_path, chunk["index"])
            chunk_path_obj = Path(chunk["path"])
            chunk_hash = compute_hash(chunk_path_obj.read_bytes()) if chunk_path_obj.exists() else compute_hash(
                f"{file_path}:{chunk['index']}"
            )
            if should_skip(collection, doc_id, chunk_hash):
                continue

            print(f"  Transcribing chunk {chunk['index'] + 1}/{total_chunks}...")
            try:
                description, media_bytes, mime = describe_media(client, config, chunk["path"], "audio")
            except Exception as e:
                print(f"  WARNING: Failed to transcribe chunk {chunk['index']}: {e}")
                description = f"Audio chunk from {file_path.name}, {chunk['start']:.0f}s to {chunk['end']:.0f}s"
                media_bytes = None
                mime = None

            if media_bytes and mime:
                try:
                    embedding = embed_multimodal(client, config, description, media_bytes, mime)
                except Exception:
                    embedding = embed_content(client, config, description)
            else:
                embedding = embed_content(client, config, description)

            collection.upsert(
                ids=[doc_id],
                embeddings=[embedding],
                documents=[description],
                metadatas=[{
                    "source": str(file_path.resolve()),
                    "type": "audio_chunk",
                    "chunk_index": chunk["index"],
                    "total_chunks": total_chunks,
                    "chunk_start_seconds": chunk["start"],
                    "chunk_end_seconds": chunk["end"],
                    "chunk_path": chunk["path"],
                    "filename": file_path.name,
                    "file_ext": file_path.suffix.lower(),
                    "content_hash": chunk_hash,
                    "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                }],
            )
            count += 1
        return count


def ingest_pdf(client, config, collection, file_path):
    """Ingest a PDF page-by-page using Gemini to extract content including visual elements."""
    file_path = Path(file_path)
    from google.genai import types

    with open(file_path, "rb") as f:
        data = f.read()

    file_hash = compute_hash(data)

    # Cheap early exit: if page-0 already has this content_hash, the PDF is
    # unchanged. Skips the (expensive) Gemini extraction call entirely.
    page0_id = file_id(file_path, 0)
    if should_skip(collection, page0_id, file_hash):
        print(f"  SKIP (unchanged PDF): {file_path}")
        return 0

    # Estimate page count (rough: ~3KB per page for typical PDFs, but varies wildly)
    # We'll ask Gemini to process the whole thing and get structured output
    # For PDFs > 6 pages, we chunk by asking for specific page ranges

    if NONTEXT_BACKEND == "deterministic":
        print(f"  Extracting PDF (deterministic/Kreuzberg): {file_path.name}...")
        text = extract_pdf_text_deterministic(file_path)
        if not text.strip():
            # OCR has ALREADY been attempted inside the extractor by this point (empty text
            # layer -> tesseract fall-through). Reaching here means BOTH passes found nothing.
            # This is now a LOUD, honest drop rather than the silent one that discarded scans.
            print(f"  DROPPED (no text layer AND OCR recovered nothing): {file_path}", file=sys.stderr)
            return 0
    else:
        print(f"  Analyzing PDF: {file_path.name}...")

        # Gemini Flash returns 503 UNAVAILABLE during high-demand windows. Without
        # retries, a single 503 kills the ingest. _retry_generate_content wraps the
        # call with bounded retries on transient SDK conditions (HTTP 429/500/503,
        # status UNAVAILABLE/RESOURCE_EXHAUSTED) and fails fast on everything else.
        extraction_prompt = (
            "Extract ALL content from this PDF. For each page, include:\n"
            "1. Page number\n"
            "2. All text content (headings, body, lists, footnotes)\n"
            "3. Description of any images, charts, diagrams, or tables\n"
            "4. Key concepts and topics on that page\n"
            "Separate each page's content with '=== PAGE N ===' markers.\n"
            "Be thorough - this will be used for search and retrieval."
        )
        response = _retry_generate_content(
            client,
            model=config.get("gemini_model", "gemini-2.5-flash"),
            contents=[
                types.Part.from_bytes(data=data, mime_type="application/pdf"),
                extraction_prompt,
            ],
        )
        if _tracker:
            _tracker.track_generation(response)
        text = response.text

    # Split by page markers if present, otherwise chunk normally
    pages = []
    if "=== PAGE" in text:
        import re
        page_splits = re.split(r'===\s*PAGE\s*\d+\s*===', text)
        pages = [p.strip() for p in page_splits if p.strip()]
    else:
        # No page markers - chunk as text
        pages = chunk_text(
            text,
            chunk_size=config.get("text_chunk_size", DEFAULT_TEXT_CHUNK_SIZE),
            overlap=config.get("text_chunk_overlap", DEFAULT_TEXT_CHUNK_OVERLAP),
        )

    # Filter pass: collect pages that need embedding (skip empty + Chroma-cached)
    pending = []
    for i, page_content in enumerate(pages):
        if not page_content.strip():
            continue
        doc_id = file_id(file_path, i)
        if should_skip(collection, doc_id, file_hash):
            continue
        pending.append((i, page_content, doc_id))

    if not pending:
        return 0

    # Batch embed
    pending_texts = [item[1] for item in pending]
    pending_embeddings = embed_contents_batch(client, config, pending_texts)

    # Bulk upsert
    ingested_at = time.strftime("%Y-%m-%dT%H:%M:%S")
    ids = [item[2] for item in pending]
    documents = [item[1] for item in pending]
    metadatas = [{
        "source": str(file_path.resolve()),
        "type": "pdf_page",
        "chunk_index": item[0],
        "total_chunks": len(pages),
        "page_number": item[0] + 1,
        "filename": file_path.name,
        "file_ext": ".pdf",
        "content_hash": file_hash,
        "ingested_at": ingested_at,
    } for item in pending]
    collection.upsert(
        ids=ids,
        embeddings=pending_embeddings,
        documents=documents,
        metadatas=metadatas,
    )
    return len(pending)


def extract_docx_text(file_path):
    """Extract text from .docx using python-docx."""
    from docx import Document
    doc = Document(str(file_path))
    parts = []
    for para in doc.paragraphs:
        if para.text.strip():
            style_name = para.style.name if para.style else ""
            if style_name.startswith("Heading"):
                level = style_name.replace("Heading ", "").strip()
                prefix = "#" * (int(level) if level.isdigit() else 1)
                parts.append(f"{prefix} {para.text}")
            else:
                parts.append(para.text)
    # Also extract tables
    for table in doc.tables:
        rows = []
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells]
            rows.append(" | ".join(cells))
        if rows:
            parts.append("\n".join(rows))
    return "\n\n".join(parts)


def extract_pptx_text(file_path):
    """Extract text from .pptx using python-pptx."""
    from pptx import Presentation
    prs = Presentation(str(file_path))
    slides = []
    for i, slide in enumerate(prs.slides):
        texts = [f"=== SLIDE {i+1} ==="]
        for shape in slide.shapes:
            if shape.has_text_frame:
                for para in shape.text_frame.paragraphs:
                    if para.text.strip():
                        texts.append(para.text)
            if shape.has_table:
                for row in shape.table.rows:
                    cells = [cell.text.strip() for cell in row.cells]
                    texts.append(" | ".join(cells))
        # Notes
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame:
            notes = slide.notes_slide.notes_text_frame.text.strip()
            if notes:
                texts.append(f"Speaker Notes: {notes}")
        slides.append("\n".join(texts))
    return "\n\n".join(slides)


def extract_xlsx_text(file_path):
    """Extract text from .xlsx using openpyxl."""
    from openpyxl import load_workbook
    wb = load_workbook(str(file_path), data_only=True)
    parts = []
    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        rows = []
        for row in ws.iter_rows(values_only=True):
            cells = [str(c) if c is not None else "" for c in row]
            if any(cells):
                rows.append(" | ".join(cells))
        if rows:
            parts.append(f"=== SHEET: {sheet_name} ===\n" + "\n".join(rows[:200]))  # cap at 200 rows
    return "\n\n".join(parts)


def ingest_office_doc(client, config, collection, file_path):
    """Ingest Office documents (.docx, .pptx, .xlsx) by extracting text locally."""
    file_path = Path(file_path)
    ext = file_path.suffix.lower()

    print(f"  Extracting content from {file_path.name}...")

    try:
        if ext in (".docx", ".doc"):
            text = extract_docx_text(file_path)
            type_name = "docx"
        elif ext in (".pptx", ".ppt"):
            text = extract_pptx_text(file_path)
            type_name = "slides"
        elif ext in (".xlsx", ".xls"):
            text = extract_xlsx_text(file_path)
            type_name = "spreadsheet"
        else:
            print(f"  SKIP (unsupported office format): {file_path}")
            return 0
    except Exception as e:
        print(f"  ERROR extracting {file_path.name}: {e}")
        return 0

    if not text.strip():
        print(f"  SKIP (empty document): {file_path}")
        return 0

    # Split presentations by slide markers, everything else by text chunks
    sections = []
    if type_name == "slides" and "=== SLIDE" in text:
        import re
        slide_splits = re.split(r'===\s*SLIDE\s*\d+\s*===', text)
        sections = [s.strip() for s in slide_splits if s.strip()]
    elif type_name == "spreadsheet" and "=== SHEET" in text:
        import re
        sheet_splits = re.split(r'===\s*SHEET:.*?===', text)
        sections = [s.strip() for s in sheet_splits if s.strip()]
    else:
        sections = chunk_text(
            text,
            chunk_size=config.get("text_chunk_size", DEFAULT_TEXT_CHUNK_SIZE),
            overlap=config.get("text_chunk_overlap", DEFAULT_TEXT_CHUNK_OVERLAP),
        )

    # Filter pass: collect sections that need embedding
    pending = []
    for i, section in enumerate(sections):
        if not section.strip():
            continue
        doc_id = file_id(file_path, i)
        section_hash = compute_hash(section)
        if should_skip(collection, doc_id, section_hash):
            continue
        pending.append((i, section, doc_id, section_hash))

    if not pending:
        return 0

    # Batch embed
    pending_texts = [item[1] for item in pending]
    pending_embeddings = embed_contents_batch(client, config, pending_texts)

    # Bulk upsert
    ingested_at = time.strftime("%Y-%m-%dT%H:%M:%S")
    ids = [item[2] for item in pending]
    documents = [item[1] for item in pending]
    metadatas = []
    for item in pending:
        meta = {
            "source": str(file_path.resolve()),
            "type": type_name,
            "chunk_index": item[0],
            "total_chunks": len(sections),
            "filename": file_path.name,
            "file_ext": ext,
            "content_hash": item[3],
            "ingested_at": ingested_at,
        }
        if type_name == "slides":
            meta["slide_number"] = item[0] + 1
        metadatas.append(meta)
    collection.upsert(ids=ids, embeddings=pending_embeddings, documents=documents, metadatas=metadatas)
    return len(pending)


# Global flag for --force re-ingestion
args_force = False


def ingest_file(client, config, collection, file_path):
    """Route a file to the appropriate ingest handler."""
    file_path = Path(file_path)
    ext = file_path.suffix.lower()

    # Skip common non-content files
    if file_path.name.lower() in SKIP_FILE_NAMES:
        return 0

    # Skip junk directories
    parts = set(file_path.parts)
    if parts & SKIP_DIR_NAMES:
        return 0

    # Skip text files > 10MB (likely generated/binary)
    size_mb = file_path.stat().st_size / (1024 * 1024)
    if ext in TEXT_EXTS and size_mb > 10:
        print(f"  SKIP (too large: {size_mb:.0f}MB): {file_path}")
        return 0
    if ext in IMAGE_EXTS and size_mb > 50:
        print(f"  SKIP (too large: {size_mb:.0f}MB): {file_path}")
        return 0
    if ext in DOC_EXTS and size_mb > 100:
        print(f"  SKIP (too large: {size_mb:.0f}MB): {file_path}")
        return 0

    if ext in VIDEO_EXTS:
        return ingest_video(client, config, collection, file_path)
    elif ext in AUDIO_EXTS:
        return ingest_audio(client, config, collection, file_path)
    elif ext in IMAGE_EXTS:
        return ingest_image(client, config, collection, file_path)
    elif ext == ".pdf":
        return ingest_pdf(client, config, collection, file_path)
    elif ext in DOC_EXTS:
        return ingest_office_doc(client, config, collection, file_path)
    elif ext in TEXT_EXTS:
        return ingest_text_file(client, config, collection, file_path)
    else:
        # Try as text for unknown extensions
        try:
            file_path.read_text(errors="strict")[:100]
            return ingest_text_file(client, config, collection, file_path)
        except (UnicodeDecodeError, Exception):
            print(f"  SKIP (binary/unsupported): {file_path}")
            return 0

# ---------------------------------------------------------------------------
# Post-ingest self-verify (truncation guard)
# ---------------------------------------------------------------------------
def _is_text_route(file_path):
    """Mirror ingest_file()'s routing: would this file be handled by
    ingest_text_file()? Only text-routed sources have index counts that
    chunk_text() can predict, so only they are self-verifiable. Kept in lockstep
    with ingest_file() (same skip sets, same ext gating, same size cap)."""
    file_path = Path(file_path)
    if not file_path.is_file():
        return False
    if file_path.name.lower() in SKIP_FILE_NAMES:
        return False
    if set(file_path.parts) & SKIP_DIR_NAMES:
        return False
    ext = file_path.suffix.lower()
    if ext in VIDEO_EXTS or ext in AUDIO_EXTS or ext in IMAGE_EXTS or ext in DOC_EXTS:
        return False
    if ext == ".pdf":
        return False
    size_mb = file_path.stat().st_size / (1024 * 1024)
    if ext in TEXT_EXTS:
        return size_mb <= 10  # ingest_file skips text files > 10MB
    # Unknown extension: ingest_file tries to read it as text — mirror that probe.
    try:
        file_path.read_text(errors="strict")[:100]
        return True
    except Exception:
        return False


def verify_indexed_counts(collection, config, sources):
    """Layer-3 acceptance guard, run as a STANDING check after every ingest.

    For each text source touched this run, independently RE-DERIVE the expected
    chunk count from the file via chunk_text() (the shared predicate — NOT the
    process's own "Added N" self-report, which would be circular) using the SAME
    resolved chunk config the ingest used, then count how many of that file's
    doc_ids (md5(path)+_chunk{i}) actually exist in the collection.

    Because the commit model is all-or-nothing PER FILE and doc_ids are keyed on
    THIS file's path+index, the collection must hold exactly N doc_ids for a
    COMPLETE run — regardless of how many were newly embedded vs deduped this run.
    actual < expected means chunks are missing (a kill mid-embed, or any silent
    under-persist). Returns True if ANY source is truncated (after printing every
    offender LOUD to stderr); False if all sources verify.
    """
    resolved_size = config.get("text_chunk_size", DEFAULT_TEXT_CHUNK_SIZE)
    resolved_overlap = config.get("text_chunk_overlap", DEFAULT_TEXT_CHUNK_OVERLAP)

    truncated = False
    checked = 0
    for src in sources:
        src = Path(src)
        try:
            text = src.read_text(errors="replace")
        except Exception as e:
            print(f"KB-INGEST VERIFY: cannot read {src}: {e}", file=sys.stderr)
            truncated = True
            continue
        expected_ids = [file_id(src, i)
                        for i in range(len(chunk_text(text, resolved_size, resolved_overlap)))]
        n_expected = len(expected_ids)
        if n_expected == 0:
            continue  # empty/whitespace file — nothing to index, nothing to verify
        got = collection.get(ids=expected_ids)
        m_indexed = len((got or {}).get("ids") or [])
        checked += 1
        if m_indexed < n_expected:
            print(f"KB-INGEST TRUNCATED: {src} indexed {m_indexed} != expected {n_expected}",
                  file=sys.stderr)
            truncated = True

    if not truncated and checked:
        print(f"Verify: {checked} text source(s) fully indexed (chunk counts match).")
    return truncated


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
def cmd_ingest(args):
    global args_force, _tracker
    args_force = getattr(args, 'force', False)
    _tracker = UsageTracker("ingest")

    config = load_config()
    # Lazy: the key is required only if a Gemini path is actually taken (see _LazyGenaiClient).
    # Under EMBEDDING_BACKEND=local + NONTEXT_BACKEND=deterministic no Gemini call happens,
    # so no key is needed — which is what makes retiring the key possible at all.
    client = _LazyGenaiClient(config)
    collection_name = args.collection or config.get("default_collection", "default")
    collection = get_chroma_collection(collection_name)

    if args_force:
        print(f"Force mode: will re-ingest existing files")

    total = 0
    skipped = 0
    errors = 0
    verify_sources = []  # text sources touched this run, for the post-verify pass

    # ---- Layers 1 + 2: interrupt / wall-clock timeout guard --------------
    # Progress state the interrupt handler reads to report WHAT was persisted vs
    # what was in-flight. `current` is set ONLY while a single file's
    # embed+upsert is executing (that's the commit-atomic unit — a kill there
    # persists nothing for it); it is cleared the instant the file completes.
    progress = {"start": time.time(), "done": 0, "total": 0, "current": None}
    # Pre-count the files so `done/total` is meaningful the moment a signal lands
    # (cheap directory re-walk; matches the same discovery the loop uses).
    for path_str in args.paths:
        p = Path(path_str).resolve()
        if p.is_dir():
            progress["total"] += sum(1 for f in p.rglob("*")
                                     if f.is_file() and not f.name.startswith("."))
        elif p.is_file():
            progress["total"] += 1

    def _on_interrupt(signum, frame):
        # GNU `timeout` sends SIGTERM by default; SIGALRM is our own --timeout
        # deadline; SIGINT is Ctrl-C. All three convert a would-be SILENT kill
        # into a LOUD, machine-greppable line + a distinct exit code (2).
        # NOTE: a Python signal handler only runs between bytecode ops, so if the
        # signal lands during the blocking ONNX embed C-call it fires when that
        # call returns (batch-group boundary), not instantly — still loud, just
        # granular. `-s KILL`/SIGKILL is uncatchable; layer 3 (verify) covers it.
        elapsed = time.time() - progress["start"]
        try:
            reason = signal.Signals(signum).name
        except Exception:
            reason = str(signum)
        sys.stderr.write(
            f"\nKB-INGEST INTERRUPTED after {elapsed:.0f}s: "
            f"{progress['done']}/{progress['total']} files persisted, "
            f"current='{progress['current']}' NOT persisted ({reason})\n"
        )
        sys.stderr.flush()
        # Raise SystemExit(2) on the main thread. It is NOT caught by the
        # per-file `except Exception` (SystemExit is BaseException), and the
        # outer `finally` still flushes the usage tracker on the way out.
        sys.exit(2)

    _prev_handlers = {}

    def _install(sig):
        try:
            _prev_handlers[sig] = signal.signal(sig, _on_interrupt)
        except (ValueError, OSError):
            pass  # not the main thread (e.g. under a test harness) — skip

    _install(signal.SIGTERM)
    _install(signal.SIGINT)
    timeout = getattr(args, "timeout", None)
    # --force disables the internal deadline: a full re-embed is legitimately long
    # (chief measured --force MEMORY.md at 8m18s) and must not be capped. The
    # default (600s) is a genuine-HANG catch for the routine DELTA path, NOT a
    # caller's cap adopted as the tool's own — L1 already covers a caller kill.
    if getattr(args, "force", False):
        timeout = None
    _alarm_armed = False
    if timeout and timeout > 0 and hasattr(signal, "SIGALRM"):
        # SIGALRM (not a per-file elapsed check) because it can fire BETWEEN
        # embed batch-groups within a single large file, not only at file
        # boundaries — strictly finer granularity, and it needs no polling.
        _install(signal.SIGALRM)
        signal.alarm(int(timeout))
        _alarm_armed = True
        print(f"Timeout armed: {int(timeout)}s wall-clock (SIGALRM -> loud exit 2 on deadline)")

    try:
        for path_str in args.paths:
            p = Path(path_str).resolve()
            if p.is_dir():
                files = sorted(f for f in p.rglob("*") if f.is_file() and not f.name.startswith("."))
                print(f"Ingesting directory: {p} ({len(files)} files)")
                for f in files:
                    print(f"  Processing: {f.relative_to(p)}")
                    progress["current"] = str(f)
                    try:
                        count = ingest_file(client, config, collection, f)
                        total += count
                        if _is_text_route(f):
                            verify_sources.append(f)
                        if count > 0:
                            print(f"    Added {count} chunk(s)")
                        elif count == 0:
                            skipped += 1
                        progress["done"] += 1
                    except Exception as e:
                        print(f"    ERROR: {e}")
                        errors += 1
                    finally:
                        progress["current"] = None
            elif p.is_file():
                print(f"Ingesting: {p.name}")
                progress["current"] = str(p)
                try:
                    count = ingest_file(client, config, collection, p)
                    total += count
                    if _is_text_route(p):
                        verify_sources.append(p)
                    if count > 0:
                        print(f"  Added {count} chunk(s)")
                    progress["done"] += 1
                except Exception as e:
                    print(f"  ERROR: {e}")
                    errors += 1
                finally:
                    progress["current"] = None
            else:
                print(f"NOT FOUND: {p}")
    finally:
        if _alarm_armed:
            signal.alarm(0)  # disarm — verify/persist must not be interrupted
        _tracker.persist()

    print(f"\nDone! Ingested {total} new chunk(s) into '{collection_name}'")
    if skipped:
        print(f"  Skipped: {skipped} (already existed or empty)")
    if errors:
        print(f"  Errors: {errors}")
    print(_tracker.summary_line())

    # ---- Layer 3: post-ingest self-verify (default ON; --no-verify off) ---
    # Runs only on files that ingested WITHOUT raising (errored files are
    # reported via the errors=1 path below and are deliberately not re-flagged
    # here). A truncation is louder and more specific than a per-file error, so
    # exit 3 takes precedence over exit 1.
    if not getattr(args, "no_verify", False):
        if verify_indexed_counts(collection, config, verify_sources):
            sys.exit(3)

    if errors:
        # Non-zero exit so the bus knowledge-base.ts wrapper can detect
        # per-file failures (e.g. Gemini 429 RESOURCE_EXHAUSTED on one file
        # of a multi-file ingest) and emit the kb/quota_skip structured event.
        # Without this, an "errors=N" summary printed alongside exit 0 silently
        # absorbs quota failures and the detector never fires.
        sys.exit(1)


def deduplicate_results(results, similarity_ratio=0.85):
    """Remove near-duplicate results based on content overlap."""
    if len(results) <= 1:
        return results

    deduped = [results[0]]
    for r in results[1:]:
        is_dup = False
        r_content = r["content"][:500]  # compare first 500 chars
        for existing in deduped:
            e_content = existing["content"][:500]
            # Quick overlap check: count shared words
            r_words = set(r_content.lower().split())
            e_words = set(e_content.lower().split())
            if not r_words or not e_words:
                continue
            overlap = len(r_words & e_words) / max(len(r_words), len(e_words))
            if overlap > similarity_ratio:
                is_dup = True
                break
        if not is_dup:
            deduped.append(r)
    return deduped


def cmd_query(args):
    global _tracker
    _tracker = UsageTracker("query")

    config = load_config()
    # Lazy: the key is required only if a Gemini path is actually taken (see _LazyGenaiClient).
    # Under EMBEDDING_BACKEND=local + NONTEXT_BACKEND=deterministic no Gemini call happens,
    # so no key is needed — which is what makes retiring the key possible at all.
    client = _LazyGenaiClient(config)
    collection_name = args.collection or config.get("default_collection", "default")
    collection = get_chroma_collection(collection_name)

    if collection.count() == 0:
        print("Knowledge base is empty. Ingest some files first.")
        return

    # Fetch extra results so we have room after filtering/dedup
    fetch_k = (args.top_k or 5) * 3
    threshold = args.threshold if args.threshold is not None else config.get("similarity_threshold", DEFAULT_SIMILARITY_THRESHOLD)
    max_tokens = args.max_tokens or config.get("max_tokens", DEFAULT_MAX_TOKENS)
    show_full = args.full
    type_filter = args.type  # e.g., "image", "video", "text", "pdf"

    query_embedding = embed_query(client, config, args.question)

    # Build ChromaDB where filter for type
    where_filter = None
    if type_filter:
        # Map user-friendly names to stored types
        type_map = {
            "image": {"type": "image"},
            "video": {"type": "video_chunk"},
            "text": {"type": "text"},
            "pdf": {"type": "pdf_page"},
            "audio": {"$or": [{"type": "audio"}, {"type": "audio_chunk"}]},
        }
        if type_filter in type_map:
            where_filter = type_map[type_filter]
        else:
            # Direct type match
            where_filter = {"type": type_filter}

    query_kwargs = {
        "query_embeddings": [query_embedding],
        "n_results": min(fetch_k, collection.count()),
        "include": ["documents", "metadatas", "distances"],
    }
    if where_filter:
        query_kwargs["where"] = where_filter

    try:
        results = collection.query(**query_kwargs)
    except Exception as e:
        # where filter might fail if no docs match - fall back to unfiltered
        if where_filter:
            del query_kwargs["where"]
            results = collection.query(**query_kwargs)
        else:
            raise

    # Filter by similarity threshold
    filtered = []
    if results["ids"] and results["ids"][0]:
        for i, doc_id in enumerate(results["ids"][0]):
            distance = results["distances"][0][i] if results["distances"] else 0
            similarity = 1 - distance
            if similarity >= threshold:
                filtered.append({
                    "id": doc_id,
                    "content": results["documents"][0][i] if results["documents"] else "",
                    "similarity": similarity,
                    "metadata": results["metadatas"][0][i] if results["metadatas"] else {},
                })

    # Deduplicate near-identical results (same file in multiple lesson folders)
    filtered = deduplicate_results(filtered)

    # Trim to requested top_k after dedup
    final_k = args.top_k or 5
    filtered = filtered[:final_k]

    # Apply max_tokens budget
    if max_tokens > 0:
        budgeted = []
        token_count = 0
        for r in filtered:
            chunk_tokens = len(r["content"]) // 4
            if token_count + chunk_tokens > max_tokens:
                remaining = max_tokens - token_count
                if remaining > 50:
                    r["content"] = r["content"][:remaining * 4] + "... [truncated]"
                    budgeted.append(r)
                break
            budgeted.append(r)
            token_count += chunk_tokens
        filtered = budgeted

    # Collect unique source files for the agent
    source_files = list(dict.fromkeys(
        r["metadata"].get("source", "") for r in filtered if r["metadata"].get("source")
    ))

    if args.json:
        output = {
            "query": args.question,
            "collection": collection_name,
            "result_count": len(filtered),
            "source_files": source_files,
            "results": [],
        }
        for r in filtered:
            meta = r["metadata"]
            entry = {
                "content": r["content"] if show_full else r["content"][:DEFAULT_PREVIEW_CHARS],
                "content_full_length": len(r["content"]),
                "similarity": round(r["similarity"], 4),
                "source": meta.get("source", ""),
                "type": meta.get("type", ""),
                "filename": meta.get("filename", ""),
            }
            # Add type-specific fields
            if meta.get("chunk_index") is not None:
                entry["chunk_index"] = meta["chunk_index"]
                entry["total_chunks"] = meta.get("total_chunks", 0)
            if meta.get("chunk_start_seconds") is not None:
                entry["time_start"] = meta["chunk_start_seconds"]
                entry["time_end"] = meta.get("chunk_end_seconds", 0)
            if meta.get("chunk_path"):
                entry["chunk_path"] = meta["chunk_path"]
            if meta.get("page_number"):
                entry["page_number"] = meta["page_number"]
            output["results"].append(entry)

        print(json.dumps(output, indent=2))
    else:
        print(f"Query: {args.question}")
        print(f"Collection: {collection_name}")
        print(f"Results: {len(filtered)} (threshold: {threshold})")
        if source_files:
            print(f"Source files ({len(source_files)}):")
            for sf in source_files:
                print(f"  - {sf}")
        print("-" * 60)

        if filtered:
            for i, r in enumerate(filtered):
                meta = r["metadata"]
                print(f"\n[{i+1}] Similarity: {r['similarity']:.3f}")
                print(f"    Source: {meta.get('source', 'unknown')}")
                print(f"    Type: {meta.get('type', 'unknown')}")
                if meta.get("chunk_index") is not None:
                    print(f"    Chunk: {meta['chunk_index'] + 1}/{meta.get('total_chunks', '?')}")
                if meta.get("chunk_start_seconds") is not None:
                    print(f"    Time: {meta['chunk_start_seconds']:.0f}s - {meta.get('chunk_end_seconds', 0):.0f}s")
                if meta.get("chunk_path"):
                    print(f"    Chunk file: {meta['chunk_path']}")
                if meta.get("page_number"):
                    print(f"    Page: {meta['page_number']}")

                content = r["content"]
                if not show_full and len(content) > DEFAULT_PREVIEW_CHARS:
                    content = content[:DEFAULT_PREVIEW_CHARS] + f"... [{len(r['content'])} chars total, use --full to see all]"
                print(f"    Content: {content}")
        else:
            print("No results above similarity threshold.")

    _tracker.persist()


def cmd_usage(args):
    """Show token usage and cost summary."""
    if args.reset:
        if USAGE_FILE.exists():
            USAGE_FILE.unlink()
        print("Usage data reset.")
        return

    if not USAGE_FILE.exists():
        print("No usage data yet. Run an ingest or query first.")
        return

    with open(USAGE_FILE) as f:
        data = json.load(f)

    if args.json:
        print(json.dumps(data, indent=2))
        return

    c = data.get("cumulative", {})
    sessions = data.get("sessions", [])

    # Cost components are summed from per-session cost dicts (era-aware: local-backend
    # sessions persisted $0 embedding), NOT recomputed from cumulative tokens at the
    # Gemini rate — cumulative tokens mix billed (gemini) + free (local) eras.
    # Fall back to a Gemini-rate token estimate only for legacy sessions with no cost dict.
    emb_cost = gen_in_cost = gen_out_cost = vis_cost = 0.0
    for s in sessions:
        sc = s.get("cost")
        if sc:
            emb_cost += sc.get("embedding", 0)
            gen_in_cost += sc.get("generation_input", 0)
            gen_out_cost += sc.get("generation_output", 0)
            vis_cost += sc.get("vision_input", 0) + sc.get("vision_output", 0)
        else:
            emb_cost += (s.get("embedding_tokens", 0) / 1_000_000) * EMBEDDING_PRICE_PER_M
            gen_in_cost += (s.get("generation_input_tokens", 0) / 1_000_000) * FLASH_INPUT_PRICE_PER_M
            gen_out_cost += (s.get("generation_output_tokens", 0) / 1_000_000) * FLASH_OUTPUT_PRICE_PER_M
            vis_cost += (s.get("vision_input_tokens", 0) / 1_000_000) * VISION_INPUT_PRICE_PER_M
            vis_cost += (s.get("vision_output_tokens", 0) / 1_000_000) * VISION_OUTPUT_PRICE_PER_M
    total = emb_cost + gen_in_cost + gen_out_cost + vis_cost

    print("mmrag Usage Summary")
    print("=" * 40)
    print(f"Total cost:    ${total:.4f}")
    print(f"Total calls:   {c.get('embedding_calls', 0) + c.get('generation_calls', 0)} "
          f"({c.get('embedding_calls', 0)} embedding, {c.get('generation_calls', 0)} generation)")
    print()
    print("Token breakdown:")
    print(f"  Embedding:         {c.get('embedding_tokens', 0):>10,} tokens (est)  ${emb_cost:.4f}")
    print(f"  Generation input:  {c.get('generation_input_tokens', 0):>10,} tokens        ${gen_in_cost:.4f}")
    print(f"  Generation output: {c.get('generation_output_tokens', 0):>10,} tokens        ${gen_out_cost:.4f}")
    print()
    print(f"Sessions: {len(sessions)}")
    if sessions:
        last = sessions[-1]
        print(f"  Last: {last.get('operation', '?')} @ {last.get('finished_at', '?')} "
              f"(${last.get('cost', {}).get('total', 0):.4f})")

    # Per-day breakdown from sessions
    by_day = {}
    for s in sessions:
        day = s.get("started_at", "")[:10]
        if day:
            by_day.setdefault(day, {"cost": 0, "count": 0})
            by_day[day]["cost"] += s.get("cost", {}).get("total", 0)
            by_day[day]["count"] += 1

    if by_day:
        print()
        print("Daily breakdown:")
        for day in sorted(by_day.keys(), reverse=True)[:7]:
            d = by_day[day]
            print(f"  {day}:  ${d['cost']:.4f} ({d['count']} sessions)")


def cmd_status(args):
    config = load_config()
    collection_name = args.collection or config.get("default_collection", "default")

    try:
        collection = get_chroma_collection(collection_name)
        count = collection.count()
    except Exception:
        count = 0

    print(f"Collection: {collection_name}")
    print(f"Total chunks: {count}")
    print(f"Data dir: {MMRAG_DIR}")
    print(f"ChromaDB: {CHROMADB_DIR}")
    print(f"Config: {CONFIG_FILE}")

    # Show config values
    print(f"\nChunk settings:")
    print(f"  Text: {config.get('text_chunk_size', DEFAULT_TEXT_CHUNK_SIZE)} chars, {config.get('text_chunk_overlap', DEFAULT_TEXT_CHUNK_OVERLAP)} overlap")
    print(f"  Video: {config.get('video_chunk_seconds', DEFAULT_VIDEO_CHUNK_SECONDS)}s, {config.get('video_overlap_seconds', DEFAULT_VIDEO_OVERLAP_SECONDS)}s overlap")
    print(f"  Audio: {config.get('audio_chunk_seconds', DEFAULT_AUDIO_CHUNK_SECONDS)}s, {config.get('audio_overlap_seconds', DEFAULT_AUDIO_OVERLAP_SECONDS)}s overlap")
    print(f"  Embedding dims: {config.get('embedding_dimensions', DEFAULT_EMBEDDING_DIMENSIONS)}")

    if count > 0:
        all_data = collection.get(include=["metadatas"])
        types_map = {}
        sources = set()
        for meta in all_data["metadatas"]:
            t = meta.get("type", "unknown")
            types_map[t] = types_map.get(t, 0) + 1
            sources.add(meta.get("source", "unknown"))

        print(f"\nUnique sources: {len(sources)}")
        print("Type breakdown:")
        for t, c in sorted(types_map.items()):
            print(f"  {t}: {c} chunks")


def cmd_list(args):
    config = load_config()
    collection_name = args.collection or config.get("default_collection", "default")

    try:
        collection = get_chroma_collection(collection_name)
    except Exception:
        print("No data found.")
        return

    all_data = collection.get(include=["metadatas"])
    if not all_data["ids"]:
        print("No documents in collection.")
        return

    # Group by source
    by_source = {}
    for meta in all_data["metadatas"]:
        src = meta.get("source", "unknown")
        if src not in by_source:
            by_source[src] = {"type": meta.get("type", "unknown"), "chunks": 0,
                              "filename": meta.get("filename", "")}
        by_source[src]["chunks"] += 1

    print(f"Collection: {collection_name} ({len(by_source)} files, {len(all_data['ids'])} chunks)")
    print(f"{'Source':<60} {'Type':<15} {'Chunks':<8}")
    print("-" * 85)
    for src, info in sorted(by_source.items()):
        display = src if len(src) <= 58 else "..." + src[-55:]
        print(f"{display:<60} {info['type']:<15} {info['chunks']:<8}")


def cmd_collections(args):
    chroma = get_chroma_client()
    collections = chroma.list_collections()
    if not collections:
        print("No collections found.")
        return
    # Total-first + total-last: a truncated capture (pipe, exec buffer, screen)
    # self-announces instead of reading as a complete list. 2026-07-22: an
    # 8-of-26 read of this output caused a fleet-wide false alarm — the defect
    # was the SILENCE of the truncation, wherever it happened.
    print(f"Collections: {len(collections)} total")
    print(f"{'Collection':<30} {'Documents':<12}")
    print("-" * 44)
    shown = 0
    for c in collections:
        name = c.name if hasattr(c, 'name') else c
        try:
            col = chroma.get_collection(name)
            print(f"{name:<30} {col.count():<12}")
        except Exception as e:  # one bad collection must not silently end the list
            print(f"{name:<30} ERROR: {type(e).__name__}: {e}")
        shown += 1
    if shown != len(collections):
        print(f"WARNING: listed {shown} of {len(collections)} collections")
    print(f"({shown} of {len(collections)} collections listed)")


def cmd_delete(args):
    config = load_config()
    collection_name = args.collection or config.get("default_collection", "default")
    collection = get_chroma_collection(collection_name)

    source_path = str(Path(args.path).resolve())
    all_data = collection.get(include=["metadatas"])

    ids_to_delete = []
    for i, meta in enumerate(all_data["metadatas"]):
        if meta.get("source") == source_path:
            ids_to_delete.append(all_data["ids"][i])

    if not ids_to_delete:
        print(f"No documents found for: {source_path}")
        return

    collection.delete(ids=ids_to_delete)
    print(f"Deleted {len(ids_to_delete)} chunk(s) from '{collection_name}' for: {source_path}")


def cmd_backfill_hashes(args):
    """Backfill content_hash metadata on existing collection records using
    the documents already stored in chromadb — ZERO embed calls. Idempotent:
    re-runs skip records that already have a content_hash."""
    collection_name = args.collection
    if not collection_name:
        config = load_config()
        collection_name = config.get("default_collection", "default")

    collection = get_chroma_collection(collection_name)
    all_records = collection.get(include=["documents", "metadatas"])
    ids = all_records.get("ids") or []
    documents = all_records.get("documents") or []
    metadatas = all_records.get("metadatas") or []

    update_ids = []
    update_metas = []
    skipped = 0

    for i, doc_id in enumerate(ids):
        meta = (metadatas[i] if i < len(metadatas) else None) or {}
        if meta.get("content_hash"):
            skipped += 1
            continue
        doc = documents[i] if i < len(documents) else ""
        if doc is None:
            doc = ""
        meta["content_hash"] = compute_hash(doc)
        update_ids.append(doc_id)
        update_metas.append(meta)

    if update_ids:
        # chromadb.update accepts arrays; do it in batches to be safe on
        # collections with tens of thousands of records.
        batch = 500
        for start in range(0, len(update_ids), batch):
            collection.update(
                ids=update_ids[start:start + batch],
                metadatas=update_metas[start:start + batch],
            )

    print(
        f"Backfill complete on '{collection_name}': "
        f"{len(update_ids)} record(s) backfilled, {skipped} already had content_hash."
    )


def cmd_reset(args):
    if not args.confirm:
        print("ERROR: Pass --confirm to reset the knowledge base.")
        return

    chroma = get_chroma_client()
    collections = chroma.list_collections()
    count = 0
    for c in collections:
        name = c.name if hasattr(c, 'name') else c
        chroma.delete_collection(name)
        count += 1

    import shutil
    if MEDIA_DIR.exists():
        shutil.rmtree(MEDIA_DIR)
        MEDIA_DIR.mkdir(parents=True)

    print(f"Reset complete. Deleted {count} collection(s) and cleared media cache.")

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    # RETIRED-DEFAULT GUARD (2026-07-22, narrow by design — missing-DEFAULT-dir only).
    # ~/.mmrag was a complete parallel decoy store nothing legitimate used; it cost
    # two wrong reads in one night, both of which SUCCEEDED with plausible values.
    # After its retirement, a bare invocation (no MMRAG_DIR env) must REFUSE with
    # the live path named — NOT silently recreate an empty store: measured before
    # this guard, `collections` against an absent default dir returned exit 0
    # "No collections found" and recreated the dir. An empty decoy is silent-wrong
    # with a fresher haircut. Explicit-env callers are untouched; a broad
    # try/except would swallow real errors and is deliberately not this.
    if "MMRAG_DIR" not in os.environ and not MMRAG_DIR.exists():
        sys.stderr.write(
            "REFUSED: the default store ~/.mmrag is RETIRED (2026-07-22) and this "
            "invocation set no MMRAG_DIR.\n"
            "Live stores resolve per-org via the bus env: use `cortextos bus kb-query|kb-ingest ...`,\n"
            "or set MMRAG_DIR explicitly, e.g.\n"
            "  MMRAG_DIR=~/.cortextos/default/orgs/<org>/knowledge-base "
            "knowledge-base/venv/bin/python3 knowledge-base/scripts/mmrag.py ...\n"
        )
        sys.exit(2)
    parser = argparse.ArgumentParser(
        description="Multimodal RAG Knowledge Base CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", help="Command to run")

    # ingest
    p_ingest = sub.add_parser("ingest", help="Ingest files into the knowledge base")
    p_ingest.add_argument("paths", nargs="+", help="File or directory paths to ingest")
    p_ingest.add_argument("--collection", "-c", help="Collection name (default: 'default')")
    p_ingest.add_argument("--force", action="store_true", help="Re-ingest files even if already in the KB")
    p_ingest.add_argument("--timeout", type=int, default=600, metavar="SECONDS",
                          help="Abort the run after N seconds wall-clock (SIGALRM); loud stderr + exit 2. "
                               "Default 600s = a genuine-hang catch (NOT tuned to any caller's cap; L1 "
                               "handles caller kills). Auto-disabled under --force. Pass 0 to disable.")
    p_ingest.add_argument("--no-verify", action="store_true",
                          help="Disable the post-ingest self-verify. By default, after the run each "
                               "text source's indexed chunk count is checked against chunk_text(source); "
                               "a mismatch prints 'KB-INGEST TRUNCATED' and exits 3.")

    # query
    p_query = sub.add_parser("query", help="Query the knowledge base")
    p_query.add_argument("question", help="Question to ask")
    p_query.add_argument("--top-k", "-k", type=int, default=5, help="Max number of results (default: 5)")
    p_query.add_argument("--threshold", "-t", type=float, default=None,
                         help="Min similarity threshold 0.0-1.0 (default: 0.0, return all)")
    p_query.add_argument("--max-tokens", "-m", type=int, default=0,
                         help="Max total tokens in results (0=unlimited)")
    p_query.add_argument("--collection", "-c", help="Collection name")
    p_query.add_argument("--type", help="Filter by content type: image, video, text, pdf, audio")
    p_query.add_argument("--json", "-j", action="store_true", help="Output as JSON (for agent consumption)")
    p_query.add_argument("--full", "-f", action="store_true", help="Show full content (not truncated)")

    # status
    p_status = sub.add_parser("status", help="Show knowledge base status")
    p_status.add_argument("--collection", "-c", help="Collection name")

    # list
    p_list = sub.add_parser("list", help="List ingested documents")
    p_list.add_argument("--collection", "-c", help="Collection name")

    # collections
    sub.add_parser("collections", help="List all collections")

    # delete
    p_delete = sub.add_parser("delete", help="Delete a document by source path")
    p_delete.add_argument("path", help="Source file path to delete")
    p_delete.add_argument("--collection", "-c", help="Collection name")

    # backfill-hashes
    p_backfill = sub.add_parser(
        "backfill-hashes",
        help="Stamp content_hash on existing records using stored documents (no embed calls).",
    )
    p_backfill.add_argument("--collection", "-c", help="Collection name (default: from config)")

    # reset
    p_reset = sub.add_parser("reset", help="Reset the entire knowledge base")
    p_reset.add_argument("--confirm", action="store_true", help="Confirm reset")

    # usage
    p_usage = sub.add_parser("usage", help="Show token usage and cost summary")
    p_usage.add_argument("--json", "-j", action="store_true", help="Output as JSON")
    p_usage.add_argument("--reset", action="store_true", help="Reset usage data")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    commands = {
        "ingest": cmd_ingest,
        "query": cmd_query,
        "status": cmd_status,
        "list": cmd_list,
        "collections": cmd_collections,
        "delete": cmd_delete,
        "reset": cmd_reset,
        "usage": cmd_usage,
        "backfill-hashes": cmd_backfill_hashes,
    }

    commands[args.command](args)


if __name__ == "__main__":
    main()
