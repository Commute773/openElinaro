import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI, Modality, type Session } from "@google/genai";
import type { LiveCallbacks, LiveServerMessage } from "@google/genai";
import type { ServerWebSocket } from "bun";
import { getRuntimeConfig } from "../config/runtime-config";
import { resolveRuntimePath } from "./runtime-root";
import { SecretStoreService } from "./secret-store-service";
import { telemetry } from "./telemetry";
import { VonageService, getVonageWebhookPath } from "./vonage-service";
import {
  buildPhoneCallStartPrompt,
  buildPhoneCallSystemInstruction,
  END_CALL_TRIGGER_PHRASES,
} from "./phone-call-prompts";

const DEFAULT_GEMINI_SECRET_REF = "gemini.apiKey";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
const DEFAULT_SECRET_PROFILE_ID = "root";
const DEFAULT_TRANSCRIPT_FILE_NAME = "transcript.log";
const LIVE_PHONE_ROOT = ["communications", "live-calls"] as const;
const DEFAULT_INBOUND_SPEECH_ENERGY_THRESHOLD = 700;
const DEFAULT_CALLER_PREFIX_PADDING_MS = 20;
const DEFAULT_CALLER_SILENCE_DURATION_MS = 100;
const DEFAULT_GEMINI_LIVE_THINKING_BUDGET = 0;
const PCM_16KHZ_BYTES_PER_MS = 32;

export type GeminiLivePhoneSocketData = {
  kind: "gemini-live-phone";
  sessionId: string;
};

type GeminiLivePhoneStatus =
  | "creating"
  | "dialing"
  | "connecting"
  | "active"
  | "completed"
  | "failed";

type GeminiTranscriptState = {
  text: string;
  finished: boolean;
};

type AudioStreamStats = {
  packets: number;
  bytes: number;
  firstPacketAt: string | null;
  lastPacketAt: string | null;
  gapCount: number;
  avgGapMs: number | null;
  maxGapMs: number | null;
  avgChunkMs: number | null;
  maxChunkMs: number | null;
};

