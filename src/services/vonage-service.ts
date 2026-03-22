import crypto from "node:crypto";
import type {
  CallControlAction,
  CallRecord,
  CommunicationDirection,
  CommunicationsStatus,
  MessageChannel,
  MessageRecord,
} from "../domain/communications";
import { getRuntimeConfig } from "../config/runtime-config";
import { CommunicationsStore } from "./communications-store";
import { SecretStoreService } from "./secret-store-service";
import { telemetry } from "./telemetry";
import { normalizeString } from "../utils/text-utils";
import { DEFAULT_PROFILE_ID as DEFAULT_SECRET_PROFILE_ID } from "../config/service-constants";
import { timestamp as nowIso } from "../utils/timestamp";

const DEFAULT_HTTP_HOST = "0.0.0.0";
const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_VOICE_API_BASE_URL = "https://api.nexmo.com";
const DEFAULT_MESSAGES_API_BASE_URL = "https://api.nexmo.com";
const DEFAULT_WEBHOOK_BASE_PATH = "/webhooks/vonage";
const DEFAULT_PRIVATE_KEY_SECRET_REF = "vonage.private_key";
const DEFAULT_SIGNATURE_SECRET_REF = "vonage.signature_secret";
const DEFAULT_VOICE_ANSWER_TEXT =
  "The assistant is online, but live inbound calling is not configured yet. Please send a text message instead.";
const DEFAULT_MESSAGE_CHANNEL: MessageChannel = "sms";
const DEFAULT_TTS_LANGUAGE = "en-US";

type WebhookKind =
  | "voice.answer"
  | "voice.event"
  | "voice.fallback"
  | "messages.inbound"
  | "messages.status";

type CallCreateInput = {
  to: string;
  from?: string;
  answerText?: string;
  eventUrl?: string;
  answerUrl?: string;
  fallbackUrl?: string;
};

type RealtimeWebsocketAuthorization = {
  type: "vonage" | "custom";
  value?: string;
};

type RealtimeWebsocketCallInput = {
  to: string;
  from?: string;
  uri: string;
  headers?: Record<string, unknown>;
  authorization?: RealtimeWebsocketAuthorization;
  eventUrl?: string;
  fallbackUrl?: string;
  contentType?: "audio/l16;rate=16000" | "audio/l16;rate=8000";
};

type CallControlInput = {
  uuid: string;
  action: CallControlAction;
  text?: string;
  streamUrl?: string;
  loop?: number;
  language?: string;
  destinationNumber?: string;
};

type MessageSendInput = {
  to: string;
  from?: string;
  channel?: MessageChannel;
  text: string;
  clientRef?: string;
};


function normalizeBaseUrl(value: string | undefined | null) {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  return normalized.replace(/\/+$/, "");
}

function parsePort(value: string | undefined) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HTTP_PORT;
}


function normalizeNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeDirection(value: unknown): CommunicationDirection {
  return value === "inbound" || value === "outbound" ? value : "unknown";
}

function normalizeMessageChannel(value: unknown): MessageChannel {
  return value === "sms"
    || value === "mms"
    || value === "whatsapp"
    || value === "messenger"
    || value === "viber"
    ? value
    : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json",
  };
}

