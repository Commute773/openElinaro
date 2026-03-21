import fs from "node:fs";
import path from "node:path";
import type {
  CallRecord,
  CommunicationDirection,
  CommunicationEventRecord,
  CommunicationsStoreShape,
  MessageChannel,
  MessageRecord,
  CallChannel,
} from "../domain/communications";
import { resolveRuntimePath } from "./runtime-root";

const STORE_VERSION = 1;
const MAX_EVENTS_PER_RECORD = 50;

function nowIso() {
  return new Date().toISOString();
}

function emptyStore(): CommunicationsStoreShape {
  return {
    version: STORE_VERSION,
    calls: {},
    messages: {},
  };
}

function sortNewestFirst<T extends { updatedAt: string }>(left: T, right: T) {
  return right.updatedAt.localeCompare(left.updatedAt);
}

function normalizeDirection(value: unknown): CommunicationDirection {
  if (value === "inbound" || value === "outbound") {
    return value;
  }
  return "unknown";
}

function normalizeCallChannel(value: unknown): CallChannel {
  if (value === "phone" || value === "sip" || value === "app" || value === "websocket" || value === "vbc") {
    return value;
  }
  return "unknown";
}

function normalizeMessageChannel(value: unknown): MessageChannel {
  if (value === "sms" || value === "mms" || value === "whatsapp" || value === "messenger" || value === "viber") {
    return value;
  }
  return "unknown";
}

