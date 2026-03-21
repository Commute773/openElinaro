#!/usr/bin/env python3
"""
MLX Batch Inference Server — keeps model warm, serves batch requests.

Exposes:
  POST /v1/batch   — batch inference (multiple prompts → multiple completions)
  POST /v1/chat/completions — single OpenAI-compatible endpoint (for compatibility)
  GET  /health     — health check

The model stays loaded in memory. No speculative decoding — pure batch throughput.
Uses mlx-lm's BatchGenerator for concurrent sequence processing.
"""

import argparse
import asyncio
import copy
import json
import os
import time
import traceback
from typing import Optional, List, Union
from pathlib import Path

import mlx.core as mx
import mlx.nn as nn
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from contextlib import asynccontextmanager

from mlx_lm.utils import load
from mlx_lm.models.cache import make_prompt_cache
from mlx_lm.generate import (
    BatchGenerator,
    batch_generate,
    generate_step,
    generation_stream,
)
from mlx_lm.sample_utils import make_sampler
from mlx_lm.tokenizer_utils import TokenizerWrapper

# --- Configuration ---
DEFAULT_MODEL_CACHE_ROOT = Path.home() / ".cache" / "mlx-models"
DEFAULT_MODEL_PATH = os.getenv(
    "OPENELINARO_LOCAL_LLM_BATCH_MODEL_PATH",
    os.getenv(
        "OPENELINARO_LOCAL_LLM_MODEL_PATH",
        str(DEFAULT_MODEL_CACHE_ROOT / "Qwen3.5-35B-A3B-4bit-textonly"),
    ),
)
DEFAULT_PORT = int(
    os.getenv(
        "OPENELINARO_LOCAL_LLM_BATCH_PORT",
        os.getenv("MLX_BATCH_PORT", "8802"),
    )
)
DEFAULT_HOST = os.getenv("OPENELINARO_LOCAL_LLM_BATCH_HOST", "0.0.0.0")

# Think suppression tokens
THINK_OPEN = "<think>"
THINK_CLOSE = "</think>"

# Globals
model = None
tokenizer = None
model_name = "qwen3.5-35b-a3b"
_inference_lock = None  # serialize access to model


# =====================================================================
# Lifespan
# =====================================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    global model, tokenizer, model_name, _inference_lock

    _inference_lock = asyncio.Lock()

    model_path = app.state.model_path
    model_name = Path(model_path).name

    print(f"Loading model from {model_path}...")
    t0 = time.time()
    model, tokenizer = load(model_path)
    if not isinstance(tokenizer, TokenizerWrapper):
        tokenizer = TokenizerWrapper(tokenizer)

    if mx.metal.is_available():
        max_rec = mx.device_info()["max_recommended_working_set_size"]
        mx.set_wired_limit(max_rec)
        print(f"Wired limit set to {max_rec / 1e9:.1f}GB")

    n_layers = len(model.layers)
    print(f"Model loaded in {time.time() - t0:.1f}s ({n_layers} layers)")

    yield

    print("Shutting down batch server...")


app = FastAPI(lifespan=lifespan)


# =====================================================================
# Request models
# =====================================================================
class BatchRequest(BaseModel):
    prompts: List[str] = Field(..., description="List of raw text prompts")
    max_tokens: int = Field(256, description="Max tokens per response")
    temperature: float = Field(0.0, description="Sampling temperature")
    top_p: float = Field(1.0, description="Top-p sampling")
    suppress_thinking: bool = Field(True, description="Suppress <think> blocks")
    prefill_batch_size: int = Field(8, description="Prefill batch size")
    completion_batch_size: int = Field(32, description="Completion batch size")


class ChatRequest(BaseModel):
    model: str = "default"
    messages: list
    max_tokens: int = 256
    temperature: float = 0.0
    top_p: float = 1.0


# =====================================================================
# Think suppression
# =====================================================================
def apply_think_suppression(messages: list) -> list:
    """Add force-empty think block to suppress model reasoning."""
    result = list(messages)
    result.append({
        "role": "assistant",
        "content": f"{THINK_OPEN}\n{THINK_CLOSE}\n",
    })
    return result


