import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import type { AgentLoopResult } from "./agent-loop";

// ---------------------------------------------------------------------------
// Mock the agent-loop module so tests never call a real model API.
// The mock exposes a `setHandler` function that individual tests can use
// to provide scripted behaviour.
// ---------------------------------------------------------------------------
type MockLoopHandler = (opts: {
  messages: Message[];
  tools: any[];
  executeTool?: (tc: ToolCall, signal?: AbortSignal) => Promise<any>;
  providerOptions?: Record<string, unknown>;
  signal?: AbortSignal;
}) => Promise<AgentLoopResult>;

let agentLoopHandler: MockLoopHandler | null = null;

function setAgentLoopHandler(handler: MockLoopHandler) {
  agentLoopHandler = handler;
}

mock.module("./agent-loop", () => ({
  runAgentLoop: async (opts: any) => {
    if (!agentLoopHandler) {
      throw new Error("No agent-loop handler set for this test.");
    }
    return agentLoopHandler(opts);
  },
}));

// Import after the mock so the mock takes effect
const { AgentChatService } = await import("./agent-chat-service");
const { ConversationStore } = await import("./conversation-store");
const { SystemPromptService } = await import("../system-prompt-service");

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
  agentLoopHandler = null;
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
  recallContext?: string;
  disableAutomaticMemory?: boolean;
}) {
  const requests: Array<{ sessionId?: string; humanMessages: string[] }> = [];

  setAgentLoopHandler(async (opts) => {
    const humanMessages = opts.messages
      .filter((msg) => isUserMessage(msg))
      .map((msg) => typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
    requests.push({
      sessionId: (opts.providerOptions?.sessionId as string) ?? undefined,
      humanMessages,
    });
    let finalMessage: AssistantMessage;
    if (options?.onRequest) {
      finalMessage = await options.onRequest({
        sessionId: (opts.providerOptions?.sessionId as string) ?? undefined,
        messages: humanMessages.map((text) => ({ text, role: "user" })),
      });
    } else {
      finalMessage = assistantTextMessage(`Acknowledged: ${humanMessages.at(-1) ?? ""}`);
    }
    return {
      newMessages: [finalMessage],
      finalMessage,
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
          selection: { providerId: "scripted-test", modelId: "scripted-model" },
          runtimeModel: { id: "scripted-model", api: "openai-completions", provider: "scripted-test", baseUrl: "", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 },
          apiKey: "test-key",
        };
      },
    } as any,
    memory: options?.disableAutomaticMemory
      ? undefined
      : {
          async buildRecallContext() {
            return options?.recallContext ?? "";
          },
        } as any,
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
      onRequest: async ({ sessionId }) => {
        if (sessionId === "conversation-1" && !firstTurnStarted) {
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

  test("injects automatic memory recall without persisting recalled context into the thread", async () => {
    const { service, requests, conversations } = createService({
      recallContext: [
        "<recalled_memory>",
        "This block is automatic memory retrieval.",
        "It is background context only and is not part of the user's new message.",
        "",
        "<memory_item>",
        "index: 1",
        "path: root/core/MEMORY.md",
        "heading: User style",
        "score: 0.9300",
        "content:",
        "User prefers terse replies.",
        "</memory_item>",
        "</recalled_memory>",
      ].join("\n"),
    });

    const result = await service.reply({
      conversationKey: "conversation-1",
      content: "How should you answer me?",
    });

    expect(result.message).toContain("Acknowledged:");
    expect(requests[0]?.humanMessages).toHaveLength(1);
    expect(requests[0]?.humanMessages[0]).toContain('<INJECTED_MESSAGE generated_by="memory_recall">');

    expect(requests[0]?.humanMessages[0]).toContain("<recalled_memory>");
    expect(requests[0]?.humanMessages[0]).toContain("User prefers terse replies");
    expect(requests[0]?.humanMessages[0]).toContain("How should you answer me?");
    const injectedMessage = requests[0]?.humanMessages[0] ?? "";
    expect(injectedMessage.indexOf("<recalled_memory>"))
      .toBeLessThan(injectedMessage.indexOf("How should you answer me?"));
    const savedConversation = await conversations.get("conversation-1");
    const savedUserMessage = savedConversation.messages.findLast((message) => isUserMessage(message));
    expect(savedUserMessage?.role).toBe("user");
    const savedContent = typeof savedUserMessage?.content === "string" ? savedUserMessage.content : JSON.stringify(savedUserMessage?.content);
    expect(savedContent).toContain("How should you answer me?");
    // In the Pi migration, the persisted user message includes the full injected
    // context (memory recall + time prefix) because the agent loop receives the
    // combined message and the service persists the same user message it sent.
    expect(savedContent).toContain("<recalled_memory>");
  });

  test("does not inject an extra human message when recall is empty", async () => {
    const { service, requests } = createService({
      recallContext: "",
    });

    await service.reply({
      conversationKey: "conversation-1",
      content: "Plain user prompt with no relevant memory.",
    });

    expect(requests[0]?.humanMessages).toHaveLength(1);
    expect(requests[0]?.humanMessages[0]).toContain("Plain user prompt with no relevant memory.");
    expect(requests[0]?.humanMessages[0]).not.toContain("<recalled_memory>");
  });

  test("can disable automatic memory recall entirely", async () => {
    const { service, requests } = createService({
      recallContext: "<recalled_memory>\nshould not appear\n</recalled_memory>",
      disableAutomaticMemory: true,
    });

    await service.reply({
      conversationKey: "conversation-1",
      content: "Subagent turn should stay clean.",
    });

    expect(requests[0]?.humanMessages).toHaveLength(1);
    expect(requests[0]?.humanMessages[0]).toContain("Subagent turn should stay clean.");
    expect(requests[0]?.humanMessages[0]).not.toContain("<recalled_memory>");
  });

  test("persists tool calls and tool results in the conversation", async () => {
    const toolInvocations: string[] = [];
    let callIndex = 0;

    setAgentLoopHandler(async (opts) => {
      const executeTool = opts.executeTool!;
      callIndex++;

      if (callIndex === 1) {
        // First call: model returns tool calls for load_tool_library
        const assistantMsg1: AssistantMessage = {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc-load-1", name: "load_tool_library", arguments: { library: "shell" } },
            { type: "toolCall", id: "tc-load-2", name: "load_tool_library", arguments: { library: "web" } },
          ],
          api: "scripted", provider: "scripted-test", model: "scripted-model",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse", timestamp: Date.now(),
        };

        const tr1 = await executeTool({ type: "toolCall", id: "tc-load-1", name: "load_tool_library", arguments: { library: "shell" } });
        const tr2 = await executeTool({ type: "toolCall", id: "tc-load-2", name: "load_tool_library", arguments: { library: "web" } });

        // Second call: model returns tool calls for exec_command
        const assistantMsg2: AssistantMessage = {
          role: "assistant",
          content: [
            { type: "toolCall", id: "tc-exec-1", name: "exec_command", arguments: { command: "ls" } },
            { type: "toolCall", id: "tc-exec-2", name: "exec_command", arguments: { command: "pwd" } },
          ],
          api: "scripted", provider: "scripted-test", model: "scripted-model",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse", timestamp: Date.now(),
        };

        const tr3 = await executeTool({ type: "toolCall", id: "tc-exec-1", name: "exec_command", arguments: { command: "ls" } });
        const tr4 = await executeTool({ type: "toolCall", id: "tc-exec-2", name: "exec_command", arguments: { command: "pwd" } });

        // Third call: final message
        const finalMessage = assistantTextMessage("All done. I loaded 2 libraries and ran 2 commands.");

        return {
          newMessages: [assistantMsg1, tr1, tr2, assistantMsg2, tr3, tr4, finalMessage],
          finalMessage,
          steps: 3,
        };
      }

      const finalMessage = assistantTextMessage("Unexpected call");
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
            selection: { providerId: "scripted-test", modelId: "scripted-model" },
            runtimeModel: { id: "scripted-model", api: "openai-completions", provider: "scripted-test", baseUrl: "", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 },
            apiKey: "test-key",
          };
        },
      } as any,
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

    setAgentLoopHandler(async (opts) => {
      const executeTool = opts.executeTool!;

      const assistantMsg: AssistantMessage = {
        role: "assistant",
        content: [
          { type: "text", text: "Let me run that" },
          { type: "toolCall", id: "tc-1", name: "exec_command", arguments: { command: "ls" } },
        ],
        api: "scripted", provider: "scripted-test", model: "scripted-model",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse", timestamp: Date.now(),
      };

      const tr = await executeTool({ type: "toolCall", id: "tc-1", name: "exec_command", arguments: { command: "ls" } });

      // Request stop AFTER the tool has executed
      if (session) {
        session.stopRequested = true;
      }

      const finalMessage = assistantTextMessage("Here are the results");

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
            selection: { providerId: "scripted-test", modelId: "scripted-model" },
            runtimeModel: { id: "scripted-model", api: "openai-completions", provider: "scripted-test", baseUrl: "", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 },
            apiKey: "test-key",
          };
        },
      } as any,
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
