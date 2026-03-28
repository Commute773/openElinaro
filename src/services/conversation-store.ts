import { mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  type BaseMessage,
  type StoredMessage,
} from "@langchain/core/messages";
import { ConversationHistoryService } from "./conversation-history-service";
import { assertTestRuntimeRootIsIsolated, resolveRuntimePath } from "./runtime-root";
import type { SystemPromptSnapshot } from "./system-prompt-service";
import { telemetry } from "./infrastructure/telemetry";
import { timestamp } from "../utils/timestamp";

export interface ConversationState {
  key: string;
  messages: BaseMessage[];
  updatedAt: string;
  systemPrompt?: SystemPromptSnapshot;
}

type ConversationStoreOptions = {
  history?: ConversationHistoryService;
};

type StoredConversationState = {
  key: string;
  messages: StoredMessage[] | LegacyMessage[];
  updatedAt: string;
  systemPrompt?: SystemPromptSnapshot;
};

type ConversationStoreShape = {
  conversations: Record<string, StoredConversationState>;
};

type LegacyTextBlock = {
  type: "text";
  text: string;
};

type LegacyToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

type LegacyMessage =
  | {
      role: "user";
      content: string | LegacyTextBlock[];
      timestamp?: number;
    }
  | {
      role: "assistant";
      content: Array<LegacyTextBlock | LegacyToolCallBlock>;
      timestamp?: number;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: LegacyTextBlock[];
      isError?: boolean;
      timestamp?: number;
    };

function getStorePath() {
  return resolveRuntimePath("conversations.json");
}

async function ensureStoreDir() {
  await mkdir(path.dirname(getStorePath()), { recursive: true });
}

async function readStore(): Promise<ConversationStoreShape> {
  await ensureStoreDir();
  const storePath = getStorePath();
  if (!(await Bun.file(storePath).exists())) {
    return { conversations: {} };
  }

  return JSON.parse(await Bun.file(storePath).text()) as ConversationStoreShape;
}

async function writeStore(store: ConversationStoreShape) {
  assertTestRuntimeRootIsIsolated("Conversation store");
  await ensureStoreDir();
  const storePath = getStorePath();
  await Bun.write(storePath, `${JSON.stringify(store, null, 2)}\n`);
  await chmod(storePath, 0o600);
}

function encodeMessages(messages: BaseMessage[]) {
  return mapChatMessagesToStoredMessages(messages);
}

