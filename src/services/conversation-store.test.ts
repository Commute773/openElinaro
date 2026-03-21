import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ConversationHistoryService } from "./conversation-history-service";
import { ConversationStore } from "./conversation-store";
import { SystemPromptService } from "./system-prompt-service";

let tempRoot = "";
let previousRootDirEnv: string | undefined;

function getStorePath() {
  return path.join(tempRoot, ".openelinarotest", "conversations.json");
}

function getHistoryDir() {
  return path.join(tempRoot, ".openelinarotest", "conversation-history");
}

describe("ConversationStore", () => {
  const store = new ConversationStore({
    history: new ConversationHistoryService({
      embedTexts: async (texts) =>
        texts.map((text) => {
          const lower = text.toLowerCase();
          return [
            lower.includes("graph") ? 1 : 0,
            lower.includes("cache") ? 1 : 0,
            lower.length / 1_000,
          ];
        }),
    }),
  });
  const systemPrompts = new SystemPromptService();

  beforeEach(() => {
    previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-conversation-store-"));
    process.env.OPENELINARO_ROOT_DIR = tempRoot;
    fs.rmSync(getStorePath(), { force: true });
    fs.rmSync(getHistoryDir(), { recursive: true, force: true });
  });

  afterEach(() => {
    if (previousRootDirEnv === undefined) {
      delete process.env.OPENELINARO_ROOT_DIR;
    } else {
      process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  });

  test("supports append-only writes", () => {
    store.save({
      key: "thread-1",
      messages: [new HumanMessage("hello")],
      updatedAt: new Date().toISOString(),
      systemPrompt: systemPrompts.load(),
    });

    const conversation = store.appendMessages("thread-1", [new AIMessage("world")]);

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[1]).toBeInstanceOf(AIMessage);
  });

  test("supports explicit rollback plus append", () => {
    store.save({
      key: "thread-1",
      messages: [
        new HumanMessage("first"),
        new AIMessage("second"),
        new HumanMessage("third"),
      ],
      updatedAt: new Date().toISOString(),
      systemPrompt: systemPrompts.load(),
    });

    const conversation = store.rollbackAndAppend("thread-1", 2, [new AIMessage("replacement")]);

    expect(conversation.messages).toHaveLength(2);
    expect((conversation.messages[0] as HumanMessage).content).toBe("first");
    expect((conversation.messages[1] as AIMessage).content).toBe("replacement");
  });

  test("preserves image mime types across store round-trips", () => {
    store.save({
      key: "thread-1",
      messages: [new HumanMessage([
        { type: "text", text: "what is this?" },
        { type: "image", data: "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoIAAgAAkA4JaQAA3AA/vuUAAA=", mimeType: "image/webp" },
      ])],
      updatedAt: new Date().toISOString(),
      systemPrompt: systemPrompts.load(),
    });

    const conversation = store.get("thread-1");
    const message = conversation.messages[0] as HumanMessage;
    const blocks = message.content as Array<{ type: string; mimeType?: string }>;

    expect(blocks.some((block) => block.type === "image" && block.mimeType === "image/webp")).toBe(true);
  });

  test("rejects non-append message rewrites through save", () => {
    store.save({
      key: "thread-1",
      messages: [
        new HumanMessage("first"),
        new AIMessage("second"),
      ],
      updatedAt: new Date().toISOString(),
      systemPrompt: systemPrompts.load(),
    });

    expect(() =>
      store.save({
        key: "thread-1",
        messages: [
          new HumanMessage("edited first"),
          new AIMessage("second"),
        ],
        updatedAt: new Date().toISOString(),
      })).toThrow("Refusing non-append conversation mutation");
  });

  test("journals appended conversation messages to JSONL as they are saved", () => {
    store.save({
      key: "thread-1",
      messages: [new HumanMessage("hello graph cache"), new AIMessage("world")],
      updatedAt: new Date().toISOString(),
      systemPrompt: systemPrompts.load(),
    });

    const journalPath = path.join(getHistoryDir(), "events.root.jsonl");
    const lines = fs.readFileSync(journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      kind: "message",
      conversationKey: "thread-1",
      profileId: "root",
      messageIndex: 1,
      role: "user",
      text: "hello graph cache",
    });
    expect(lines[1]).toMatchObject({
      kind: "message",
      conversationKey: "thread-1",
      profileId: "root",
      messageIndex: 2,
      role: "assistant",
      text: "world",
    });
  });

  test("searches archived conversation history with hybrid ranking and recency output", async () => {
    store.save({
      key: "thread-1",
      messages: [new HumanMessage("We need to fix the cache miss issue in graph search.")],
      updatedAt: "2026-03-14T10:00:00.000Z",
      systemPrompt: systemPrompts.load(),
    });
    store.save({
      key: "thread-2",
      messages: [new HumanMessage("Graph compaction is still weird but cache is fine.")],
      updatedAt: "2026-03-14T11:00:00.000Z",
      systemPrompt: systemPrompts.load(),
    });

    const result = await store.searchHistory({
      query: "cache graph",
      limit: 2,
      contextChars: 60,
    });

    expect(result).toContain('Conversation hits for "cache graph"');
    expect(result).toContain("conversation=thread-2");
    expect(result).toContain("conversation=thread-1");
    expect(result).toContain("excerpt:");
  });

  test("bounds conversation search embedding work to rerank candidates instead of the full archive", async () => {
    const embedCalls: string[][] = [];
    const boundedStore = new ConversationStore({
      history: new ConversationHistoryService({
        embedTexts: async (texts) => {
          embedCalls.push(texts);
          return texts.map((text) => {
            const lower = text.toLowerCase();
            return [lower.includes("cache") ? 1 : 0, lower.includes("graph") ? 1 : 0];
          });
        },
      }),
    });

    for (let index = 0; index < 40; index += 1) {
      boundedStore.save({
        key: `thread-${index + 1}`,
        messages: [
          new HumanMessage(
            index === 39 ? "Newest cache graph regression note." : `Background note ${index + 1}.`,
          ),
        ],
        updatedAt: `2026-03-14T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
        systemPrompt: systemPrompts.load(),
      });
    }

    const result = await boundedStore.searchHistory({
      query: "cache graph",
      limit: 2,
      contextChars: 60,
    });

    expect(result).toContain("conversation=thread-40");
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toHaveLength(21);
    expect(embedCalls[0]?.[0]).toBe("cache graph");
  });
});
