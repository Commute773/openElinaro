#!/usr/bin/env python3
"""
MLX Cache Server v10 — OpenAI-compatible local LLM server with speculative decoding.

Features:
- Speculative decoding with snapshot+restore+replay for hybrid attention models
- Perfect output quality (no ArraysCache contamination from rejected drafts)
- Checkpoint-based prefix caching for both main + draft models
- Force-empty think block (bypasses model thinking for fast inference)
- OpenAI-compatible /v1/chat/completions and /v1/embeddings

Architecture:
  Qwen3.5-27B uses hybrid attention: 48 linear_attention layers (ArraysCache,
  recurrent, non-trimmable) + 16 full_attention layers (KVCache, trimmable).

  The problem with standard speculative decoding:
  - _rewind_cache() calls trim_prompt_cache() which refuses if ANY entry is
    non-trimmable (ArraysCache.is_trimmable() returns False)
  - v7's monkey-patch trimmed only KVCache and skipped ArraysCache, but this
    left ArraysCache contaminated with rejected draft tokens → ~30% artifacts

  v8 fix: Custom speculative generation loop with snapshot+restore+replay:
  1. Before each draft+verify round, snapshot (deepcopy) all ArraysCache entries
  2. Run draft model for N tokens, then verify with main model
  3. After verification, RESTORE ArraysCache entries from snapshot
  4. Trim only KVCache entries for the rejected token count
  5. REPLAY accepted tokens through both models to correctly update ArraysCache
  This ensures ArraysCache never sees rejected tokens.

  Prefix caching:
  1. Save checkpoint after processing each prompt through both main + draft model
  2. Each request gets fresh deepcopy of checkpoint caches
  3. Generation cache is thrown away after each request

  Think suppression: Force-prefix assistant response with "<think>\\n</think>\\n".
"""

import argparse
import asyncio
import collections
import copy
import json
import os
import random
import sys
import time
import traceback
import uuid
from pathlib import Path
from textwrap import dedent
from typing import Optional, Union

# Request logging
REQUEST_LOG_DIR = Path.home() / ".openelinaro" / "logs" / "mlx-requests"
REQUEST_LOG_ENABLED = True
REQUEST_LOG_SKIP_HEADER = "x-mlx-no-log"

import mlx.core as mx
import mlx.nn as nn
import uvicorn
from fastapi import FastAPI, Request as RawRequest
from fastapi.responses import StreamingResponse, JSONResponse, HTMLResponse
from pydantic import BaseModel
from contextlib import asynccontextmanager

from mlx_lm.utils import load
from mlx_lm.models.cache import make_prompt_cache, KVCache, RotatingKVCache, ArraysCache
from mlx_lm.models import cache as cache_module
from mlx_lm.generate import generate_step, generation_stream
from mlx_lm.sample_utils import make_sampler
from mlx_lm.tokenizer_utils import TokenizerWrapper
from mlx_lm.models.qwen3_5 import create_attention_mask, create_ssm_mask

# --- Configuration ---
DEFAULT_MODEL_CACHE_ROOT = Path.home() / ".cache" / "mlx-models"
MODEL_PATH = os.getenv(
    "OPENELINARO_LOCAL_LLM_MODEL_PATH",
    str(DEFAULT_MODEL_CACHE_ROOT / "Qwen3.5-35B-A3B-4bit-textonly"),
)
DRAFT_MODEL_PATH = os.getenv(
    "OPENELINARO_LOCAL_LLM_DRAFT_MODEL_PATH",
    str(DEFAULT_MODEL_CACHE_ROOT / "Qwen3.5-0.8B-4bit-textonly"),
)
PREFILL_STEP_SIZE = int(os.getenv("MLX_PREFILL_STEP_SIZE", "512"))
NUM_DRAFT_TOKENS = int(os.getenv("MLX_NUM_DRAFT_TOKENS", "3"))  # Max draft tokens per speculative round
SPEC_DISABLE_THRESHOLD = 0.50  # Disable spec when acceptance < 50% (not worth the replay cost)
SPEC_WINDOW = 2                # Detect low acceptance in just 2 rounds (~140ms)
DEFAULT_HOST = os.getenv("OPENELINARO_LOCAL_LLM_HOST", "0.0.0.0")
DEFAULT_PORT = int(os.getenv("OPENELINARO_LOCAL_LLM_PORT", "8800"))

EMBEDDING_MODEL_NAME = "bge-small"
EMBEDDING_MODEL_REPO = "BAAI/bge-small-en-v1.5"

# Token IDs
EOS_TOKEN_IDS = {248046, 248044}  # <|im_end|>, <|endoftext|>
THINK_TOKEN_IDS = {248068, 248069}  # <think>, </think> — filter from output

# Model globals
model = None
draft_model = None
tokenizer = None
model_name = "qwen3.5-35b-a3b"

# Embedding model globals
embed_model = None
embed_tokenizer = None

# --- Multi-Slot LRU Checkpoint Cache ---
MAX_CACHE_SLOTS = int(os.getenv("MLX_CACHE_SLOTS", "6"))
MAX_PREFIX_SLOTS = int(os.getenv("MLX_PREFIX_CACHE_SLOTS", str(MAX_CACHE_SLOTS * 2)))
PREFIX_ANCHOR_GRANULARITY = int(os.getenv("MLX_PREFIX_ANCHOR_GRANULARITY", "16"))
PREFIX_ANCHOR_MIN_DELTA = int(os.getenv("MLX_PREFIX_ANCHOR_MIN_DELTA", "8"))
MIN_PREFIX_HIT = 4
# OrderedDict for LRU: each value is {'model_cache': ..., 'draft_cache': ..., 'tokens': [...]}
_cache_slots: collections.OrderedDict = collections.OrderedDict()
_prefix_slots: collections.OrderedDict = collections.OrderedDict()
_cache_lock = None


_slot_counter = 0


def _next_slot_id():
    """Generate a unique slot ID."""
    global _slot_counter
    _slot_counter += 1
    return f"slot-{_slot_counter:04d}"

# Tokenization cache
_last_chat_text: str = ""
_last_chat_tokens: list = []


# =====================================================================
# Lifespan
# =====================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    global model, draft_model, tokenizer, embed_model, embed_tokenizer, _cache_lock

    _cache_lock = asyncio.Lock()

    print(f"Loading main model from {MODEL_PATH}...")
    t0 = time.time()
    model, tokenizer = load(MODEL_PATH)
    if not isinstance(tokenizer, TokenizerWrapper):
        tokenizer = TokenizerWrapper(tokenizer)
    if mx.metal.is_available():
        max_rec = mx.device_info()["max_recommended_working_set_size"]
        mx.set_wired_limit(max_rec)
        print(f"Wired limit set to {max_rec / 1e9:.1f}GB")
    n_layers = len(model.layers)
    n_kv = sum(1 for l in model.layers if hasattr(l, 'self_attn') and
               not getattr(getattr(l.self_attn, 'attn', None), '__class__', type(None)).__name__.startswith('Linear'))
    print(f"Main model loaded in {time.time() - t0:.1f}s ({n_layers} layers)")

    print(f"Loading draft model from {DRAFT_MODEL_PATH}...")
    t1 = time.time()
    draft_model, _ = load(DRAFT_MODEL_PATH)
    n_draft_layers = len(draft_model.layers)
    print(f"Draft model loaded in {time.time() - t1:.1f}s ({n_draft_layers} layers)")

    print(f"Loading embedding model {EMBEDDING_MODEL_NAME}...")
    t2 = time.time()
    from mlx_embedding_models.embedding import EmbeddingModel
    from transformers import AutoTokenizer as ATok
    embed_model = EmbeddingModel.from_registry(EMBEDDING_MODEL_NAME)
    embed_tokenizer = ATok.from_pretrained(EMBEDDING_MODEL_REPO)
    _embed_texts(["warmup"])
    print(f"Embedding model loaded in {time.time() - t2:.1f}s")
    print(f"Server ready — speculative decoding v8 (num_draft={NUM_DRAFT_TOKENS}), snapshot+restore+replay.")

    yield
    print("Shutting down.")


app = FastAPI(lifespan=lifespan)


# =====================================================================
# Cache Utilities
# =====================================================================

def deepcopy_cache(cache_list):
    """Deep copy a cache list. Handles KVCache, ArraysCache, etc."""
    result = []
    for c in cache_list:
        if isinstance(c, KVCache):
            nc = KVCache()
            if c.keys is not None:
                nc.keys = mx.array(c.keys)
                nc.values = mx.array(c.values)
                nc.offset = c.offset
            result.append(nc)
        elif isinstance(c, ArraysCache):
            nc = ArraysCache(len(c.cache))
            # Qwen3.5 replaces ArraysCache entries instead of mutating them in
            # place, so sharing backing tensors across request-local clones is safe.
            nc.cache = list(c.cache)
            if c.left_padding is not None:
                nc.left_padding = mx.array(c.left_padding)
            if c.lengths is not None:
                nc.lengths = mx.array(c.lengths)
            result.append(nc)
        elif isinstance(c, RotatingKVCache):
            nc = RotatingKVCache(max_size=c.max_size, keep=getattr(c, 'keep', 0))
            if c.keys is not None:
                nc.keys = mx.array(c.keys)
                nc.values = mx.array(c.values)
                nc.offset = c.offset
                nc._idx = c._idx
            result.append(nc)
        else:
            result.append(copy.deepcopy(c))
    return result


