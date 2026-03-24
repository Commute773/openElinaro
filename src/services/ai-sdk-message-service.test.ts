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

describe("ai-sdk message service tool call round-trip", () => {
  test("tool calls survive appendResponseMessages → storage → toModelMessages round-trip", async () => {
    const messageModule = await import("./ai-sdk-message-service");
    const { mapChatMessagesToStoredMessages, mapStoredMessagesToChatMessages, AIMessage: AIMsg } = await import("@langchain/core/messages");

    // Simulate a multi-step response with tool calls
    const responseMessages: Array<{
      role: "assistant" | "tool";
      content: any;
    }> = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Loading tools" },
          { type: "tool-call", toolCallId: "tc-1", toolName: "load_tool_library", input: { library: "shell" } },
          { type: "tool-call", toolCallId: "tc-2", toolName: "load_tool_library", input: { library: "web" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "tc-1", toolName: "load_tool_library", output: { type: "text", value: "Loaded shell" } },
          { type: "tool-result", toolCallId: "tc-2", toolName: "load_tool_library", output: { type: "text", value: "Loaded web" } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc-3", toolName: "exec_command", input: { command: "ls" } },
          { type: "tool-call", toolCallId: "tc-4", toolName: "exec_command", input: { command: "pwd" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "tc-3", toolName: "exec_command", output: { type: "text", value: "file1\nfile2" } },
          { type: "tool-result", toolCallId: "tc-4", toolName: "exec_command", output: { type: "text", value: "/home" } },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done running commands" }],
      },
    ];

    // Step 1: Convert response messages to BaseMessage[]
    const baseMessages = messageModule.appendResponseMessages(
      [new HumanMessage("do stuff")],
      responseMessages,
    );

    // Verify initial conversion preserves tool calls
    const step1ToolCalls = baseMessages
      .filter((m) => m._getType() === "ai")
      .flatMap((m) => (m as any).tool_calls ?? []);
    expect(step1ToolCalls).toHaveLength(4);
    expect(step1ToolCalls.map((tc: any) => tc.name).sort()).toEqual([
      "exec_command", "exec_command", "load_tool_library", "load_tool_library",
    ]);

    // Step 2: Serialize to storage format
    const stored = mapChatMessagesToStoredMessages(baseMessages);

    // Step 3: Deserialize back
    const decoded = mapStoredMessagesToChatMessages(stored);
    const step3ToolCalls = decoded
      .filter((m) => m._getType() === "ai")
      .flatMap((m) => (m as any).tool_calls ?? []);
    expect(step3ToolCalls).toHaveLength(4);
    expect(step3ToolCalls.map((tc: any) => tc.name).sort()).toEqual([
      "exec_command", "exec_command", "load_tool_library", "load_tool_library",
    ]);

    // Step 4: Convert back to model messages (for sending to LLM)
    const modelMessages = messageModule.toModelMessages(decoded);

    // Count tool-call parts in assistant messages
    const toolCallPartsCount = modelMessages
      .filter((m) => m.role === "assistant")
      .reduce((count, m) => {
        if (typeof m.content === "string") return count;
        return count + m.content.filter((p: any) => p.type === "tool-call").length;
      }, 0);
    expect(toolCallPartsCount).toBe(4);

    // Count tool-result parts in tool messages
    const toolResultPartsCount = modelMessages
      .filter((m) => m.role === "tool")
      .reduce((count, m) => {
        if (typeof m.content === "string") return count;
        return count + m.content.filter((p: any) => p.type === "tool-result").length;
      }, 0);
    expect(toolResultPartsCount).toBe(4);

    // Verify tool call IDs match between tool-call and tool-result
    const toolCallIds = new Set(step3ToolCalls.map((tc: any) => tc.id));
    const toolResultIds = new Set(
      decoded
        .filter((m): m is ToolMessage => m instanceof ToolMessage)
        .map((m) => m.tool_call_id),
    );
    expect(toolCallIds).toEqual(toolResultIds);
  });
});

describe("ai-sdk message service multimodal user messages", () => {
  test("always uses inline base64 data for images even when sourceUrl is present", async () => {
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
    expect(imagePart.image).toBe("base64data");
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
