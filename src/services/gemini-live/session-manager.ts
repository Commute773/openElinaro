/**
 * Gemini Live API session configuration and credential resolution.
 *
 * Extracts the pure configuration-building and credential-loading logic from
 * the main GeminiLivePhoneService so it can be tested and understood in
 * isolation.
 */

import { Modality } from "@google/genai";
import { getRuntimeConfig } from "../../config/runtime-config";
import { DEFAULT_PROFILE_ID as DEFAULT_SECRET_PROFILE_ID } from "../../config/service-constants";
import {
  buildPhoneCallStartPrompt,
  buildPhoneCallSystemInstruction,
} from "../phone-call-prompts";
import type { SecretStoreService } from "../infrastructure/secret-store-service";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_GEMINI_SECRET_REF = "gemini.apiKey";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
const DEFAULT_CALLER_PREFIX_PADDING_MS = 20;
const DEFAULT_CALLER_SILENCE_DURATION_MS = 100;
const DEFAULT_GEMINI_LIVE_THINKING_BUDGET = 0;

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

export function resolveGeminiApiKey(secrets: SecretStoreService) {
  const gemini = getRuntimeConfig().communications.geminiLive;
  const secretRef = gemini.apiKeySecretRef || DEFAULT_GEMINI_SECRET_REF;
  const profileId = gemini.secretProfileId || DEFAULT_SECRET_PROFILE_ID;
  return secrets.resolveSecretRef(secretRef, profileId);
}

export function resolveModel() {
  return (
    getRuntimeConfig().communications.geminiLive.model.trim() ||
    DEFAULT_GEMINI_MODEL
  );
}

// ---------------------------------------------------------------------------
// Activity detection parameters
// ---------------------------------------------------------------------------

export function resolveCallerPrefixPaddingMs() {
  const raw = getRuntimeConfig().communications.geminiLive.prefixPaddingMs;
  return Number.isFinite(raw) ? raw : DEFAULT_CALLER_PREFIX_PADDING_MS;
}

export function resolveCallerSilenceDurationMs() {
  const raw = getRuntimeConfig().communications.geminiLive.silenceDurationMs;
  return Number.isFinite(raw) ? raw : DEFAULT_CALLER_SILENCE_DURATION_MS;
}

// ---------------------------------------------------------------------------
// Speech config
// ---------------------------------------------------------------------------

export function buildSpeechConfig() {
  const voiceName =
    getRuntimeConfig().communications.geminiLive.voiceName?.trim();
  if (!voiceName) {
    return undefined;
  }
  return {
    voiceConfig: {
      prebuiltVoiceConfig: { voiceName },
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

export function buildSystemInstruction(operatorInstructions: string) {
  return buildPhoneCallSystemInstruction(operatorInstructions);
}

export function buildCallStartPrompt(operatorInstructions: string) {
  return buildPhoneCallStartPrompt(operatorInstructions);
}

// ---------------------------------------------------------------------------
// Full Gemini connect config builder
// ---------------------------------------------------------------------------

export function buildGeminiConnectConfig(operatorInstructions: string) {
  return {
    responseModalities: [Modality.AUDIO],
    systemInstruction: buildSystemInstruction(operatorInstructions),
    generationConfig: {
      thinkingConfig: {
        thinkingBudget: DEFAULT_GEMINI_LIVE_THINKING_BUDGET,
      },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        prefixPaddingMs: resolveCallerPrefixPaddingMs(),
        silenceDurationMs: resolveCallerSilenceDurationMs(),
      },
    },
    speechConfig: buildSpeechConfig(),
  };
}
