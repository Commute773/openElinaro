/**
 * Latency metrics collection and turn management for Gemini live phone calls.
 *
 * Includes:
 * - All latency-related types (`TurnLatencyMetrics`, `SetupLatencyMetrics`,
 *   `LiveCallLatencyProfile`, `LatencySummary`)
 * - Factory functions (`createLatencyProfile`, `emptyLatencySummary`)
 * - Setup metric updates (`withSetupMetric`)
 * - Summary recomputation (`recomputeLatencySummary`)
 * - Turn lifecycle helpers (`getOrStartInboundTurn`, `getActiveTurnForResponse`)
 * - Persistence throttle (`maybePersistLatency`)
 * - Utility functions shared across latency logic
 */

import { timestamp as nowIso } from "../../utils/timestamp";
import { type AudioStreamStats, emptyAudioStreamStats } from "./audio-stream";

// ---------------------------------------------------------------------------
// Utility helpers (pure, no side-effects)
// ---------------------------------------------------------------------------

export function nowMs() {
  return Date.now();
}

export function isoToMs(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function diffMs(
  start: string | null | undefined,
  end: string | null | undefined,
) {
  const startMs = isoToMs(start);
  const endMs = isoToMs(end);
  if (startMs === null || endMs === null) {
    return null;
  }
  return Math.max(0, endMs - startMs);
}

export function average(numbers: number[]) {
  if (numbers.length === 0) {
    return null;
  }
  return Math.round(
    numbers.reduce((sum, value) => sum + value, 0) / numbers.length,
  );
}

export function estimateInputLatencyBreakdown(
  postSpeechLatencyMs: number | null,
  silenceDurationMs: number,
) {
  if (postSpeechLatencyMs === null) {
    return {
      endpointingDelayMs: null,
      recognitionDelayMs: null,
    };
  }
  return {
    endpointingDelayMs: Math.max(
      0,
      Math.min(postSpeechLatencyMs, silenceDurationMs),
    ),
    recognitionDelayMs: Math.max(0, postSpeechLatencyMs - silenceDurationMs),
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TurnLatencyMetrics = {
  id: number;
  startedAt: string;
  completedAt: string | null;
  callerFirstAudioAt: string | null;
  callerLastAudioAt: string | null;
  callerLastAudioBeforeFirstTranscriptAt: string | null;
  callerFirstTranscriptAt: string | null;
  callerFinalTranscriptAt: string | null;
  callerTranscript: string | null;
  assistantFirstTranscriptAt: string | null;
  assistantFirstAudioAt: string | null;
  assistantTranscript: string | null;
  callerSpeechDurationBeforeFirstTranscriptMs: number | null;
  callerAudioToFirstTranscriptMs: number | null;
  callerAudioToFinalTranscriptMs: number | null;
  callerLastAudioToFirstTranscriptMs: number | null;
  estimatedEndpointingDelayMs: number | null;
  estimatedRecognitionDelayMs: number | null;
  generationDelayMs: number | null;
  assistantTranscriptToAudioMs: number | null;
  callerFinalToAssistantTranscriptMs: number | null;
  callerFinalToAssistantAudioMs: number | null;
  callerLastAudioToAssistantTranscriptMs: number | null;
  callerLastAudioToAssistantAudioMs: number | null;
};

export type SetupLatencyMetrics = {
  sessionCreatedAt: string;
  callCreatedAt: string | null;
  ringingAt: string | null;
  startedAt: string | null;
  answeredAt: string | null;
  vonageWebsocketOpenedAt: string | null;
  geminiWebsocketOpenedAt: string | null;
  mediaConnectedAt: string | null;
  firstAssistantTranscriptAt: string | null;
  firstAssistantAudioAt: string | null;
  callEndedAt: string | null;
  createToRingingMs: number | null;
  createToStartedMs: number | null;
  createToAnsweredMs: number | null;
  answeredToVonageWebsocketMs: number | null;
  vonageWebsocketToGeminiWebsocketMs: number | null;
  mediaConnectedToFirstAssistantTranscriptMs: number | null;
  mediaConnectedToFirstAssistantAudioMs: number | null;
};

export type SetupLatencyTimestampKey =
  | "callCreatedAt"
  | "ringingAt"
  | "startedAt"
  | "answeredAt"
  | "vonageWebsocketOpenedAt"
  | "geminiWebsocketOpenedAt"
  | "mediaConnectedAt"
  | "firstAssistantTranscriptAt"
  | "firstAssistantAudioAt"
  | "callEndedAt";

export type LatencySummary = {
  totalTurns: number;
  avgCallerSpeechDurationBeforeFirstTranscriptMs: number | null;
  avgCallerAudioToFirstTranscriptMs: number | null;
  avgCallerAudioToFinalTranscriptMs: number | null;
  avgCallerLastAudioToFirstTranscriptMs: number | null;
  avgEstimatedEndpointingDelayMs: number | null;
  avgEstimatedRecognitionDelayMs: number | null;
  avgGenerationDelayMs: number | null;
  avgAssistantTranscriptToAudioMs: number | null;
  avgCallerFinalToAssistantTranscriptMs: number | null;
  avgCallerFinalToAssistantAudioMs: number | null;
  avgCallerLastAudioToAssistantTranscriptMs: number | null;
  avgCallerLastAudioToAssistantAudioMs: number | null;
  inboundPackets: number;
  outboundPackets: number;
  inboundAvgGapMs: number | null;
  outboundAvgGapMs: number | null;
  inboundAvgChunkMs: number | null;
  outboundAvgChunkMs: number | null;
  maxPendingMessages: number;
  maxPendingBytes: number;
  maxPendingAudioMs: number;
};

export type LiveCallLatencyProfile = {
  setup: SetupLatencyMetrics;
  stream: {
    inboundAudio: AudioStreamStats;
    outboundAudio: AudioStreamStats;
  };
  turns: TurnLatencyMetrics[];
  summary: LatencySummary;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLatencyProfile(
  createdAt: string,
): LiveCallLatencyProfile {
  return {
    setup: {
      sessionCreatedAt: createdAt,
      callCreatedAt: null,
      ringingAt: null,
      startedAt: null,
      answeredAt: null,
      vonageWebsocketOpenedAt: null,
      geminiWebsocketOpenedAt: null,
      mediaConnectedAt: null,
      firstAssistantTranscriptAt: null,
      firstAssistantAudioAt: null,
      callEndedAt: null,
      createToRingingMs: null,
      createToStartedMs: null,
      createToAnsweredMs: null,
      answeredToVonageWebsocketMs: null,
      vonageWebsocketToGeminiWebsocketMs: null,
      mediaConnectedToFirstAssistantTranscriptMs: null,
      mediaConnectedToFirstAssistantAudioMs: null,
    },
    stream: {
      inboundAudio: emptyAudioStreamStats(),
      outboundAudio: emptyAudioStreamStats(),
    },
    turns: [],
    summary: {
      totalTurns: 0,
      avgCallerSpeechDurationBeforeFirstTranscriptMs: null,
      avgCallerAudioToFirstTranscriptMs: null,
      avgCallerAudioToFinalTranscriptMs: null,
      avgCallerLastAudioToFirstTranscriptMs: null,
      avgEstimatedEndpointingDelayMs: null,
      avgEstimatedRecognitionDelayMs: null,
      avgGenerationDelayMs: null,
      avgAssistantTranscriptToAudioMs: null,
      avgCallerFinalToAssistantTranscriptMs: null,
      avgCallerFinalToAssistantAudioMs: null,
      avgCallerLastAudioToAssistantTranscriptMs: null,
      avgCallerLastAudioToAssistantAudioMs: null,
      inboundPackets: 0,
      outboundPackets: 0,
      inboundAvgGapMs: null,
      outboundAvgGapMs: null,
      inboundAvgChunkMs: null,
      outboundAvgChunkMs: null,
      maxPendingMessages: 0,
      maxPendingBytes: 0,
      maxPendingAudioMs: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Setup metric updates
// ---------------------------------------------------------------------------

export function withSetupMetric(
  latency: LiveCallLatencyProfile,
  key: SetupLatencyTimestampKey,
  value: string | null,
): LiveCallLatencyProfile {
  const next: LiveCallLatencyProfile = {
    ...latency,
    setup: {
      ...latency.setup,
      [key]: value,
    },
    stream: {
      inboundAudio: { ...latency.stream.inboundAudio },
      outboundAudio: { ...latency.stream.outboundAudio },
    },
    turns: latency.turns.map((turn) => ({ ...turn })),
    summary: { ...latency.summary },
  };
  next.setup.createToRingingMs = diffMs(
    next.setup.callCreatedAt,
    next.setup.ringingAt,
  );
  next.setup.createToStartedMs = diffMs(
    next.setup.callCreatedAt,
    next.setup.startedAt,
  );
  next.setup.createToAnsweredMs = diffMs(
    next.setup.callCreatedAt,
    next.setup.answeredAt,
  );
  next.setup.answeredToVonageWebsocketMs = diffMs(
    next.setup.answeredAt,
    next.setup.vonageWebsocketOpenedAt,
  );
  next.setup.vonageWebsocketToGeminiWebsocketMs = diffMs(
    next.setup.vonageWebsocketOpenedAt,
    next.setup.geminiWebsocketOpenedAt,
  );
  next.setup.mediaConnectedToFirstAssistantTranscriptMs = diffMs(
    next.setup.mediaConnectedAt,
    next.setup.firstAssistantTranscriptAt,
  );
  next.setup.mediaConnectedToFirstAssistantAudioMs = diffMs(
    next.setup.mediaConnectedAt,
    next.setup.firstAssistantAudioAt,
  );
  return recomputeLatencySummary(next);
}

// ---------------------------------------------------------------------------
// Summary recomputation
// ---------------------------------------------------------------------------

export function recomputeLatencySummary(
  latency: LiveCallLatencyProfile,
): LiveCallLatencyProfile {
  const turns = latency.turns;
  latency.summary = {
    totalTurns: turns.length,
    avgCallerSpeechDurationBeforeFirstTranscriptMs: average(
      turns.flatMap((t) =>
        t.callerSpeechDurationBeforeFirstTranscriptMs === null
          ? []
          : [t.callerSpeechDurationBeforeFirstTranscriptMs],
      ),
    ),
    avgCallerAudioToFirstTranscriptMs: average(
      turns.flatMap((t) =>
        t.callerAudioToFirstTranscriptMs === null
          ? []
          : [t.callerAudioToFirstTranscriptMs],
      ),
    ),
    avgCallerAudioToFinalTranscriptMs: average(
      turns.flatMap((t) =>
        t.callerAudioToFinalTranscriptMs === null
          ? []
          : [t.callerAudioToFinalTranscriptMs],
      ),
    ),
    avgCallerLastAudioToFirstTranscriptMs: average(
      turns.flatMap((t) =>
        t.callerLastAudioToFirstTranscriptMs === null
          ? []
          : [t.callerLastAudioToFirstTranscriptMs],
      ),
    ),
    avgEstimatedEndpointingDelayMs: average(
      turns.flatMap((t) =>
        t.estimatedEndpointingDelayMs === null
          ? []
          : [t.estimatedEndpointingDelayMs],
      ),
    ),
    avgEstimatedRecognitionDelayMs: average(
      turns.flatMap((t) =>
        t.estimatedRecognitionDelayMs === null
          ? []
          : [t.estimatedRecognitionDelayMs],
      ),
    ),
    avgGenerationDelayMs: average(
      turns.flatMap((t) =>
        t.generationDelayMs === null ? [] : [t.generationDelayMs],
      ),
    ),
    avgAssistantTranscriptToAudioMs: average(
      turns.flatMap((t) =>
        t.assistantTranscriptToAudioMs === null
          ? []
          : [t.assistantTranscriptToAudioMs],
      ),
    ),
    avgCallerFinalToAssistantTranscriptMs: average(
      turns.flatMap((t) =>
        t.callerFinalToAssistantTranscriptMs === null
          ? []
          : [t.callerFinalToAssistantTranscriptMs],
      ),
    ),
    avgCallerFinalToAssistantAudioMs: average(
      turns.flatMap((t) =>
        t.callerFinalToAssistantAudioMs === null
          ? []
          : [t.callerFinalToAssistantAudioMs],
      ),
    ),
    avgCallerLastAudioToAssistantTranscriptMs: average(
      turns.flatMap((t) =>
        t.callerLastAudioToAssistantTranscriptMs === null
          ? []
          : [t.callerLastAudioToAssistantTranscriptMs],
      ),
    ),
    avgCallerLastAudioToAssistantAudioMs: average(
      turns.flatMap((t) =>
        t.callerLastAudioToAssistantAudioMs === null
          ? []
          : [t.callerLastAudioToAssistantAudioMs],
      ),
    ),
    inboundPackets: latency.stream.inboundAudio.packets,
    outboundPackets: latency.stream.outboundAudio.packets,
    inboundAvgGapMs: latency.stream.inboundAudio.avgGapMs,
    outboundAvgGapMs: latency.stream.outboundAudio.avgGapMs,
    inboundAvgChunkMs: latency.stream.inboundAudio.avgChunkMs,
    outboundAvgChunkMs: latency.stream.outboundAudio.avgChunkMs,
    maxPendingMessages: latency.summary.maxPendingMessages,
    maxPendingBytes: latency.summary.maxPendingBytes,
    maxPendingAudioMs: latency.summary.maxPendingAudioMs,
  };
  return latency;
}

// ---------------------------------------------------------------------------
// Turn lifecycle
// ---------------------------------------------------------------------------

/**
 * Returns the active inbound turn, creating a new one if none exists or if
 * the current turn has already received an assistant response.
 */
export function getOrStartInboundTurn(
  turns: TurnLatencyMetrics[],
  activeTurnIndex: number | null,
): { turn: TurnLatencyMetrics; activeTurnIndex: number } {
  const active =
    activeTurnIndex === null ? null : (turns[activeTurnIndex] ?? null);
  if (
    !active ||
    active.assistantFirstAudioAt ||
    active.assistantFirstTranscriptAt ||
    active.completedAt
  ) {
    const nextTurn: TurnLatencyMetrics = {
      id: turns.length + 1,
      startedAt: nowIso(),
      completedAt: null,
      callerFirstAudioAt: null,
      callerLastAudioAt: null,
      callerLastAudioBeforeFirstTranscriptAt: null,
      callerFirstTranscriptAt: null,
      callerFinalTranscriptAt: null,
      callerTranscript: null,
      assistantFirstTranscriptAt: null,
      assistantFirstAudioAt: null,
      assistantTranscript: null,
      callerSpeechDurationBeforeFirstTranscriptMs: null,
      callerAudioToFirstTranscriptMs: null,
      callerAudioToFinalTranscriptMs: null,
      callerLastAudioToFirstTranscriptMs: null,
      estimatedEndpointingDelayMs: null,
      estimatedRecognitionDelayMs: null,
      generationDelayMs: null,
      assistantTranscriptToAudioMs: null,
      callerFinalToAssistantTranscriptMs: null,
      callerFinalToAssistantAudioMs: null,
      callerLastAudioToAssistantTranscriptMs: null,
      callerLastAudioToAssistantAudioMs: null,
    };
    if (active && !active.completedAt) {
      active.completedAt = nowIso();
    }
    turns.push(nextTurn);
    return { turn: nextTurn, activeTurnIndex: turns.length - 1 };
  }
  return { turn: active, activeTurnIndex: activeTurnIndex as number };
}

/**
 * Returns the turn at `activeTurnIndex`, or `null` if none is active.
 */
export function getActiveTurnForResponse(
  turns: TurnLatencyMetrics[],
  activeTurnIndex: number | null,
) {
  if (activeTurnIndex === null) {
    return null;
  }
  return turns[activeTurnIndex] ?? null;
}