def strip_think_tokens(text: str) -> str:
    """Remove any <think>...</think> blocks from output."""
    import re
    text = re.sub(r"<think>.*?</think>\s*", "", text, flags=re.DOTALL)
    return text.strip()


# =====================================================================
# Batch inference
# =====================================================================
def run_batch_inference(
    prompts: List[str],
    max_tokens: int = 256,
    temperature: float = 0.0,
    top_p: float = 1.0,
    suppress_thinking: bool = True,
    prefill_batch_size: int = 8,
    completion_batch_size: int = 32,
) -> dict:
    """Run batch inference on multiple prompts simultaneously.

    IMPORTANT: /v1/batch treats prompts as RAW text completions, not chat messages.
    This is intentional so structured prompts (classification, extraction, etc.)
    don't get mangled by a chat template.
    """

    # Tokenize all prompts as raw completions
    token_lists = []
    for prompt in prompts:
        text = prompt
        if suppress_thinking and "<think>" not in text:
            # Mild suppression hint for reasoning models without forcing chat template
            text = text + "\n\nDo not output <think> tags. Respond directly."
        tokens = tokenizer.encode(text)
        token_lists.append(tokens)

    t0 = time.time()

    # Create sampler
    if temperature == 0:
        sampler = lambda x: mx.argmax(x, axis=-1)
    else:
        from mlx_lm.sample_utils import make_sampler
        sampler = make_sampler(temperature, top_p=top_p)

    # Run batch generation
    gen = BatchGenerator(
        model,
        stop_tokens=set(tokenizer.eos_token_ids),
        sampler=sampler,
        prefill_batch_size=prefill_batch_size,
        completion_batch_size=completion_batch_size,
        max_tokens=max_tokens,
    )

    uids = gen.insert(token_lists, [max_tokens] * len(token_lists))
    results = {uid: [] for uid in uids}

    while responses := gen.next():
        for r in responses:
            if r.finish_reason != "stop":
                results[r.uid].append(r.token)

    stats = gen.stats()
    gen.close()

    elapsed = time.time() - t0

    # Decode results in order
    texts = []
    for uid in uids:
        text = tokenizer.decode(results[uid])
        if suppress_thinking:
            text = strip_think_tokens(text)
        texts.append(text)

    return {
        "results": texts,
        "stats": {
            "num_prompts": len(prompts),
            "total_prompt_tokens": stats.prompt_tokens,
            "total_generation_tokens": stats.generation_tokens,
            "prompt_tps": round(stats.prompt_tps, 1),
            "generation_tps": round(stats.generation_tps, 1),
            "elapsed_seconds": round(elapsed, 3),
            "avg_prompt_tokens": round(stats.prompt_tokens / len(prompts), 1),
            "avg_generation_tokens": round(stats.generation_tokens / len(prompts), 1),
        },
    }


# =====================================================================
# Single inference (for compatibility)
# =====================================================================
def run_single_inference(
    messages: list,
    max_tokens: int = 256,
    temperature: float = 0.0,
    top_p: float = 1.0,
) -> dict:
    """Run single inference for OpenAI-compatible endpoint."""

    text = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
    tokens = tokenizer.encode(text)

    t0 = time.time()

    if temperature == 0:
        sampler = lambda x: mx.argmax(x, axis=-1)
    else:
        sampler = make_sampler(temperature, top_p=top_p)

    prompt_cache = make_prompt_cache(model)
    output_tokens = []
    eos = set(tokenizer.eos_token_ids)

    for token, _ in generate_step(
        mx.array(tokens),
        model,
        temp=temperature,
        top_p=top_p,
        prompt_cache=prompt_cache,
    ):
        if token in eos:
            break
        output_tokens.append(token)
        if len(output_tokens) >= max_tokens:
            break

    elapsed = time.time() - t0
    result_text = tokenizer.decode(output_tokens)

    return {
        "text": result_text,
        "prompt_tokens": len(tokens),
        "completion_tokens": len(output_tokens),
        "elapsed": round(elapsed, 3),
    }


# =====================================================================
# Endpoints
# =====================================================================
@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": model_name,
        "model_loaded": model is not None,
    }


