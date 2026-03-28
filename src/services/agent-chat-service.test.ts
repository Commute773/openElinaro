import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { ScriptedProviderConnector } from "../test/scripted-provider-connector";
import { AgentChatService } from "./agent-chat-service";
import { ConversationStore } from "./conversation-store";
import { SystemPromptService } from "./system-prompt-service";

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
});

function createService(options?: {
  onRequest?: (request: { sessionId?: string; messages: Array<{ text: string; role: string }> }) => Promise<AIMessage> | AIMessage;
  inspectContextWindowUsage?: (params: { messages: HumanMessage[] | unknown[] }) => Promise<{
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
  const connector = new ScriptedProviderConnector(async (request) => {
    const humanMessages = request.messages
      .filter((message): message is HumanMessage => message instanceof HumanMessage)
      .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
    requests.push({
      sessionId: request.sessionId,
      humanMessages,
    });
    if (options?.onRequest) {
      return options.onRequest({
        sessionId: request.sessionId,
        messages: humanMessages.map((text) => ({ text, role: "user" })),
      });
    }
    return new AIMessage(`Acknowledged: ${humanMessages.at(-1) ?? ""}`);
  });
  const conversations = new ConversationStore();
  const service = new AgentChatService({
    connector,
    routineTools: {
      consumePendingBackgroundExecNotifications() {
        return [];
      },
      consumePendingConversationReset() {
        return null;
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
      async inspectContextWindowUsage(params: { messages: unknown[] }) {
        if (options?.inspectContextWindowUsage) {
          return options.inspectContextWindowUsage(params as { messages: HumanMessage[] | unknown[] });
        }
        return {
          usedTokens: 100,
          maxContextTokens: 8_192,
          maxOutputTokens: 1_024,
          utilizationPercent: 1.22,
          breakdownMethod: "heuristic_estimate" as const,
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
          return new AIMessage("First turn complete.");
        }
        return new AIMessage("Follow-up turn complete.");
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

  test("includes pending steering messages in compaction budgeting", async () => {
    let compacted = false;
    const inspectedHumanMessages: string[] = [];
    const { service, conversations } = createService({
      inspectContextWindowUsage: async ({ messages }) => {
        for (const message of messages) {
          if (message instanceof HumanMessage) {
            inspectedHumanMessages.push(
              typeof message.content === "string" ? message.content : JSON.stringify(message.content),
            );
          }
        }
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
    await conversations.appendMessages("conversation-1", [new HumanMessage("Existing context.")]);

    const session = (service as any).getSession("conversation-1");
    session.pendingSteeringMessages.push({
      conversationKey: "conversation-1",
      content: "Queued message one",
      typingEligible: true,
    });
    session.pendingSteeringMessages.push({
      conversationKey: "conversation-1",
      content: "Queued message two",
      typingEligible: true,
    });

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
    expect(inspectedHumanMessages.some((message) =>
      message.includes("Current turn message")
      && message.includes("Queued message one")
      && message.includes("Queued message two")
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
    expect(requests[0]?.humanMessages[0]).toContain("<recalled_memory>");
    expect(requests[0]?.humanMessages[0]).toContain("User prefers terse replies");
    expect(requests[0]?.humanMessages[0]).toContain("How should you answer me?");
    const injectedMessage = requests[0]?.humanMessages[0] ?? "";
    expect(injectedMessage.indexOf("<recalled_memory>"))
      .toBeLessThan(injectedMessage.indexOf("How should you answer me?"));
    const savedConversation = await conversations.get("conversation-1");
    const savedHumanMessage = savedConversation.messages.findLast((message) => message instanceof HumanMessage);
    expect(savedHumanMessage).toBeInstanceOf(HumanMessage);
    expect(typeof savedHumanMessage?.content === "string" ? savedHumanMessage.content : JSON.stringify(savedHumanMessage?.content))
      .toContain("How should you answer me?");
    expect(typeof savedHumanMessage?.content === "string" ? savedHumanMessage.content : JSON.stringify(savedHumanMessage?.content))
      .not.toContain("<recalled_memory>");
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
    let callIndex = 0;
    const toolInvocations: string[] = [];

    const mockLoadLibrary = new DynamicStructuredTool({
      name: "load_tool_library",
      description: "Load a tool library",
      schema: z.object({ library: z.string() }),
      func: async (input) => {
        toolInvocations.push(`load:${input.library}`);
        return `Loaded library: ${input.library}`;
      },
    });

    const mockExecCommand = new DynamicStructuredTool({
      name: "exec_command",
      description: "Execute a command",
      schema: z.object({ command: z.string() }),
      func: async (input) => {
        toolInvocations.push(`exec:${input.command}`);
        return `Output of: ${input.command}`;
      },
    });

    const allTools = [mockLoadLibrary, mockExecCommand];
    const connector = new ScriptedProviderConnector(async () => {
      callIndex++;
      if (callIndex === 1) {
        return new AIMessage({
          content: "",
          tool_calls: [
            { id: "tc-load-1", name: "load_tool_library", args: { library: "shell" }, type: "tool_call" as const },
            { id: "tc-load-2", name: "load_tool_library", args: { library: "web" }, type: "tool_call" as const },
          ],
        });
      }
      if (callIndex === 2) {
        return new AIMessage({
          content: "",
          tool_calls: [
            { id: "tc-exec-1", name: "exec_command", args: { command: "ls" }, type: "tool_call" as const },
            { id: "tc-exec-2", name: "exec_command", args: { command: "pwd" }, type: "tool_call" as const },
          ],
        });
      }
      return new AIMessage("All done. I loaded 2 libraries and ran 2 commands.");
    });

    const conversations = new ConversationStore();
    const service = new AgentChatService({
      connector,
      routineTools: {
        consumePendingBackgroundExecNotifications() { return []; },
        consumePendingConversationReset() { return null; },
      } as any,
      toolResolver: {
        resolveAllForChat() {
          return { entries: allTools };
        },
        resolveForChat() {
          return { entries: allTools, tools: allTools.map((t) => t.name) };
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
      (message): message is AIMessage => message instanceof AIMessage,
    );
    const toolMessages = conversation.messages.filter(
      (message): message is ToolMessage => message instanceof ToolMessage,
    );

    // Verify tool calls are stored in AI messages
    const allToolCalls = aiMessages.flatMap((message) => message.tool_calls ?? []);
    expect(allToolCalls.length).toBeGreaterThanOrEqual(4);
    expect(allToolCalls.some((tc) => tc.name === "load_tool_library")).toBe(true);
    expect(allToolCalls.some((tc) => tc.name === "exec_command")).toBe(true);

    // Verify tool results are stored
    expect(toolMessages.length).toBeGreaterThanOrEqual(4);
    expect(toolMessages.some((message) => message.name === "load_tool_library")).toBe(true);
    expect(toolMessages.some((message) => message.name === "exec_command")).toBe(true);
  });

  test("persists tool calls even when stop is requested during execution", async () => {
    let callIndex = 0;
    let session: any = null;

    const mockTool = new DynamicStructuredTool({
      name: "exec_command",
      description: "Execute a command",
      schema: z.object({ command: z.string() }),
      func: async (input) => {
        // Request stop AFTER the tool has executed
        if (session) {
          session.stopRequested = true;
        }
        return `Output of: ${input.command}`;
      },
    });

    const connector = new ScriptedProviderConnector(async () => {
      callIndex++;
      if (callIndex === 1) {
        return new AIMessage({
          content: "Let me run that",
          tool_calls: [
            { id: "tc-1", name: "exec_command", args: { command: "ls" }, type: "tool_call" as const },
          ],
        });
      }
      return new AIMessage("Here are the results");
    });

    const conversations = new ConversationStore();
    const service = new AgentChatService({
      connector,
      routineTools: {
        consumePendingBackgroundExecNotifications() { return []; },
        consumePendingConversationReset() { return null; },
      } as any,
      toolResolver: {
        resolveAllForChat() {
          return { entries: [mockTool] };
        },
        resolveForChat() {
          return { entries: [mockTool], tools: [mockTool.name] };
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
      .filter((message): message is AIMessage => message instanceof AIMessage)
      .flatMap((message) => message.tool_calls ?? []);
    const toolResults = conversation.messages.filter(
      (message): message is ToolMessage => message instanceof ToolMessage,
    );

    // Tool calls and results must be persisted even though stop was requested
    expect(allToolCalls.some((tc) => tc.name === "exec_command")).toBe(true);
    expect(toolResults.some((message) => message.name === "exec_command")).toBe(true);
  });
});
