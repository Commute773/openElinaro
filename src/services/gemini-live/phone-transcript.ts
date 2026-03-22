/**
 * Transcript management for Gemini live phone calls.
 *
 * Includes:
 * - Transcript types
 * - Transcript log persistence (append to JSONL files)
 * - End-call trigger phrase detection
 */

import fs from "node:fs";
import path from "node:path";
import { resolveRuntimePath } from "../runtime-root";
import { END_CALL_TRIGGER_PHRASES } from "../phone-call-prompts";

export const LIVE_PHONE_ROOT = ["communications", "live-calls"] as const;
export const DEFAULT_TRANSCRIPT_FILE_NAME = "transcript.log";

export type GeminiTranscriptState = {
  text: string;
  finished: boolean;
};

export type TranscriptLogEntry = {
  timestamp: string;
  type: string;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function ensureLivePhoneRoot() {
  fs.mkdirSync(resolveRuntimePath(...LIVE_PHONE_ROOT), { recursive: true });
}

export function getSessionDir(sessionId: string) {
  return resolveRuntimePath(...LIVE_PHONE_ROOT, sessionId);
}

export function getSessionPath(sessionId: string) {
  return path.join(getSessionDir(sessionId), "session.json");
}

export function getTranscriptLogPath(sessionId: string) {
  return path.join(getSessionDir(sessionId), DEFAULT_TRANSCRIPT_FILE_NAME);
}

export function getCallIndexPath() {
  return resolveRuntimePath(...LIVE_PHONE_ROOT, "call-index.json");
}

// ---------------------------------------------------------------------------
// Transcript log persistence
// ---------------------------------------------------------------------------

export function appendTranscriptLog(
  sessionId: string,
  entry: TranscriptLogEntry,
) {
  ensureLivePhoneRoot();
  const transcriptLogPath = getTranscriptLogPath(sessionId);
  fs.mkdirSync(path.dirname(transcriptLogPath), { recursive: true });
  fs.appendFileSync(transcriptLogPath, `${JSON.stringify(entry)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// End-call trigger phrase detection
// ---------------------------------------------------------------------------

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeForPhraseMatch(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function containsEndCallTrigger(text: string) {
  const normalized = normalizeForPhraseMatch(text);
  if (!normalized) {
    return false;
  }
  return END_CALL_TRIGGER_PHRASES.some((phrase) => {
    const pattern =
      phrase === "bye"
        ? /\bbye\b/i
        : new RegExp(escapeRegExp(phrase), "i");
    return pattern.test(normalized);
  });
}
