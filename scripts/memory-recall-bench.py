#!/usr/bin/env python3
"""
Benchmark KV-cache-persistent memory recall with Qwen3.5-4B on MLX.

Loads all memory markdown files into a system prompt, prefills the model,
saves the KV cache to disk with a content hash. On subsequent runs, if the
hash matches, loads the warm cache from disk and skips prefill.

Uses mlx-lm's built-in save_prompt_cache/load_prompt_cache which correctly
handle hybrid architectures (KVCache for full-attention layers, ArraysCache
for linear-attention/GatedDeltaNet layers).

Usage:
  python3 scripts/memory-recall-bench.py
  python3 scripts/memory-recall-bench.py --cold   # force cold run
  python3 scripts/memory-recall-bench.py --query "What is Nik working on?"
"""

import argparse
import hashlib
import os
import time
from pathlib import Path

import mlx.core as mx
from mlx_lm import load
from mlx_lm.models.cache import make_prompt_cache, save_prompt_cache, load_prompt_cache

MODEL_ID = os.getenv("BENCH_MODEL", "mlx-community/Qwen3.5-4B-MLX-4bit")
MEMORY_ROOT = Path.home() / ".openelinaro" / "memory" / "root"
CACHE_DIR = Path.home() / ".openelinaro" / "memory" / "kv-cache"

SYSTEM_PREFIX = (
    "You are a memory recall agent. Below is a corpus of memory documents. "
    "When the user asks, return relevant memories as JSON.\n\n## Memory Corpus\n\n"
)
USER_PREFIX = (
    'Which memories from the corpus are relevant to the following message? '
    'Return a JSON array (max 5 entries).\n'
    'Each entry: { "path": "relative/path.md", "heading": "title", '
    '"content": "1-3 line excerpt", "reason": "why relevant" }\n'
    'Return [] if nothing is relevant. JSON only, no markdown fences, no explanation text.\n\n'
    'User message: '
)

SKIP_DIRS = {"identity", "compactions"}
SKIP_FILES = {"INDEX.md"}

MAX_CORPUS_CHARS = 800_000  # ~248K tokens, fits in 262K window with room for prompt


def collect_corpus(root: Path) -> str:
    """Collect all markdown files into a single corpus string."""
    segments = []
    seen = set()
    total_chars = 0

    # Prioritize structured, then core, then everything else
    priority_dirs = [root / "structured", root / "core", root / "auto", root]

    def walk(d: Path):
        nonlocal total_chars
        if not d.is_dir():
            return
        for entry in sorted(d.iterdir()):
            if total_chars >= MAX_CORPUS_CHARS:
                return
            if entry in seen:
                continue
            if entry.is_dir():
                if entry.name in SKIP_DIRS:
                    continue
                walk(entry)
                continue
            if not entry.name.endswith(".md") or entry.name in SKIP_FILES:
                continue
            seen.add(entry)
            try:
                content = entry.read_text().strip()
                if not content:
                    continue
                rel = entry.relative_to(root)
                segment = f"### {rel}\n{content}"
                if total_chars + len(segment) > MAX_CORPUS_CHARS:
                    return
                segments.append(segment)
                total_chars += len(segment)
            except Exception:
                pass

    for d in priority_dirs:
        if total_chars >= MAX_CORPUS_CHARS:
            break
        walk(d)

    return "\n\n".join(segments)


def hash_corpus(corpus: str) -> str:
    return hashlib.sha256(corpus.encode()).hexdigest()[:16]


def cache_file_path(model_id: str) -> Path:
    """Return the .safetensors cache path for the given model."""
    model_name = model_id.split("/")[-1]
    cache_dir = CACHE_DIR / model_name
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / "prompt_cache.safetensors"


def find_split_index(full_tokens, system_prompt, tokenizer):
    """Find the token index where the system prompt ends and user turn begins.

    Tokenizes a dummy message with the same system prompt, then finds the
    longest common prefix between the two tokenizations.
    """
    dummy_chat = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": "SPLIT_MARKER"},
    ]
    dummy_tokens = tokenizer.apply_chat_template(
        dummy_chat, tokenize=True, add_generation_prompt=True
    )
    split_idx = 0
    for i in range(min(len(full_tokens), len(dummy_tokens))):
        if full_tokens[i] != dummy_tokens[i]:
            break
        split_idx = i + 1
    return split_idx


def prefill(model, tokens, cache):
    """Run prefill on tokens in chunks, populating the cache. Returns last logits."""
    CHUNK = 512
    logits = None
    for start in range(0, len(tokens), CHUNK):
        end = min(start + CHUNK, len(tokens))
        chunk = mx.array([tokens[start:end]])
        logits = model(chunk, cache=cache)
        mx.eval(logits)
    return logits