def eval_cache(cache_list):
    """Materialize all cache arrays."""
    arrays = []
    for c in cache_list:
        if isinstance(c, KVCache):
            if c.keys is not None:
                arrays.extend([c.keys, c.values])
        elif isinstance(c, ArraysCache):
            arrays.extend([x for x in c.cache if x is not None])
        elif isinstance(c, RotatingKVCache):
            if c.keys is not None:
                arrays.extend([c.keys, c.values])
    if arrays:
        mx.eval(arrays)


def cache_nbytes(cache_list):
    """Estimate resident bytes held by a prompt cache."""
    total = 0
    for c in cache_list:
        if isinstance(c, (KVCache, RotatingKVCache)):
            if c.keys is not None:
                total += c.keys.nbytes + c.values.nbytes
        elif isinstance(c, ArraysCache):
            total += sum(a.nbytes for a in c.cache if a is not None)
            if c.left_padding is not None:
                total += c.left_padding.nbytes
            if c.lengths is not None:
                total += c.lengths.nbytes
    return int(total)


def prefill_tokens_model(tokens, cache, target_model):
    """Prefill tokens through a specific model, updating cache in place."""
    if not tokens:
        return
    arr = mx.array(tokens, dtype=mx.uint32)
    total = len(tokens)
    processed = 0

    while processed < total:
        n = min(PREFILL_STEP_SIZE, total - processed)
        chunk = arr[processed:processed + n]
        with mx.stream(generation_stream):
            target_model(chunk[None], cache=cache)
        eval_cache(cache)
        processed += n
        if processed < total:
            mx.clear_cache()


def find_common_prefix_length(a, b) -> int:
    n = min(len(a), len(b))
    for i in range(n):
        if a[i] != b[i]:
            return i
    return n


def _all_slot_views():
    """Yield (kind, container) pairs in lookup order."""
    return (("primary", _cache_slots), ("prefix", _prefix_slots))


def _move_slot_to_end(kind, key):
    container = _cache_slots if kind == "primary" else _prefix_slots
    container.move_to_end(key)


def _total_slot_count():
    return len(_cache_slots) + len(_prefix_slots)


def _total_slot_bytes():
    total = 0
    for _, container in _all_slot_views():
        for slot in container.values():
            total += cache_nbytes(slot["model_cache"]) + cache_nbytes(slot["draft_cache"])
    return total


def _find_exact_slot(slot_tokens):
    """Return the slot whose cached tokens exactly match slot_tokens."""
    slot_tokens = list(slot_tokens)
    for kind, container in _all_slot_views():
        for key, slot in container.items():
            if slot["tokens"] == slot_tokens:
                return kind, key, slot
    return None, None, None


def _find_longest_exact_prefix_slot(prompt_tokens):
    """Return the longest slot whose full token list is a prefix of prompt_tokens."""
    best_kind = None
    best_key = None
    best_slot = None
    best_len = 0

    for kind, container in _all_slot_views():
        for key, slot in container.items():
            slot_tokens = slot["tokens"]
            slot_len = len(slot_tokens)
            if slot_len <= best_len or slot_len > len(prompt_tokens):
                continue
            if prompt_tokens[:slot_len] == slot_tokens:
                best_kind = kind
                best_key = key
                best_slot = slot
                best_len = slot_len

    return best_kind, best_key, best_slot, best_len


def _find_longest_partial_slot(prompt_tokens):
    """Return the slot with the longest common prefix with prompt_tokens."""
    best_kind = None
    best_key = None
    best_slot = None
    best_common = 0

    for kind, container in _all_slot_views():
        for key, slot in container.items():
            common = find_common_prefix_length(slot["tokens"], prompt_tokens)
            if common > best_common:
                best_kind = kind
                best_key = key
                best_slot = slot
                best_common = common

    return best_kind, best_key, best_slot, best_common


