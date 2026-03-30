import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AssistantMessage, Message, ToolCall } from "../../messages/types";
import {
  assistantTextMessage,
  extractAssistantText,
  isAssistantMessage,
  isToolResultMessage,
  isUserMessage,
  userMessage,
  toolResultMessage,
} from "../../messages/types";
import { PI_CORE_MANIFEST } from "../../core/pi-core";
import type { AgentCore, CoreRunOptions, CoreRunResult, CoreFactory, CoreAssistantMessage } from "../../core/types";
import { piMessagesToCore, coreMessagesToPi } from "../../core/message-bridge";
import { AgentChatService } from "./agent-chat-service";
import { ConversationStore } from "./conversation-store";
import { SystemPromptService } from "../system-prompt-service";

// ---------------------------------------------------------------------------
// Mock core factory — tests provide a handler that receives core run options
// and returns a CoreRunResult.
// ---------------------------------------------------------------------------
type MockCoreHandler = (opts: CoreRunOptions) => Promise<CoreRunResult>;

let coreRunHandler: MockCoreHandler | null = null;

function setCoreRunHandler(handler: MockCoreHandler) {
  coreRunHandler = handler;
}

function createMockCoreFactory(): CoreFactory {
  return () => ({
    manifest: PI_CORE_MANIFEST,
    async run(opts: CoreRunOptions): Promise<CoreRunResult> {
      if (!coreRunHandler) {
        throw new Error("No core run handler set for this test.");
      }
      return coreRunHandler(opts);
    },
  });
}

/**
 * Helper: convert a pi-ai AssistantMessage to a CoreAssistantMessage for test results.
 */
function piAssistantToCore(msg: AssistantMessage): CoreAssistantMessage {
  return {
    role: "assistant",
    content: msg.content,
    provider: msg.provider,
    model: msg.model,
    usage: msg.usage,
    stopReason: msg.stopReason,
    errorMessage: msg.errorMessage,
    timestamp: msg.timestamp,
  };
}

let previousCwd = "";
let previousRootDir = "";
let tempRoot = "";

beforeEach(() => {
  previousCwd = process.cwd();
  previousRootDir = process.env.OPENELINARO_ROOT_DIR ?? "";
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-chat-service-"));
  process.env.OPENELINARO_ROOT_DIR = tempRoot;
  process.chdir(tempRoot);
});

