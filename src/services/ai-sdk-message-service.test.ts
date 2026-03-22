import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HumanMessage, ToolMessage } from "@langchain/core/messages";

let tempRoot = "";
let previousRootDirEnv: string | undefined;

describe("ai-sdk message service tool-result refs", () => {
  beforeEach(() => {
    previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-ai-sdk-message-service-"));
    process.env.OPENELINARO_ROOT_DIR = tempRoot;
  });

  afterEach(() => {
    if (previousRootDirEnv === undefined) {
      delete process.env.OPENELINARO_ROOT_DIR;
    } else {
      process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("stores longer tool results out of band and keeps only a compact ref in message history", async () => {
    const messageModule = await import("./ai-sdk-message-service");
    const toolResultStoreModule = await import("./tool-result-store");
    const store = new toolResultStoreModule.ToolResultStore();
    const longOutput = Array.from({ length: 220 }, (_, index) => `line-${index + 1}`).join("\n");

    const appended = messageModule.appendResponseMessages(
      [],
      [{
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "read_file",
          output: {
            type: "text",
            value: longOutput,
          },
        }],
      }],
      {
        toolResultStore: store,
        toolResultNamespace: "conversation:test",
      },
    );

    expect(appended).toHaveLength(1);
    const toolMessage = appended[0] as ToolMessage;
    expect(toolMessage).toBeInstanceOf(ToolMessage);
    expect(String(toolMessage.content)).toContain("[tool_result_ref");
    expect(String(toolMessage.content)).toContain("reopen_with=tool_result_read");
    expect(String(toolMessage.content)).not.toContain(longOutput);

    const refMatch = String(toolMessage.content).match(/ref=([a-z0-9._-]+)/i);
    const ref = refMatch?.[1];
    expect(ref).toBeTruthy();
    if (!ref) {
      throw new Error("expected a stored tool-result ref");
    }

    const stored = store.get(ref);
    expect(stored?.content).toBe(longOutput);
    expect(stored?.namespace).toBe("conversation:test");
  });

  test("keeps large load_tool_library payloads inline even above the spill threshold", async () => {
    const messageModule = await import("./ai-sdk-message-service");
    const toolResultStoreModule = await import("./tool-result-store");
    const store = new toolResultStoreModule.ToolResultStore();
    const longOutput = Array.from({ length: 220 }, (_, index) => `candidate-${index + 1}`).join("\n");

    const appended = messageModule.appendResponseMessages(
      [],
      [{
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call-tool-search",
          toolName: "load_tool_library",
          output: {
            type: "text",
            value: longOutput,
          },
        }],
      }],
      {
        toolResultStore: store,
        toolResultNamespace: "conversation:test",
      },
    );

    expect(appended).toHaveLength(1);
    const toolMessage = appended[0] as ToolMessage;
    expect(String(toolMessage.content)).toBe(longOutput);
    expect(String(toolMessage.content)).not.toContain("[tool_result_ref");
  });

  test("keeps short tool results inline instead of storing a ref", async () => {
    const messageModule = await import("./ai-sdk-message-service");
    const toolResultStoreModule = await import("./tool-result-store");
    const store = new toolResultStoreModule.ToolResultStore();
    const shortOutput = "alpha\nbeta\ngamma";

    const appended = messageModule.appendResponseMessages(
      [],
      [{
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call-short",
          toolName: "read_file",
          output: {
            type: "text",
            value: shortOutput,
          },
        }],
      }],
      {
        toolResultStore: store,
        toolResultNamespace: "conversation:test",
      },
    );

    expect(appended).toHaveLength(1);
    const toolMessage = appended[0] as ToolMessage;
    expect(String(toolMessage.content)).toBe(shortOutput);
    expect(String(toolMessage.content)).not.toContain("[tool_result_ref");
  });

  test("keeps medium-sized tool results inline below the 1000-char threshold", async () => {
    const messageModule = await import("./ai-sdk-message-service");
    const toolResultStoreModule = await import("./tool-result-store");
    const store = new toolResultStoreModule.ToolResultStore();
    const mediumOutput = "x".repeat(900);

    const appended = messageModule.appendResponseMessages(
      [],
      [{
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call-medium",
          toolName: "list_dir",
          output: {
            type: "text",
            value: mediumOutput,
          },
        }],
      }],
      {
        toolResultStore: store,
        toolResultNamespace: "conversation:test",
      },
    );

    expect(appended).toHaveLength(1);
    const toolMessage = appended[0] as ToolMessage;
    expect(String(toolMessage.content)).toBe(mediumOutput);
    expect(String(toolMessage.content)).not.toContain("[tool_result_ref");
  });

  test("does not re-reference explicit tool_result_read output", async () => {
    const messageModule = await import("./ai-sdk-message-service");
    const toolResultStoreModule = await import("./tool-result-store");
    const store = new toolResultStoreModule.ToolResultStore();

    const appended = messageModule.appendResponseMessages(
      [],
      [{
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call-2",
          toolName: "tool_result_read",
          output: {
            type: "text",
            value: "[tool_result_slice ref=toolres_example]\nraw payload",
          },
        }],
      }],
      {
        toolResultStore: store,
        toolResultNamespace: "conversation:test",
      },
    );

    expect(appended).toHaveLength(1);
    const toolMessage = appended[0] as ToolMessage;
    expect(String(toolMessage.content)).toContain("raw payload");
    expect(String(toolMessage.content)).not.toContain("[tool_result_ref");
  });

  test("still stores large web_fetch output out of band", async () => {
    const messageModule = await import("./ai-sdk-message-service");
    const toolResultStoreModule = await import("./tool-result-store");
    const store = new toolResultStoreModule.ToolResultStore();
    const longOutput = Array.from({ length: 220 }, (_, index) => `page-line-${index + 1}`).join("\n");

    const appended = messageModule.appendResponseMessages(
      [],
      [{
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call-web-fetch",
          toolName: "web_fetch",
          output: {
            type: "text",
            value: longOutput,
          },
        }],
      }],
      {
        toolResultStore: store,
        toolResultNamespace: "conversation:test",
      },
    );

    expect(appended).toHaveLength(1);
    const toolMessage = appended[0] as ToolMessage;
    expect(String(toolMessage.content)).toContain("[tool_result_ref");
    expect(String(toolMessage.content)).toContain("tool=web_fetch");
  });
});