def _pick_prefix_anchor_length(total_len, parent_len=0):
    """Choose a reusable exact-prefix checkpoint near the end of a slot."""
    if total_len <= parent_len:
        return 0

    anchor = (total_len // PREFIX_ANCHOR_GRANULARITY) * PREFIX_ANCHOR_GRANULARITY
    if anchor <= parent_len:
        return 0
    if total_len - anchor < PREFIX_ANCHOR_MIN_DELTA:
        return 0
    return anchor


def _prefill_tokens_both(tokens, model_cache, draft_cache, *, capture_points=None):
    """Prefill both models together and optionally capture checkpoints mid-way."""
    if not tokens:
        return {}

    arr = mx.array(tokens, dtype=mx.uint32)
    total = len(tokens)
    processed = 0
    capture_points = sorted(
        p for p in set(capture_points or []) if 0 < p < total
    )
    capture_idx = 0
    captured = {}

    while processed < total:
        remaining = total - processed
        next_span = remaining
        next_capture = capture_points[capture_idx] if capture_idx < len(capture_points) else None
        if next_capture is not None and processed < next_capture:
            next_span = min(next_span, next_capture - processed)

        n = min(PREFILL_STEP_SIZE, next_span)
        chunk = arr[processed:processed + n]

        with mx.stream(generation_stream):
            model(chunk[None], cache=model_cache)
            draft_model(chunk[None], cache=draft_cache)

        eval_cache(model_cache)
        eval_cache(draft_cache)
        processed += n

        if next_capture is not None and processed == next_capture:
            snapshot = (deepcopy_cache(model_cache), deepcopy_cache(draft_cache))
            eval_cache(snapshot[0])
            eval_cache(snapshot[1])
            captured[next_capture] = snapshot
            capture_idx += 1

        if processed < total:
            mx.clear_cache()

    return captured


def _normalize_capture_points(total_len, parent_len=0, extra_prefix_lengths=None):
    """Return sorted absolute checkpoint lengths to capture while prefilling."""
    capture_points = set()
    for prefix_len in extra_prefix_lengths or ():
        if parent_len < prefix_len < total_len:
            capture_points.add(prefix_len)

    anchor_len = _pick_prefix_anchor_length(total_len, parent_len)
    if parent_len < anchor_len < total_len:
        capture_points.add(anchor_len)

    return sorted(capture_points)


def _evict_one_slot(*, exclude_keys=()):
    """Evict the oldest slot, preferring keys not involved in the current request."""
    if len(_cache_slots) < MAX_CACHE_SLOTS:
        return

    exclude = set(exclude_keys)
    for key in list(_cache_slots.keys()):
        if key in exclude:
            continue
        evict_slot = _cache_slots.pop(key)
        print(f"[cache] evicting slot={key} ({len(evict_slot['tokens'])} tok)")
        return

    key, evict_slot = _cache_slots.popitem(last=False)
    print(f"[cache] evicting slot={key} ({len(evict_slot['tokens'])} tok)")


def _evict_one_prefix_slot():
    """Evict the oldest auxiliary prefix slot."""
    if len(_prefix_slots) < MAX_PREFIX_SLOTS:
        return

    key, evict_slot = _prefix_slots.popitem(last=False)
    print(f"[cache] evicting prefix={key} ({len(evict_slot['tokens'])} tok)")


def _store_slot(slot_tokens, model_cache, draft_cache, *, exclude_keys=()):
    """Insert a new persistent prompt slot, deduplicating exact token matches."""
    slot_tokens = list(slot_tokens)
    existing_kind, existing_key, existing_slot = _find_exact_slot(slot_tokens)
    if existing_slot is not None:
        _move_slot_to_end(existing_kind, existing_key)
        return existing_kind, existing_key, existing_slot, False

    _evict_one_slot(exclude_keys=exclude_keys)

    new_key = _next_slot_id()
    slot = {
        "model_cache": model_cache,
        "draft_cache": draft_cache,
        "tokens": slot_tokens,
    }
    _cache_slots[new_key] = slot
    return "primary", new_key, slot, True


def _store_prefix_slot(slot_tokens, model_cache, draft_cache):
    """Insert a reusable exact-prefix checkpoint."""
    slot_tokens = list(slot_tokens)
    existing_kind, existing_key, existing_slot = _find_exact_slot(slot_tokens)
    if existing_slot is not None:
        _move_slot_to_end(existing_kind, existing_key)
        return existing_kind, existing_key, existing_slot, False

    _evict_one_prefix_slot()

    new_key = _next_slot_id()
    slot = {
        "model_cache": model_cache,
        "draft_cache": draft_cache,
        "tokens": slot_tokens,
    }
    _prefix_slots[new_key] = slot
    return "prefix", new_key, slot, True


def _clone_slot_for_request(slot):
    """Create request-local working caches from a persistent slot."""
    working_model = deepcopy_cache(slot["model_cache"])
    working_draft = deepcopy_cache(slot["draft_cache"])
    eval_cache(working_model)
    eval_cache(working_draft)
    return working_model, working_draft


def _create_fresh_slot(slot_tokens, *, exclude_keys=(), extra_prefix_lengths=None, store_kind="primary"):
    """Create a fresh checkpoint by cold-prefilling slot_tokens from scratch."""
    slot_tokens = list(slot_tokens)
    existing_kind, existing_key, existing_slot = _find_exact_slot(slot_tokens)
    if existing_slot is not None:
        _move_slot_to_end(existing_kind, existing_key)
        return existing_kind, existing_key, existing_slot, 0.0, False

    t_cold = time.perf_counter()
    model_cache = make_prompt_cache(model)
    draft_cache = make_prompt_cache(draft_model)
    capture_points = _normalize_capture_points(len(slot_tokens), extra_prefix_lengths=extra_prefix_lengths)
    captured = {}
    if slot_tokens:
        captured = _prefill_tokens_both(
            slot_tokens,
            model_cache,
            draft_cache,
            capture_points=capture_points,
        )
    cold_ms = (time.perf_counter() - t_cold) * 1000

    for prefix_len in capture_points:
        snapshot = captured.get(prefix_len)
        if snapshot is None:
            continue
        _store_prefix_slot(slot_tokens[:prefix_len], snapshot[0], snapshot[1])

    if store_kind == "prefix":
        kind, key, slot, _ = _store_prefix_slot(slot_tokens, model_cache, draft_cache)
    else:
        kind, key, slot, _ = _store_slot(
            slot_tokens,
            model_cache,
            draft_cache,
            exclude_keys=exclude_keys,
        )
    return kind, key, slot, cold_ms, True


def _create_extended_slot(base_kind, base_key, base_slot, new_tokens, *, exclude_keys=(), extra_prefix_lengths=None, store_kind="primary"):
    """Create a child slot that extends an existing prefix checkpoint."""
    new_tokens = list(new_tokens)
    if not new_tokens:
        _move_slot_to_end(base_kind, base_key)
        return base_kind, base_key, base_slot, 0.0, False

    slot_tokens = list(base_slot["tokens"]) + new_tokens
    existing_kind, existing_key, existing_slot = _find_exact_slot(slot_tokens)
    if existing_slot is not None:
        _move_slot_to_end(existing_kind, existing_key)
        return existing_kind, existing_key, existing_slot, 0.0, False

    t_ext = time.perf_counter()
    model_cache = deepcopy_cache(base_slot["model_cache"])
    draft_cache = deepcopy_cache(base_slot["draft_cache"])
    capture_points = _normalize_capture_points(
        len(slot_tokens),
        len(base_slot["tokens"]),
        extra_prefix_lengths=extra_prefix_lengths,
    )
    capture_after = [point - len(base_slot["tokens"]) for point in capture_points]
    captured = _prefill_tokens_both(
        new_tokens,
        model_cache,
        draft_cache,
        capture_points=capture_after,
    )
    extend_ms = (time.perf_counter() - t_ext) * 1000

    for prefix_len, relative_len in zip(capture_points, capture_after):
        snapshot = captured.get(relative_len)
        if snapshot is None:
            continue
        _store_prefix_slot(slot_tokens[:prefix_len], snapshot[0], snapshot[1])

    if store_kind == "prefix":
        kind, key, slot, _ = _store_prefix_slot(slot_tokens, model_cache, draft_cache)
    else:
        kind, key, slot, _ = _store_slot(
            slot_tokens,
            model_cache,
            draft_cache,
            exclude_keys=set(exclude_keys) | ({base_key} if base_kind == "primary" else set()),
        )
    return kind, key, slot, extend_ms, True


def _ensure_slot(slot_tokens, *, store_kind="primary", exclude_keys=(), extra_prefix_lengths=None):
    """Ensure slot_tokens exists as a reusable checkpoint, extending from the best exact prefix."""
    slot_tokens = list(slot_tokens)
    existing_kind, existing_key, existing_slot = _find_exact_slot(slot_tokens)
    if existing_slot is not None:
        _move_slot_to_end(existing_kind, existing_key)
        return existing_kind, existing_key, existing_slot, 0.0, False

    best_kind, best_key, best_slot, best_len = _find_longest_exact_prefix_slot(slot_tokens)
    if best_slot is not None and best_len >= MIN_PREFIX_HIT:
        return _create_extended_slot(
            best_kind,
            best_key,
            best_slot,
            slot_tokens[best_len:],
            exclude_keys=exclude_keys,
            extra_prefix_lengths=extra_prefix_lengths,
            store_kind=store_kind,
        )

    return _create_fresh_slot(
        slot_tokens,
        exclude_keys=exclude_keys,
        extra_prefix_lengths=extra_prefix_lengths,
        store_kind=store_kind,
    )


def prepare_cache_and_prompt(prompt_tokens, checkpoint_lengths=None):
    """
    Prepare working caches (main + draft) + remaining prompt using prefix-matching LRU strategy.

    Scans ALL cache slots for the longest common prefix match (not hash-based).
    This means a system prompt cached from request A will be reused by request B
    even if the user messages differ.

    Returns (working_model_cache, working_draft_cache, last_token_array, cache_hit_len)
    """
    best_kind, best_key, best_slot, best_len = _find_longest_exact_prefix_slot(prompt_tokens)

    if best_slot is not None and best_len >= MIN_PREFIX_HIT:
        _move_slot_to_end(best_kind, best_key)

        cache_hit = best_len
        new_tokens = list(prompt_tokens[best_len:-1]) if len(prompt_tokens) > best_len + 1 else []
        slot_kind = best_kind
        slot_key = best_key
        slot = best_slot

        if new_tokens:
            slot_kind, slot_key, slot, pf_ms, created = _create_extended_slot(
                best_kind,
                best_key,
                best_slot,
                new_tokens,
                exclude_keys=(best_key,) if best_kind == "primary" else (),
                extra_prefix_lengths=checkpoint_lengths,
            )
            action = "branched" if created else "reused"
            print(
                f"[cache] slot={slot_key} {action} +{len(new_tokens)} tok "
                f"from={best_key} in {pf_ms:.1f}ms"
            )

        t_copy = time.perf_counter()
        working_model, working_draft = _clone_slot_for_request(slot)
        copy_ms = (time.perf_counter() - t_copy) * 1000
        print(
            f"[cache] slot={slot_key} HIT exact={cache_hit} copy={copy_ms:.1f}ms "
            f"({_total_slot_count()} slots)"
        )

        remaining = mx.array(prompt_tokens[-1:], dtype=mx.uint32)
        return working_model, working_draft, remaining, cache_hit

    best_partial_kind, best_partial_key, best_partial_slot, best_common = _find_longest_partial_slot(prompt_tokens)
    fallback_prefix_lengths = set(checkpoint_lengths or [])
    if best_partial_slot is not None and best_common >= MIN_PREFIX_HIT:
        fallback_prefix_lengths.add(best_common)
        print(
            f"[cache] slot={best_partial_key} PARTIAL match={best_common}/{len(best_partial_slot['tokens'])} "
            f"→ cold-prefilling full target ({_total_slot_count()} slots)"
        )
    else:
        print(
            f"[cache] MISS (no prefix match >= {MIN_PREFIX_HIT} tok, {_total_slot_count()} existing slots)"
        )

    # --- Step 2: Cold start — evict oldest if at capacity, prefill fresh ---
    new_tokens = list(prompt_tokens[:-1]) if len(prompt_tokens) > 1 else []
    _, new_key, new_slot, cold_ms, _ = _create_fresh_slot(
        new_tokens,
        extra_prefix_lengths=sorted(fallback_prefix_lengths),
    )

    t_copy = time.perf_counter()
    working_model, working_draft = _clone_slot_for_request(new_slot)
    copy_ms = (time.perf_counter() - t_copy) * 1000
    print(
        f"[cache] slot={new_key} cold {len(new_tokens)} tok in {cold_ms:.1f}ms "
        f"copy={copy_ms:.1f}ms ({_total_slot_count()} slots)"
    )

    remaining = mx.array(prompt_tokens[-1:] if prompt_tokens else [], dtype=mx.uint32)
    return working_model, working_draft, remaining, 0


# =====================================================================
# Request Logging
# =====================================================================

def _log_request_async(body: dict):
    ts = time.strftime("%Y%m%d-%H%M%S")
    req_id = uuid.uuid4().hex[:8]
    REQUEST_LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = REQUEST_LOG_DIR / f"{ts}-{req_id}.json"
    try:
        with open(log_path, "w") as f:
            json.dump(body, f, indent=2, default=str)
    except Exception:
        pass


def _should_log_request(raw_request: RawRequest) -> bool:
    if not REQUEST_LOG_ENABLED:
        return False
    header_value = raw_request.headers.get(REQUEST_LOG_SKIP_HEADER, "")
    return header_value.lower() not in {"1", "true", "yes", "on"}


# =====================================================================
# Pydantic Models
# =====================================================================

class ChatMessage(BaseModel):
    role: str
    content: Union[str, list, None] = None
    tool_calls: Optional[list] = None
    tool_call_id: Optional[str] = None
    model_config = {"extra": "ignore"}

    def text(self) -> str:
        if self.content is None:
            return ""
        if isinstance(self.content, str):
            return self.content
        parts = []
        for part in self.content:
            if isinstance(part, dict) and part.get("type") == "text":
                parts.append(part.get("text", ""))
            elif isinstance(part, str):
                parts.append(part)
        return "\n".join(parts)


class ChatRequest(BaseModel):
    model: str = ""
    messages: list[ChatMessage]
    max_tokens: int = 2048
    temperature: float = 0.6
    top_p: float = 0.95
    stream: bool = False
    stop: Optional[list[str]] = None
    enable_thinking: bool = False
    no_spec: bool = False  # Force-disable speculative decoding for this request
    model_config = {"extra": "ignore"}


# =====================================================================
# Embeddings
# =====================================================================

def _embed_texts(texts: list[str]) -> list[list[float]]:
    encoded = embed_tokenizer(
        texts, padding=True, truncation=True, max_length=512, return_tensors="np"
    )
    input_ids = mx.array(encoded["input_ids"])
    token_type_ids = mx.array(encoded["token_type_ids"])
    attention_mask = mx.array(encoded["attention_mask"])

    output = embed_model.model(
        input_ids, token_type_ids=token_type_ids, attention_mask=attention_mask
    )
    last_hidden = output[0]
    mask_expanded = attention_mask[:, :, None].astype(mx.float32)
    summed = (last_hidden * mask_expanded).sum(axis=1)
    counts = mask_expanded.sum(axis=1)
    embeddings = summed / counts
    norms = mx.sqrt((embeddings * embeddings).sum(axis=-1, keepdims=True))
    embeddings = embeddings / norms
    mx.eval(embeddings)
    return [emb.tolist() for emb in embeddings]


@app.post("/v1/embeddings")
async def create_embeddings(raw_request: RawRequest):
    try:
        body = await raw_request.json()
        inp = body.get("input", [])
        if isinstance(inp, str):
            inp = [inp]
        req_model = body.get("model", EMBEDDING_MODEL_NAME)

        t0 = time.perf_counter()
        embeddings = _embed_texts(inp)
        elapsed = time.perf_counter() - t0

        total_tokens = sum(len(embed_tokenizer.encode(t)) for t in inp)
        print(f"[embed] {len(inp)} texts, {total_tokens} tok in {elapsed * 1000:.1f}ms")

        return {
            "object": "list",
            "data": [
                {"object": "embedding", "embedding": emb, "index": i}
                for i, emb in enumerate(embeddings)
            ],
            "model": req_model,
            "usage": {"prompt_tokens": total_tokens, "total_tokens": total_tokens},
        }
    except Exception as e:
        print(f"[ERROR] Embedding: {e}", file=sys.stderr, flush=True)
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/v1/models")
async def list_models():
    return {
        "object": "list",
        "data": [
            {"id": model_name, "object": "model", "owned_by": "local"},
            {"id": EMBEDDING_MODEL_NAME, "object": "model", "owned_by": "local"},
        ],
    }


def _render_chat_page() -> str:
    html = dedent(
        """
        <!doctype html>
        <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
          <title>MLX Chat</title>
          <style>
            :root {
              color-scheme: dark;
              --bg: #0b0f14;
              --panel: rgba(18, 24, 33, 0.94);
              --border: rgba(148, 163, 184, 0.18);
              --text: #e5eef8;
              --muted: #8fa3ba;
              --accent: #4fd1c5;
              --accent-strong: #2dd4bf;
              --assistant: #18212d;
              --shadow: 0 24px 80px rgba(0, 0, 0, 0.38);
            }

            * {
              box-sizing: border-box;
            }

            html, body {
              margin: 0;
              min-height: 100%;
              background:
                radial-gradient(circle at top, rgba(45, 212, 191, 0.14), transparent 34%),
                radial-gradient(circle at bottom right, rgba(59, 130, 246, 0.12), transparent 30%),
                var(--bg);
              color: var(--text);
              font: 15px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }

            body {
              display: flex;
              justify-content: center;
              padding: 20px;
            }

            .shell {
              width: min(980px, 100%);
              min-height: calc(100vh - 40px);
              display: grid;
              grid-template-rows: auto auto 1fr auto;
              gap: 14px;
            }

            .panel {
              background: var(--panel);
              border: 1px solid var(--border);
              backdrop-filter: blur(18px);
              box-shadow: var(--shadow);
            }

            .header {
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 12px;
              padding: 18px 20px;
              border-radius: 24px;
            }

            .title-group {
              display: flex;
              flex-direction: column;
              gap: 4px;
            }

            .title {
              margin: 0;
              font-size: 20px;
              font-weight: 700;
              letter-spacing: -0.02em;
            }

            .subtitle {
              color: var(--muted);
              font-size: 13px;
            }

            .model-pill {
              padding: 8px 12px;
              border-radius: 999px;
              background: rgba(79, 209, 197, 0.12);
              border: 1px solid rgba(79, 209, 197, 0.22);
              color: #b8fff6;
              font-size: 13px;
              white-space: nowrap;
            }

            details.settings {
              border-radius: 20px;
              overflow: hidden;
            }

            details.settings > summary {
              cursor: pointer;
              list-style: none;
              display: flex;
              align-items: center;
              justify-content: space-between;
              padding: 16px 18px;
              color: var(--muted);
              user-select: none;
            }

            details.settings > summary::-webkit-details-marker {
              display: none;
            }

            .settings-body {
              padding: 0 18px 18px;
              display: grid;
              gap: 10px;
            }

            label {
              font-size: 13px;
              color: var(--muted);
            }

            textarea,
            button {
              font: inherit;
            }

            textarea {
              width: 100%;
              resize: vertical;
              min-height: 96px;
              max-height: 220px;
              padding: 14px 16px;
              border-radius: 16px;
              border: 1px solid var(--border);
              background: rgba(10, 15, 23, 0.9);
              color: var(--text);
              outline: none;
            }

            textarea:focus {
              border-color: rgba(79, 209, 197, 0.5);
              box-shadow: 0 0 0 3px rgba(79, 209, 197, 0.14);
            }

            .conversation {
              border-radius: 28px;
              padding: 18px;
              overflow: hidden;
              display: flex;
              flex-direction: column;
              min-height: 320px;
            }

            .messages {
              overflow-y: auto;
              padding-right: 4px;
              display: flex;
              flex-direction: column;
              gap: 14px;
            }

            .empty {
              margin: auto;
              max-width: 520px;
              text-align: center;
              color: var(--muted);
              padding: 30px 18px;
            }

            .message {
              display: flex;
            }

            .message.user {
              justify-content: flex-end;
            }

            .message-card {
              max-width: min(82%, 720px);
              padding: 14px 16px;
              border-radius: 20px;
              border: 1px solid transparent;
              word-wrap: break-word;
              overflow-wrap: anywhere;
            }

            .message.user .message-card {
              background: linear-gradient(135deg, rgba(37, 99, 235, 0.96), rgba(29, 78, 216, 0.96));
              color: white;
              border-bottom-right-radius: 8px;
            }

            .message.assistant .message-card {
              background: var(--assistant);
              border-color: rgba(148, 163, 184, 0.12);
              border-bottom-left-radius: 8px;
            }

            .message-meta {
              font-size: 11px;
              text-transform: uppercase;
              letter-spacing: 0.08em;
              opacity: 0.72;
              margin-bottom: 8px;
            }

            .message.assistant[data-streaming="true"] .message-meta::after {
              content: " • streaming";
              color: var(--accent);
            }

            .message-content p {
              margin: 0 0 0.85em;
            }

            .message-content p:last-child {
              margin-bottom: 0;
            }

            .message-content pre {
              margin: 0.9em 0;
              padding: 12px 14px;
              border-radius: 14px;
              overflow-x: auto;
              background: rgba(2, 6, 23, 0.9);
              border: 1px solid rgba(148, 163, 184, 0.14);
            }

            .message-content code {
              font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
              font-size: 0.92em;
            }

            .message-content :not(pre) > code {
              background: rgba(148, 163, 184, 0.14);
              border-radius: 8px;
              padding: 0.12em 0.4em;
            }

            .message-content a {
              color: #8ddcff;
            }

            .composer {
              border-radius: 24px;
              padding: 16px;
              display: grid;
              gap: 12px;
            }

            .composer-actions {
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 12px;
            }

            .composer-hint {
              color: var(--muted);
              font-size: 12px;
            }

            .button-row {
              display: flex;
              align-items: center;
              gap: 10px;
            }

            button {
              border: 0;
              border-radius: 999px;
              padding: 11px 16px;
              cursor: pointer;
              color: white;
              background: linear-gradient(135deg, var(--accent-strong), #0f766e);
              transition: transform 120ms ease, opacity 120ms ease;
            }

            button.secondary {
              background: rgba(30, 41, 59, 0.9);
              color: var(--text);
              border: 1px solid var(--border);
            }

            button:hover {
              transform: translateY(-1px);
            }

            button:disabled {
              opacity: 0.6;
              cursor: not-allowed;
              transform: none;
            }

            @media (max-width: 720px) {
              body {
                padding: 12px;
              }

              .shell {
                min-height: calc(100vh - 24px);
                gap: 10px;
              }

              .header,
              .conversation,
              .composer,
              details.settings {
                border-radius: 20px;
              }

              .header {
                padding: 16px;
                align-items: flex-start;
                flex-direction: column;
              }

              .message-card {
                max-width: 100%;
              }

              .composer-actions {
                flex-direction: column;
                align-items: stretch;
              }

              .button-row {
                justify-content: space-between;
              }
            }
          </style>
        </head>
        <body>
          <div class="shell">
            <header class="header panel">
              <div class="title-group">
                <h1 class="title">MLX Chat</h1>
                <div class="subtitle">Local chat UI backed by the existing OpenAI-compatible MLX endpoint.</div>
              </div>
              <div class="model-pill" data-testid="model-name" id="model-name">__MODEL_NAME_TEXT__</div>
            </header>

            <details class="settings panel" id="settings-panel">
              <summary data-testid="settings-toggle">
                <span>Settings</span>
                <span>System prompt</span>
              </summary>
              <div class="settings-body">
                <label for="system-prompt">System prompt</label>
                <textarea id="system-prompt" data-testid="system-prompt" placeholder="Optional system prompt for this chat session."></textarea>
              </div>
            </details>

            <main class="conversation panel">
              <div class="messages" id="messages" data-testid="conversation">
                <div class="empty" id="empty-state">
                  Ask something to start a client-side conversation. Responses stream from <code>/v1/chat/completions</code>.
                </div>
              </div>
            </main>

            <section class="composer panel">
              <textarea id="message-input" data-testid="message-input" placeholder="Message the model..." aria-label="Message input"></textarea>
              <div class="composer-actions">
                <div class="composer-hint" id="status-line">Enter to send. Shift+Enter for a newline.</div>
                <div class="button-row">
                  <button class="secondary" type="button" id="clear-button" data-testid="clear-button">Clear</button>
                  <button type="button" id="send-button" data-testid="send-button">Send</button>
                </div>
              </div>
            </section>
          </div>

          <script>
            const initialModelName = __MODEL_NAME_JSON__;
            const state = {
              modelName: initialModelName,
              messages: [],
              streaming: false,
            };

            const messagesEl = document.getElementById("messages");
            const emptyStateEl = document.getElementById("empty-state");
            const inputEl = document.getElementById("message-input");
            const sendButtonEl = document.getElementById("send-button");
            const clearButtonEl = document.getElementById("clear-button");
            const systemPromptEl = document.getElementById("system-prompt");
            const modelNameEl = document.getElementById("model-name");
            const statusLineEl = document.getElementById("status-line");

            function escapeHtml(text) {
              return text
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#39;");
            }

            function renderInlineMarkdown(text) {
              return text
                .replace(/`([^`]+)`/g, "<code>$1</code>")
                .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
                .replace(/\\*([^*]+)\\*/g, "<em>$1</em>")
                .replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
            }

            function renderMarkdown(text) {
              const codeBlocks = [];
              const placeholderText = text.replace(/```([\\w-]+)?\\n([\\s\\S]*?)```/g, (_, lang, code) => {
                const html = `<pre><code class="${lang ? `language-${lang}` : ""}">${escapeHtml(code.trim())}</code></pre>`;
                const index = codeBlocks.push(html) - 1;
                return `%%CODEBLOCK${index}%%`;
              });

              const escaped = escapeHtml(placeholderText);
              const segments = escaped.split(/\\n{2,}/).map((segment) => {
                const trimmed = segment.trim();
                if (!trimmed) {
                  return "";
                }
                if (/^%%CODEBLOCK\\d+%%$/.test(trimmed)) {
                  return trimmed;
                }
                return `<p>${renderInlineMarkdown(trimmed).replace(/\\n/g, "<br>")}</p>`;
              }).filter(Boolean);

              let html = segments.join("");
              html = html.replace(/%%CODEBLOCK(\\d+)%%/g, (_, index) => codeBlocks[Number(index)] || "");
              return html;
            }

            function scrollToBottom() {
              messagesEl.scrollTop = messagesEl.scrollHeight;
            }

            function syncComposerState() {
              const hasText = inputEl.value.trim().length > 0;
              sendButtonEl.disabled = !hasText || state.streaming;
              inputEl.disabled = state.streaming;
              statusLineEl.textContent = state.streaming
                ? "Streaming response..."
                : "Enter to send. Shift+Enter for a newline.";
            }

            function setModelName(name) {
              if (!name) return;
              state.modelName = name;
              modelNameEl.textContent = name;
            }

            function createMessageElement(role, content) {
              const wrapper = document.createElement("article");
              wrapper.className = `message ${role}`;
              wrapper.dataset.role = role;

              const card = document.createElement("div");
              card.className = "message-card";

              const meta = document.createElement("div");
              meta.className = "message-meta";
              meta.textContent = role === "user" ? "You" : state.modelName;

              const body = document.createElement("div");
              body.className = "message-content";
              body.innerHTML = role === "assistant"
                ? renderMarkdown(content)
                : `<p>${escapeHtml(content).replace(/\\n/g, "<br>")}</p>`;

              card.append(meta, body);
              wrapper.append(card);
              return { wrapper, body, meta };
            }

            function appendMessage(role, content) {
              emptyStateEl.hidden = true;
              const element = createMessageElement(role, content);
              messagesEl.append(element.wrapper);
              scrollToBottom();
              return element;
            }

            function rebuildConversation() {
              messagesEl.innerHTML = "";
              if (state.messages.length === 0) {
                emptyStateEl.hidden = false;
                messagesEl.append(emptyStateEl);
                return;
              }

              emptyStateEl.hidden = true;
              for (const message of state.messages) {
                appendMessage(message.role, message.content);
              }
            }

            function buildApiMessages() {
              const apiMessages = [];
              const systemPrompt = systemPromptEl.value.trim();
              if (systemPrompt) {
                apiMessages.push({ role: "system", content: systemPrompt });
              }
              for (const message of state.messages) {
                apiMessages.push({ role: message.role, content: message.content });
              }
              return apiMessages;
            }

            async function refreshModelName() {
              try {
                const response = await fetch("/health");
                if (!response.ok) return;
                const payload = await response.json();
                setModelName(payload.model);
              } catch (_) {
              }
            }

            async function streamChatResponse() {
              const response = await fetch("/v1/chat/completions", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-MLX-No-Log": "1",
                },
                body: JSON.stringify({
                  model: state.modelName,
                  stream: true,
                  messages: buildApiMessages(),
                }),
              });

              if (!response.ok || !response.body) {
                throw new Error(`Request failed with status ${response.status}`);
              }

              const assistant = appendMessage("assistant", "");
              assistant.wrapper.dataset.streaming = "true";
              assistant.meta.textContent = state.modelName;

              const decoder = new TextDecoder();
              const reader = response.body.getReader();
              let buffered = "";
              let content = "";

              while (true) {
                const { value, done } = await reader.read();
                buffered += decoder.decode(value || new Uint8Array(), { stream: !done });

                let boundary = buffered.indexOf("\\n\\n");
                while (boundary !== -1) {
                  const rawEvent = buffered.slice(0, boundary);
                  buffered = buffered.slice(boundary + 2);

                  const dataLines = rawEvent
                    .split("\\n")
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trim());

                  for (const payload of dataLines) {
                    if (!payload) {
                      continue;
                    }
                    if (payload === "[DONE]") {
                      assistant.wrapper.dataset.streaming = "false";
                      state.messages.push({ role: "assistant", content });
                      assistant.body.innerHTML = renderMarkdown(content || "");
                      scrollToBottom();
                      return;
                    }

                    let parsed;
                    try {
                      parsed = JSON.parse(payload);
                    } catch (_) {
                      continue;
                    }

                    if (parsed.model) {
                      setModelName(parsed.model);
                      assistant.meta.textContent = state.modelName;
                    }

                    const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
                    if (delta && typeof delta.content === "string") {
                      content += delta.content;
                      assistant.body.innerHTML = renderMarkdown(content);
                      scrollToBottom();
                    }
                  }

                  boundary = buffered.indexOf("\\n\\n");
                }

                if (done) {
                  break;
                }
              }

              assistant.wrapper.dataset.streaming = "false";
              state.messages.push({ role: "assistant", content });
              assistant.body.innerHTML = renderMarkdown(content || "");
              scrollToBottom();
            }

            async function sendMessage() {
              if (state.streaming) {
                return;
              }
              const content = inputEl.value.trim();
              if (!content) {
                return;
              }

              state.messages.push({ role: "user", content });
              appendMessage("user", content);
              inputEl.value = "";
              state.streaming = true;
              syncComposerState();

              try {
                await streamChatResponse();
              } catch (error) {
                const message = `Request error: ${error.message}`;
                appendMessage("assistant", message);
                state.messages.push({ role: "assistant", content: message });
              } finally {
                state.streaming = false;
                syncComposerState();
                inputEl.focus();
              }
            }

            sendButtonEl.addEventListener("click", sendMessage);
            clearButtonEl.addEventListener("click", () => {
              if (state.streaming) {
                return;
              }
              state.messages = [];
              rebuildConversation();
              inputEl.focus();
            });

            inputEl.addEventListener("keydown", (event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
              }
            });

            inputEl.addEventListener("input", syncComposerState);

            syncComposerState();
            refreshModelName();
            inputEl.focus();
          </script>
        </body>
        </html>
        """
    )
    return (
        html.replace("__MODEL_NAME_JSON__", json.dumps(model_name))
        .replace("__MODEL_NAME_TEXT__", model_name)
    )


@app.get("/chat", response_class=HTMLResponse)
async def chat_page():
    return HTMLResponse(_render_chat_page())


# =====================================================================
# Chat Completions
# =====================================================================

def _chat_messages(req: ChatRequest) -> list[dict]:
    """Normalize Pydantic messages into chat-template dictionaries."""
    return [{"role": m.role, "content": m.text()} for m in req.messages]


def _render_chat_template(messages: list[dict], *, add_generation_prompt: bool, force_empty_think: bool) -> str:
    """Render the model's chat template with optional empty think suppression."""
    text = tokenizer.apply_chat_template(
        messages,
        tokenize=False,
        add_generation_prompt=add_generation_prompt,
    )
    if force_empty_think:
        text += "\n<think>\n</think>\n"
    return text


def _build_prompt(req: ChatRequest) -> str:
    """Build prompt with force-empty think block to suppress thinking."""
    return _render_chat_template(
        _chat_messages(req),
        add_generation_prompt=True,
        force_empty_think=not req.enable_thinking,
    )


def _compute_prompt_checkpoint_lengths(req: ChatRequest, prompt_tokens: list[int]) -> list[int]:
    """Compute reusable exact-prefix checkpoint lengths at message boundaries."""
    messages = _chat_messages(req)
    checkpoint_lengths = set()

    # Keep only the first completed message boundary as a long-lived shared prefix.
    # Deeper conversation branches are covered by response checkpoints persisted
    # after generation, which avoids crowding out useful turn-level slots.
    for end_idx in range(1, min(len(messages), 2)):
        prefix_text = tokenizer.apply_chat_template(
            messages[:end_idx],
            tokenize=False,
            add_generation_prompt=True,
        )
        if not req.enable_thinking:
            prefix_text += "\n<think>\n</think>\n"

        prefix_tokens = tokenizer.encode(prefix_text, add_special_tokens=False)
        if not prefix_tokens:
            continue
        if prefix_tokens != prompt_tokens[:len(prefix_tokens)]:
            continue

        slot_len = len(prefix_tokens) - 1
        if MIN_PREFIX_HIT <= slot_len < len(prompt_tokens) - 1:
            checkpoint_lengths.add(slot_len)

    # Capture the assistant-header prefix before the synthetic think block.
    base_text = _render_chat_template(
        messages,
        add_generation_prompt=True,
        force_empty_think=False,
    )
    base_tokens = tokenizer.encode(base_text, add_special_tokens=False)
    if (
        base_tokens
        and base_tokens == prompt_tokens[:len(base_tokens)]
        and MIN_PREFIX_HIT <= len(base_tokens) < len(prompt_tokens) - 1
    ):
        checkpoint_lengths.add(len(base_tokens))

    return sorted(checkpoint_lengths)


def _persist_response_prefix(messages: list[dict], assistant_text: str):
    """Store the canonical conversation state after an assistant turn completes."""
    if not assistant_text:
        return

    base_text = _render_chat_template(
        messages,
        add_generation_prompt=True,
        force_empty_think=False,
    )
    base_tokens = tokenizer.encode(base_text, add_special_tokens=False)

    response_text = _render_chat_template(
        messages + [{"role": "assistant", "content": assistant_text}],
        add_generation_prompt=False,
        force_empty_think=False,
    )
    response_tokens = tokenizer.encode(response_text, add_special_tokens=False)
    if not response_tokens:
        return

    kind, key, slot, store_ms, created = _ensure_slot(
        response_tokens,
        store_kind="prefix",
    )
    action = "stored" if created else "reused"
    print(
        f"[cache] slot={key} response-{action} {len(slot['tokens'])} tok "
        f"in {store_ms:.1f}ms ({kind})"
    )

    # The assistant-header checkpoint is request-local scaffolding for building
    # the response slot. Drop it once the canonical response prefix exists so
    # branchable conversation states survive longer in the prefix pool.
    if base_tokens and base_tokens != response_tokens:
        base_kind, base_key, base_slot = _find_exact_slot(base_tokens)
        if (
            base_slot is not None
            and base_kind == "prefix"
            and base_key != key
            and _prefix_slots.pop(base_key, None) is not None
        ):
            print(f"[cache] removed transient prefix={base_key} ({len(base_tokens)} tok)")


@app.post("/v1/chat/completions")
async def chat_completions(raw_request: RawRequest):
    raw_body = await raw_request.json()
    if _should_log_request(raw_request):
        asyncio.get_event_loop().run_in_executor(None, _log_request_async, raw_body)

    try:
        req = ChatRequest(**raw_body)
    except Exception as e:
        print(f"[ERROR] Validation: {e}", file=sys.stderr, flush=True)
        traceback.print_exc()
        return JSONResponse(status_code=422, content={"detail": str(e)})

    messages = _chat_messages(req)

    # Tokenize
    global _last_chat_text, _last_chat_tokens
    t_tok = time.perf_counter()
    text = _build_prompt(req)
    if text == _last_chat_text:
        prompt_tokens = _last_chat_tokens
    else:
        prompt_tokens = tokenizer.encode(text, add_special_tokens=False)
        _last_chat_text = text
        _last_chat_tokens = prompt_tokens
    tok_ms = (time.perf_counter() - t_tok) * 1000

    checkpoint_lengths = _compute_prompt_checkpoint_lengths(req, prompt_tokens)

    # Prepare cache (both main + draft)
    t_cache = time.perf_counter()
    async with _cache_lock:
        working_model_cache, working_draft_cache, remaining_prompt, cache_hit = \
            prepare_cache_and_prompt(prompt_tokens, checkpoint_lengths=checkpoint_lengths)
    cache_ms = (time.perf_counter() - t_cache) * 1000

    sampler = make_sampler(req.temperature, req.top_p)
    extra_stop_ids = set()
    if req.stop:
        for s in req.stop:
            ids = tokenizer.encode(s, add_special_tokens=False)
            if len(ids) == 1:
                extra_stop_ids.add(ids[0])

    request_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"
    print(
        f"[req] {request_id} tok={tok_ms:.1f}ms cache={cache_ms:.1f}ms "
        f"prompt={len(prompt_tokens)} cached={cache_hit} "
        f"think={'on' if req.enable_thinking else 'off'} "
        f"spec={'off' if req.no_spec else 'on'} "
        f"stream={req.stream}"
    )

    if req.stream:
        return StreamingResponse(
            _stream_response(
                request_id, remaining_prompt, working_model_cache,
                working_draft_cache, sampler,
                req.max_tokens, extra_stop_ids, len(prompt_tokens),
                messages=messages,
                temperature=req.temperature,
                no_spec=req.no_spec,
            ),
            media_type="text/event-stream",
        )
    else:
        return await _complete_response(
            request_id, remaining_prompt, working_model_cache,
            working_draft_cache, sampler,
            req.max_tokens, extra_stop_ids, len(prompt_tokens),
            messages=messages,
            temperature=req.temperature,
            no_spec=req.no_spec,
        )


# =====================================================================
# Generation Core
# =====================================================================

def _snapshot_arrays_cache(cache_list):
    """Snapshot ArraysCache entries by reference.

    Qwen3.5 recurrent cache updates replace entries rather than mutating the
    backing tensors, so holding references to the pre-round arrays is enough.
    """
    snapshots = []
    for i, c in enumerate(cache_list):
        if isinstance(c, ArraysCache):
            saved = tuple(c.cache)
            snapshots.append((i, saved))
    return snapshots


def _restore_arrays_cache(cache_list, snapshots):
    """Restore ArraysCache entries from snapshot."""
    for i, saved in snapshots:
        c = cache_list[i]
        c.cache = list(saved)


def _trim_kv_only(cache_list, num_tokens):
    """Trim only KVCache entries, skip ArraysCache."""
    if num_tokens <= 0:
        return
    for c in cache_list:
        if isinstance(c, KVCache) and c.is_trimmable():
            c.trim(num_tokens)



def _verify_with_saved_states(verify_input, working_model_cache, n_predict):
    """Run main model verification while saving hidden states at ArraysCache layer inputs.

    Returns (raw_logits, saved_states_dict).
    raw_logits: (n_predict, vocab_size) raw logits before any temperature/sampling.
    saved_states maps layer_idx -> hidden_states tensor at that layer's input,
    used for lightweight ArraysCache-only replay without full forward pass.
    """
    inner_model = model.language_model.model  # Qwen3_5TextModel
    text_model = model.language_model  # TextModel

    with mx.stream(generation_stream):
        h = inner_model.embed_tokens(verify_input[None])

        fa_mask = create_attention_mask(h, working_model_cache[inner_model.fa_idx])
        ssm_mask = create_ssm_mask(h, working_model_cache[inner_model.ssm_idx])

        saved_states = {}
        for i, (layer, c) in enumerate(zip(inner_model.layers, working_model_cache)):
            if layer.is_linear:
                saved_states[i] = h
            mask = ssm_mask if layer.is_linear else fa_mask
            h = layer(h, mask=mask, cache=c)

        h = inner_model.norm(h)
        if text_model.args.tie_word_embeddings:
            logits = inner_model.embed_tokens.as_linear(h)
        else:
            logits = text_model.lm_head(h)

        logits = logits[:, -n_predict:, :].squeeze(0)  # (n_predict, vocab_size)

    return logits, saved_states


def _replay_model_arrays_only(saved_states, n_positions, working_model_cache):
    """Replay n_positions through ArraysCache layers using saved hidden states.

    ~10ms instead of ~64ms full forward pass. Each ArraysCache layer's
    linear_attn is called with the saved hidden states for accepted positions,
    updating only conv_state and recurrent state. Does NOT touch KVCache.
    """
    if n_positions <= 0:
        return
    inner_model = model.language_model.model
    with mx.stream(generation_stream):
        for layer_idx, h_saved in saved_states.items():
            layer = inner_model.layers[layer_idx]
            h_slice = h_saved[:, :n_positions, :]
            layer.linear_attn(layer.input_layernorm(h_slice), None, working_model_cache[layer_idx])


def _sample_tokens(raw_logits, sampler, temperature):
    """Sample from raw logits, with an argmax fast path for greedy decoding."""
    if temperature < 1e-6:
        return mx.argmax(raw_logits, axis=-1).astype(mx.uint32)
    logprobs = raw_logits - mx.logsumexp(raw_logits, axis=-1, keepdims=True)
    return sampler(logprobs)


def _rejection_sample_spec(draft_logits_list, main_logits, draft_token_list,
                           temperature, sampler):
    """Rejection sampling for speculative decoding.

    At temp=0: exact token matching (equivalent to greedy).
    At temp>0: probabilistic acceptance using min(1, p(d)/q(d)),
    with residual distribution sampling on rejection.

    Args:
        draft_logits_list: list of nd raw logit arrays from draft model (each shape (vocab,) or (1,vocab))
        main_logits: (nd+1, vocab) raw logits from main model
        draft_token_list: list of nd drafted token ids
        temperature: sampling temperature
        sampler: sampler function for bonus/corrected tokens

    Returns:
        (n_accepted, corrected_token_id)
    """
    nd = len(draft_token_list)

    if temperature < 1e-6:
        # Greedy: exact token matching
        main_tokens = mx.argmax(main_logits[:nd], axis=-1).astype(mx.uint32)
        mx.eval(main_tokens)
        main_list = main_tokens.tolist()

        n_accepted = 0
        while n_accepted < nd:
            if main_list[n_accepted] != draft_token_list[n_accepted]:
                break
            n_accepted += 1

        if n_accepted == nd:
            bonus = mx.argmax(main_logits[nd:nd+1], axis=-1).astype(mx.uint32)
            mx.eval(bonus)
            return nd, bonus.squeeze().item()
        else:
            return n_accepted, main_list[n_accepted]

    # --- Temperature > 0: rejection sampling ---
    # Compute temperature-scaled probabilities for both models
    main_probs = mx.softmax(main_logits / temperature, axis=-1)  # (nd+1, vocab)
    mx.eval(main_probs)

    n_accepted = 0
    for i in range(nd):
        d = draft_token_list[i]

        # Draft probability of the drafted token
        dl = draft_logits_list[i]
        if dl.ndim == 2:
            dl = dl.squeeze(0)
        draft_probs_i = mx.softmax(dl / temperature, axis=-1)
        mx.eval(draft_probs_i)

        q_d = draft_probs_i[d].item()
        p_d = main_probs[i, d].item()

        # Accept with probability min(1, p(d) / q(d))
        if q_d < 1e-10:
            # Draft assigned ~0 probability but sampled it anyway (numerical edge case)
            # Accept if main model also likes it
            if p_d > 1e-6:
                n_accepted += 1
                continue
            else:
                # Both near zero — reject, sample from main
                main_logprobs_i = main_logits[i:i+1] - mx.logsumexp(main_logits[i:i+1], axis=-1, keepdims=True)
                corrected = sampler(main_logprobs_i)
                mx.eval(corrected)
                return n_accepted, corrected.squeeze().item()

        accept_prob = min(1.0, p_d / q_d)
        if random.random() < accept_prob:
            n_accepted += 1
        else:
            # Sample from residual distribution: max(0, p(x) - q(x)) normalized
            residual = mx.maximum(main_probs[i] - draft_probs_i, mx.array(0.0))
            residual_sum = residual.sum()
            mx.eval(residual_sum)

            if residual_sum.item() < 1e-10:
                # Residual is empty — fallback to main model distribution
                main_logprobs_i = main_logits[i:i+1] - mx.logsumexp(main_logits[i:i+1], axis=-1, keepdims=True)
                corrected = sampler(main_logprobs_i)
                mx.eval(corrected)
                return n_accepted, corrected.squeeze().item()

            # Sample from normalized residual using categorical
            log_residual = mx.log(residual / residual_sum + 1e-10)
            corrected_id = mx.random.categorical(log_residual).item()
            return n_accepted, corrected_id

    # All accepted — bonus token from main model's last position
    main_logprobs_bonus = main_logits[nd:nd+1] - mx.logsumexp(main_logits[nd:nd+1], axis=-1, keepdims=True)
    bonus = sampler(main_logprobs_bonus)
    mx.eval(bonus)
    return nd, bonus.squeeze().item()


def _generate_tokens_spec(prompt_arr, working_model_cache, working_draft_cache,
                          sampler, max_tokens, extra_stop_ids, temperature=0.0,
                          request_id=None, no_spec=False):
    """Speculative decoding with adaptive fallback.

    Tracks acceptance rate over a sliding window. When acceptance drops below
    SPEC_DISABLE_THRESHOLD, falls back to non-speculative (main-model-only)
    generation. Periodically retries speculative decoding to detect recovery.

    Main model on rejection:
    - Trim KVCache by (nd - n_accepted) to keep y + accepted KV entries
    - Restore ArraysCache from snapshot, replay accepted positions through
      only ArraysCache layers using saved hidden states (~10ms)

    Draft model on rejection:
    - Trim KVCache by max(nd - n_accepted - 1, 0)
    - Restore ArraysCache from snapshot (no replay — accepted tokens missing
      from recurrent state, but clean; KVCache layers still provide context)
    """
    all_stop = EOS_TOKEN_IDS | extra_stop_ids
    count = 0

    # Initial prefill of the last prompt token through both models
    with mx.stream(generation_stream):
        main_logits = model(prompt_arr[None], cache=working_model_cache)
        draft_model(prompt_arr[None], cache=working_draft_cache)
    main_logits = main_logits[:, -1, :]
    y = _sample_tokens(main_logits, sampler, temperature)
    mx.eval(y)

    token_id = y.squeeze().item()
    if token_id in all_stop:
        return
    if token_id not in THINK_TOKEN_IDS:
        count += 1
        yield token_id
        if count >= max_tokens:
            return

    y = mx.array([token_id], dtype=mx.uint32)

    # Instrumentation
    _spec_rounds = 0
    _nonspec_tokens = 0
    _total_accepted = 0
    _total_drafted = 0
    _all_accepted_rounds = 0

    # Adaptive state: sliding window of recent acceptance rates
    _recent_accepted = []  # list of (accepted, drafted) tuples, last SPEC_WINDOW rounds
    _spec_enabled = not no_spec
    _nonspec_streak = 0  # how many non-spec tokens since last spec attempt
    _nonspec_buffer = []  # tokens generated in non-spec mode, for draft model resync
    SPEC_RETRY_INTERVAL = 10 if not no_spec else 999999  # never retry if forced off

    while count < max_tokens:
        if not _spec_enabled:
            # --- Non-speculative path: main model only, one token at a time ---
            # Draft model is NOT kept in sync (too expensive). When re-enabling
            # spec mode, we resync the draft model with accumulated tokens.
            with mx.stream(generation_stream):
                logits = model(y[None], cache=working_model_cache)
            logits = logits[:, -1, :]
            tok = _sample_tokens(logits, sampler, temperature)
            mx.eval(tok)
            token_id = tok.squeeze().item()

            if token_id in all_stop:
                break
            if token_id not in THINK_TOKEN_IDS:
                count += 1
                _nonspec_tokens += 1
                _nonspec_streak += 1
                _nonspec_buffer.append(token_id)
                yield token_id
                if count >= max_tokens:
                    break

            y = mx.array([token_id], dtype=mx.uint32)

            # Periodically retry speculative decoding
            if _nonspec_streak >= SPEC_RETRY_INTERVAL:
                # Resync draft model with tokens generated during non-spec mode
                if _nonspec_buffer:
                    sync_arr = mx.array(_nonspec_buffer, dtype=mx.uint32)
                    with mx.stream(generation_stream):
                        draft_model(sync_arr[None], cache=working_draft_cache)
                    eval_cache(working_draft_cache)
                    _nonspec_buffer.clear()
                _spec_enabled = True
                _nonspec_streak = 0
                _recent_accepted.clear()
            continue

        # --- Speculative path ---
        nd = min(NUM_DRAFT_TOKENS, max_tokens - count)
        if nd <= 0:
            break

        # 1. Snapshot ArraysCache for both models
        model_snap = _snapshot_arrays_cache(working_model_cache)
        draft_snap = _snapshot_arrays_cache(working_draft_cache)
        snap_arrays = []
        for _, saved in model_snap:
            snap_arrays.extend([a for a in saved if a is not None])
        for _, saved in draft_snap:
            snap_arrays.extend([a for a in saved if a is not None])
        if snap_arrays:
            mx.eval(snap_arrays)

        # 2. Draft model generates N tokens (store raw logits for rejection sampling)
        draft_tokens = []
        draft_logits_list = [] if temperature >= 1e-6 else None
        dy = y
        for _ in range(nd):
            with mx.stream(generation_stream):
                d_logits = draft_model(dy[None], cache=working_draft_cache)
            d_logits = d_logits[:, -1, :]  # (1, vocab)
            if draft_logits_list is not None:
                draft_logits_list.append(d_logits.squeeze(0))
            d_tok = _sample_tokens(d_logits, sampler, temperature)
            mx.async_eval(d_tok)
            draft_tokens.append(d_tok)
            dy = d_tok.reshape(-1)

        draft_tokens_arr = mx.concatenate(draft_tokens)

        # 3. Verify with main model — get raw logits + saved states for replay
        verify_input = mx.concatenate([y, draft_tokens_arr])
        main_logits_raw, saved_states = \
            _verify_with_saved_states(verify_input, working_model_cache, nd + 1)

        # Evaluate only what rejection sampling needs on the hot path.
        eval_arrays = [main_logits_raw, draft_tokens_arr]
        if draft_logits_list is not None:
            eval_arrays.extend(draft_logits_list)
        mx.eval(*eval_arrays)

        draft_token_list = draft_tokens_arr.tolist()

        # 4. Rejection sampling (exact match at temp=0, probabilistic at temp>0)
        n_accepted, corrected_token = _rejection_sample_spec(
            draft_logits_list, main_logits_raw, draft_token_list,
            temperature, sampler
        )
        accepted_drafts = draft_token_list[:n_accepted]

        # Track stats
        _spec_rounds += 1
        _total_drafted += nd
        _total_accepted += n_accepted
        if n_accepted == nd:
            _all_accepted_rounds += 1

        # Update sliding window for adaptive control
        _recent_accepted.append((n_accepted, nd))
        if len(_recent_accepted) > SPEC_WINDOW:
            _recent_accepted.pop(0)

        # Check if we should disable speculative decoding
        if len(_recent_accepted) >= SPEC_WINDOW:
            window_accepted = sum(a for a, _ in _recent_accepted)
            window_drafted = sum(d for _, d in _recent_accepted)
            window_rate = window_accepted / max(window_drafted, 1)
            if window_rate < SPEC_DISABLE_THRESHOLD:
                _spec_enabled = False
                _nonspec_streak = 0

        # 5. Fix caches
        if n_accepted == nd:
            # All accepted — main model cache is perfect as-is
            # Draft needs last draft token fed (it was output, not cached input)
            last_draft_tok = mx.array([draft_token_list[-1]], dtype=mx.uint32)
            with mx.stream(generation_stream):
                draft_model(last_draft_tok[None], cache=working_draft_cache)
            eval_cache(working_draft_cache)
        else:
            # === Main model: trim KVCache + restore+replay ArraysCache ===
            _trim_kv_only(working_model_cache, nd - n_accepted)
            _restore_arrays_cache(working_model_cache, model_snap)
            mx.eval(*saved_states.values())
            _replay_model_arrays_only(saved_states, 1 + n_accepted, working_model_cache)
            replay_eval = []
            for c in working_model_cache:
                if isinstance(c, ArraysCache):
                    replay_eval.extend([a for a in c.cache if a is not None])
            if replay_eval:
                mx.eval(replay_eval)

            # === Draft model: trim KVCache + restore ArraysCache (no replay) ===
            _trim_kv_only(working_draft_cache, max(nd - n_accepted - 1, 0))
            _restore_arrays_cache(working_draft_cache, draft_snap)

        # Yield tokens
        tokens_to_yield = accepted_drafts + [corrected_token]
        should_stop = False
        for tok in tokens_to_yield:
            if tok in all_stop:
                should_stop = True
                break
            if tok not in THINK_TOKEN_IDS:
                count += 1
                yield tok
                if count >= max_tokens:
                    should_stop = True
                    break
        if should_stop:
            break
        y = mx.array([corrected_token], dtype=mx.uint32)

    # Log final stats
    spec_info = ""
    if _spec_rounds > 0:
        accept_rate = _total_accepted / max(_total_drafted, 1) * 100
        all_acc_pct = _all_accepted_rounds / max(_spec_rounds, 1) * 100
        spec_info = (f"spec_rounds={_spec_rounds} "
                     f"drafted={_total_drafted} accepted={_total_accepted} "
                     f"rate={accept_rate:.0f}% all_accepted={all_acc_pct:.0f}%")
    nonspec_info = f"nonspec_tokens={_nonspec_tokens}" if _nonspec_tokens else ""
    parts = [p for p in [spec_info, nonspec_info] if p]
    if parts:
        prefix = f"[spec] {request_id} " if request_id else "[spec] "
        print(f"{prefix}{' | '.join(parts)}")

async def _complete_response(request_id, prompt_arr, working_model_cache,
                             working_draft_cache, sampler,
                             max_tokens, extra_stop_ids, prompt_token_count,
                             messages, temperature=0.0, no_spec=False):
    """Non-streaming response."""
    tokens_out = []
    t0 = time.perf_counter()
    t_first = None

    try:
        for token in _generate_tokens_spec(
            prompt_arr, working_model_cache, working_draft_cache,
            sampler, max_tokens, extra_stop_ids,
            temperature=temperature, request_id=request_id,
            no_spec=no_spec
        ):
            if t_first is None:
                t_first = time.perf_counter()
            tokens_out.append(token)
    except Exception as e:
        print(f"[ERROR] Generation: {e}", file=sys.stderr, flush=True)
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": str(e)})

    text = tokenizer.decode(tokens_out) if tokens_out else ""
    async with _cache_lock:
        _persist_response_prefix(messages, text)
    t1 = time.perf_counter()
    ttft = ((t_first or t1) - t0) * 1000
    gen_time = t1 - (t_first or t0)
    tps = len(tokens_out) / max(gen_time, 0.001) if tokens_out else 0
    print(f"[gen] {request_id} {len(tokens_out)} tok {t1-t0:.2f}s TTFT={ttft:.0f}ms {tps:.1f}tok/s")

    return {
        "id": request_id,
        "object": "chat.completion",
        "model": model_name,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": text},
            "finish_reason": "stop",
        }],
        "usage": {
            "prompt_tokens": prompt_token_count,
            "completion_tokens": len(tokens_out),
            "total_tokens": prompt_token_count + len(tokens_out),
        },
    }