afterEach(() => {
  process.chdir(previousCwd);
  if (previousRootDir) {
    process.env.OPENELINARO_ROOT_DIR = previousRootDir;
  } else {
    delete process.env.OPENELINARO_ROOT_DIR;
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
  coreRunHandler = null;
});

function createService(options?: {
  onRequest?: (request: { sessionId?: string; messages: Array<{ text: string; role: string }> }) => Promise<AssistantMessage> | AssistantMessage;
  inspectContextWindowUsage?: (params: { messages: Message[] }) => Promise<{
    usedTokens: number;
    maxContextTokens: number;
    maxOutputTokens?: number;
    utilizationPercent: number;
    breakdownMethod: "heuristic_estimate" | "provider_count";
  }>;
  onCompact?: () => Promise<void> | void;
}) {
  const requests: Array<{ sessionId?: string; humanMessages: string[] }> = [];

  setCoreRunHandler(async (opts) => {
    const humanMessages = opts.messages
      .filter((msg) => msg.role === "user")
      .map((msg) => typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
    // Extract sessionId from the core — not directly available, but we can track via requests
    requests.push({
      humanMessages,
    });
    let finalMessage: AssistantMessage;
    if (options?.onRequest) {
      finalMessage = await options.onRequest({
        messages: humanMessages.map((text) => ({ text, role: "user" })),
      });
    } else {
      finalMessage = assistantTextMessage(`Acknowledged: ${humanMessages.at(-1) ?? ""}`);
    }
    const coreFinal = piAssistantToCore(finalMessage);
    return {
      newMessages: [coreFinal],
      finalMessage: coreFinal,
      steps: 1,
    };
  });

  const conversations = new ConversationStore();
  const service = new AgentChatService({
    routineTools: {
      consumePendingBackgroundExecNotifications() {
        return [];
      },
      consumePendingConversationReset() {
        return null;
      },
      getToolDefinitions() {
        return [];
      },
      executeTool() {
        return toolResultMessage({ toolCallId: "stub", toolName: "stub", content: "stub" });
      },
    } as any,
    toolResolver: {
      resolveAllForChat() {
        return { entries: [] };
      },
      resolveForChat() {
        return { entries: [], tools: [] };
      },
    } as any,
    transitions: {
      async compactForContinuation() {
        await options?.onCompact?.();
        return {
          conversation: await conversations.get("conversation-1"),
          summary: "Compacted for continuation.",
          memoryFilePath: null,
        };
      },
    } as any,
    conversations,
    systemPrompts: new SystemPromptService(),
    models: {
      async inspectContextWindowUsage(params: { messages: Message[] }) {
        if (options?.inspectContextWindowUsage) {
          return options.inspectContextWindowUsage(params);
        }
        return {
          usedTokens: 100,
          maxContextTokens: 8_192,
          maxOutputTokens: 1_024,
          utilizationPercent: 1.22,
          breakdownMethod: "heuristic_estimate" as const,
        };
      },
      async resolveModelForPurpose() {
        return {
          selection: { providerId: "scripted-test", modelId: "scripted-model", thinkingLevel: "high" },
          runtimeModel: { id: "scripted-model", api: "openai-completions", provider: "scripted-test", baseUrl: "", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 },
          apiKey: "test-key",
        };
      },
    } as any,
    coreFactory: createMockCoreFactory(),
  });

  return { service, requests, conversations };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

describe("AgentChatService", () => {
  test("combines queued messages into one follow-up turn", async () => {
    const releaseFirstTurnRef: { current?: () => void } = {};
    const firstTurnGate = new Promise<void>((resolve) => {
      releaseFirstTurnRef.current = resolve;
    });
    let firstTurnStarted = false;
    let resolveFirstTurnStarted: (() => void) | null = null;
    const firstTurnStartedPromise = new Promise<void>((resolve) => {
      resolveFirstTurnStarted = resolve;
    });
    const activity: boolean[] = [];
    const backgroundResponses: string[] = [];

    const { service, requests } = createService({
      onRequest: async () => {
        if (!firstTurnStarted) {
          firstTurnStarted = true;
          resolveFirstTurnStarted?.();
          await firstTurnGate;
          return assistantTextMessage("First turn complete.");
        }
        return assistantTextMessage("Follow-up turn complete.");
      },
    });
    service.setConversationActivityNotifier(({ active }) => {
      activity.push(active);
    });

    const firstReply = service.reply({
      conversationKey: "conversation-1",
      content: "Initial message",
    });

    await firstTurnStartedPromise;

    const secondReply = await service.reply({
      conversationKey: "conversation-1",
      content: "Queued message two",
      onBackgroundResponse: async (result) => {
        backgroundResponses.push(result.message);
      },
    });
    const thirdReply = await service.reply({
      conversationKey: "conversation-1",
      content: "Queued message three",
      onBackgroundResponse: async (result) => {
        backgroundResponses.push(result.message);
      },
    });

    releaseFirstTurnRef.current?.();

    const firstResult = await firstReply;
    await waitFor(() => requests.length === 2 && backgroundResponses.length === 1);

    expect(firstResult.message).toBe("First turn complete.");
    expect(secondReply.mode).toBe("accepted");
    expect(thirdReply.mode).toBe("accepted");
    expect(requests[1]?.humanMessages.at(-1)).toContain("Multiple user messages arrived while you were busy");
    expect(requests[1]?.humanMessages.at(-1)).toContain("Queued message two");
    expect(requests[1]?.humanMessages.at(-1)).toContain("Queued message three");
    expect(activity).toContain(true);
    expect(activity.at(-1)).toBe(false);
  });

  test("triggers compaction when stored messages exceed utilization threshold", async () => {
    let compacted = false;
    const inspectedMessages: Message[] = [];
    const { service, conversations } = createService({
      inspectContextWindowUsage: async ({ messages }) => {
        inspectedMessages.push(...messages);
        return {
          usedTokens: 6_900,
          maxContextTokens: 8_192,
          maxOutputTokens: 512,
          utilizationPercent: 79,
          breakdownMethod: "heuristic_estimate",
        };
      },
      onCompact: async () => {
        compacted = true;
      },
    });

    await conversations.ensureSystemPrompt("conversation-1", await new SystemPromptService().load());
    await conversations.appendMessages("conversation-1", [userMessage("Existing context.")]);

    const session = (service as any).getSession("conversation-1");

    await (service as any).compactIfNeeded({
      kind: "chat",
      conversationKey: "conversation-1",
      content: "Current turn message",
      typingEligible: true,
      background: false,
      execution: {
        persistConversation: true,
        enableCompaction: true,
      },
      resolve() {},
      reject() {},
    }, session);

    expect(compacted).toBe(true);
    // The stored user message is included in the context usage inspection
    expect(inspectedMessages.some((msg) =>
      isUserMessage(msg) && typeof msg.content === "string" && msg.content.includes("Existing context."),
    )).toBe(true);
  });

  test("persists tool calls and tool results in the conversation", async () => {
    const toolInvocations: string[] = [];
    let callIndex = 0;

    setCoreRunHandler(async (opts) => {
      const executeTool = opts.executeTool;
      callIndex++;

      if (callIndex === 1) {
        // First call: model returns tool calls for load_tool_library
        const assistantMsg1: CoreAssistantMessage = {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc-load-1", name: "load_tool_library", arguments: { library: "shell" } },
            { type: "toolCall", id: "tc-load-2", name: "load_tool_library", arguments: { library: "web" } },
          ],
          provider: "scripted-test", model: "scripted-model",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse", timestamp: Date.now(),
        };

        const tr1 = await executeTool({ type: "toolCall", id: "tc-load-1", name: "load_tool_library", arguments: { library: "shell" } });
        const tr2 = await executeTool({ type: "toolCall", id: "tc-load-2", name: "load_tool_library", arguments: { library: "web" } });

        // Second call: model returns tool calls for exec_command
        const assistantMsg2: CoreAssistantMessage = {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc-exec-1", name: "exec_command", arguments: { command: "ls" } },
            { type: "toolCall", id: "tc-exec-2", name: "exec_command", arguments: { command: "pwd" } },
          ],
          provider: "scripted-test", model: "scripted-model",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse", timestamp: Date.now(),
        };

        const tr3 = await executeTool({ type: "toolCall", id: "tc-exec-1", name: "exec_command", arguments: { command: "ls" } });
        const tr4 = await executeTool({ type: "toolCall", id: "tc-exec-2", name: "exec_command", arguments: { command: "pwd" } });

        // Third call: final message
        const finalMessage = piAssistantToCore(assistantTextMessage("All done. I loaded 2 libraries and ran 2 commands."));

        return {
          newMessages: [assistantMsg1, tr1, tr2, assistantMsg2, tr3, tr4, finalMessage],
          finalMessage,
          steps: 3,
        };
      }

      const finalMessage = piAssistantToCore(assistantTextMessage("Unexpected call"));
      return { newMessages: [finalMessage], finalMessage, steps: 1 };
    });

    const conversations = new ConversationStore();
    const service = new AgentChatService({
      routineTools: {
        consumePendingBackgroundExecNotifications() { return []; },
        consumePendingConversationReset() { return null; },
        getToolDefinitions() { return []; },
        async executeTool(tc: ToolCall) {
          if (tc.name === "load_tool_library") {
            toolInvocations.push(`load:${tc.arguments.library}`);
            return toolResultMessage({ toolCallId: tc.id, toolName: tc.name, content: `Loaded library: ${tc.arguments.library}` });
          }
          if (tc.name === "exec_command") {
            toolInvocations.push(`exec:${tc.arguments.command}`);
            return toolResultMessage({ toolCallId: tc.id, toolName: tc.name, content: `Output of: ${tc.arguments.command}` });
          }
          return toolResultMessage({ toolCallId: tc.id, toolName: tc.name, content: "unknown tool" });
        },
      } as any,
      toolResolver: {
        resolveAllForChat() {
          return { entries: [] };
        },
        resolveForChat() {
          return { entries: [], tools: ["load_tool_library", "exec_command"] };
        },
      } as any,
      transitions: {} as any,
      conversations,
      systemPrompts: new SystemPromptService(),
      models: {
        async inspectContextWindowUsage() {
          return {
            usedTokens: 100,
            maxContextTokens: 8_192,
            maxOutputTokens: 1_024,
            utilizationPercent: 1.22,
            breakdownMethod: "heuristic_estimate" as const,
          };
        },
        async resolveModelForPurpose() {
          return {
            selection: { providerId: "scripted-test", modelId: "scripted-model", thinkingLevel: "high" },
            runtimeModel: { id: "scripted-model", api: "openai-completions", provider: "scripted-test", baseUrl: "", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 },
            apiKey: "test-key",
          };
        },
      } as any,
      coreFactory: createMockCoreFactory(),
    });

    const result = await service.reply({
      conversationKey: "conversation-1",
      content: "Load shell and web libraries, then run ls and pwd",
    });

    expect(result.message).toContain("All done");
    expect(toolInvocations).toContain("load:shell");
    expect(toolInvocations).toContain("load:web");
    expect(toolInvocations).toContain("exec:ls");
    expect(toolInvocations).toContain("exec:pwd");

    const conversation = await conversations.get("conversation-1");
    const aiMessages = conversation.messages.filter(
      (message) => isAssistantMessage(message),
    );
    const toolMessages = conversation.messages.filter(
      (message) => isToolResultMessage(message),
    );

    // Verify tool calls are stored in AI messages
    const allToolCalls = aiMessages.flatMap((message) =>
      (message as AssistantMessage).content.filter((c): c is ToolCall => c.type === "toolCall"),
    );
    expect(allToolCalls.length).toBeGreaterThanOrEqual(4);
    expect(allToolCalls.some((tc) => tc.name === "load_tool_library")).toBe(true);
    expect(allToolCalls.some((tc) => tc.name === "exec_command")).toBe(true);

    // Verify tool results are stored
    expect(toolMessages.length).toBeGreaterThanOrEqual(4);
    expect(toolMessages.some((message) => (message as any).toolName === "load_tool_library")).toBe(true);
    expect(toolMessages.some((message) => (message as any).toolName === "exec_command")).toBe(true);
  });

  test("persists tool calls even when stop is requested during execution", async () => {
    let session: any = null;

    setCoreRunHandler(async (opts) => {
      const executeTool = opts.executeTool;

      const assistantMsg: CoreAssistantMessage = {
        role: "assistant",
        content: [
          { type: "text", text: "Let me run that" },
          { type: "toolCall", id: "tc-1", name: "exec_command", arguments: { command: "ls" } },
        ],
        provider: "scripted-test", model: "scripted-model",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse", timestamp: Date.now(),
      };

      const tr = await executeTool({ type: "toolCall", id: "tc-1", name: "exec_command", arguments: { command: "ls" } });

      // Request stop AFTER the tool has executed
      if (session) {
        session.stopRequested = true;
      }

      const finalMessage = piAssistantToCore(assistantTextMessage("Here are the results"));

      return {
        newMessages: [assistantMsg, tr, finalMessage],
        finalMessage,
        steps: 2,
      };
    });

    const conversations = new ConversationStore();
    const service = new AgentChatService({
      routineTools: {
        consumePendingBackgroundExecNotifications() { return []; },
        consumePendingConversationReset() { return null; },
        getToolDefinitions() { return []; },
        async executeTool(tc: ToolCall) {
          const result = toolResultMessage({ toolCallId: tc.id, toolName: tc.name, content: `Output of: ${tc.arguments.command}` });
          // Request stop AFTER the tool has executed
          if (session) {
            session.stopRequested = true;
          }
          return result;
        },
      } as any,
      toolResolver: {
        resolveAllForChat() {
          return { entries: [] };
        },
        resolveForChat() {
          return { entries: [], tools: ["exec_command"] };
        },
      } as any,
      transitions: {} as any,
      conversations,
      systemPrompts: new SystemPromptService(),
      models: {
        async inspectContextWindowUsage() {
          return {
            usedTokens: 100,
            maxContextTokens: 8_192,
            maxOutputTokens: 1_024,
            utilizationPercent: 1.22,
            breakdownMethod: "heuristic_estimate" as const,
          };
        },
        async resolveModelForPurpose() {
          return {
            selection: { providerId: "scripted-test", modelId: "scripted-model", thinkingLevel: "high" },
            runtimeModel: { id: "scripted-model", api: "openai-completions", provider: "scripted-test", baseUrl: "", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 },
            apiKey: "test-key",
          };
        },
      } as any,
      coreFactory: createMockCoreFactory(),
    });

    // Grab the internal session after it's created
    const originalGetSession = (service as any).getSession.bind(service);
    (service as any).getSession = function (key: string) {
      const s = originalGetSession(key);
      session = s;
      return s;
    };

    const result = await service.reply({
      conversationKey: "conversation-1",
      content: "Run ls",
    });

    // The stop should have been caught, but messages should be persisted
    const conversation = await conversations.get("conversation-1");
    const allToolCalls = conversation.messages
      .filter((message) => isAssistantMessage(message))
      .flatMap((message) =>
        (message as AssistantMessage).content.filter((c): c is ToolCall => c.type === "toolCall"),
      );
    const toolResults = conversation.messages.filter(
      (message) => isToolResultMessage(message),
    );

    // Tool calls and results must be persisted even though stop was requested
    expect(allToolCalls.some((tc) => tc.name === "exec_command")).toBe(true);
    expect(toolResults.some((message) => (message as any).toolName === "exec_command")).toBe(true);
  });
});
