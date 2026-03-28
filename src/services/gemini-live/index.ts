/**
 * GeminiLivePhoneService — thin coordinator that imports focused sub-modules.
 *
 * Sub-modules:
 * - `audio-stream.ts`     — PCM constants, resampling, speech detection
 * - `latency-tracker.ts`  — Latency types, metrics, turn management
 * - `phone-transcript.ts` — Transcript types, persistence, end-call detection
 * - `session-manager.ts`  — Gemini API config, credentials, prompt building
 * - `vonage-bridge.ts`    — Vonage event processing, call-index, URL helpers
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI, type Session } from "@google/genai";
import type { LiveCallbacks, LiveServerMessage } from "@google/genai";
import type { ServerWebSocket } from "bun";
import { normalizeString } from "../../utils/text-utils";
import { timestamp as nowIso } from "../../utils/timestamp";
import { readWebhookPayload } from "../../utils/http-helpers";
import { SecretStoreService } from "../infrastructure/secret-store-service";
import { telemetry } from "../infrastructure/telemetry";
import { VonageService } from "../vonage-service";

import {
  LinearPcmResampler,
  bytesToPcm16kDurationMs,
  hasSpeechLikeEnergy,
  recordAudioPacket,
  toBuffer,
} from "./audio-stream";

import {
  type LiveCallLatencyProfile,
  createLatencyProfile,
  diffMs,
  estimateInputLatencyBreakdown,
  getActiveTurnForResponse,
  getOrStartInboundTurn,
  isoToMs,
  nowMs,
  recomputeLatencySummary,
  withSetupMetric,
} from "./latency-tracker";

import {
  type GeminiTranscriptState,
  appendTranscriptLog,
  containsEndCallTrigger,
  ensureLivePhoneRoot,
  getSessionDir,
  getSessionPath,
  getTranscriptLogPath,
} from "./phone-transcript";

import {
  buildCallStartPrompt,
  buildGeminiConnectConfig,
  resolveCallerSilenceDurationMs,
  resolveGeminiApiKey,
  resolveModel,
} from "./session-manager";

import {
  applyVoiceEventToLatency,
  deriveSessionStatus,
  getSessionWebSocketPath as getSessionWsPath,
  isTerminalVoiceStatus,
  logVoiceEvent,
  readCallIndex,
  resolveSessionIdFromPath as resolveSessionIdFromPathImpl,
  toWebSocketUrl,
  writeCallIndex,
} from "./vonage-bridge";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type GeminiLiveClient = {
  live: {
    connect(params: {
      model: string;
      callbacks: LiveCallbacks;
      config?: Record<string, unknown>;
    }): Promise<Session>;
  };
};

type GeminiClientFactory = (apiKey: string) => GeminiLiveClient;

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

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class GeminiLivePhoneService {
  private readonly secrets: SecretStoreService;
  private readonly vonage: VonageService;
  private readonly activeBridges = new Map<string, ActiveBridge>();
  private readonly liveTelemetry = telemetry.child({
    component: "gemini-live-phone",
  });
  private readonly geminiFactory: GeminiClientFactory;

  constructor(options?: {
    secrets?: SecretStoreService;
    vonage?: VonageService;
    geminiFactory?: GeminiClientFactory;
  }) {
    this.secrets = options?.secrets ?? new SecretStoreService();
    this.vonage = options?.vonage ?? new VonageService();
    this.geminiFactory =
      options?.geminiFactory ?? ((apiKey) => new GoogleGenAI({ apiKey }));
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  getSession(id: string) {
    ensureLivePhoneRoot();
    const sessionPath = getSessionPath(id);
    if (!fs.existsSync(sessionPath)) {
      return null;
    }
    const parsed = JSON.parse(
      fs.readFileSync(sessionPath, "utf8"),
    ) as Partial<GeminiLivePhoneSessionRecord>;
    const createdAt = normalizeString(parsed.createdAt) ?? nowIso();
    return {
      ...(parsed as GeminiLivePhoneSessionRecord),
      latency: parsed.latency ?? createLatencyProfile(createdAt),
    };
  }

  async recordVoiceEventWebhook(request: Request) {
    const payload = await readWebhookPayload(request);
    return this.recordVoiceEventPayload(payload);
  }

  getSessionWebSocketPath(sessionId: string) {
    return getSessionWsPath(sessionId);
  }

  resolveSessionIdFromPath(pathname: string) {
    return resolveSessionIdFromPathImpl(pathname);
  }

  async makePhoneCall(input: {
    to: string;
    from?: string;
    instructions: string;
  }) {
    const communications = this.vonage.getStatus();
    if (!communications.publicBaseUrl) {
      throw new Error(
        "communications.publicBaseUrl is required for live phone calls.",
      );
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
      model: resolveModel(),
      websocketUrl: toWebSocketUrl(
        communications.publicBaseUrl,
        this.getSessionWebSocketPath(sessionId),
      ),
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
    appendTranscriptLog(record.id, {
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
        latency: withSetupMetric(record.latency, "callCreatedAt", nowIso()),
      });
      writeCallIndex(call.id, record.id);
      appendTranscriptLog(record.id, {
        timestamp: nowIso(),
        type: "call.created",
        callId: call.id,
      });
      return updated;
    } catch (error) {
      const updated = this.failSession(record.id, error);
      throw new Error(
        `Failed to create live phone call ${updated.id}: ${updated.error}`,
      );
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

  // -----------------------------------------------------------------------
  // Vonage WebSocket handlers
  // -----------------------------------------------------------------------

  async handleVonageSocketOpen(
    socket: ServerWebSocket<GeminiLivePhoneSocketData>,
  ) {
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
      startPrompt: buildCallStartPrompt(session.instructions),
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
    bridge.latency = withSetupMetric(
      bridge.latency,
      "vonageWebsocketOpenedAt",
      websocketOpenedAt,
    );
    this.saveSession({
      ...session,
      status: "connecting",
      updatedAt: nowIso(),
      startedAt: session.startedAt ?? nowIso(),
      error: null,
      latency: bridge.latency,
    });
    appendTranscriptLog(sessionId, {
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
      this.liveTelemetry.recordError(error, {
        operation: "gemini.connect",
        sessionId,
      });
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
    this.recordAudioPacketOnBridge(bridge, "inbound", audio.length);
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
    appendTranscriptLog(socket.data.sessionId, {
      timestamp: nowIso(),
      type: "vonage.websocket.close",
      code,
      reason,
    });
    const session = this.getSession(socket.data.sessionId);
    if (!session) {
      return;
    }
    bridge.latency = withSetupMetric(
      bridge.latency,
      "callEndedAt",
      nowIso(),
    );
    this.saveSession({
      ...session,
      status: session.status === "failed" ? "failed" : "completed",
      updatedAt: nowIso(),
      endedAt: session.endedAt ?? nowIso(),
      latency: recomputeLatencySummary(bridge.latency),
    });
  }

  // -----------------------------------------------------------------------
  // Gemini connection & messages
  // -----------------------------------------------------------------------

  private async connectGemini(
    bridge: ActiveBridge,
    session: GeminiLivePhoneSessionRecord,
  ) {
    const apiKey = resolveGeminiApiKey(this.secrets);
    const ai = this.geminiFactory(apiKey);
    const connected = await ai.live.connect({
      model: session.model,
      config: buildGeminiConnectConfig(session.instructions),
      callbacks: {
        onopen: () => {
          bridge.latency = withSetupMetric(
            bridge.latency,
            "geminiWebsocketOpenedAt",
            nowIso(),
          );
          appendTranscriptLog(session.id, {
            timestamp: nowIso(),
            type: "gemini.websocket.open",
          });
          const current = this.getSession(session.id);
          if (current) {
            this.saveSession({
              ...current,
              status: bridge.vonageConnected ? "active" : "connecting",
              updatedAt: nowIso(),
              latency: recomputeLatencySummary(bridge.latency),
            });
          }
        },
        onmessage: (message) => {
          this.handleGeminiServerMessage(bridge, message);
        },
        onerror: (event) => {
          const message = event.message || "Unknown Gemini websocket error";
          appendTranscriptLog(session.id, {
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
          appendTranscriptLog(session.id, {
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

  private handleGeminiServerMessage(
    bridge: ActiveBridge,
    message: LiveServerMessage,
  ) {
    const content = message.serverContent;
    if (!content) {
      return;
    }

    if (content.interrupted) {
      bridge.vonageSocket.send(JSON.stringify({ action: "clear" }));
      appendTranscriptLog(bridge.sessionId, {
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
        this.recordAudioPacketOnBridge(bridge, "outbound", pcm16k.length);
        bridge.vonageSocket.send(pcm16k);
      }
    }
    this.maybePersistLatency(bridge, true);
  }

  // -----------------------------------------------------------------------
  // Vonage control messages
  // -----------------------------------------------------------------------

  private handleVonageControlMessage(bridge: ActiveBridge, rawMessage: string) {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(rawMessage) as Record<string, unknown>;
    } catch {
      payload = { raw: rawMessage };
    }
    const event = normalizeString(payload.event) ?? "message";
    appendTranscriptLog(bridge.sessionId, {
      timestamp: nowIso(),
      type: "vonage.control",
      event,
      payload,
    });
    if (event === "websocket:connected") {
      bridge.vonageConnected = true;
      bridge.latency = withSetupMetric(
        bridge.latency,
        "mediaConnectedAt",
        nowIso(),
      );
      const session = this.getSession(bridge.sessionId);
      if (session) {
        this.saveSession({
          ...session,
          status: bridge.geminiSession ? "active" : "connecting",
          updatedAt: nowIso(),
          latency: recomputeLatencySummary(bridge.latency),
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
      turns: [
        {
          role: "user",
          parts: [
            {
              text: bridge.startPrompt,
            },
          ],
        },
      ],
      turnComplete: true,
    });
    appendTranscriptLog(bridge.sessionId, {
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

  // -----------------------------------------------------------------------
  // Transcription recording
  // -----------------------------------------------------------------------

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
    const previous =
      speaker === "caller" ? bridge.inputTranscript : bridge.outputTranscript;
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
    appendTranscriptLog(bridge.sessionId, {
      timestamp: nowIso(),
      type: "transcript",
      speaker,
      final: finished,
      text: normalized,
    });
    this.maybePersistLatency(bridge);
  }

  // -----------------------------------------------------------------------
  // Audio & speech activity recording (delegates to sub-modules)
  // -----------------------------------------------------------------------

  private recordAudioPacketOnBridge(
    bridge: ActiveBridge,
    direction: "inbound" | "outbound",
    byteLength: number,
  ) {
    const stats =
      direction === "inbound"
        ? bridge.latency.stream.inboundAudio
        : bridge.latency.stream.outboundAudio;
    recordAudioPacket(stats, byteLength, nowIso(), isoToMs);
  }

  private recordPendingQueueState(bridge: ActiveBridge) {
    const maxPendingMessages = bridge.latency.summary.maxPendingMessages;
    const maxPendingBytes = bridge.latency.summary.maxPendingBytes;
    bridge.latency.summary.maxPendingMessages = Math.max(
      maxPendingMessages,
      bridge.pendingMessages.length,
    );
    bridge.latency.summary.maxPendingBytes = Math.max(
      maxPendingBytes,
      bridge.pendingAudioBytes,
    );
    const pendingAudioMs = bytesToPcm16kDurationMs(bridge.pendingAudioBytes);
    bridge.latency.summary.maxPendingAudioMs = Math.max(
      bridge.latency.summary.maxPendingAudioMs,
      pendingAudioMs,
    );
  }

  private recordInboundSpeechActivity(bridge: ActiveBridge, audio: Buffer) {
    if (!hasSpeechLikeEnergy(audio)) {
      return;
    }
    this.clearPendingHangup(bridge);
    const result = getOrStartInboundTurn(
      bridge.latency.turns,
      bridge.activeTurnIndex,
    );
    bridge.activeTurnIndex = result.activeTurnIndex;
    const turn = result.turn;
    const timestamp = nowIso();
    turn.callerFirstAudioAt ??= timestamp;
    turn.callerLastAudioAt = timestamp;
  }

  // -----------------------------------------------------------------------
  // Latency: caller & assistant transcript recording
  // -----------------------------------------------------------------------

  private recordCallerTranscript(
    bridge: ActiveBridge,
    text: string,
    finished: boolean,
  ) {
    const result = getOrStartInboundTurn(
      bridge.latency.turns,
      bridge.activeTurnIndex,
    );
    bridge.activeTurnIndex = result.activeTurnIndex;
    const turn = result.turn;
    const timestamp = nowIso();
    turn.callerFirstTranscriptAt ??= timestamp;
    turn.callerLastAudioBeforeFirstTranscriptAt ??= turn.callerLastAudioAt;
    turn.callerTranscript = text;
    turn.callerSpeechDurationBeforeFirstTranscriptMs ??= diffMs(
      turn.callerFirstAudioAt,
      turn.callerLastAudioBeforeFirstTranscriptAt,
    );
    turn.callerAudioToFirstTranscriptMs ??= diffMs(
      turn.callerFirstAudioAt,
      turn.callerFirstTranscriptAt,
    );
    turn.callerLastAudioToFirstTranscriptMs ??= diffMs(
      turn.callerLastAudioBeforeFirstTranscriptAt,
      turn.callerFirstTranscriptAt,
    );
    if (
      turn.estimatedEndpointingDelayMs === null ||
      turn.estimatedRecognitionDelayMs === null
    ) {
      const breakdown = estimateInputLatencyBreakdown(
        turn.callerLastAudioToFirstTranscriptMs,
        resolveCallerSilenceDurationMs(),
      );
      turn.estimatedEndpointingDelayMs = breakdown.endpointingDelayMs;
      turn.estimatedRecognitionDelayMs = breakdown.recognitionDelayMs;
      appendTranscriptLog(bridge.sessionId, {
        timestamp,
        type: "latency.input",
        turnId: turn.id,
        callerSpeechDurationBeforeFirstTranscriptMs:
          turn.callerSpeechDurationBeforeFirstTranscriptMs,
        callerLastAudioToFirstTranscriptMs:
          turn.callerLastAudioToFirstTranscriptMs,
        estimatedEndpointingDelayMs: turn.estimatedEndpointingDelayMs,
        estimatedRecognitionDelayMs: turn.estimatedRecognitionDelayMs,
        configuredSilenceDurationMs: resolveCallerSilenceDurationMs(),
      });
    }
    if (finished) {
      turn.callerFinalTranscriptAt ??= timestamp;
      turn.callerAudioToFinalTranscriptMs ??= diffMs(
        turn.callerFirstAudioAt,
        turn.callerFinalTranscriptAt,
      );
    }
  }

  private recordAssistantTranscript(
    bridge: ActiveBridge,
    text: string,
    _finished: boolean,
  ) {
    const timestamp = nowIso();
    const turn = getActiveTurnForResponse(
      bridge.latency.turns,
      bridge.activeTurnIndex,
    );
    if (turn && !turn.assistantFirstTranscriptAt) {
      turn.assistantFirstTranscriptAt = timestamp;
      turn.assistantTranscript = text;
      turn.callerFinalToAssistantTranscriptMs = diffMs(
        turn.callerFinalTranscriptAt,
        turn.assistantFirstTranscriptAt,
      );
      turn.callerLastAudioToAssistantTranscriptMs = diffMs(
        turn.callerLastAudioAt,
        turn.assistantFirstTranscriptAt,
      );
      turn.generationDelayMs = turn.callerLastAudioToAssistantTranscriptMs;
      appendTranscriptLog(bridge.sessionId, {
        timestamp,
        type: "latency.turn",
        turnId: turn.id,
        metric: "caller_to_first_assistant_transcript",
        callerFinalToAssistantTranscriptMs:
          turn.callerFinalToAssistantTranscriptMs,
        callerLastAudioToAssistantTranscriptMs:
          turn.callerLastAudioToAssistantTranscriptMs,
        generationDelayMs: turn.generationDelayMs,
      });
    }
    bridge.latency.setup.firstAssistantTranscriptAt ??= timestamp;
    bridge.latency = withSetupMetric(
      bridge.latency,
      "firstAssistantTranscriptAt",
      bridge.latency.setup.firstAssistantTranscriptAt,
    );
    if (containsEndCallTrigger(text)) {
      this.maybeScheduleAutoHangup(bridge, text);
    }
  }

  private recordAssistantAudioStart(bridge: ActiveBridge) {
    const timestamp = nowIso();
    const turn = getActiveTurnForResponse(
      bridge.latency.turns,
      bridge.activeTurnIndex,
    );
    if (turn && !turn.assistantFirstAudioAt) {
      turn.assistantFirstAudioAt = timestamp;
      turn.callerFinalToAssistantAudioMs = diffMs(
        turn.callerFinalTranscriptAt,
        turn.assistantFirstAudioAt,
      );
      turn.callerLastAudioToAssistantAudioMs = diffMs(
        turn.callerLastAudioAt,
        turn.assistantFirstAudioAt,
      );
      turn.assistantTranscriptToAudioMs = diffMs(
        turn.assistantFirstTranscriptAt,
        turn.assistantFirstAudioAt,
      );
      turn.completedAt ??= timestamp;
      appendTranscriptLog(bridge.sessionId, {
        timestamp,
        type: "latency.turn",
        turnId: turn.id,
        metric: "caller_to_first_assistant_audio",
        callerFinalToAssistantAudioMs: turn.callerFinalToAssistantAudioMs,
        callerLastAudioToAssistantAudioMs:
          turn.callerLastAudioToAssistantAudioMs,
        assistantTranscriptToAudioMs: turn.assistantTranscriptToAudioMs,
      });
    }
    bridge.latency.setup.firstAssistantAudioAt ??= timestamp;
    bridge.latency = withSetupMetric(
      bridge.latency,
      "firstAssistantAudioAt",
      bridge.latency.setup.firstAssistantAudioAt,
    );
  }

  // -----------------------------------------------------------------------
  // Latency persistence
  // -----------------------------------------------------------------------

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
      latency: recomputeLatencySummary(bridge.latency),
    });
  }

  // -----------------------------------------------------------------------
  // Auto-hangup
  // -----------------------------------------------------------------------

  private maybeScheduleAutoHangup(bridge: ActiveBridge, text: string) {
    const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
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
    appendTranscriptLog(bridge.sessionId, {
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
    appendTranscriptLog(bridge.sessionId, {
      timestamp: nowIso(),
      type: "call.auto_hangup.start",
      reason,
      callId: session.callId,
    });
    try {
      await this.vonage.hangupCall(session.callId);
      appendTranscriptLog(bridge.sessionId, {
        timestamp: nowIso(),
        type: "call.auto_hangup.success",
        reason,
        callId: session.callId,
      });
    } catch (error) {
      bridge.endingCall = false;
      appendTranscriptLog(bridge.sessionId, {
        timestamp: nowIso(),
        type: "call.auto_hangup.error",
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // -----------------------------------------------------------------------
  // Session persistence
  // -----------------------------------------------------------------------

  private saveSession(record: GeminiLivePhoneSessionRecord) {
    ensureLivePhoneRoot();
    fs.mkdirSync(path.dirname(record.sessionPath), { recursive: true });
    const normalized = {
      ...record,
      latency: recomputeLatencySummary(record.latency),
    };
    fs.writeFileSync(
      record.sessionPath,
      `${JSON.stringify(normalized, null, 2)}\n`,
      "utf8",
    );
    return normalized;
  }

  private recordVoiceEventPayload(payload: Record<string, unknown>) {
    const callId = normalizeString(payload.uuid);
    if (!callId) {
      return null;
    }
    const sessionId = readCallIndex(callId);
    if (!sessionId) {
      return null;
    }
    const session = this.getSession(sessionId);
    if (!session) {
      return null;
    }
    const status = normalizeString(payload.status) ?? "event";
    const detail = normalizeString(payload.detail);
    const timestamp = nowIso();
    const latency = applyVoiceEventToLatency(
      session.latency,
      status,
      timestamp,
    );
    const updated = this.saveSession({
      ...session,
      status: deriveSessionStatus(session.status, status),
      updatedAt: timestamp,
      startedAt:
        session.startedAt ??
        (status === "answered" ? timestamp : session.startedAt),
      endedAt: isTerminalVoiceStatus(status)
        ? (session.endedAt ?? timestamp)
        : session.endedAt,
      error: status === "failed" ? (detail ?? status) : session.error,
      latency,
    });
    logVoiceEvent(
      sessionId,
      status,
      detail,
      payload,
      updated.latency.setup,
    );
    const activeBridge = this.activeBridges.get(sessionId);
    if (activeBridge) {
      activeBridge.latency = updated.latency;
    }
    return updated;
  }

  private failSession(sessionId: string, error: unknown) {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Unknown live phone session: ${sessionId}`);
    }
    const message =
      error instanceof Error ? error.message : String(error);
    const updated = this.saveSession({
      ...session,
      status: "failed",
      updatedAt: nowIso(),
      endedAt: session.endedAt ?? nowIso(),
      error: message,
    });
    appendTranscriptLog(sessionId, {
      timestamp: nowIso(),
      type: "session.failed",
      error: message,
    });
    return updated;
  }

}