@app.post("/v1/batch")
async def batch_endpoint(req: BatchRequest):
    async with _inference_lock:
        try:
            result = await asyncio.to_thread(
                run_batch_inference,
                prompts=req.prompts,
                max_tokens=req.max_tokens,
                temperature=req.temperature,
                top_p=req.top_p,
                suppress_thinking=req.suppress_thinking,
                prefill_batch_size=req.prefill_batch_size,
                completion_batch_size=req.completion_batch_size,
            )
            return JSONResponse(result)
        except Exception as e:
            traceback.print_exc()
            return JSONResponse({"error": str(e)}, status_code=500)


@app.post("/v1/chat/completions")
async def chat_completions(req: ChatRequest):
    async with _inference_lock:
        try:
            result = await asyncio.to_thread(
                run_single_inference,
                messages=req.messages,
                max_tokens=req.max_tokens,
                temperature=req.temperature,
                top_p=req.top_p,
            )
            return JSONResponse({
                "id": f"chatcmpl-batch",
                "object": "chat.completion",
                "model": model_name,
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": result["text"],
                    },
                    "finish_reason": "stop",
                }],
                "usage": {
                    "prompt_tokens": result["prompt_tokens"],
                    "completion_tokens": result["completion_tokens"],
                    "total_tokens": result["prompt_tokens"] + result["completion_tokens"],
                },
            })
        except Exception as e:
            traceback.print_exc()
            return JSONResponse({"error": str(e)}, status_code=500)


# =====================================================================
# Benchmark endpoint
# =====================================================================
class BenchmarkRequest(BaseModel):
    batch_sizes: List[int] = Field([1, 2, 4, 8, 16, 32], description="Batch sizes to test")
    prompt_lengths: List[str] = Field(
        ["short", "medium", "long"],
        description="Prompt length categories to test",
    )
    max_tokens: int = Field(64, description="Max tokens per response")
    runs_per_config: int = Field(2, description="Runs per configuration")


BENCH_PROMPTS = {
    "short": [
        "What is 2+2?",
        "Name a color.",
        "Capital of France?",
        "What is gravity?",
        "Name a planet.",
        "What is DNA?",
        "Define entropy.",
        "What is pi?",
        "Name a metal.",
        "What is light?",
        "Define mass.",
        "What is water?",
        "Name a gas.",
        "What is heat?",
        "Define speed.",
        "What is sound?",
        "Name a fruit.",
        "What is ice?",
        "Define force.",
        "What is fire?",
        "Name a bird.",
        "What is rain?",
        "Define work.",
        "What is snow?",
        "Name a tree.",
        "What is wind?",
        "Define time.",
        "What is soil?",
        "Name a fish.",
        "What is air?",
        "Define area.",
        "What is fog?",
    ],
    "medium": [
        "Explain photosynthesis in 2-3 sentences.",
        "What causes tides on Earth?",
        "How does a bicycle stay upright?",
        "Why is the sky blue?",
        "How do vaccines work?",
        "What makes bread rise?",
        "How do airplanes fly?",
        "Why do we dream?",
        "How does WiFi work?",
        "What causes earthquakes?",
        "How do magnets work?",
        "Why do leaves change color?",
        "How does a refrigerator work?",
        "What is dark matter?",
        "How does GPS work?",
        "Why does salt melt ice?",
        "How do batteries work?",
        "What causes thunder?",
        "How does a microwave work?",
        "Why is space dark?",
        "How do speakers produce sound?",
        "What causes the northern lights?",
        "How does a compass work?",
        "Why do stars twinkle?",
        "How does soap clean?",
        "What causes static electricity?",
        "How do touch screens work?",
        "Why is the ocean salty?",
        "How does a laser work?",
        "What causes hiccups?",
        "How do 3D printers work?",
        "Why do we yawn?",
    ],
    "long": [
        "You are a service price classifier. Given a list of observed service labels from businesses, classify each into the correct service group. Here are the service groups for the Massage Therapy category:\n1. Swedish Massage (30 min)\n2. Swedish Massage (60 min)\n3. Swedish Massage (90 min)\n4. Deep Tissue Massage (60 min)\n5. Hot Stone Massage\n6. Prenatal Massage\n7. Sports Massage\n\nClassify these observations:\n- 'Massage suédois 60 min' → ",
        "You are a service price classifier for a Montreal business directory. Given a list of observed service labels from barbershops, classify each into the correct service group. Here are the service groups:\n1. Standard Haircut\n2. Fade / Taper\n3. Buzz Cut\n4. Beard Trim\n5. Haircut + Beard Combo\n6. Hot Towel Shave\n7. Children's Haircut\n\nClassify these observations:\n- 'Coupe classique' → ",
        "You are classifying prices from Montreal businesses. Determine if each observation is: (a) a service, (b) a retail product, (c) a combo/package, or (d) an add-on supplement.\n\nObservations:\n1. 'Davines OI Shampoo' - $21.00\n2. '60-Minute Therapeutic Massage' - $105.00\n3. 'Haircut + Beard + Black Mask' - $75.00\n4. 'Shellac Supplement' - $10.00\n\nClassify each:",
        "You are a service price classifier. Given a list of observed service labels from nail salons, classify each into the correct service group. Here are the service groups:\n1. Basic Manicure\n2. Gel Manicure\n3. Acrylic Full Set\n4. Pedicure\n5. Gel Pedicure\n6. Nail Art\n7. Gel Removal\n\nClassify these observations:\n- 'Manucure classique' → ",
    ] * 8,  # Repeat to have 32
}


