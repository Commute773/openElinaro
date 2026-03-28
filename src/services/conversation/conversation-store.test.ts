import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConversationHistoryService } from "./conversation-history-service";
import { ConversationStore } from "./conversation-store";
import { SystemPromptService } from "../system-prompt-service";
import { userMessage, assistantTextMessage } from "../../messages/types";
import type { Message } from "../../messages/types";

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

  test("supports append-only writes", async () => {
    await store.appendMessages("thread-1", [userMessage("hello")], {
      systemPrompt: await systemPrompts.load(),
    });

    const conversation = await store.appendMessages("thread-1", [assistantTextMessage("world")]);

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[1]!.role).toBe("assistant");
  });

  test("supports explicit rollback plus append", async () => {
    await store.appendMessages("thread-1", [
      userMessage("first"),
      assistantTextMessage("second"),
      userMessage("third"),
    ], { systemPrompt: await systemPrompts.load() });

    const conversation = await store.rollbackAndAppend("thread-1", 2, [assistantTextMessage("replacement")]);

    expect(conversation.messages).toHaveLength(2);
    expect((conversation.messages[0] as Message & { content: string }).content).toBe("first");
    // AssistantMessage content is an array of content blocks
    const assistantMsg = conversation.messages[1] as Message & { content: any };
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content[0].text).toBe("replacement");
  });

  test("preserves image mime types across store round-trips", async () => {
    await store.appendMessages("thread-1", [userMessage([
      { type: "text", text: "what is this?" },
      { type: "image", data: "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoIAAgAAkA4JaQAA3AA/vuUAAA=", mimeType: "image/webp" },
    ])], { systemPrompt: await systemPrompts.load() });

    const conversation = await store.get("thread-1");
    const message = conversation.messages[0];
    const blocks = (message as any).content as Array<{ type: string; mimeType?: string }>;

    expect(blocks.some((block) => block.type === "image" && block.mimeType === "image/webp")).toBe(true);
  });

  test("journals appended conversation messages to JSONL as they are saved", async () => {
    await store.appendMessages("thread-1", [userMessage("hello graph cache"), assistantTextMessage("world")], {
      systemPrompt: await systemPrompts.load(),
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
    await store.appendMessages("thread-1", [userMessage("We need to fix the cache miss issue in graph search.")], {
      systemPrompt: await systemPrompts.load(),
    });
    await store.appendMessages("thread-2", [userMessage("Graph compaction is still weird but cache is fine.")], {
      systemPrompt: await systemPrompts.load(),
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
      await boundedStore.appendMessages(`thread-${index + 1}`, [
        userMessage(
          index === 39 ? "Newest cache graph regression note." : `Background note ${index + 1}.`,
        ),
      ], { systemPrompt: await systemPrompts.load() });
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