async def _stream_response(request_id, prompt_arr, working_model_cache,
                           working_draft_cache, sampler,
                           max_tokens, extra_stop_ids, prompt_token_count,
                           messages, temperature=0.0, no_spec=False):
    """Streaming SSE response."""
    chunk = {
        "id": request_id, "object": "chat.completion.chunk", "model": model_name,
        "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
    }
    yield f"data: {json.dumps(chunk)}\n\n"

    gen_tokens = 0
    t0 = time.perf_counter()
    t_first = None
    detok = tokenizer.detokenizer

    try:
        for token in _generate_tokens_spec(
            prompt_arr, working_model_cache, working_draft_cache,
            sampler, max_tokens, extra_stop_ids,
            temperature=temperature, request_id=request_id,
            no_spec=no_spec
        ):
            gen_tokens += 1
            detok.add_token(token)
            segment = detok.last_segment
            if not segment:
                continue

            if t_first is None:
                t_first = time.perf_counter()

            chunk = {
                "id": request_id, "object": "chat.completion.chunk", "model": model_name,
                "choices": [{"index": 0, "delta": {"content": segment}, "finish_reason": None}],
            }
            yield f"data: {json.dumps(chunk)}\n\n"

            if gen_tokens % 8 == 0:
                await asyncio.sleep(0)
    except Exception as e:
        print(f"[ERROR] Stream: {e}", file=sys.stderr, flush=True)
        traceback.print_exc()

    # Flush detokenizer
    detok.finalize()
    remaining_text = detok.last_segment
    if remaining_text:
        if t_first is None:
            t_first = time.perf_counter()
        chunk = {
            "id": request_id, "object": "chat.completion.chunk", "model": model_name,
            "choices": [{"index": 0, "delta": {"content": remaining_text}, "finish_reason": None}],
        }
        yield f"data: {json.dumps(chunk)}\n\n"

    full_text = detok.text
    async with _cache_lock:
        _persist_response_prefix(messages, full_text)

    # Usage chunk
    yield f"data: {json.dumps({'id': request_id, 'object': 'chat.completion.chunk', 'model': model_name, 'choices': [], 'usage': {'prompt_tokens': prompt_token_count, 'completion_tokens': gen_tokens, 'total_tokens': prompt_token_count + gen_tokens}})}\n\n"

    # Stop chunk
    chunk = {
        "id": request_id, "object": "chat.completion.chunk", "model": model_name,
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
    }
    yield f"data: {json.dumps(chunk)}\n\n"
    yield "data: [DONE]\n\n"

    t1 = time.perf_counter()
    gen_time = t1 - (t_first or t0)
    ttft = ((t_first or t1) - t0) * 1000
    tps = gen_tokens / max(gen_time, 0.001) if gen_tokens else 0
    print(f"[gen] {request_id} {gen_tokens} tok {t1-t0:.2f}s TTFT={ttft:.0f}ms {tps:.1f}tok/s")