function base64UrlJson(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function parseJwtClaims(token: string) {
  const [, payload] = token.split(".");
  if (!payload) {
    throw new Error("Invalid JWT payload.");
  }
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

function formatWebhookMethod(label: string, method: string, url: string | null) {
  return `${label}: ${method} ${url ?? "(missing communications.publicBaseUrl)"}`;
}

function extractCallAddress(value: unknown) {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (isRecord(value)) {
    return normalizeString(value.number) ?? normalizeString(value.uri) ?? normalizeString(value.user);
  }
  return null;
}

function buildWebhookUrls(baseUrl: string | null, webhookBasePath: string) {
  const join = (suffix: string) => baseUrl ? `${baseUrl}${webhookBasePath}${suffix}` : null;
  return {
    voiceAnswer: join("/voice/answer"),
    voiceEvent: join("/voice/event"),
    voiceFallback: join("/voice/fallback"),
    messagesInbound: join("/messages/inbound"),
    messagesStatus: join("/messages/status"),
  };
}

function getCommunicationsConfig() {
  return getRuntimeConfig().communications;
}

function getVonageConfig() {
  return getCommunicationsConfig().vonage;
}

async function readWebhookPayload(request: Request) {
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

export class VonageService {
  private readonly store: CommunicationsStore;
  private readonly secrets: SecretStoreService;
  private readonly vonageTelemetry = telemetry.child({ component: "vonage" });

  constructor(options?: {
    store?: CommunicationsStore;
    secrets?: SecretStoreService;
  }) {
    this.store = options?.store ?? new CommunicationsStore();
    this.secrets = options?.secrets ?? new SecretStoreService();
  }

  getStatus(): CommunicationsStatus {
    const communications = getCommunicationsConfig();
    const vonage = communications.vonage;
    const publicBaseUrl = normalizeBaseUrl(communications.publicBaseUrl);
    const httpHost = getRuntimeConfig().core.http.host ?? DEFAULT_HTTP_HOST;
    const httpPort = parsePort(String(getRuntimeConfig().core.http.port));
    const applicationId = normalizeString(vonage.applicationId);
    const privateKeySecretRef = vonage.privateKeySecretRef || DEFAULT_PRIVATE_KEY_SECRET_REF;
    const signatureSecretRef = vonage.signatureSecretRef || DEFAULT_SIGNATURE_SECRET_REF;
    const voiceRegion = normalizeString(vonage.voiceRegion);
    const defaultFromNumber = normalizeString(vonage.defaultFromNumber);
    const defaultMessageFrom = normalizeString(vonage.defaultMessageFrom);
    const defaultMessageChannel = normalizeMessageChannel(
      vonage.defaultMessageChannel ?? DEFAULT_MESSAGE_CHANNEL,
    );
    const secretProfileId = vonage.secretProfileId || DEFAULT_SECRET_PROFILE_ID;
    const webhookBasePath = vonage.webhookBasePath || DEFAULT_WEBHOOK_BASE_PATH;
    const webhookUrls = buildWebhookUrls(publicBaseUrl, webhookBasePath);
    const privateKeyConfigured = this.hasSecret(privateKeySecretRef, secretProfileId);
    const signatureSecretConfigured = this.hasSecret(signatureSecretRef, secretProfileId);
    const missing = [
      !publicBaseUrl ? "communications.publicBaseUrl" : "",
      !applicationId ? "communications.vonage.applicationId" : "",
      !privateKeyConfigured ? `${privateKeySecretRef} secret` : "",
    ].filter(Boolean);
    const warnings = [
      !defaultFromNumber ? "communications.vonage.defaultFromNumber is not set; outbound calls need an explicit from number." : "",
      !defaultMessageFrom ? "communications.vonage.defaultMessageFrom is not set; outbound messages need an explicit from value." : "",
      !signatureSecretConfigured ? `${signatureSecretRef} is not configured; webhook signatures will not be verified.` : "",
    ].filter(Boolean);

    return {
      configured: missing.length === 0,
      missing,
      warnings,
      publicBaseUrl,
      httpHost,
      httpPort,
      webhookUrls,
      vonage: {
        applicationId,
        privateKeySecretRef,
        privateKeyConfigured,
        signatureSecretRef,
        signatureSecretConfigured,
        voiceRegion,
        defaultFromNumber,
        defaultMessageChannel,
        defaultMessageFrom,
      },
    };
  }

  formatStatus(status = this.getStatus()) {
    const lines = [
      `Configured: ${status.configured ? "yes" : "no"}`,
      `Public base URL: ${status.publicBaseUrl ?? "(missing)"}`,
      `HTTP listener: ${status.httpHost}:${status.httpPort}`,
      `Vonage application id: ${status.vonage.applicationId ?? "(missing)"}`,
      `Private key secret ref: ${status.vonage.privateKeySecretRef} (${status.vonage.privateKeyConfigured ? "present" : "missing"})`,
      `Webhook signature secret ref: ${status.vonage.signatureSecretRef} (${status.vonage.signatureSecretConfigured ? "present" : "missing"})`,
      `Default call from: ${status.vonage.defaultFromNumber ?? "(unset)"}`,
      `Default message channel: ${status.vonage.defaultMessageChannel}`,
      `Default message from: ${status.vonage.defaultMessageFrom ?? "(unset)"}`,
      status.vonage.voiceRegion ? `Voice region: ${status.vonage.voiceRegion}` : "Voice region: (unset)",
      "",
      "Vonage dashboard values:",
      formatWebhookMethod("Voice answer URL", "GET", status.webhookUrls.voiceAnswer),
      formatWebhookMethod("Voice event URL", "GET", status.webhookUrls.voiceEvent),
      formatWebhookMethod("Voice fallback URL", "GET", status.webhookUrls.voiceFallback),
      formatWebhookMethod("Messages inbound URL", "POST", status.webhookUrls.messagesInbound),
      formatWebhookMethod("Messages status URL", "POST", status.webhookUrls.messagesStatus),
    ];

    if (status.missing.length > 0) {
      lines.push("", `Missing: ${status.missing.join(", ")}`);
    }
    if (status.warnings.length > 0) {
      lines.push("", ...status.warnings.map((warning) => `Warning: ${warning}`));
    }
    return lines.join("\n");
  }

  async createCall(input: CallCreateInput) {
    const status = this.getStatus();
    if (!status.vonage.defaultFromNumber && !input.from?.trim()) {
      throw new Error("Outbound calls require a from number. Set communications.vonage.defaultFromNumber or pass from.");
    }
    const answerText = input.answerText?.trim() || getVonageConfig().voiceAnswerText || DEFAULT_VOICE_ANSWER_TEXT;
    const urls = status.webhookUrls;
    const response = await this.fetchVonageJson(
      `${this.getVoiceApiBaseUrl()}/v1/calls`,
      {
        method: "POST",
        body: JSON.stringify({
          to: [{ type: "phone", number: input.to }],
          from: { type: "phone", number: input.from?.trim() || status.vonage.defaultFromNumber },
          ncco: [{ action: "talk", text: answerText }],
          answer_url: input.answerUrl ? [input.answerUrl] : urls.voiceAnswer ? [urls.voiceAnswer] : undefined,
          event_url: input.eventUrl ? [input.eventUrl] : urls.voiceEvent ? [urls.voiceEvent] : undefined,
          fallback_answer_url: input.fallbackUrl ? [input.fallbackUrl] : urls.voiceFallback ? [urls.voiceFallback] : undefined,
        }),
      },
      "vonage.api.call_create",
    );
    const call = this.upsertRemoteCallRecord(response, {
      fallbackFrom: input.from?.trim() || status.vonage.defaultFromNumber,
      fallbackTo: input.to,
      fallbackStatus: "started",
      fallbackDirection: "outbound",
    });
    this.store.appendCallEvent({
      id: call.id,
      source: "api.call.create",
      eventType: "api.create",
      verified: true,
      payload: response,
    });
    return call;
  }

  async createRealtimeWebsocketCall(input: RealtimeWebsocketCallInput) {
    const status = this.getStatus();
    if (!status.vonage.defaultFromNumber && !input.from?.trim()) {
      throw new Error("Outbound calls require a from number. Set communications.vonage.defaultFromNumber or pass from.");
    }
    const response = await this.fetchVonageJson(
      `${this.getVoiceApiBaseUrl()}/v1/calls`,
      {
        method: "POST",
        body: JSON.stringify({
          to: [{ type: "phone", number: input.to }],
          from: { type: "phone", number: input.from?.trim() || status.vonage.defaultFromNumber },
          ncco: [{
            action: "connect",
            endpoint: [{
              type: "websocket",
              uri: input.uri,
              "content-type": input.contentType ?? "audio/l16;rate=16000",
              headers: input.headers ?? {},
              authorization: input.authorization ?? undefined,
            }],
          }],
          event_url: input.eventUrl ? [input.eventUrl] : status.webhookUrls.voiceEvent ? [status.webhookUrls.voiceEvent] : undefined,
          fallback_answer_url: input.fallbackUrl ? [input.fallbackUrl] : status.webhookUrls.voiceFallback ? [status.webhookUrls.voiceFallback] : undefined,
        }),
      },
      "vonage.api.call_create_realtime_websocket",
    );
    const call = this.upsertRemoteCallRecord(response, {
      fallbackFrom: input.from?.trim() || status.vonage.defaultFromNumber,
      fallbackTo: input.to,
      fallbackStatus: "started",
      fallbackDirection: "outbound",
    });
    this.store.appendCallEvent({
      id: call.id,
      source: "api.call.create",
      eventType: "api.create.realtime_websocket",
      verified: true,
      payload: response,
    });
    return call;
  }

  async listCalls(options?: { limit?: number; status?: string; direction?: CommunicationDirection }) {
    const response = await this.fetchVonageJson(
      `${this.getVoiceApiBaseUrl()}/v1/calls/`,
      { method: "GET" },
      "vonage.api.call_list",
    );
    const rawCalls = Array.isArray(response)
      ? response
      : Array.isArray((response as { _embedded?: { calls?: unknown[] } })._embedded?.calls)
        ? (response as { _embedded: { calls: unknown[] } })._embedded.calls
        : [];
    for (const rawCall of rawCalls) {
      if (!isRecord(rawCall)) {
        continue;
      }
      this.upsertRemoteCallRecord(rawCall, {});
    }
    return this.store.listCalls(options);
  }

  async getCall(uuid: string) {
    const response = await this.fetchVonageJson(
      `${this.getVoiceApiBaseUrl()}/v1/calls/${encodeURIComponent(uuid)}`,
      { method: "GET" },
      "vonage.api.call_get",
    );
    return this.upsertRemoteCallRecord(response, { fallbackId: uuid });
  }

  async controlCall(input: CallControlInput) {
    const baseUrl = this.getCallControlBaseUrl(input.uuid);
    if (input.action === "talk") {
      await this.fetchVonageJson(
        `${baseUrl}/v1/calls/${encodeURIComponent(input.uuid)}/talk`,
        {
          method: "PUT",
          body: JSON.stringify({
            text: input.text?.trim(),
            language: input.language?.trim() || DEFAULT_TTS_LANGUAGE,
          }),
        },
        "vonage.api.call_talk",
      );
    } else if (input.action === "stop_talk") {
      await this.fetchVonageJson(
        `${baseUrl}/v1/calls/${encodeURIComponent(input.uuid)}/talk`,
        { method: "DELETE" },
        "vonage.api.call_stop_talk",
      );
    } else if (input.action === "stream") {
      await this.fetchVonageJson(
        `${baseUrl}/v1/calls/${encodeURIComponent(input.uuid)}/stream`,
        {
          method: "PUT",
          body: JSON.stringify({
            stream_url: [input.streamUrl?.trim()],
            loop: input.loop ?? 1,
          }),
        },
        "vonage.api.call_stream",
      );
    } else if (input.action === "stop_stream") {
      await this.fetchVonageJson(
        `${baseUrl}/v1/calls/${encodeURIComponent(input.uuid)}/stream`,
        { method: "DELETE" },
        "vonage.api.call_stop_stream",
      );
    } else if (input.action === "transfer") {
      await this.fetchVonageJson(
        `${baseUrl}/v1/calls/${encodeURIComponent(input.uuid)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            action: "transfer",
            destination: {
              type: "ncco",
              ncco: [{
                action: "connect",
                endpoint: [{ type: "phone", number: input.destinationNumber?.trim() }],
              }],
            },
          }),
        },
        "vonage.api.call_transfer",
      );
    }

    this.store.appendCallEvent({
      id: input.uuid,
      source: "api.call.control",
      eventType: input.action,
      verified: true,
      payload: {
        action: input.action,
        text: input.text,
        stream_url: input.streamUrl,
        destination_number: input.destinationNumber,
      },
    });
    return this.store.getCall(input.uuid) ?? this.store.upsertCallSnapshot({ id: input.uuid });
  }

  async hangupCall(uuid: string) {
    const baseUrl = this.getCallControlBaseUrl(uuid);
    await this.fetchVonageJson(
      `${baseUrl}/v1/calls/${encodeURIComponent(uuid)}`,
      {
        method: "PUT",
        body: JSON.stringify({ action: "hangup" }),
      },
      "vonage.api.call_hangup",
    );
    this.store.appendCallEvent({
      id: uuid,
      source: "api.call.control",
      eventType: "hangup",
      verified: true,
      payload: { action: "hangup" },
    });
    return this.store.getCall(uuid) ?? this.store.upsertCallSnapshot({ id: uuid });
  }

  async sendMessage(input: MessageSendInput) {
    const status = this.getStatus();
    const channel = input.channel ?? status.vonage.defaultMessageChannel;
    const from = input.from?.trim() || status.vonage.defaultMessageFrom;
    if (!from) {
      throw new Error("Outbound messages require a from value. Set communications.vonage.defaultMessageFrom or pass from.");
    }

    const response = await this.fetchVonageJson(
      `${this.getMessagesApiBaseUrl()}/v1/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          channel,
          message_type: "text",
          to: input.to,
          from,
          text: input.text,
          client_ref: input.clientRef,
        }),
      },
      "vonage.api.message_send",
    );

    const id = normalizeString((response as Record<string, unknown>).message_uuid)
      ?? normalizeString((response as Record<string, unknown>).messageUuid)
      ?? `message-${Date.now().toString(36)}`;
    const record = this.store.upsertMessageSnapshot({
      id,
      status: normalizeString((response as Record<string, unknown>).status) ?? "accepted",
      direction: "outbound",
      channel,
      from,
      to: input.to,
      text: input.text,
      clientRef: input.clientRef,
    });
    this.store.appendMessageEvent({
      id: record.id,
      source: "api.message.send",
      eventType: "api.send",
      verified: true,
      payload: response,
    });
    return record;
  }

  listMessages(options?: {
    limit?: number;
    status?: string;
    direction?: CommunicationDirection;
    channel?: MessageChannel;
  }) {
    return this.store.listMessages(options);
  }

  getMessage(id: string) {
    return this.store.getMessage(id);
  }

  formatCall(call: CallRecord) {
    return [
      `Call ${call.id}`,
      `Status: ${call.status}`,
      `Direction: ${call.direction}`,
      `Channel: ${call.channel}`,
      `From: ${call.from ?? "(unknown)"}`,
      `To: ${call.to ?? "(unknown)"}`,
      `Conversation: ${call.conversationUuid ?? "(none)"}`,
      `Region URL: ${call.regionUrl ?? "(unknown)"}`,
      `Started: ${call.startedAt ?? call.createdAt}`,
      `Answered: ${call.answeredAt ?? "(not recorded)"}`,
      `Completed: ${call.completedAt ?? "(not recorded)"}`,
      `Duration seconds: ${call.durationSeconds ?? "(unknown)"}`,
      `Price: ${call.price ?? "(unknown)"}`,
      `Events: ${call.events.length}`,
    ].join("\n");
  }

  formatMessage(message: MessageRecord) {
    return [
      `Message ${message.id}`,
      `Status: ${message.status}`,
      `Direction: ${message.direction}`,
      `Channel: ${message.channel}`,
      `From: ${message.from ?? "(unknown)"}`,
      `To: ${message.to ?? "(unknown)"}`,
      `Client ref: ${message.clientRef ?? "(none)"}`,
      `Text: ${message.text ?? "(empty)"}`,
      `Created: ${message.createdAt}`,
      `Updated: ${message.updatedAt}`,
      `Events: ${message.events.length}`,
    ].join("\n");
  }

  formatCallList(calls: CallRecord[]) {
    if (calls.length === 0) {
      return "No calls are recorded yet.";
    }
    return calls.map((call) =>
      [
        `- ${call.id}`,
        `[${call.status}/${call.direction}]`,
        `${call.from ?? "?"} -> ${call.to ?? "?"}`,
        `${call.updatedAt}`,
      ].join(" ")).join("\n");
  }

  formatMessageList(messages: MessageRecord[]) {
    if (messages.length === 0) {
      return "No messages are recorded yet.";
    }
    return messages.map((message) =>
      [
        `- ${message.id}`,
        `[${message.status}/${message.direction}/${message.channel}]`,
        `${message.from ?? "?"} -> ${message.to ?? "?"}`,
        `${message.text ?? "(empty)"}`,
      ].join(" ")).join("\n");
  }

  async handleVoiceAnswerWebhook(request: Request) {
    const payload = await readWebhookPayload(request);
    const verification = this.verifyWebhookRequest(request);
    const id = this.resolveCallId(payload);
    this.store.appendCallEvent({
      id,
      source: "voice.answer",
      eventType: "answer",
      verified: verification.verified,
      payload,
    });
    const answerText = getVonageConfig().voiceAnswerText || DEFAULT_VOICE_ANSWER_TEXT;
    return Response.json([{ action: "talk", text: answerText }], {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  }

  async handleVoiceEventWebhook(request: Request) {
    const payload = await readWebhookPayload(request);
    const verification = this.verifyWebhookRequest(request);
    const id = this.resolveCallId(payload);
    this.store.appendCallEvent({
      id,
      source: "voice.event",
      eventType: normalizeString(payload.status) ?? "event",
      verified: verification.verified,
      payload,
    });
    return Response.json({ ok: true }, { status: 200 });
  }

  async handleVoiceFallbackWebhook(request: Request) {
    const payload = await readWebhookPayload(request);
    const verification = this.verifyWebhookRequest(request);
    const id = this.resolveCallId(payload);
    this.store.appendCallEvent({
      id,
      source: "voice.fallback",
      eventType: "fallback",
      verified: verification.verified,
      payload,
    });
    const answerText = getVonageConfig().voiceAnswerText || DEFAULT_VOICE_ANSWER_TEXT;
    return Response.json([{ action: "talk", text: answerText }], {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  }

  async handleMessagesInboundWebhook(request: Request) {
    const payload = await readWebhookPayload(request);
    const verification = this.verifyWebhookRequest(request);
    const id = this.resolveMessageId(payload);
    this.store.appendMessageEvent({
      id,
      source: "messages.inbound",
      eventType: "inbound",
      verified: verification.verified,
      payload,
    });
    return Response.json({ ok: true }, { status: 200 });
  }

  async handleMessagesStatusWebhook(request: Request) {
    const payload = await readWebhookPayload(request);
    const verification = this.verifyWebhookRequest(request);
    const id = this.resolveMessageId(payload);
    this.store.appendMessageEvent({
      id,
      source: "messages.status",
      eventType: normalizeString(payload.status) ?? "status",
      verified: verification.verified,
      payload,
    });
    return Response.json({ ok: true }, { status: 200 });
  }

  verifySignedRequest(request: Request) {
    return this.verifyWebhookRequest(request);
  }

  private getVoiceApiBaseUrl() {
    return normalizeBaseUrl(getVonageConfig().voiceApiBaseUrl) ?? DEFAULT_VOICE_API_BASE_URL;
  }

  private getMessagesApiBaseUrl() {
    return normalizeBaseUrl(getVonageConfig().messagesApiBaseUrl) ?? DEFAULT_MESSAGES_API_BASE_URL;
  }

  private getCallControlBaseUrl(uuid: string) {
    return this.store.getCall(uuid)?.regionUrl ?? this.getVoiceApiBaseUrl();
  }

  private resolveSecretProfileId() {
    return getVonageConfig().secretProfileId || DEFAULT_SECRET_PROFILE_ID;
  }

  private hasSecret(secretRef: string, profileId: string) {
    try {
      return Boolean(this.secrets.resolveSecretRef(secretRef, profileId));
    } catch {
      return false;
    }
  }

  private createApplicationJwt() {
    const applicationId = getVonageConfig().applicationId?.trim();
    if (!applicationId) {
      throw new Error("communications.vonage.applicationId is required for Vonage API calls.");
    }
    const privateKeySecretRef = getVonageConfig().privateKeySecretRef || DEFAULT_PRIVATE_KEY_SECRET_REF;
    const privateKey = this.secrets.resolveSecretRef(privateKeySecretRef, this.resolveSecretProfileId());
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      application_id: applicationId,
      iat: now,
      exp: now + 300,
      jti: crypto.randomUUID(),
    };
    const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
    const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
    return `${signingInput}.${signature}`;
  }

  private verifyWebhookRequest(request: Request) {
    const signatureSecretRef = getVonageConfig().signatureSecretRef || DEFAULT_SIGNATURE_SECRET_REF;
    let signatureSecret: string | null = null;
    try {
      signatureSecret = this.secrets.resolveSecretRef(signatureSecretRef, this.resolveSecretProfileId());
    } catch {
      signatureSecret = null;
    }
    if (!signatureSecret) {
      return { verified: false, reason: "missing signature secret" as const };
    }

    const header = request.headers.get("authorization")?.trim() ?? request.headers.get("Authorization")?.trim() ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!token) {
      return { verified: false, reason: "missing bearer token" as const };
    }

    const parts = token.split(".");
    if (parts.length !== 3) {
      return { verified: false, reason: "invalid jwt shape" as const };
    }

    try {
      const [encodedHeader, encodedPayload, encodedSignature] = parts;
      if (!encodedSignature) {
        return { verified: false, reason: "missing signature" as const };
      }
      const signingInput = `${encodedHeader}.${encodedPayload}`;
      const expected = crypto.createHmac("sha256", signatureSecret).update(signingInput).digest("base64url");
      const verified = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(encodedSignature));
      if (!verified) {
        return { verified: false, reason: "invalid signature" as const };
      }

      const claims = parseJwtClaims(token);
      const now = Math.floor(Date.now() / 1000);
      const exp = normalizeNumber(claims.exp);
      if (exp !== null && exp < now) {
        return { verified: false, reason: "expired token" as const };
      }
      return { verified: true as const, reason: "ok" as const };
    } catch (error) {
      this.vonageTelemetry.recordError(error, { operation: "webhook.verify" });
      return { verified: false, reason: "verification error" as const };
    }
  }

  private async fetchVonageJson(url: string, init: RequestInit, operation: string) {
    const token = this.createApplicationJwt();
    const response = await this.vonageTelemetry.instrumentFetch({
      component: "vonage",
      operation,
      method: init.method ?? "GET",
      url,
      init: {
        ...init,
        headers: {
          ...jsonHeaders(token),
          ...(isRecord(init.headers) ? init.headers : {}),
        },
      },
    });
    const text = await response.text();
    const parsed = text.trim()
      ? (() => {
          try {
            return JSON.parse(text) as Record<string, unknown> | unknown[];
          } catch {
            return { raw: text };
          }
        })()
      : {};

    if (!response.ok) {
      throw new Error(`Vonage API ${response.status}: ${text || response.statusText}`);
    }
    return parsed;
  }

  private upsertRemoteCallRecord(
    response: Record<string, unknown> | unknown[],
    options: {
      fallbackId?: string;
      fallbackFrom?: string | null;
      fallbackTo?: string | null;
      fallbackStatus?: string;
      fallbackDirection?: CommunicationDirection;
    },
  ) {
    const payload = Array.isArray(response) ? {} : response;
    const id = normalizeString(payload.uuid) ?? options.fallbackId ?? `call-${Date.now().toString(36)}`;
    return this.store.upsertCallSnapshot({
      id,
      status: normalizeString(payload.status) ?? options.fallbackStatus,
      direction: payload.direction ?? options.fallbackDirection,
      channel: payload.endpoint_type ?? payload.to,
      from: extractCallAddress(payload.from) ?? options.fallbackFrom,
      to: extractCallAddress(payload.to) ?? options.fallbackTo,
      conversationUuid: payload.conversation_uuid,
      regionUrl: payload.region_url,
      startedAt: payload.start_time,
      durationSeconds: payload.duration,
      price: payload.price,
    });
  }

  private resolveCallId(payload: Record<string, unknown>) {
    return normalizeString(payload.uuid)
      ?? normalizeString(payload.conversation_uuid)
      ?? `call-${Date.now().toString(36)}`;
  }

  private resolveMessageId(payload: Record<string, unknown>) {
    return normalizeString(payload.message_uuid)
      ?? normalizeString(payload.messageUuid)
      ?? normalizeString(payload.client_ref)
      ?? `message-${Date.now().toString(36)}`;
  }
}

export function getVonageWebhookPath(kind: WebhookKind) {
  const base = getVonageConfig().webhookBasePath || DEFAULT_WEBHOOK_BASE_PATH;
  switch (kind) {
    case "voice.answer":
      return `${base}/voice/answer`;
    case "voice.event":
      return `${base}/voice/event`;
    case "voice.fallback":
      return `${base}/voice/fallback`;
    case "messages.inbound":
      return `${base}/messages/inbound`;
    case "messages.status":
      return `${base}/messages/status`;
  }
}
