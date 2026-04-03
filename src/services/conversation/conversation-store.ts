import { mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import type { Message } from "../../messages/types";
import { assertTestRuntimeRootIsIsolated, resolveRuntimePath } from "../runtime-root";
import type { SystemPromptSnapshot } from "../system-prompt-service";
import { telemetry } from "../infrastructure/telemetry";
import { timestamp } from "../../utils/timestamp";

export interface ConversationState {
  key: string;
  messages: Message[];
  updatedAt: string;
  systemPrompt?: SystemPromptSnapshot;
  /** SDK-managed session ID for cross-turn continuity (Claude Agent SDK). */
  sdkSessionId?: string;
}

type StoredConversationState = {
  key: string;
  messages: Message[];
  updatedAt: string;
  systemPrompt?: SystemPromptSnapshot;
  sdkSessionId?: string;
};

type ConversationStoreShape = {
  conversations: Record<string, StoredConversationState>;
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

function areMessagesEqual(left: Message[], right: Message[]) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((message, index) => JSON.stringify(message) === JSON.stringify(right[index]));
}

function isMessagePrefix(prefix: Message[], full: Message[]) {
  if (prefix.length > full.length) {
    return false;
  }

  return prefix.every((message, index) => JSON.stringify(message) === JSON.stringify(full[index]));
}

function describeMutation(current: Message[], next: Message[]) {
  if (areMessagesEqual(current, next)) {
    return "unchanged";
  }

  if (isMessagePrefix(current, next)) {
    return `append-only (+${next.length - current.length} messages)`;
  }

  if (isMessagePrefix(next, current)) {
    return `rollback-only (-${current.length - next.length} messages)`;
  }

  return "non-append mutation";
}

export class ConversationStore {
  async list(): Promise<ConversationState[]> {
    const store = await readStore();
    return Object.values(store.conversations)
      .map((entry) => ({
        key: entry.key,
        messages: entry.messages ?? [],
        updatedAt: entry.updatedAt,
        systemPrompt: entry.systemPrompt,
        sdkSessionId: entry.sdkSessionId,
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

    return {
      key,
      messages: existing.messages ?? [],
      updatedAt: existing.updatedAt,
      systemPrompt: existing.systemPrompt,
      sdkSessionId: existing.sdkSessionId,
    };
  }

  private async save(state: ConversationState): Promise<ConversationState> {
    const store = await readStore();
    const existing = store.conversations[state.key];
    const currentMessages: Message[] = existing?.messages ?? [];

    if (existing) {
      if (
        !areMessagesEqual(currentMessages, state.messages)
        && !isMessagePrefix(currentMessages, state.messages)
        && !isMessagePrefix(state.messages, currentMessages)
      ) {
        throw new Error(
          `Refusing non-append conversation mutation for ${state.key}; use appendMessages(), rollbackMessages(), or rollbackAndAppend(). Existing=${describeMutation(currentMessages, state.messages)}.`,
        );
      }
    }

    const nextState: StoredConversationState = {
      key: state.key,
      messages: state.messages,
      updatedAt: timestamp(),
      systemPrompt: state.systemPrompt ?? existing?.systemPrompt,
      sdkSessionId: state.sdkSessionId ?? existing?.sdkSessionId,
    };
    store.conversations[state.key] = nextState;
    await writeStore(store);

    return {
      key: state.key,
      messages: state.messages,
      updatedAt: nextState.updatedAt,
      systemPrompt: nextState.systemPrompt,
      sdkSessionId: nextState.sdkSessionId,
    };
  }

  async appendMessages(
    key: string,
    messages: Message[],
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
    messages: Message[],
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

  async updateSdkSessionId(key: string, sdkSessionId: string): Promise<ConversationState> {
    const conversation = await this.get(key);
    return this.save({
      ...conversation,
      sdkSessionId,
    });
  }

  /**
   * Remove the persisted SDK session ID so the next turn creates a fresh
   * session instead of resuming the old one.  Used during conversation resets.
   */
  async clearSdkSessionId(key: string): Promise<void> {
    const store = await readStore();
    const existing = store.conversations[key];
    if (!existing || !existing.sdkSessionId) return;
    delete existing.sdkSessionId;
    existing.updatedAt = timestamp();
    await writeStore(store);
  }
}