function extractLegacyText(
  content: string | Array<LegacyTextBlock | LegacyToolCallBlock> | undefined,
) {
  if (typeof content === "string") {
    return content;
  }
  return (content ?? [])
    .filter((block): block is LegacyTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function isStoredMessage(value: StoredMessage | LegacyMessage): value is StoredMessage {
  return typeof (value as StoredMessage).type === "string";
}

function convertLegacyMessage(message: LegacyMessage): BaseMessage {
  if (message.role === "user") {
    return new HumanMessage(extractLegacyText(message.content));
  }

  if (message.role === "toolResult") {
    return new ToolMessage({
      content: extractLegacyText(message.content),
      tool_call_id: message.toolCallId,
      name: message.toolName,
      status: message.isError ? "error" : "success",
    });
  }

  return new AIMessage({
    content: extractLegacyText(message.content),
    tool_calls: message.content
      .filter((block): block is LegacyToolCallBlock => block.type === "toolCall")
      .map((block) => ({
        id: block.id,
        name: block.name,
        args: block.arguments,
        type: "tool_call" as const,
      })),
  });
}

function decodeMessages(rawMessages: StoredMessage[] | LegacyMessage[], key: string): BaseMessage[] {
  if (rawMessages.length === 0) {
    return [];
  }

  if (isStoredMessage(rawMessages[0] as StoredMessage | LegacyMessage)) {
    return mapStoredMessagesToChatMessages(rawMessages as StoredMessage[]);
  }

  telemetry.event("conversation_store.legacy_migration", {
    conversationKey: key,
    messageCount: rawMessages.length,
    entityType: "conversation",
    entityId: key,
  });
  return (rawMessages as LegacyMessage[]).map(convertLegacyMessage);
}

function normalizeStoredMessages(rawMessages: StoredMessage[] | LegacyMessage[], key: string) {
  return encodeMessages(decodeMessages(rawMessages, key));
}

function areStoredMessagesEqual(left: StoredMessage[], right: StoredMessage[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((message, index) => JSON.stringify(message) === JSON.stringify(right[index]));
}

function isStoredMessagePrefix(prefix: StoredMessage[], full: StoredMessage[]) {
  if (prefix.length > full.length) {
    return false;
  }

  return prefix.every((message, index) => JSON.stringify(message) === JSON.stringify(full[index]));
}

function describeMutation(current: StoredMessage[], next: StoredMessage[]) {
  if (areStoredMessagesEqual(current, next)) {
    return "unchanged";
  }

  if (isStoredMessagePrefix(current, next)) {
    return `append-only (+${next.length - current.length} messages)`;
  }

  if (isStoredMessagePrefix(next, current)) {
    return `rollback-only (-${current.length - next.length} messages)`;
  }

  return "non-append mutation";
}

export class ConversationStore {
  private readonly history: ConversationHistoryService;

  constructor(options?: ConversationStoreOptions) {
    this.history = options?.history ?? new ConversationHistoryService();
  }

  async list(): Promise<ConversationState[]> {
    const store = await readStore();
    return Object.values(store.conversations)
      .map((entry) => ({
        key: entry.key,
        messages: decodeMessages(entry.messages, entry.key),
        updatedAt: entry.updatedAt,
        systemPrompt: entry.systemPrompt,
      }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getLatest(): Promise<ConversationState | undefined> {
    return (await this.list()).at(0);
  }

  async get(key: string): Promise<ConversationState> {
    const store = await readStore();
    const existing = store.conversations[key];
    if (!existing) {
      return {
        key,
        messages: [],
        updatedAt: timestamp(),
        systemPrompt: undefined,
      };
    }

    const messages = decodeMessages(existing.messages, key);
    const normalized: StoredConversationState = {
      key,
      messages: mapChatMessagesToStoredMessages(messages),
      updatedAt: existing.updatedAt,
      systemPrompt: existing.systemPrompt,
    };
    store.conversations[key] = normalized;
    await writeStore(store);

    return {
      key,
      messages,
      updatedAt: existing.updatedAt,
      systemPrompt: existing.systemPrompt,
    };
  }

  private async save(state: ConversationState): Promise<ConversationState> {
    const store = await readStore();
    const existing = store.conversations[state.key];
    const nextMessages = encodeMessages(state.messages);
    let currentMessages: StoredMessage[] = [];

    if (existing) {
      currentMessages = normalizeStoredMessages(existing.messages, state.key);
      if (
        !areStoredMessagesEqual(currentMessages, nextMessages)
        && !isStoredMessagePrefix(currentMessages, nextMessages)
        && !isStoredMessagePrefix(nextMessages, currentMessages)
      ) {
        throw new Error(
          `Refusing non-append conversation mutation for ${state.key}; use appendMessages(), rollbackMessages(), or rollbackAndAppend(). Existing=${describeMutation(currentMessages, nextMessages)}.`,
        );
      }
    }

    const nextState: StoredConversationState = {
      key: state.key,
      messages: nextMessages,
      updatedAt: timestamp(),
      systemPrompt: state.systemPrompt ?? existing?.systemPrompt,
    };
    store.conversations[state.key] = nextState;
    await writeStore(store);

    try {
      if (isStoredMessagePrefix(currentMessages, nextMessages) && nextMessages.length > currentMessages.length) {
        this.history.recordAppendedMessages({
          conversationKey: state.key,
          messages: state.messages.slice(currentMessages.length),
          startingIndex: currentMessages.length,
          occurredAt: nextState.updatedAt,
        });
      } else if (
        isStoredMessagePrefix(nextMessages, currentMessages) &&
        currentMessages.length > nextMessages.length
      ) {
        this.history.recordRollback({
          conversationKey: state.key,
          removedCount: currentMessages.length - nextMessages.length,
          occurredAt: nextState.updatedAt,
        });
      }
    } catch (error) {
      telemetry.recordError(error, {
        conversationKey: state.key,
        entityType: "conversation",
        entityId: state.key,
        operation: "conversation_store.history_write",
      });
    }

    return {
      key: state.key,
      messages: state.messages,
      updatedAt: nextState.updatedAt,
      systemPrompt: nextState.systemPrompt,
    };
  }

  async appendMessages(
    key: string,
    messages: BaseMessage[],
    options?: { systemPrompt?: SystemPromptSnapshot },
  ): Promise<ConversationState> {
    if (messages.length === 0) {
      const conversation = await this.get(key);
      if (options?.systemPrompt) {
        return this.save({
          ...conversation,
          systemPrompt: options.systemPrompt,
        });
      }
      return conversation;
    }

    const conversation = await this.get(key);
    return this.save({
      ...conversation,
      messages: conversation.messages.concat(messages),
      systemPrompt: options?.systemPrompt ?? conversation.systemPrompt,
    });
  }

  async rollbackMessages(
    key: string,
    count: number,
    options?: { systemPrompt?: SystemPromptSnapshot },
  ): Promise<ConversationState> {
    const conversation = await this.get(key);
    const safeCount = Math.max(0, Math.floor(count));
    return this.save({
      ...conversation,
      messages: conversation.messages.slice(0, Math.max(0, conversation.messages.length - safeCount)),
      systemPrompt: options?.systemPrompt ?? conversation.systemPrompt,
    });
  }

  async rollbackAndAppend(
    key: string,
    rollbackCount: number,
    messages: BaseMessage[],
    options?: { systemPrompt?: SystemPromptSnapshot },
  ): Promise<ConversationState> {
    const rolledBack = await this.rollbackMessages(key, rollbackCount, options);
    if (messages.length === 0) {
      return rolledBack;
    }
    return this.appendMessages(key, messages, {
      systemPrompt: options?.systemPrompt ?? rolledBack.systemPrompt,
    });
  }

  async ensureSystemPrompt(key: string, snapshot: SystemPromptSnapshot): Promise<ConversationState> {
    const conversation = await this.get(key);
    if (conversation.systemPrompt) {
      return conversation;
    }

    return this.save({
      ...conversation,
      systemPrompt: snapshot,
    });
  }

  async replaceSystemPrompt(key: string, snapshot: SystemPromptSnapshot): Promise<ConversationState> {
    const conversation = await this.get(key);
    return this.save({
      ...conversation,
      systemPrompt: snapshot,
    });
  }

  searchHistory(params: {
    query: string;
    limit?: number;
    contextChars?: number;
  }) {
    return this.history.search(params);
  }

  listRecentHistory(params?: {
    limit?: number;
    since?: string;
    conversationKey?: string;
  }) {
    return this.history.listRecentMessages(params);
  }
}
