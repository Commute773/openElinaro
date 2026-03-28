import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { LiveCallbacks, Session } from "@google/genai";
import { GeminiLivePhoneService } from "./gemini-live-phone-service";
import { SecretStoreService } from "./infrastructure/secret-store-service";
import type { VonageService } from "./vonage-service";

const tempDirs: string[] = [];
const previousEnv = {
  OPENELINARO_ROOT_DIR: process.env.OPENELINARO_ROOT_DIR,
  OPENELINARO_SECRET_KEY: process.env.OPENELINARO_SECRET_KEY,
  OPENELINARO_GEMINI_LIVE_MODEL: process.env.OPENELINARO_GEMINI_LIVE_MODEL,
};
const previousCwd = process.cwd();

function withRuntimeRoot() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-gemini-live-phone-"));
  tempDirs.push(runtimeRoot);
  process.env.OPENELINARO_ROOT_DIR = runtimeRoot;
  process.chdir(runtimeRoot);
  return runtimeRoot;
}

function restoreEnv() {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  process.chdir(previousCwd);
}

function createFakeVonage() {
  return {
    getStatus: () => ({
      publicBaseUrl: "https://openelinaro.example.com",
      webhookUrls: {
        voiceEvent: "https://openelinaro.example.com/webhooks/vonage/voice/event",
        voiceFallback: "https://openelinaro.example.com/webhooks/vonage/voice/fallback",
      },
    }),
    createRealtimeWebsocketCall: async () => ({
      id: "call-123",
      provider: "vonage",
      direction: "outbound",
      channel: "phone",
      status: "started",
      from: "+15145550000",
      to: "+15145550001",
      conversationUuid: null,
      regionUrl: null,
      startedAt: null,
      answeredAt: null,
      completedAt: null,
      durationSeconds: null,
      price: null,
      createdAt: "2026-03-20T00:00:00.000Z",
      updatedAt: "2026-03-20T00:00:00.000Z",
      events: [],
    }),
    hangupCall: async () => ({
      id: "call-123",
    }),
  } as unknown as VonageService;
}