type TurnLatencyMetrics = {
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

type SetupLatencyMetrics = {
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

type SetupLatencyTimestampKey =
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

type LatencySummary = {
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

type LiveCallLatencyProfile = {
  setup: SetupLatencyMetrics;
  stream: {
    inboundAudio: AudioStreamStats;
    outboundAudio: AudioStreamStats;
  };
  turns: TurnLatencyMetrics[];
  summary: LatencySummary;
};

type ActiveBridge = {
  sessionId: string;
  vonageSocket: ServerWebSocket<GeminiLivePhoneSocketData>;
  geminiSession: Session | null;
  pendingMessages: Array<string | Buffer>;
  resampler: LinearPcmResampler;
  vonageConnected: boolean;
  introSent: boolean;
  startPrompt: string;
  closed: boolean;
  inputTranscript: GeminiTranscriptState | null;
  outputTranscript: GeminiTranscriptState | null;
  latency: LiveCallLatencyProfile;
  activeTurnIndex: number | null;
  lastLatencyPersistAtMs: number;
  endingCall: boolean;
  pendingHangupTimer: ReturnType<typeof setTimeout> | null;
  pendingAudioBytes: number;
};

type TranscriptLogEntry = {
  timestamp: string;
  type: string;
  [key: string]: unknown;
};

type GeminiLiveClient = {
  live: {
    connect(params: {
      model: string;
      callbacks: LiveCallbacks;
      config?: Record<string, unknown>;
    }): Promise<Session>;
  };
};

export type GeminiLivePhoneSessionRecord = {
  id: string;
  callId: string | null;
  status: GeminiLivePhoneStatus;
  to: string;
  from: string | null;
  instructions: string;
  model: string;
  websocketUrl: string;
  transcriptLogPath: string;
  sessionPath: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  latency: LiveCallLatencyProfile;
};

type GeminiClientFactory = (apiKey: string) => GeminiLiveClient;

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function isoToMs(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function diffMs(start: string | null | undefined, end: string | null | undefined) {
  const startMs = isoToMs(start);
  const endMs = isoToMs(end);
  if (startMs === null || endMs === null) {
    return null;
  }
  return Math.max(0, endMs - startMs);
}

function average(numbers: number[]) {
  if (numbers.length === 0) {
    return null;
  }
  return Math.round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
}

function emptyAudioStreamStats(): AudioStreamStats {
  return {
    packets: 0,
    bytes: 0,
    firstPacketAt: null,
    lastPacketAt: null,
    gapCount: 0,
    avgGapMs: null,
    maxGapMs: null,
    avgChunkMs: null,
    maxChunkMs: null,
  };
}

function createLatencyProfile(createdAt: string): LiveCallLatencyProfile {
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

function bytesToPcm16kDurationMs(byteLength: number) {
  return Math.max(0, Math.round(byteLength / PCM_16KHZ_BYTES_PER_MS));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeForPhraseMatch(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function containsEndCallTrigger(text: string) {
  const normalized = normalizeForPhraseMatch(text);
  if (!normalized) {
    return false;
  }
  return END_CALL_TRIGGER_PHRASES.some((phrase) => {
    const pattern = phrase === "bye"
      ? /\bbye\b/i
      : new RegExp(escapeRegExp(phrase), "i");
    return pattern.test(normalized);
  });
}

function estimateInputLatencyBreakdown(postSpeechLatencyMs: number | null, silenceDurationMs: number) {
  if (postSpeechLatencyMs === null) {
    return {
      endpointingDelayMs: null,
      recognitionDelayMs: null,
    };
  }
  return {
    endpointingDelayMs: Math.max(0, Math.min(postSpeechLatencyMs, silenceDurationMs)),
    recognitionDelayMs: Math.max(0, postSpeechLatencyMs - silenceDurationMs),
  };
}

function normalizeString(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function ensureLivePhoneRoot() {
  fs.mkdirSync(resolveRuntimePath(...LIVE_PHONE_ROOT), { recursive: true });
}

function getSessionDir(sessionId: string) {
  return resolveRuntimePath(...LIVE_PHONE_ROOT, sessionId);
}

function getSessionPath(sessionId: string) {
  return path.join(getSessionDir(sessionId), "session.json");
}

function getTranscriptLogPath(sessionId: string) {
  return path.join(getSessionDir(sessionId), DEFAULT_TRANSCRIPT_FILE_NAME);
}

function getCallIndexPath() {
  return resolveRuntimePath(...LIVE_PHONE_ROOT, "call-index.json");
}

function toWebSocketUrl(baseUrl: string, pathname: string) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function decodePathSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function toBuffer(message: string | Buffer | ArrayBuffer | Uint8Array) {
  if (typeof message === "string") {
    return Buffer.from(message, "utf8");
  }
  if (Buffer.isBuffer(message)) {
    return message;
  }
  if (message instanceof ArrayBuffer) {
    return Buffer.from(message);
  }
  return Buffer.from(message.buffer, message.byteOffset, message.byteLength);
}

class LinearPcmResampler {
  private readonly step: number;
  private leftover = Buffer.alloc(0);
  private sourcePosition = 0;

  constructor(
    private readonly inputRate: number,
    private readonly outputRate: number,
  ) {
    this.step = inputRate / outputRate;
  }

  push(chunk: Buffer) {
    if (chunk.length === 0 || this.inputRate === this.outputRate) {
      return Buffer.from(chunk);
    }

    this.leftover = this.leftover.length > 0
      ? Buffer.concat([this.leftover, chunk])
      : Buffer.from(chunk);

    const sampleCount = Math.floor(this.leftover.length / 2);
    if (sampleCount < 2) {
      return Buffer.alloc(0);
    }

    const samples = new Int16Array(sampleCount);
    for (let index = 0; index < sampleCount; index += 1) {
      samples[index] = this.leftover.readInt16LE(index * 2);
    }

    const output: number[] = [];
    while (this.sourcePosition + 1 < sampleCount) {
      const leftIndex = Math.floor(this.sourcePosition);
      const rightIndex = Math.min(leftIndex + 1, sampleCount - 1);
      const fraction = this.sourcePosition - leftIndex;
      const left = samples[leftIndex] ?? 0;
      const right = samples[rightIndex] ?? left;
      const interpolated = left + ((right - left) * fraction);
      output.push(Math.max(-32768, Math.min(32767, Math.round(interpolated))));
      this.sourcePosition += this.step;
    }

    const consumedSamples = Math.max(0, Math.floor(this.sourcePosition));
    const remainingSamples = Math.max(0, sampleCount - consumedSamples);
    const remainingBytes = remainingSamples * 2;
    this.leftover = remainingBytes > 0
      ? Buffer.from(this.leftover.subarray(consumedSamples * 2, consumedSamples * 2 + remainingBytes))
      : Buffer.alloc(0);
    this.sourcePosition -= consumedSamples;

    const outputBuffer = Buffer.alloc(output.length * 2);
    for (let index = 0; index < output.length; index += 1) {
      outputBuffer.writeInt16LE(output[index] ?? 0, index * 2);
    }
    return outputBuffer;
  }
}

export class GeminiLivePhoneService {
  private readonly secrets: SecretStoreService;
  private readonly vonage: VonageService;
  private readonly activeBridges = new Map<string, ActiveBridge>();
  private readonly liveTelemetry = telemetry.child({ component: "gemini-live-phone" });
  private readonly geminiFactory: GeminiClientFactory;

  constructor(options?: {
    secrets?: SecretStoreService;
    vonage?: VonageService;
    geminiFactory?: GeminiClientFactory;
  }) {
    this.secrets = options?.secrets ?? new SecretStoreService();
    this.vonage = options?.vonage ?? new VonageService();
    this.geminiFactory = options?.geminiFactory ?? ((apiKey) => new GoogleGenAI({ apiKey }));
  }

  getSession(id: string) {
    ensureLivePhoneRoot();
    const sessionPath = getSessionPath(id);
    if (!fs.existsSync(sessionPath)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(sessionPath, "utf8")) as Partial<GeminiLivePhoneSessionRecord>;
    const createdAt = normalizeString(parsed.createdAt) ?? nowIso();
    return {
      ...(parsed as GeminiLivePhoneSessionRecord),
      latency: parsed.latency ?? createLatencyProfile(createdAt),
    };
  }

  async recordVoiceEventWebhook(request: Request) {
    const payload = await this.readWebhookPayload(request);
    return this.recordVoiceEventPayload(payload);
  }

  getSessionWebSocketPath(sessionId: string) {
    return `${getVonageWebhookPath("voice.answer").replace(/\/answer$/, "")}/live/${encodeURIComponent(sessionId)}`;
  }

  resolveSessionIdFromPath(pathname: string) {
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

  async makePhoneCall(input: {
    to: string;
    from?: string;
    instructions: string;
  }) {
    const communications = this.vonage.getStatus();
    if (!communications.publicBaseUrl) {
      throw new Error("communications.publicBaseUrl is required for live phone calls.");
    }

    const sessionId = crypto.randomUUID();
    const sessionDir = getSessionDir(sessionId);
    const sessionPath = getSessionPath(sessionId);
    const transcriptLogPath = getTranscriptLogPath(sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    const record: GeminiLivePhoneSessionRecord = {
      id: sessionId,
      callId: null,
      status: "creating",
      to: input.to,
      from: normalizeString(input.from),
      instructions: input.instructions.trim(),
      model: this.resolveModel(),
      websocketUrl: toWebSocketUrl(communications.publicBaseUrl, this.getSessionWebSocketPath(sessionId)),
      transcriptLogPath,
      sessionPath,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: null,
      endedAt: null,
      error: null,
      latency: createLatencyProfile(nowIso()),
    };
    this.saveSession(record);
    this.appendTranscriptLog(record.id, {
      timestamp: nowIso(),
      type: "session.created",
      sessionId: record.id,
      to: record.to,
      from: record.from,
      model: record.model,
    });

    try {
      const call = await this.vonage.createRealtimeWebsocketCall({
        to: input.to,
        from: input.from,
        uri: record.websocketUrl,
        headers: {
          session_id: sessionId,
          flow: "gemini-live-phone",
        },
        authorization: { type: "vonage" },
        eventUrl: communications.webhookUrls.voiceEvent ?? undefined,
        fallbackUrl: communications.webhookUrls.voiceFallback ?? undefined,
      });
      const updated = this.saveSession({
        ...record,
        callId: call.id,
        status: "dialing",
        updatedAt: nowIso(),
        latency: this.withSetupMetric(record.latency, "callCreatedAt", nowIso()),
      });
      this.writeCallIndex(call.id, record.id);
      this.appendTranscriptLog(record.id, {
        timestamp: nowIso(),
        type: "call.created",
        callId: call.id,
      });
      return updated;
    } catch (error) {
      const updated = this.failSession(record.id, error);
      throw new Error(`Failed to create live phone call ${updated.id}: ${updated.error}`);
    }
  }

  formatSession(session: GeminiLivePhoneSessionRecord) {
    const summary = session.latency.summary;
    return [
      `Gemini live phone call ${session.id}`,
      `Status: ${session.status}`,
      `Call UUID: ${session.callId ?? "(pending)"}`,
      `To: ${session.to}`,
      `From: ${session.from ?? "(default)"}`,
      `Model: ${session.model}`,
      `Transcript log: ${session.transcriptLogPath}`,
      `Session file: ${session.sessionPath}`,
      `Started: ${session.startedAt ?? "(not connected yet)"}`,
      `Ended: ${session.endedAt ?? "(in progress)"}`,
      `Turns: ${summary.totalTurns}`,
      `Answered -> Gemini WS ms: ${session.latency.setup.vonageWebsocketToGeminiWebsocketMs ?? "(n/a)"}`,
      `Caller last-audio -> first transcript ms: ${summary.avgCallerLastAudioToFirstTranscriptMs ?? "(n/a)"}`,
      `Estimated endpointing/recognition ms: ${summary.avgEstimatedEndpointingDelayMs ?? "(n/a)"}/${summary.avgEstimatedRecognitionDelayMs ?? "(n/a)"}`,
      `Generation/audio-output ms: ${summary.avgGenerationDelayMs ?? "(n/a)"}/${summary.avgAssistantTranscriptToAudioMs ?? "(n/a)"}`,
      `Caller final -> assistant audio ms: ${summary.avgCallerFinalToAssistantAudioMs ?? "(n/a)"}`,
      `Caller final -> assistant transcript ms: ${summary.avgCallerFinalToAssistantTranscriptMs ?? "(n/a)"}`,
      `Inbound/outbound packets: ${summary.inboundPackets}/${summary.outboundPackets}`,
      `Inbound/outbound avg chunk ms: ${summary.inboundAvgChunkMs ?? "(n/a)"}/${summary.outboundAvgChunkMs ?? "(n/a)"}`,
      `Max pending messages/bytes/audio ms: ${summary.maxPendingMessages}/${summary.maxPendingBytes}/${summary.maxPendingAudioMs}`,
      session.error ? `Error: ${session.error}` : "Error: (none)",
    ].join("\n");
  }

  async handleVonageSocketOpen(socket: ServerWebSocket<GeminiLivePhoneSocketData>) {
    const sessionId = socket.data.sessionId;
    const session = this.getSession(sessionId);
    if (!session) {
      socket.close(1008, "Unknown live-call session");
      return;
    }

    const bridge: ActiveBridge = {
      sessionId,
      vonageSocket: socket,
      geminiSession: null,
      pendingMessages: [],
      resampler: new LinearPcmResampler(24_000, 16_000),
      vonageConnected: false,
      introSent: false,
      startPrompt: this.buildCallStartPrompt(session.instructions),
      closed: false,
      inputTranscript: null,
      outputTranscript: null,
      latency: session.latency ?? createLatencyProfile(session.createdAt),
      activeTurnIndex: null,
      lastLatencyPersistAtMs: 0,
      endingCall: false,
      pendingHangupTimer: null,
      pendingAudioBytes: 0,
    };
    this.activeBridges.set(sessionId, bridge);
    const websocketOpenedAt = nowIso();
    bridge.latency = this.withSetupMetric(bridge.latency, "vonageWebsocketOpenedAt", websocketOpenedAt);
    this.saveSession({
      ...session,
      status: "connecting",
      updatedAt: nowIso(),
      startedAt: session.startedAt ?? nowIso(),
      error: null,
      latency: bridge.latency,
    });
    this.appendTranscriptLog(sessionId, {
      timestamp: websocketOpenedAt,
      type: "vonage.websocket.open",
    });

    try {
      const geminiSession = await this.connectGemini(bridge, session);
      bridge.geminiSession = geminiSession;
      if (bridge.vonageConnected) {
        this.kickoffConversation(bridge);
      }
      this.flushPendingMessages(bridge);
    } catch (error) {
      this.liveTelemetry.recordError(error, { operation: "gemini.connect", sessionId });
      this.failSession(sessionId, error);
      socket.close(1011, "Gemini connection failed");
      this.activeBridges.delete(sessionId);
    }
  }

  handleVonageSocketMessage(
    socket: ServerWebSocket<GeminiLivePhoneSocketData>,
    message: string | Buffer | ArrayBuffer | Uint8Array,
  ) {
    const bridge = this.activeBridges.get(socket.data.sessionId);
    if (!bridge || bridge.closed) {
      return;
    }
    if (typeof message === "string") {
      this.handleVonageControlMessage(bridge, message);
      return;
    }
    const audio = toBuffer(message);
    this.recordAudioPacket(bridge, "inbound", audio.length);
    this.recordInboundSpeechActivity(bridge, audio);
    if (!bridge.geminiSession) {
      bridge.pendingMessages.push(Buffer.from(audio));
      bridge.pendingAudioBytes += audio.length;
      this.recordPendingQueueState(bridge);
      this.maybePersistLatency(bridge);
      return;
    }
    bridge.geminiSession.sendRealtimeInput({
      audio: {
        data: audio.toString("base64"),
        mimeType: "audio/pcm;rate=16000",
      },
    });
    this.maybePersistLatency(bridge, true);
  }

  handleVonageSocketClose(
    socket: ServerWebSocket<GeminiLivePhoneSocketData>,
    code: number,
    reason: string,
  ) {
    const bridge = this.activeBridges.get(socket.data.sessionId);
    if (!bridge) {
      return;
    }
    bridge.closed = true;
    this.clearPendingHangup(bridge);
    try {
      bridge.geminiSession?.close();
    } catch {}
    this.activeBridges.delete(socket.data.sessionId);
    this.appendTranscriptLog(socket.data.sessionId, {
      timestamp: nowIso(),
      type: "vonage.websocket.close",
      code,
      reason,
    });
    const session = this.getSession(socket.data.sessionId);
    if (!session) {
      return;
    }
    bridge.latency = this.withSetupMetric(bridge.latency, "callEndedAt", nowIso());
    this.saveSession({
      ...session,
      status: session.status === "failed" ? "failed" : "completed",
      updatedAt: nowIso(),
      endedAt: session.endedAt ?? nowIso(),
      latency: this.recomputeLatencySummary(bridge.latency),
    });
  }

  private async connectGemini(bridge: ActiveBridge, session: GeminiLivePhoneSessionRecord) {
    const apiKey = this.resolveGeminiApiKey();
    const ai = this.geminiFactory(apiKey);
    const connected = await ai.live.connect({
      model: session.model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: this.buildSystemInstruction(session.instructions),
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
            prefixPaddingMs: this.resolveCallerPrefixPaddingMs(),
            silenceDurationMs: this.resolveCallerSilenceDurationMs(),
          },
        },
        speechConfig: this.buildSpeechConfig(),
      },
      callbacks: {
        onopen: () => {
          bridge.latency = this.withSetupMetric(bridge.latency, "geminiWebsocketOpenedAt", nowIso());
          this.appendTranscriptLog(session.id, {
            timestamp: nowIso(),
            type: "gemini.websocket.open",
          });
          const current = this.getSession(session.id);
          if (current) {
            this.saveSession({
              ...current,
              status: bridge.vonageConnected ? "active" : "connecting",
              updatedAt: nowIso(),
              latency: this.recomputeLatencySummary(bridge.latency),
            });
          }
        },
        onmessage: (message) => {
          this.handleGeminiServerMessage(bridge, message);
        },
        onerror: (event) => {
          const message = event.message || "Unknown Gemini websocket error";
          this.appendTranscriptLog(session.id, {
            timestamp: nowIso(),
            type: "gemini.websocket.error",
            message,
          });
          this.failSession(session.id, new Error(message));
          try {
            bridge.vonageSocket.close(1011, "Gemini websocket error");
          } catch {}
        },
        onclose: (event) => {
          this.appendTranscriptLog(session.id, {
            timestamp: nowIso(),
            type: "gemini.websocket.close",
            code: event.code,
            reason: event.reason,
          });
        },
      },
    });
    return connected;
  }

  private handleGeminiServerMessage(bridge: ActiveBridge, message: LiveServerMessage) {
    const content = message.serverContent;
    if (!content) {
      return;
    }

    if (content.interrupted) {
      bridge.vonageSocket.send(JSON.stringify({ action: "clear" }));
      this.appendTranscriptLog(bridge.sessionId, {
        timestamp: nowIso(),
        type: "gemini.interrupted",
      });
    }

    this.recordTranscription(
      bridge,
      "caller",
      content.inputTranscription?.text ?? "",
      Boolean(content.inputTranscription?.finished),
    );
    this.recordTranscription(
      bridge,
      "assistant",
      content.outputTranscription?.text ?? "",
      Boolean(content.outputTranscription?.finished),
    );

    const parts = content.modelTurn?.parts ?? [];
    for (const part of parts) {
      if (!part.inlineData?.data) {
        continue;
      }
      const pcm24k = Buffer.from(part.inlineData.data, "base64");
      const pcm16k = bridge.resampler.push(pcm24k);
      if (pcm16k.length > 0) {
        this.recordAssistantAudioStart(bridge);
        this.recordAudioPacket(bridge, "outbound", pcm16k.length);
        bridge.vonageSocket.send(pcm16k);
      }
    }
    this.maybePersistLatency(bridge, true);
  }

  private handleVonageControlMessage(bridge: ActiveBridge, rawMessage: string) {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(rawMessage) as Record<string, unknown>;
    } catch {
      payload = { raw: rawMessage };
    }
    const event = normalizeString(payload.event) ?? "message";
    this.appendTranscriptLog(bridge.sessionId, {
      timestamp: nowIso(),
      type: "vonage.control",
      event,
      payload,
    });
    if (event === "websocket:connected") {
      bridge.vonageConnected = true;
      bridge.latency = this.withSetupMetric(bridge.latency, "mediaConnectedAt", nowIso());
      const session = this.getSession(bridge.sessionId);
      if (session) {
        this.saveSession({
          ...session,
          status: bridge.geminiSession ? "active" : "connecting",
          updatedAt: nowIso(),
          latency: this.recomputeLatencySummary(bridge.latency),
        });
      }
      if (bridge.geminiSession) {
        this.kickoffConversation(bridge);
      }
    }
  }

  private kickoffConversation(bridge: ActiveBridge) {
    if (bridge.introSent || !bridge.geminiSession) {
      return;
    }
    bridge.introSent = true;
    bridge.geminiSession.sendClientContent({
      turns: [{
        role: "user",
        parts: [{
          text: bridge.startPrompt,
        }],
      }],
      turnComplete: true,
    });
    this.appendTranscriptLog(bridge.sessionId, {
      timestamp: nowIso(),
      type: "gemini.call.start",
    });
  }

  private flushPendingMessages(bridge: ActiveBridge) {
    if (!bridge.geminiSession || bridge.pendingMessages.length === 0) {
      return;
    }
    const pending = [...bridge.pendingMessages];
    bridge.pendingMessages.length = 0;
    bridge.pendingAudioBytes = 0;
    for (const message of pending) {
      if (typeof message === "string") {
        this.handleVonageControlMessage(bridge, message);
        continue;
      }
      bridge.geminiSession.sendRealtimeInput({
        audio: {
          data: message.toString("base64"),
          mimeType: "audio/pcm;rate=16000",
        },
      });
    }
  }

  private recordTranscription(
    bridge: ActiveBridge,
    speaker: "caller" | "assistant",
    text: string,
    finished: boolean,
  ) {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }
    const previous = speaker === "caller" ? bridge.inputTranscript : bridge.outputTranscript;
    if (previous?.text === normalized && previous.finished === finished) {
      return;
    }
    const nextState = { text: normalized, finished };
    if (speaker === "caller") {
      this.clearPendingHangup(bridge);
      bridge.inputTranscript = nextState;
      this.recordCallerTranscript(bridge, normalized, finished);
    } else {
      bridge.outputTranscript = nextState;
      this.recordAssistantTranscript(bridge, normalized, finished);
    }
    this.appendTranscriptLog(bridge.sessionId, {
      timestamp: nowIso(),
      type: "transcript",
      speaker,
      final: finished,
      text: normalized,
    });
    this.maybePersistLatency(bridge);
  }

  private recordAudioPacket(bridge: ActiveBridge, direction: "inbound" | "outbound", byteLength: number) {
    const stats = direction === "inbound" ? bridge.latency.stream.inboundAudio : bridge.latency.stream.outboundAudio;
    const timestamp = nowIso();
    const currentMs = isoToMs(timestamp);
    const previousMs = isoToMs(stats.lastPacketAt);
    const chunkMs = bytesToPcm16kDurationMs(byteLength);
    stats.packets += 1;
    stats.bytes += byteLength;
    stats.firstPacketAt ??= timestamp;
    stats.maxChunkMs = stats.maxChunkMs === null ? chunkMs : Math.max(stats.maxChunkMs, chunkMs);
    stats.avgChunkMs = stats.avgChunkMs === null
      ? chunkMs
      : Math.round(((stats.avgChunkMs * (stats.packets - 1)) + chunkMs) / stats.packets);
    if (currentMs !== null && previousMs !== null) {
      const gapMs = Math.max(0, currentMs - previousMs);
      stats.maxGapMs = stats.maxGapMs === null ? gapMs : Math.max(stats.maxGapMs, gapMs);
      stats.avgGapMs = stats.avgGapMs === null
        ? gapMs
        : Math.round(((stats.avgGapMs * stats.gapCount) + gapMs) / (stats.gapCount + 1));
      stats.gapCount += 1;
    }
    stats.lastPacketAt = timestamp;
  }

  private recordPendingQueueState(bridge: ActiveBridge) {
    const maxPendingMessages = bridge.latency.summary.maxPendingMessages;
    const maxPendingBytes = bridge.latency.summary.maxPendingBytes;
    bridge.latency.summary.maxPendingMessages = Math.max(maxPendingMessages, bridge.pendingMessages.length);
    bridge.latency.summary.maxPendingBytes = Math.max(maxPendingBytes, bridge.pendingAudioBytes);
    const pendingAudioMs = bytesToPcm16kDurationMs(bridge.pendingAudioBytes);
    bridge.latency.summary.maxPendingAudioMs = Math.max(bridge.latency.summary.maxPendingAudioMs, pendingAudioMs);
  }

  private recordInboundSpeechActivity(bridge: ActiveBridge, audio: Buffer) {
    if (!this.hasSpeechLikeEnergy(audio)) {
      return;
    }
    this.clearPendingHangup(bridge);
    const turn = this.getOrStartInboundTurn(bridge);
    const timestamp = nowIso();
    turn.callerFirstAudioAt ??= timestamp;
    turn.callerLastAudioAt = timestamp;
  }

  private getOrStartInboundTurn(bridge: ActiveBridge) {
    const active = bridge.activeTurnIndex === null ? null : bridge.latency.turns[bridge.activeTurnIndex] ?? null;
    if (!active || active.assistantFirstAudioAt || active.assistantFirstTranscriptAt || active.completedAt) {
      const nextTurn: TurnLatencyMetrics = {
        id: bridge.latency.turns.length + 1,
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
      bridge.latency.turns.push(nextTurn);
      bridge.activeTurnIndex = bridge.latency.turns.length - 1;
      return nextTurn;
    }
    return active;
  }

  private getActiveTurnForResponse(bridge: ActiveBridge) {
    if (bridge.activeTurnIndex === null) {
      return null;
    }
    return bridge.latency.turns[bridge.activeTurnIndex] ?? null;
  }

  private recordCallerTranscript(bridge: ActiveBridge, text: string, finished: boolean) {
    const turn = this.getOrStartInboundTurn(bridge);
    const timestamp = nowIso();
    turn.callerFirstTranscriptAt ??= timestamp;
    turn.callerLastAudioBeforeFirstTranscriptAt ??= turn.callerLastAudioAt;
    turn.callerTranscript = text;
    turn.callerSpeechDurationBeforeFirstTranscriptMs ??= diffMs(
      turn.callerFirstAudioAt,
      turn.callerLastAudioBeforeFirstTranscriptAt,
    );
    turn.callerAudioToFirstTranscriptMs ??= diffMs(turn.callerFirstAudioAt, turn.callerFirstTranscriptAt);
    turn.callerLastAudioToFirstTranscriptMs ??= diffMs(
      turn.callerLastAudioBeforeFirstTranscriptAt,
      turn.callerFirstTranscriptAt,
    );
    if (turn.estimatedEndpointingDelayMs === null || turn.estimatedRecognitionDelayMs === null) {
      const breakdown = estimateInputLatencyBreakdown(
        turn.callerLastAudioToFirstTranscriptMs,
        this.resolveCallerSilenceDurationMs(),
      );
      turn.estimatedEndpointingDelayMs = breakdown.endpointingDelayMs;
      turn.estimatedRecognitionDelayMs = breakdown.recognitionDelayMs;
      this.appendTranscriptLog(bridge.sessionId, {
        timestamp,
        type: "latency.input",
        turnId: turn.id,
        callerSpeechDurationBeforeFirstTranscriptMs: turn.callerSpeechDurationBeforeFirstTranscriptMs,
        callerLastAudioToFirstTranscriptMs: turn.callerLastAudioToFirstTranscriptMs,
        estimatedEndpointingDelayMs: turn.estimatedEndpointingDelayMs,
        estimatedRecognitionDelayMs: turn.estimatedRecognitionDelayMs,
        configuredSilenceDurationMs: this.resolveCallerSilenceDurationMs(),
      });
    }
    if (finished) {
      turn.callerFinalTranscriptAt ??= timestamp;
      turn.callerAudioToFinalTranscriptMs ??= diffMs(turn.callerFirstAudioAt, turn.callerFinalTranscriptAt);
    }
  }

  private recordAssistantTranscript(bridge: ActiveBridge, text: string, _finished: boolean) {
    const timestamp = nowIso();
    const turn = this.getActiveTurnForResponse(bridge);
    if (turn && !turn.assistantFirstTranscriptAt) {
      turn.assistantFirstTranscriptAt = timestamp;
      turn.assistantTranscript = text;
      turn.callerFinalToAssistantTranscriptMs = diffMs(turn.callerFinalTranscriptAt, turn.assistantFirstTranscriptAt);
      turn.callerLastAudioToAssistantTranscriptMs = diffMs(turn.callerLastAudioAt, turn.assistantFirstTranscriptAt);
      turn.generationDelayMs = turn.callerLastAudioToAssistantTranscriptMs;
      this.appendTranscriptLog(bridge.sessionId, {
        timestamp,
        type: "latency.turn",
        turnId: turn.id,
        metric: "caller_to_first_assistant_transcript",
        callerFinalToAssistantTranscriptMs: turn.callerFinalToAssistantTranscriptMs,
        callerLastAudioToAssistantTranscriptMs: turn.callerLastAudioToAssistantTranscriptMs,
        generationDelayMs: turn.generationDelayMs,
      });
    }
    bridge.latency.setup.firstAssistantTranscriptAt ??= timestamp;
    bridge.latency = this.withSetupMetric(bridge.latency, "firstAssistantTranscriptAt", bridge.latency.setup.firstAssistantTranscriptAt);
    if (containsEndCallTrigger(text)) {
      this.maybeScheduleAutoHangup(bridge, text);
    }
  }

  private recordAssistantAudioStart(bridge: ActiveBridge) {
    const timestamp = nowIso();
    const turn = this.getActiveTurnForResponse(bridge);
    if (turn && !turn.assistantFirstAudioAt) {
      turn.assistantFirstAudioAt = timestamp;
      turn.callerFinalToAssistantAudioMs = diffMs(turn.callerFinalTranscriptAt, turn.assistantFirstAudioAt);
      turn.callerLastAudioToAssistantAudioMs = diffMs(turn.callerLastAudioAt, turn.assistantFirstAudioAt);
      turn.assistantTranscriptToAudioMs = diffMs(turn.assistantFirstTranscriptAt, turn.assistantFirstAudioAt);
      turn.completedAt ??= timestamp;
      this.appendTranscriptLog(bridge.sessionId, {
        timestamp,
        type: "latency.turn",
        turnId: turn.id,
        metric: "caller_to_first_assistant_audio",
        callerFinalToAssistantAudioMs: turn.callerFinalToAssistantAudioMs,
        callerLastAudioToAssistantAudioMs: turn.callerLastAudioToAssistantAudioMs,
        assistantTranscriptToAudioMs: turn.assistantTranscriptToAudioMs,
      });
    }
    bridge.latency.setup.firstAssistantAudioAt ??= timestamp;
    bridge.latency = this.withSetupMetric(bridge.latency, "firstAssistantAudioAt", bridge.latency.setup.firstAssistantAudioAt);
  }

  private withSetupMetric(
    latency: LiveCallLatencyProfile,
    key: SetupLatencyTimestampKey,
    value: string | null,
  ) {
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
    next.setup.createToRingingMs = diffMs(next.setup.callCreatedAt, next.setup.ringingAt);
    next.setup.createToStartedMs = diffMs(next.setup.callCreatedAt, next.setup.startedAt);
    next.setup.createToAnsweredMs = diffMs(next.setup.callCreatedAt, next.setup.answeredAt);
    next.setup.answeredToVonageWebsocketMs = diffMs(next.setup.answeredAt, next.setup.vonageWebsocketOpenedAt);
    next.setup.vonageWebsocketToGeminiWebsocketMs = diffMs(next.setup.vonageWebsocketOpenedAt, next.setup.geminiWebsocketOpenedAt);
    next.setup.mediaConnectedToFirstAssistantTranscriptMs = diffMs(next.setup.mediaConnectedAt, next.setup.firstAssistantTranscriptAt);
    next.setup.mediaConnectedToFirstAssistantAudioMs = diffMs(next.setup.mediaConnectedAt, next.setup.firstAssistantAudioAt);
    return this.recomputeLatencySummary(next);
  }

  private recomputeLatencySummary(latency: LiveCallLatencyProfile) {
    const turns = latency.turns;
    latency.summary = {
      totalTurns: turns.length,
      avgCallerSpeechDurationBeforeFirstTranscriptMs: average(turns.flatMap((turn) => turn.callerSpeechDurationBeforeFirstTranscriptMs === null ? [] : [turn.callerSpeechDurationBeforeFirstTranscriptMs])),
      avgCallerAudioToFirstTranscriptMs: average(turns.flatMap((turn) => turn.callerAudioToFirstTranscriptMs === null ? [] : [turn.callerAudioToFirstTranscriptMs])),
      avgCallerAudioToFinalTranscriptMs: average(turns.flatMap((turn) => turn.callerAudioToFinalTranscriptMs === null ? [] : [turn.callerAudioToFinalTranscriptMs])),
      avgCallerLastAudioToFirstTranscriptMs: average(turns.flatMap((turn) => turn.callerLastAudioToFirstTranscriptMs === null ? [] : [turn.callerLastAudioToFirstTranscriptMs])),
      avgEstimatedEndpointingDelayMs: average(turns.flatMap((turn) => turn.estimatedEndpointingDelayMs === null ? [] : [turn.estimatedEndpointingDelayMs])),
      avgEstimatedRecognitionDelayMs: average(turns.flatMap((turn) => turn.estimatedRecognitionDelayMs === null ? [] : [turn.estimatedRecognitionDelayMs])),
      avgGenerationDelayMs: average(turns.flatMap((turn) => turn.generationDelayMs === null ? [] : [turn.generationDelayMs])),
      avgAssistantTranscriptToAudioMs: average(turns.flatMap((turn) => turn.assistantTranscriptToAudioMs === null ? [] : [turn.assistantTranscriptToAudioMs])),
      avgCallerFinalToAssistantTranscriptMs: average(turns.flatMap((turn) => turn.callerFinalToAssistantTranscriptMs === null ? [] : [turn.callerFinalToAssistantTranscriptMs])),
      avgCallerFinalToAssistantAudioMs: average(turns.flatMap((turn) => turn.callerFinalToAssistantAudioMs === null ? [] : [turn.callerFinalToAssistantAudioMs])),
      avgCallerLastAudioToAssistantTranscriptMs: average(turns.flatMap((turn) => turn.callerLastAudioToAssistantTranscriptMs === null ? [] : [turn.callerLastAudioToAssistantTranscriptMs])),
      avgCallerLastAudioToAssistantAudioMs: average(turns.flatMap((turn) => turn.callerLastAudioToAssistantAudioMs === null ? [] : [turn.callerLastAudioToAssistantAudioMs])),
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

  private maybePersistLatency(bridge: ActiveBridge, force = false) {
    const currentMs = nowMs();
    if (!force && currentMs - bridge.lastLatencyPersistAtMs < 2_000) {
      return;
    }
    const session = this.getSession(bridge.sessionId);
    if (!session) {
      return;
    }
    bridge.lastLatencyPersistAtMs = currentMs;
    this.saveSession({
      ...session,
      updatedAt: nowIso(),
      latency: this.recomputeLatencySummary(bridge.latency),
    });
  }

  private resolveGeminiApiKey() {
    const gemini = getRuntimeConfig().communications.geminiLive;
    const secretRef = gemini.apiKeySecretRef || DEFAULT_GEMINI_SECRET_REF;
    const profileId = gemini.secretProfileId || DEFAULT_SECRET_PROFILE_ID;
    return this.secrets.resolveSecretRef(secretRef, profileId);
  }

  private resolveModel() {
    return getRuntimeConfig().communications.geminiLive.model.trim() || DEFAULT_GEMINI_MODEL;
  }

  private resolveCallerPrefixPaddingMs() {
    const raw = getRuntimeConfig().communications.geminiLive.prefixPaddingMs;
    return Number.isFinite(raw) ? raw : DEFAULT_CALLER_PREFIX_PADDING_MS;
  }

  private resolveCallerSilenceDurationMs() {
    const raw = getRuntimeConfig().communications.geminiLive.silenceDurationMs;
    return Number.isFinite(raw) ? raw : DEFAULT_CALLER_SILENCE_DURATION_MS;
  }

  private buildSpeechConfig() {
    const voiceName = getRuntimeConfig().communications.geminiLive.voiceName?.trim();
    if (!voiceName) {
      return undefined;
    }
    return {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName },
      },
    };
  }

  private buildSystemInstruction(operatorInstructions: string) {
    return buildPhoneCallSystemInstruction(operatorInstructions);
  }

  private buildCallStartPrompt(operatorInstructions: string) {
    return buildPhoneCallStartPrompt(operatorInstructions);
  }

  private hasSpeechLikeEnergy(audio: Buffer) {
    if (audio.length < 2) {
      return false;
    }
    let total = 0;
    let sampleCount = 0;
    for (let index = 0; index + 1 < audio.length; index += 2) {
      total += Math.abs(audio.readInt16LE(index));
      sampleCount += 1;
    }
    if (sampleCount === 0) {
      return false;
    }
    const averageMagnitude = total / sampleCount;
    return averageMagnitude >= DEFAULT_INBOUND_SPEECH_ENERGY_THRESHOLD;
  }

  private maybeScheduleAutoHangup(bridge: ActiveBridge, text: string) {
    const normalized = normalizeForPhraseMatch(text);
    if (!normalized || bridge.endingCall || bridge.closed) {
      return;
    }
    if (!containsEndCallTrigger(normalized)) {
      return;
    }
    this.clearPendingHangup(bridge);
    bridge.pendingHangupTimer = setTimeout(() => {
      void this.hangupBridgeCall(bridge, "assistant-closing");
    }, 1800);
    this.appendTranscriptLog(bridge.sessionId, {
      timestamp: nowIso(),
      type: "call.auto_hangup.scheduled",
      reason: "assistant-closing",
      delayMs: 1800,
      text,
    });
  }

  private clearPendingHangup(bridge: ActiveBridge) {
    if (!bridge.pendingHangupTimer) {
      return;
    }
    clearTimeout(bridge.pendingHangupTimer);
    bridge.pendingHangupTimer = null;
  }

  private async hangupBridgeCall(bridge: ActiveBridge, reason: string) {
    if (bridge.endingCall || bridge.closed) {
      return;
    }
    const session = this.getSession(bridge.sessionId);
    if (!session?.callId) {
      return;
    }
    bridge.endingCall = true;
    bridge.pendingHangupTimer = null;
    this.appendTranscriptLog(bridge.sessionId, {
      timestamp: nowIso(),
      type: "call.auto_hangup.start",
      reason,
      callId: session.callId,
    });
    try {
      await this.vonage.hangupCall(session.callId);
      this.appendTranscriptLog(bridge.sessionId, {
        timestamp: nowIso(),
        type: "call.auto_hangup.success",
        reason,
        callId: session.callId,
      });
    } catch (error) {
      bridge.endingCall = false;
      this.appendTranscriptLog(bridge.sessionId, {
        timestamp: nowIso(),
        type: "call.auto_hangup.error",
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private saveSession(record: GeminiLivePhoneSessionRecord) {
    ensureLivePhoneRoot();
    fs.mkdirSync(path.dirname(record.sessionPath), { recursive: true });
    const normalized = {
      ...record,
      latency: this.recomputeLatencySummary(record.latency),
    };
    fs.writeFileSync(record.sessionPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    return normalized;
  }

  private recordVoiceEventPayload(payload: Record<string, unknown>) {
    const callId = normalizeString(payload.uuid);
    if (!callId) {
      return null;
    }
    const sessionId = this.readCallIndex(callId);
    if (!sessionId) {
      return null;
    }
    const session = this.getSession(sessionId);
    if (!session) {
      return null;
    }
    const status = normalizeString(payload.status) ?? "event";
    const detail = normalizeString(payload.detail);
    let latency = session.latency;
    const timestamp = nowIso();
    if (status === "ringing") {
      latency = this.withSetupMetric(latency, "ringingAt", timestamp);
    } else if (status === "started") {
      latency = this.withSetupMetric(latency, "startedAt", timestamp);
    } else if (status === "answered") {
      latency = this.withSetupMetric(latency, "answeredAt", timestamp);
    } else if (status === "completed" || status === "disconnected" || status === "rejected" || status === "busy" || status === "timeout" || status === "failed") {
      latency = this.withSetupMetric(latency, "callEndedAt", timestamp);
    }
    const updated = this.saveSession({
      ...session,
      status: status === "failed"
        ? "failed"
        : status === "answered" || status === "ringing" || status === "started"
          ? session.status === "failed" ? "failed" : status === "answered" ? "active" : session.status
          : status === "completed" || status === "disconnected" || status === "rejected" || status === "busy" || status === "timeout"
          ? session.status === "failed" ? "failed" : "completed"
            : session.status,
      updatedAt: timestamp,
      startedAt: session.startedAt ?? (status === "answered" ? timestamp : session.startedAt),
      endedAt: status === "failed" || status === "completed" || status === "disconnected" || status === "rejected" || status === "busy" || status === "timeout"
        ? (session.endedAt ?? timestamp)
        : session.endedAt,
      error: status === "failed" ? (detail ?? status) : session.error,
      latency,
    });
    this.appendTranscriptLog(sessionId, {
      timestamp,
      type: "voice.event",
      status,
      detail,
      payload,
    });
    if (status === "ringing" || status === "answered" || status === "completed" || status === "failed") {
      this.appendTranscriptLog(sessionId, {
        timestamp,
        type: "latency.setup",
        status,
        createToRingingMs: updated.latency.setup.createToRingingMs,
        createToAnsweredMs: updated.latency.setup.createToAnsweredMs,
        answeredToVonageWebsocketMs: updated.latency.setup.answeredToVonageWebsocketMs,
      });
    }
    const activeBridge = this.activeBridges.get(sessionId);
    if (activeBridge) {
      activeBridge.latency = updated.latency;
    }
    return updated;
  }

  private appendTranscriptLog(sessionId: string, entry: TranscriptLogEntry) {
    ensureLivePhoneRoot();
    const transcriptLogPath = getTranscriptLogPath(sessionId);
    fs.mkdirSync(path.dirname(transcriptLogPath), { recursive: true });
    fs.appendFileSync(transcriptLogPath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  private readCallIndex(callId: string) {
    ensureLivePhoneRoot();
    const indexPath = getCallIndexPath();
    if (!fs.existsSync(indexPath)) {
      return null;
    }
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as Record<string, string>;
    return normalizeString(index[callId]);
  }

  private writeCallIndex(callId: string, sessionId: string) {
    ensureLivePhoneRoot();
    const indexPath = getCallIndexPath();
    const current = fs.existsSync(indexPath)
      ? JSON.parse(fs.readFileSync(indexPath, "utf8")) as Record<string, string>
      : {};
    current[callId] = sessionId;
    fs.writeFileSync(indexPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  }

  private failSession(sessionId: string, error: unknown) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Unknown live phone session: ${sessionId}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    const updated = this.saveSession({
      ...session,
      status: "failed",
      updatedAt: nowIso(),
      endedAt: session.endedAt ?? nowIso(),
      error: message,
    });
    this.appendTranscriptLog(sessionId, {
      timestamp: nowIso(),
      type: "session.failed",
      error: message,
    });
    return updated;
  }

  private async readWebhookPayload(request: Request) {
    const method = request.method.toUpperCase();
    if (method === "GET") {
      return Object.fromEntries(new URL(request.url).searchParams.entries());
    }
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("application/json")) {
      return await request.json() as Record<string, unknown>;
    }
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const text = await request.text();
      return Object.fromEntries(new URLSearchParams(text).entries());
    }
    const text = await request.text();
    if (!text.trim()) {
      return {};
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { raw: text };
    }
  }
}
