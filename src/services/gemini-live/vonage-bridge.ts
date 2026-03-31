/**
 * Vonage call-event processing and call-index persistence for Gemini live
 * phone calls.
 *
 * Extracts the voice-event status mapping, call-index read/write, URL
 * helpers, and session-failure logic from the main GeminiLivePhoneService.
 */

import fs from "node:fs";
import { attemptOr } from "../../utils/result";
import { normalizeString } from "../../utils/text-utils";
import { timestamp as nowIso } from "../../utils/timestamp";
import { getVonageWebhookPath } from "../vonage-service";
import {
  type LiveCallLatencyProfile,
  withSetupMetric,
} from "./latency-tracker";
import {
  appendTranscriptLog,
  ensureLivePhoneRoot,
  getCallIndexPath,
} from "./phone-transcript";
// ---------------------------------------------------------------------------
// Session status type (mirrors the union from index.ts to avoid circular import)
// ---------------------------------------------------------------------------

type GeminiLivePhoneStatus =
  | "creating"
  | "dialing"
  | "connecting"
  | "active"
  | "completed"
  | "failed";

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

export function toWebSocketUrl(baseUrl: string, pathname: string) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function decodePathSegment(value: string) {
  return attemptOr(() => decodeURIComponent(value), value);
}

export function getSessionWebSocketPath(sessionId: string) {
  return `${getVonageWebhookPath("voice.answer").replace(/\/answer$/, "")}/live/${encodeURIComponent(sessionId)}`;
}

export function resolveSessionIdFromPath(pathname: string) {
  const marker = `${getVonageWebhookPath("voice.answer").replace(/\/answer$/, "")}/live/`;
  if (!pathname.startsWith(marker)) {
    return null;
  }
  const encoded = pathname.slice(marker.length).split("/")[0]?.trim() ?? "";
  if (!encoded) {
    return null;
  }
  return decodePathSegment(encoded);
}

// ---------------------------------------------------------------------------
// Call index persistence
// ---------------------------------------------------------------------------

export function readCallIndex(callId: string) {
  ensureLivePhoneRoot();
  const indexPath = getCallIndexPath();
  if (!fs.existsSync(indexPath)) {
    return null;
  }
  const index = JSON.parse(
    fs.readFileSync(indexPath, "utf8"),
  ) as Record<string, string>;
  return normalizeString(index[callId]);
}

export function writeCallIndex(callId: string, sessionId: string) {
  ensureLivePhoneRoot();
  const indexPath = getCallIndexPath();
  const current = fs.existsSync(indexPath)
    ? (JSON.parse(fs.readFileSync(indexPath, "utf8")) as Record<
        string,
        string
      >)
    : {};
  current[callId] = sessionId;
  fs.writeFileSync(
    indexPath,
    `${JSON.stringify(current, null, 2)}\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// Voice event status mapping
// ---------------------------------------------------------------------------

/**
 * Terminal voice-event statuses that indicate the call has ended.
 */
const TERMINAL_STATUSES = new Set([
  "completed",
  "disconnected",
  "rejected",
  "busy",
  "timeout",
  "failed",
]);

/**
 * Maps a Vonage voice-event status to an updated latency profile by recording
 * the appropriate setup timestamp.
 */
export function applyVoiceEventToLatency(
  latency: LiveCallLatencyProfile,
  status: string,
  timestamp: string,
): LiveCallLatencyProfile {
  if (status === "ringing") {
    return withSetupMetric(latency, "ringingAt", timestamp);
  }
  if (status === "started") {
    return withSetupMetric(latency, "startedAt", timestamp);
  }
  if (status === "answered") {
    return withSetupMetric(latency, "answeredAt", timestamp);
  }
  if (TERMINAL_STATUSES.has(status)) {
    return withSetupMetric(latency, "callEndedAt", timestamp);
  }
  return latency;
}

/**
 * Derives the new session status from the current session status and the
 * incoming Vonage voice-event status string.
 */
export function deriveSessionStatus(
  currentStatus: GeminiLivePhoneStatus,
  eventStatus: string,
): GeminiLivePhoneStatus {
  if (eventStatus === "failed") {
    return "failed";
  }
  if (
    eventStatus === "answered" ||
    eventStatus === "ringing" ||
    eventStatus === "started"
  ) {
    if (currentStatus === "failed") {
      return "failed";
    }
    return eventStatus === "answered" ? "active" : currentStatus;
  }
  if (TERMINAL_STATUSES.has(eventStatus)) {
    return currentStatus === "failed" ? "failed" : "completed";
  }
  return currentStatus;
}

/**
 * Returns whether the given Vonage voice-event status string represents a
 * terminal (call-ended) event.
 */
export function isTerminalVoiceStatus(status: string) {
  return TERMINAL_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// Transcript logging for voice events
// ---------------------------------------------------------------------------

/**
 * Appends the voice-event payload and optional latency-setup log entries to
 * the session's transcript log.
 */
export function logVoiceEvent(
  sessionId: string,
  status: string,
  detail: string | null,
  payload: Record<string, unknown>,
  latencySetup: LiveCallLatencyProfile["setup"],
) {
  const timestamp = nowIso();
  appendTranscriptLog(sessionId, {
    timestamp,
    type: "voice.event",
    status,
    detail,
    payload,
  });
  if (
    status === "ringing" ||
    status === "answered" ||
    status === "completed" ||
    status === "failed"
  ) {
    appendTranscriptLog(sessionId, {
      timestamp,
      type: "latency.setup",
      status,
      createToRingingMs: latencySetup.createToRingingMs,
      createToAnsweredMs: latencySetup.createToAnsweredMs,
      answeredToVonageWebsocketMs: latencySetup.answeredToVonageWebsocketMs,
    });
  }
}