afterEach(() => {
  restoreEnv();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("GeminiLivePhoneService", () => {
  test("creates a durable live-call session with transcript log paths", async () => {
    withRuntimeRoot();
    const service = new GeminiLivePhoneService({ vonage: createFakeVonage() });

    const session = await service.makePhoneCall({
      to: "+15145550001",
      instructions: "Introduce yourself as a short test call and ask whether audio is clear.",
    });

    expect(session.callId).toBe("call-123");
    expect(session.status).toBe("dialing");
    expect(session.websocketUrl).toContain("/webhooks/vonage/voice/live/");
    expect(session.websocketUrl.startsWith("wss://openelinaro.example.com")).toBe(true);
    expect(fs.existsSync(session.sessionPath)).toBe(true);
    expect(fs.existsSync(session.transcriptLogPath)).toBe(true);
    expect(fs.readFileSync(session.transcriptLogPath, "utf8")).toContain("session.created");
    expect(fs.readFileSync(session.transcriptLogPath, "utf8")).toContain("call.created");
  });

  test("bridges Vonage websocket audio into Gemini and logs transcripts", async () => {
    withRuntimeRoot();
    process.env.OPENELINARO_SECRET_KEY = "gemini-live-test-key";

    const secrets = new SecretStoreService();
    secrets.saveSecret({
      name: "gemini",
      fields: {
        apiKey: "test-gemini-key",
      },
    });

    let callbacks: LiveCallbacks | null = null;
    let connectConfig: any = null;
    const sentRealtimeInput: unknown[] = [];
    const sentClientContent: unknown[] = [];
    let hangupCount = 0;
    let closed = false;
    const fakeGeminiSession = {
      sendRealtimeInput: (input: unknown) => {
        sentRealtimeInput.push(input);
      },
      sendClientContent: (input: unknown) => {
        sentClientContent.push(input);
      },
      close: () => {
        closed = true;
      },
    } as unknown as Session;

    const fakeVonage = {
      ...createFakeVonage(),
      hangupCall: async () => {
        hangupCount += 1;
        return { id: "call-123" };
      },
    } as unknown as VonageService;

    const service = new GeminiLivePhoneService({
      secrets,
      vonage: fakeVonage,
      geminiFactory: () => ({
        live: {
          connect: async (params: { callbacks: LiveCallbacks; config?: Record<string, unknown> }) => {
            callbacks = params.callbacks;
            connectConfig = params.config ?? null;
            return fakeGeminiSession;
          },
        },
      }),
    });

    const session = await service.makePhoneCall({
      to: "+15145550001",
      instructions: "Run a brief connectivity test and keep the conversation under ten seconds.",
    });

    const outboundMessages: Array<string | Buffer> = [];
    const fakeSocket = {
      data: {
        kind: "gemini-live-phone",
        sessionId: session.id,
      },
      send: (message: string | Buffer) => {
        outboundMessages.push(message);
      },
      close: () => {
        closed = true;
      },
    } as any;

    await service.handleVonageSocketOpen(fakeSocket);
    service.handleVonageSocketMessage(fakeSocket, JSON.stringify({ event: "websocket:connected" }));
    const inboundSpeech = Buffer.alloc(8);
    inboundSpeech.writeInt16LE(1400, 0);
    inboundSpeech.writeInt16LE(1600, 2);
    inboundSpeech.writeInt16LE(1800, 4);
    inboundSpeech.writeInt16LE(1500, 6);
    service.handleVonageSocketMessage(fakeSocket, inboundSpeech);

    const pcm24 = Buffer.from([0, 0, 12, 0, 24, 0, 36, 0, 48, 0, 60, 0]);
    expect(callbacks).not.toBeNull();
    callbacks!.onmessage({
      serverContent: {
        inputTranscription: { text: "hello there", finished: true },
        outputTranscription: { text: "hi, this is a test call", finished: true },
        modelTurn: {
          parts: [{
            inlineData: {
              data: pcm24.toString("base64"),
              mimeType: "audio/pcm;rate=24000",
            },
          }],
        },
      },
    } as any);

    expect(sentClientContent.length).toBe(1);
    expect(sentRealtimeInput.length).toBe(1);
    expect(connectConfig).not.toBeNull();
    if (!connectConfig) {
      throw new Error("Gemini connect config was not captured");
    }
    const config = connectConfig;
    expect(String(config.systemInstruction)).toContain("# Gemini Live — Human-Like Voice Prompt");
    expect(String(config.systemInstruction)).toContain("Run a brief connectivity test");
    expect(String(config.systemInstruction)).toContain("If you say any of these closing phrases");
    expect(String(config.systemInstruction)).toContain("bye, goodbye, take care");
    expect(config.tools).toBeUndefined();
    expect(config.generationConfig?.thinkingConfig?.thinkingBudget).toBe(0);
    expect(config.realtimeInputConfig?.automaticActivityDetection?.prefixPaddingMs).toBe(20);
    expect(config.realtimeInputConfig?.automaticActivityDetection?.silenceDurationMs).toBe(100);
    expect(outboundMessages.some((message) => Buffer.isBuffer(message))).toBe(true);
    const updated = service.getSession(session.id);
    expect(updated?.latency.stream.inboundAudio.packets).toBeGreaterThan(0);
    expect(updated?.latency.stream.outboundAudio.packets).toBeGreaterThan(0);
    expect(updated?.latency.summary.inboundAvgChunkMs).not.toBeNull();
    expect(updated?.latency.summary.maxPendingAudioMs).not.toBeNull();
    expect(updated?.latency.turns[0]?.callerLastAudioToFirstTranscriptMs).not.toBeNull();
    expect(updated?.latency.turns[0]?.estimatedEndpointingDelayMs).not.toBeNull();
    expect(updated?.latency.turns[0]?.estimatedRecognitionDelayMs).not.toBeNull();
    expect(updated?.latency.turns[0]?.generationDelayMs).not.toBeNull();
    expect(updated?.latency.turns[0]?.assistantTranscriptToAudioMs).not.toBeNull();
    expect(updated?.latency.summary.totalTurns).toBeGreaterThanOrEqual(1);
    expect(updated?.latency.turns[0]?.callerAudioToFinalTranscriptMs).not.toBeNull();
    expect(updated?.latency.turns[0]?.callerLastAudioToAssistantAudioMs).not.toBeNull();
    expect(fs.readFileSync(session.transcriptLogPath, "utf8")).toContain("hello there");
    expect(fs.readFileSync(session.transcriptLogPath, "utf8")).toContain("hi, this is a test call");
    expect(fs.readFileSync(session.transcriptLogPath, "utf8")).toContain("\"type\":\"latency.turn\"");
    expect(fs.readFileSync(session.transcriptLogPath, "utf8")).toContain("\"type\":\"latency.input\"");
    expect(fs.readFileSync(session.transcriptLogPath, "utf8")).toContain("\"assistantTranscriptToAudioMs\"");

    callbacks!.onmessage({
      serverContent: {
        outputTranscription: { text: "okay, bye!", finished: false },
      },
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 1900));
    expect(hangupCount).toBe(1);
    expect(fs.readFileSync(session.transcriptLogPath, "utf8")).toContain("\"type\":\"call.auto_hangup.success\"");

    service.handleVonageSocketClose(fakeSocket, 1000, "normal");
    expect(closed).toBe(true);
  });

  test("records failed voice events back into the live-call session", async () => {
    withRuntimeRoot();
    const service = new GeminiLivePhoneService({ vonage: createFakeVonage() });
    const session = await service.makePhoneCall({
      to: "+15145550001",
      instructions: "Keep this test short.",
    });

    await service.recordVoiceEventWebhook(new Request(`http://localhost/webhooks/vonage/voice/event?uuid=${encodeURIComponent(session.callId ?? "")}&status=failed&detail=cannot_route`));

    const updated = service.getSession(session.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toBe("cannot_route");
    expect(updated?.latency.setup.callEndedAt).not.toBeNull();
    expect(fs.readFileSync(session.transcriptLogPath, "utf8")).toContain("\"type\":\"voice.event\"");
  });
});