# =====================================================================
# Health
# =====================================================================

@app.get("/health")
async def health():
    primary_slots = {
        k: {
            "tokens": len(v["tokens"]),
            "model_cache_bytes": cache_nbytes(v["model_cache"]),
            "draft_cache_bytes": cache_nbytes(v["draft_cache"]),
            "total_cache_bytes": cache_nbytes(v["model_cache"]) + cache_nbytes(v["draft_cache"]),
        }
        for k, v in _cache_slots.items()
    }
    prefix_slots = {
        k: {
            "tokens": len(v["tokens"]),
            "model_cache_bytes": cache_nbytes(v["model_cache"]),
            "draft_cache_bytes": cache_nbytes(v["draft_cache"]),
            "total_cache_bytes": cache_nbytes(v["model_cache"]) + cache_nbytes(v["draft_cache"]),
        }
        for k, v in _prefix_slots.items()
    }
    return {
        "status": "ok",
        "model": model_name,
        "speculative_decoding": True,
        "draft_model": DRAFT_MODEL_PATH.split("/")[-1] if DRAFT_MODEL_PATH else None,
        "num_draft_tokens": NUM_DRAFT_TOKENS,
        "cache_slots": primary_slots,
        "prefix_slots": prefix_slots,
        "cache_slots_used": len(_cache_slots),
        "cache_slots_max": MAX_CACHE_SLOTS,
        "prefix_slots_used": len(_prefix_slots),
        "prefix_slots_max": MAX_PREFIX_SLOTS,
        "total_cache_bytes": _total_slot_bytes(),
    }


# =====================================================================
# Main
# =====================================================================

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="MLX Cache Server v10 (speculative decoding, snapshot+restore+replay)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", type=str, default=DEFAULT_HOST)
    parser.add_argument(
        "--logs",
        dest="request_logs",
        action=argparse.BooleanOptionalAction,
        default=True,
        help=f"Enable request logging under {REQUEST_LOG_DIR} (use --no-logs to disable).",
    )
    args = parser.parse_args()
    REQUEST_LOG_ENABLED = args.request_logs
    uvicorn.run(app, host=args.host, port=args.port)