@app.post("/v1/benchmark")
async def benchmark_endpoint(req: BenchmarkRequest):
    async with _inference_lock:
        results = []
        for prompt_len in req.prompt_lengths:
            prompts_pool = BENCH_PROMPTS.get(prompt_len, BENCH_PROMPTS["short"])
            for batch_size in req.batch_sizes:
                if batch_size > len(prompts_pool):
                    continue
                prompts = prompts_pool[:batch_size]

                run_results = []
                for run_idx in range(req.runs_per_config):
                    try:
                        result = await asyncio.to_thread(
                            run_batch_inference,
                            prompts=prompts,
                            max_tokens=req.max_tokens,
                            temperature=0.0,
                            suppress_thinking=True,
                            prefill_batch_size=min(batch_size, 8),
                            completion_batch_size=min(batch_size, 32),
                        )
                        run_results.append(result["stats"])
                    except Exception as e:
                        traceback.print_exc()
                        run_results.append({"error": str(e)})

                # Average stats across runs
                valid = [r for r in run_results if "error" not in r]
                if valid:
                    avg = {
                        "prompt_tps": round(sum(r["prompt_tps"] for r in valid) / len(valid), 1),
                        "generation_tps": round(sum(r["generation_tps"] for r in valid) / len(valid), 1),
                        "elapsed_seconds": round(sum(r["elapsed_seconds"] for r in valid) / len(valid), 3),
                        "total_prompt_tokens": round(sum(r["total_prompt_tokens"] for r in valid) / len(valid)),
                        "total_generation_tokens": round(sum(r["total_generation_tokens"] for r in valid) / len(valid)),
                    }
                    # Compute aggregate throughput
                    avg["aggregate_tps"] = round(
                        avg["total_generation_tokens"] / avg["elapsed_seconds"], 1
                    ) if avg["elapsed_seconds"] > 0 else 0
                else:
                    avg = {"error": "all runs failed"}

                results.append({
                    "prompt_length": prompt_len,
                    "batch_size": batch_size,
                    "avg_stats": avg,
                    "runs": run_results,
                })

                print(f"  {prompt_len} x{batch_size}: gen={avg.get('generation_tps', '?')} tps, "
                      f"agg={avg.get('aggregate_tps', '?')} tps, "
                      f"elapsed={avg.get('elapsed_seconds', '?')}s")

        return JSONResponse({"benchmark": results, "model": model_name})


# =====================================================================
# Main
# =====================================================================
def main():
    parser = argparse.ArgumentParser(description="MLX Batch Inference Server")
    parser.add_argument("--model", default=DEFAULT_MODEL_PATH, help="Model path")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Port")
    parser.add_argument("--host", default=DEFAULT_HOST, help="Host")
    args = parser.parse_args()

    app.state.model_path = args.model
    print(f"Starting MLX Batch Server on {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