function normalizeString(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
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

function asPayloadRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export class CommunicationsStore {
  private readonly storePath: string;

  constructor(options?: { storePath?: string }) {
    this.storePath = options?.storePath ?? resolveRuntimePath("communications", "store.json");
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    this.ensureStore();
  }

  getStorePath() {
    return this.storePath;
  }

  listCalls(options?: { limit?: number; status?: string; direction?: CommunicationDirection }) {
    const store = this.loadStore();
    const limit = Math.max(1, Math.min(options?.limit ?? 20, 100));
    return Object.values(store.calls)
      .filter((call) => !options?.status || call.status === options.status)
      .filter((call) => !options?.direction || call.direction === options.direction)
      .sort(sortNewestFirst)
      .slice(0, limit);
  }

  getCall(id: string) {
    return this.loadStore().calls[id] ?? null;
  }

  upsertCallSnapshot(input: {
    id: string;
    status?: unknown;
    direction?: unknown;
    channel?: unknown;
    from?: unknown;
    to?: unknown;
    conversationUuid?: unknown;
    regionUrl?: unknown;
    startedAt?: unknown;
    answeredAt?: unknown;
    completedAt?: unknown;
    durationSeconds?: unknown;
    price?: unknown;
  }) {
    const store = this.loadStore();
    const existing = store.calls[input.id];
    const createdAt = existing?.createdAt ?? nowIso();
    store.calls[input.id] = {
      id: input.id,
      provider: "vonage",
      direction: input.direction !== undefined ? normalizeDirection(input.direction) : (existing?.direction ?? "unknown"),
      channel: input.channel !== undefined ? normalizeCallChannel(input.channel) : (existing?.channel ?? "unknown"),
      status: normalizeString(input.status) ?? existing?.status ?? "unknown",
      from: input.from !== undefined ? normalizeString(input.from) : (existing?.from ?? null),
      to: input.to !== undefined ? normalizeString(input.to) : (existing?.to ?? null),
      conversationUuid: input.conversationUuid !== undefined
        ? normalizeString(input.conversationUuid)
        : (existing?.conversationUuid ?? null),
      regionUrl: input.regionUrl !== undefined ? normalizeString(input.regionUrl) : (existing?.regionUrl ?? null),
      startedAt: input.startedAt !== undefined ? normalizeString(input.startedAt) : (existing?.startedAt ?? null),
      answeredAt: input.answeredAt !== undefined ? normalizeString(input.answeredAt) : (existing?.answeredAt ?? null),
      completedAt: input.completedAt !== undefined ? normalizeString(input.completedAt) : (existing?.completedAt ?? null),
      durationSeconds: input.durationSeconds !== undefined
        ? normalizeNumber(input.durationSeconds)
        : (existing?.durationSeconds ?? null),
      price: input.price !== undefined ? normalizeString(input.price) : (existing?.price ?? null),
      createdAt,
      updatedAt: nowIso(),
      events: existing?.events ?? [],
    };
    this.saveStore(store);
    return store.calls[input.id]!;
  }

  appendCallEvent(input: {
    id: string;
    source: CommunicationEventRecord["source"];
    eventType: string;
    verified: boolean;
    payload: unknown;
  }) {
    const snapshot = this.upsertCallSnapshot({
      id: input.id,
      status: asPayloadRecord(input.payload).status,
      direction: asPayloadRecord(input.payload).direction,
      channel: asPayloadRecord(input.payload).endpoint_type,
      from: asPayloadRecord(input.payload).from,
      to: asPayloadRecord(input.payload).to,
      conversationUuid: asPayloadRecord(input.payload).conversation_uuid,
      regionUrl: asPayloadRecord(input.payload).region_url,
      answeredAt: input.eventType === "answered" ? nowIso() : undefined,
      completedAt: input.eventType === "completed" || input.eventType === "disconnected" ? nowIso() : undefined,
      durationSeconds: asPayloadRecord(input.payload).duration,
      price: asPayloadRecord(input.payload).price,
    });
    const store = this.loadStore();
    const record = store.calls[input.id] ?? snapshot;
    const events: CommunicationEventRecord[] = [
      {
        id: `call-event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        receivedAt: nowIso(),
        provider: "vonage",
        source: input.source,
        eventType: input.eventType,
        verified: input.verified,
        payload: asPayloadRecord(input.payload),
      },
      ...record.events,
    ];
    record.events = events.slice(0, MAX_EVENTS_PER_RECORD);
    record.updatedAt = nowIso();
    store.calls[input.id] = record;
    this.saveStore(store);
    return record;
  }

  listMessages(options?: {
    limit?: number;
    status?: string;
    direction?: CommunicationDirection;
    channel?: MessageChannel;
  }) {
    const store = this.loadStore();
    const limit = Math.max(1, Math.min(options?.limit ?? 20, 100));
    return Object.values(store.messages)
      .filter((message) => !options?.status || message.status === options.status)
      .filter((message) => !options?.direction || message.direction === options.direction)
      .filter((message) => !options?.channel || message.channel === options.channel)
      .sort(sortNewestFirst)
      .slice(0, limit);
  }

  getMessage(id: string) {
    return this.loadStore().messages[id] ?? null;
  }

  upsertMessageSnapshot(input: {
    id: string;
    status?: unknown;
    direction?: unknown;
    channel?: unknown;
    from?: unknown;
    to?: unknown;
    text?: unknown;
    clientRef?: unknown;
  }) {
    const store = this.loadStore();
    const existing = store.messages[input.id];
    const createdAt = existing?.createdAt ?? nowIso();
    store.messages[input.id] = {
      id: input.id,
      provider: "vonage",
      direction: input.direction !== undefined ? normalizeDirection(input.direction) : (existing?.direction ?? "unknown"),
      channel: input.channel !== undefined ? normalizeMessageChannel(input.channel) : (existing?.channel ?? "unknown"),
      status: normalizeString(input.status) ?? existing?.status ?? "unknown",
      from: input.from !== undefined ? normalizeString(input.from) : (existing?.from ?? null),
      to: input.to !== undefined ? normalizeString(input.to) : (existing?.to ?? null),
      text: input.text !== undefined ? normalizeString(input.text) : (existing?.text ?? null),
      clientRef: input.clientRef !== undefined ? normalizeString(input.clientRef) : (existing?.clientRef ?? null),
      createdAt,
      updatedAt: nowIso(),
      events: existing?.events ?? [],
    };
    this.saveStore(store);
    return store.messages[input.id]!;
  }

  appendMessageEvent(input: {
    id: string;
    source: CommunicationEventRecord["source"];
    eventType: string;
    verified: boolean;
    payload: unknown;
  }) {
    const payload = asPayloadRecord(input.payload);
    const snapshot = this.upsertMessageSnapshot({
      id: input.id,
      status: payload.status,
      direction: payload.direction,
      channel: payload.channel,
      from: payload.from,
      to: payload.to,
      text: payload.text,
      clientRef: payload.client_ref,
    });
    const store = this.loadStore();
    const record = store.messages[input.id] ?? snapshot;
    const events: CommunicationEventRecord[] = [
      {
        id: `message-event-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        receivedAt: nowIso(),
        provider: "vonage",
        source: input.source,
        eventType: input.eventType,
        verified: input.verified,
        payload,
      },
      ...record.events,
    ];
    record.events = events.slice(0, MAX_EVENTS_PER_RECORD);
    record.updatedAt = nowIso();
    store.messages[input.id] = record;
    this.saveStore(store);
    return record;
  }

  private ensureStore() {
    if (!fs.existsSync(this.storePath)) {
      this.saveStore(emptyStore());
    }
  }

  private loadStore() {
    if (!fs.existsSync(this.storePath)) {
      return emptyStore();
    }
    const parsed = JSON.parse(fs.readFileSync(this.storePath, "utf8")) as Partial<CommunicationsStoreShape>;
    return {
      version: STORE_VERSION,
      calls: parsed.calls ?? {},
      messages: parsed.messages ?? {},
    } satisfies CommunicationsStoreShape;
  }

  private saveStore(store: CommunicationsStoreShape) {
    fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
    fs.writeFileSync(this.storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }
}