def generate(model, tokenizer, prompt_tokens, cache, max_tokens=512):
    """Prefill prompt_tokens through cache, then decode up to max_tokens."""
    logits = prefill(model, prompt_tokens, cache)

    tokens = []
    next_token = mx.argmax(logits[:, -1, :], axis=-1)

    for _ in range(max_tokens):
        t = next_token.item()
        if t == tokenizer.eos_token_id:
            break
        tokens.append(t)
        logits = model(next_token.reshape(1, 1), cache=cache)
        mx.eval(logits)
        next_token = mx.argmax(logits[:, -1, :], axis=-1)

    return tokenizer.decode(tokens)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cold", action="store_true", help="Force cold run (ignore cached KV)")
    parser.add_argument("--query", default="What is Niks email?", help="Query to test")
    args = parser.parse_args()

    print(f"Loading model {MODEL_ID}...")
    t0 = time.time()
    model, tokenizer = load(MODEL_ID)
    print(f"Model loaded in {time.time() - t0:.1f}s")

    if mx.metal.is_available():
        max_rec = mx.device_info()["max_recommended_working_set_size"]
        mx.set_wired_limit(max_rec)
        print(f"Wired limit: {max_rec / 1e9:.1f}GB")

    # Build corpus
    print("Building corpus...")
    corpus = collect_corpus(MEMORY_ROOT)
    corpus_hash = hash_corpus(corpus)
    print(f"Corpus: {len(corpus):,} chars, hash={corpus_hash}")

    # Build the full prompt
    system_prompt = SYSTEM_PREFIX + corpus
    user_message = USER_PREFIX + args.query

    full_chat = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_message},
    ]
    full_tokens = tokenizer.apply_chat_template(
        full_chat, tokenize=True, add_generation_prompt=True
    )

    split_idx = find_split_index(full_tokens, system_prompt, tokenizer)
    system_tokens = full_tokens[:split_idx]
    user_tokens = full_tokens[split_idx:]

    print(f"System tokens: {len(system_tokens):,}")
    print(f"User tokens: {len(user_tokens):,}")
    print(f"Total tokens: {len(full_tokens):,}")

    cache_path = cache_file_path(MODEL_ID)
    warm_cache = None

    if not args.cold and cache_path.exists():
        print(f"\nLoading cached prompt from {cache_path}...")
        t_load_start = time.time()
        try:
            loaded_cache, metadata = load_prompt_cache(
                str(cache_path), return_metadata=True
            )
            stored_hash = metadata.get("corpus_hash", "")
            if stored_hash == corpus_hash:
                warm_cache = loaded_cache
                load_time = time.time() - t_load_start
                print(f"  Warm cache loaded in {load_time:.1f}s (hash={stored_hash})")
            else:
                print(f"  Hash mismatch: stored={stored_hash}, current={corpus_hash}")
        except Exception as e:
            print(f"  Failed to load cache: {e}")

    # --- COLD RUN ---
    if warm_cache is None:
        print(f"\n=== COLD RUN (prefill {len(system_tokens):,} system tokens) ===")
        cache = make_prompt_cache(model)

        t_prefill_start = time.time()
        prefill(model, system_tokens, cache)
        t_prefill_end = time.time()
        prefill_time = t_prefill_end - t_prefill_start
        prefill_tps = len(system_tokens) / prefill_time

        print(f"  Prefill: {prefill_time:.1f}s ({prefill_tps:.0f} tok/s)")

        # Save to disk using mlx-lm's built-in serialization
        print(f"  Saving prompt cache to {cache_path}...")
        t_save_start = time.time()
        save_prompt_cache(
            str(cache_path),
            cache,
            metadata={
                "corpus_hash": corpus_hash,
                "prompt_tokens": str(len(system_tokens)),
                "model_id": MODEL_ID,
            },
        )
        save_time = time.time() - t_save_start
        cache_size = cache_path.stat().st_size / 1024 / 1024
        print(f"  Save: {save_time:.1f}s, cache size: {cache_size:.0f}MB")

        # Generate with the cold cache
        print(f"  Generating response...")
        t_gen_start = time.time()
        response = generate(model, tokenizer, user_tokens, cache, max_tokens=512)
        gen_time = time.time() - t_gen_start
        total_cold = time.time() - t_prefill_start

        print(f"  Generation: {gen_time:.1f}s")
        print(f"  Total cold: {total_cold:.1f}s")
        print(f"  Response: {response[:500]}")

        # Now do warm run from the saved cache
        print(f"\n=== WARM RUN (load from disk + generate) ===")
        t_load_start = time.time()
        try:
            loaded_cache = load_prompt_cache(str(cache_path))
            t_load_end = time.time()
            load_time = t_load_end - t_load_start
            print(f"  Load: {load_time:.1f}s")

            t_gen_start = time.time()
            response2 = generate(model, tokenizer, user_tokens, loaded_cache, max_tokens=512)
            gen_time2 = time.time() - t_gen_start
            total_warm = time.time() - t_load_start

            print(f"  Generation: {gen_time2:.1f}s")
            print(f"  Total warm: {total_warm:.1f}s")
            print(f"  Speedup: {total_cold / total_warm:.1f}x")
            print(f"  Response: {response2[:500]}")
        except Exception as e:
            print(f"  ERROR loading saved cache: {e}")
    else:
        # Warm cache loaded successfully
        print(f"\n=== WARM RUN (loaded from disk) ===")
        t_gen_start = time.time()
        response = generate(model, tokenizer, user_tokens, warm_cache, max_tokens=512)
        gen_time = time.time() - t_gen_start
        print(f"  Generation: {gen_time:.1f}s")
        print(f"  Response: {response[:500]}")

    # Memory stats
    import resource
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024 / 1024
    print(f"\nPeak RSS: {rss:.0f}MB")


if __name__ == "__main__":
    main()
