#!/usr/bin/env python3
"""Optimized Kokoro TTS server owned by openElinaro.

Endpoints:
- POST /v1/audio/speech
- GET  /health

This is adapted into the repo from the earlier Elinaro/OpenClaw Kokoro path so
the voice runtime can live fully inside openElinaro.
"""

from __future__ import annotations

import io
import logging
import os
import re
import struct
import time
from typing import AsyncGenerator

import mlx.core as mx
import numpy as np
import uvicorn
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("openelinaro-kokoro")

REPO_ID = "mlx-community/Kokoro-82M-bf16"
DEFAULT_VOICE = "am_fenrir"
PORT = int(os.getenv("OPENELINARO_KOKORO_PORT", "8801"))
HOST = os.getenv("OPENELINARO_KOKORO_HOST", "0.0.0.0")

app = FastAPI()

model = None
pipeline = None
voice_cache: dict[str, mx.array] = {}


class SpeechRequest(BaseModel):
    model: str = REPO_ID
    input: str
    voice: str | None = DEFAULT_VOICE
    speed: float = 1.0
    lang_code: str = "a"
    response_format: str = "wav"


def load():
    global model, pipeline
    from mlx_audio.utils import load_model

    log.info("Loading Kokoro model...")
    started_at = time.perf_counter()
    model = load_model(REPO_ID)
    pipeline = model._get_pipeline("a")
    get_voice(DEFAULT_VOICE)
    for text in ["Hello", "Testing warmup"]:
        for _gs, ps, _tks in pipeline.en_tokenize(pipeline.g2p(text)[1]):
            _ = model(ps, voice_cache[DEFAULT_VOICE][len(ps) - 1], 1.0, return_output=True)
    mx.clear_cache()
    log.info("Kokoro ready in %.1fs", time.perf_counter() - started_at)


def get_voice(voice_name: str) -> mx.array:
    if voice_name not in voice_cache:
        voice_cache[voice_name] = pipeline.load_voice(voice_name)
    return voice_cache[voice_name]


def split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?;:\u2026])\s+", text.strip())
    sentences: list[str] = []
    for part in parts:
        normalized = part.strip()
        if not normalized:
            continue
        if len(normalized) < 10 and sentences:
            sentences[-1] = f"{sentences[-1]} {normalized}"
        else:
            sentences.append(normalized)
    return sentences if sentences else [text]


def pcm16_bytes(audio_mx: mx.array) -> bytes:
    audio_np = np.array(audio_mx, copy=False)
    return (audio_np * 32767).astype(np.int16).tobytes()


def wav_header(sample_rate: int, data_size: int = 0xFFFFFFFF - 36) -> bytes:
    buf = io.BytesIO()
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + data_size))
    buf.write(b"WAVE")
    buf.write(b"fmt ")
    buf.write(struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16))
    buf.write(b"data")
    buf.write(struct.pack("<I", data_size))
    return buf.getvalue()


async def generate_wav_stream(text: str, voice_name: str, speed: float) -> AsyncGenerator[bytes, None]:
    pack = get_voice(voice_name)
    sample_rate = model.config.sample_rate
    yield wav_header(sample_rate)
    for sentence in split_sentences(text):
        _phonemes, tokens = pipeline.g2p(sentence)
        for _gs, ps, _tks in pipeline.en_tokenize(tokens):
            if not ps:
                continue
            if len(ps) > 510:
                ps = ps[:510]
            output = model(ps, pack[len(ps) - 1], speed, return_output=True)
            audio = output.audio
            if audio.ndim == 2:
                audio = audio[0]
            yield pcm16_bytes(audio)


@app.post("/v1/audio/speech")
async def tts_speech(payload: SpeechRequest):
    voice = payload.voice or DEFAULT_VOICE
    response_format = payload.response_format or "wav"
    if response_format != "wav":
        raise ValueError("openElinaro Kokoro server currently serves wav only")
    return StreamingResponse(
        generate_wav_stream(payload.input, voice, payload.speed),
        media_type="audio/wav",
        headers={"Content-Disposition": "attachment; filename=speech.wav"},
    )


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": REPO_ID,
        "voices_cached": list(voice_cache.keys()),
    }


@app.on_event("startup")
async def startup():
    load()


if __name__ == "__main__":
    uvicorn.run(
        "__main__:app",
        host=HOST,
        port=PORT,
        workers=1,
        loop="asyncio",
        log_level="info",
    )