describe("ai-sdk message service multimodal user messages", () => {
  test("uses remote image URLs when available in chat content", async () => {
    const messageModule = await import("./ai-sdk-message-service");

    const messages = messageModule.toModelMessages([
      new HumanMessage([
        { type: "text", text: "Look at this" },
        {
          type: "image",
          data: "base64data",
          mimeType: "image/png",
          sourceUrl: "https://cdn.discordapp.com/attachments/example.png",
        },
      ]),
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "Look at this" },
        { type: "image", mediaType: "image/png" },
      ],
    });
    const userMessage = messages[0] as Extract<typeof messages[number], { role: "user" }>;
    expect(Array.isArray(userMessage.content)).toBe(true);
    if (!Array.isArray(userMessage.content)) {
      throw new Error("expected multipart user content");
    }
    const imagePart = userMessage.content[1];
    expect(imagePart?.type).toBe("image");
    if (imagePart?.type !== "image") {
      throw new Error("expected image part");
    }
    expect(imagePart.image).toBeInstanceOf(URL);
    expect((imagePart.image as URL).toString()).toBe("https://cdn.discordapp.com/attachments/example.png");
  });

  test("keeps inline image data when the source URL is not remotely fetchable", async () => {
    const messageModule = await import("./ai-sdk-message-service");

    const messages = messageModule.toModelMessages([
      new HumanMessage([
        {
          type: "image",
          data: "base64data",
          mimeType: "image/png",
          sourceUrl: "data:image/png;base64,base64data",
        },
      ]),
    ]);

    const userMessage = messages[0] as Extract<typeof messages[number], { role: "user" }>;
    expect(Array.isArray(userMessage.content)).toBe(true);
    if (!Array.isArray(userMessage.content)) {
      throw new Error("expected multipart user content");
    }
    const imagePart = userMessage.content[0];
    expect(imagePart?.type).toBe("image");
    if (imagePart?.type !== "image") {
      throw new Error("expected image part");
    }
    expect(imagePart.image).toBe("base64data");
  });
});
