import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConversationStore } from "./conversation-store";
import { SystemPromptService } from "../system-prompt-service";
import { userMessage, assistantTextMessage } from "../../messages/types";
import type { Message } from "../../messages/types";

let tempRoot = "";
let previousRootDirEnv: string | undefined;

function getStorePath() {
  return path.join(tempRoot, ".openelinarotest", "conversations.json");
}

describe("ConversationStore", () => {
  const store = new ConversationStore();
  const systemPrompts = new SystemPromptService();

  beforeEach(() => {
    previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-conversation-store-"));
    process.env.OPENELINARO_ROOT_DIR = tempRoot;
    fs.rmSync(getStorePath(), { force: true });
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
});
