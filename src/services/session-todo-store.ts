import { mkdir, chmod } from "node:fs/promises";
import path from "node:path";
import { assertTestRuntimeRootIsIsolated, resolveRuntimePath } from "./runtime-root";

export const SESSION_TODO_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
] as const;

export const SESSION_TODO_PRIORITIES = [
  "high",
  "medium",
  "low",
] as const;

export type SessionTodoStatus = (typeof SESSION_TODO_STATUSES)[number];
export type SessionTodoPriority = (typeof SESSION_TODO_PRIORITIES)[number];

export type SessionTodoItem = {
  content: string;
  status: SessionTodoStatus;
  priority: SessionTodoPriority;
};

type SessionTodoStoreShape = {
  version: 1;
  conversations: Record<string, SessionTodoItem[]>;
};

function normalizeTodo(item: SessionTodoItem): SessionTodoItem {
  return {
    content: item.content.trim(),
    status: item.status,
    priority: item.priority,
  };
}

export class SessionTodoStore {
  constructor(private readonly storePath = resolveRuntimePath("session-todos.json")) {}

  async get(conversationKey: string): Promise<SessionTodoItem[]> {
    const store = await this.readStore();
    return (store.conversations[conversationKey] ?? []).map(normalizeTodo);
  }

  async update(conversationKey: string, todos: SessionTodoItem[]) {
    const normalized = todos.map(normalizeTodo);
    const inProgressCount = normalized.filter((item) => item.status === "in_progress").length;
    if (inProgressCount > 1) {
      throw new Error("Only one todo item can be in_progress at a time.");
    }

    const store = await this.readStore();
    if (normalized.length === 0) {
      delete store.conversations[conversationKey];
    } else {
      store.conversations[conversationKey] = normalized;
    }
    await this.writeStore(store);
    return normalized;
  }

  async clear(conversationKey: string) {
    const store = await this.readStore();
    if (!(conversationKey in store.conversations)) {
      return;
    }
    delete store.conversations[conversationKey];
    await this.writeStore(store);
  }

  private async ensureStoreDir() {
    await mkdir(path.dirname(this.storePath), { recursive: true });
  }

  private async readStore(): Promise<SessionTodoStoreShape> {
    await this.ensureStoreDir();
    if (!(await Bun.file(this.storePath).exists())) {
      return {
        version: 1,
        conversations: {},
      };
    }

    const parsed = JSON.parse(await Bun.file(this.storePath).text()) as Partial<SessionTodoStoreShape>;
    return {
      version: 1,
      conversations: Object.fromEntries(
        Object.entries(parsed.conversations ?? {}).map(([conversationKey, todos]) => [
          conversationKey,
          Array.isArray(todos) ? todos.map((item) => normalizeTodo(item as SessionTodoItem)) : [],
        ]),
      ),
    };
  }

  private async writeStore(store: SessionTodoStoreShape) {
    assertTestRuntimeRootIsIsolated("Session todo store");
    await this.ensureStoreDir();
    await Bun.write(this.storePath, `${JSON.stringify(store, null, 2)}\n`);
    await chmod(this.storePath, 0o600);
  }
}
