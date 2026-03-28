import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Message, AssistantMessage, UserMessage, ToolResultMessage } from "../messages/types";
import {
  userMessage,
  assistantTextMessage,
  toolResultMessage,
  isUserMessage,
  isAssistantMessage,
  isToolResultMessage,
  extractAssistantText,
} from "../messages/types";

const repoRoot = process.cwd();

let previousCwd = "";
let previousRootDirEnv: string | undefined;
let tempRoot = "";

function copyDirectory(relativePath: string) {
  const source = path.join(repoRoot, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }
  fs.cpSync(source, path.join(tempRoot, relativePath), { recursive: true });
}

function copyFile(relativePath: string) {
  const source = path.join(repoRoot, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }
  const destination = path.join(tempRoot, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?test=${Date.now()}-${Math.random()}`) as Promise<T>;
}

type RequestRecord = {
  usagePurpose?: string;
  sessionId?: string;
  humanMessages: string[];
};

type HarnessOptions = {
  onCompaction?: (summaryRequest: {
    usagePurpose?: string;
    sessionId?: string;
    humanMessages: string[];
  }) => Promise<AssistantMessage> | AssistantMessage;
  onReply?: (request: {
    usagePurpose?: string;
    sessionId?: string;
    humanMessages: string[];
  }) => Promise<AssistantMessage> | AssistantMessage;
};

type Harness = {
  service: any;
  conversations: any;
  systemPrompts: any;
  requests: RequestRecord[];
};

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const agentChatModule = await importFresh<typeof import("./conversation/agent-chat-service")>("src/services/conversation/agent-chat-service.ts");
  const conversationStateTransitionModule = await importFresh<typeof import("./conversation/conversation-state-transition-service")>("src/services/conversation/conversation-state-transition-service.ts");
  const conversationStoreModule = await importFresh<typeof import("./conversation/conversation-store")>("src/services/conversation/conversation-store.ts");
  const memoryServiceModule = await importFresh<typeof import("./memory-service")>("src/services/memory-service.ts");
  const profileServiceModule = await importFresh<typeof import("./profiles/profile-service")>("src/services/profiles/profile-service.ts");
  const systemPromptModule = await importFresh<typeof import("./system-prompt-service")>("src/services/system-prompt-service.ts");
  const scriptedConnectorModule = await importFresh<typeof import("../test/scripted-provider-connector")>("src/test/scripted-provider-connector.ts");

  const requests: RequestRecord[] = [];
  const profiles = new profileServiceModule.ProfileService("root");
  const profile = profiles.getActiveProfile();
  const conversations = new conversationStoreModule.ConversationStore();
  const systemPrompts = new systemPromptModule.SystemPromptService();
  const memory = new memoryServiceModule.MemoryService(profile, profiles);
  // NOTE: In the Pi architecture, scripted model responses need to be wired
  // through ModelService.resolveModelForPurpose or the pi-ai complete()
  // function. The scripted handler captures intent for future integration.
  const _scriptedHandler = async (request: { usagePurpose?: string; sessionId?: string; messages: Message[] }) => {
    const humanMessages = request.messages
      .filter((message): message is UserMessage => isUserMessage(message))
      .map((message: UserMessage) => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
    requests.push({
      usagePurpose: request.usagePurpose,
      sessionId: request.sessionId,
      humanMessages,
    });

    if (request.usagePurpose === "conversation_compaction") {
      if (options.onCompaction) {
        return options.onCompaction({
          usagePurpose: request.usagePurpose,
          sessionId: request.sessionId,
          humanMessages,
        });
      }
      return assistantTextMessage(JSON.stringify({
        summary: "Conversation compacted for e2e.",
        memory_markdown: "- User prefers terse replies.",
      }), { api: "scripted", provider: "scripted-compaction-e2e", model: "scripted-model" });
    }

    if (options.onReply) {
      return options.onReply({
        usagePurpose: request.usagePurpose,
        sessionId: request.sessionId,
        humanMessages,
      });
    }

    return assistantTextMessage("Reply after compaction.", {
      api: "scripted",
      provider: "scripted-compaction-e2e",
      model: "scripted-model",
    });
  };

  const modelHelpers = {
    async inspectContextWindowUsage() {
      return {
        usedTokens: 7_000,
        maxContextTokens: 8_192,
        maxOutputTokens: 512,
        utilizationPercent: 79,
        breakdownMethod: "heuristic_estimate" as const,
      };
    },
    async generateMemoryText(params: { usagePurpose: string }) {
      if (params.usagePurpose === "conversation_compaction_core_memory") {
        return [
          "# Core Memory",
          "",
          "## Preferences",
          "",
          "- User prefers terse replies.",
        ].join("\n");
      }
      return "";
    },
  };

  const transitions = new conversationStateTransitionModule.ConversationStateTransitionService(
    modelHelpers as any,
    conversations,
    memory,
    systemPrompts,
  );
  const service = new agentChatModule.AgentChatService({
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
    transitions,
    conversations,
    systemPrompts,
    models: modelHelpers as any,
  });

  return {
    service,
    conversations,
    systemPrompts,
    requests,
  };
}

function extractText(message: Message) {
  if (isUserMessage(message)) {
    return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
  }
  if (isAssistantMessage(message)) {
    return extractAssistantText(message);
  }
  if (isToolResultMessage(message)) {
    return message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
  return JSON.stringify(message);
}

beforeAll(() => {
  previousCwd = process.cwd();
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-compaction-e2e-"));
  process.env.OPENELINARO_ROOT_DIR = tempRoot;
  process.chdir(tempRoot);

  copyDirectory("system_prompt");
  copyFile("profiles/registry.json");
});

afterAll(() => {
  process.chdir(previousCwd);
  if (previousRootDirEnv) {
    process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
  } else {
    delete process.env.OPENELINARO_ROOT_DIR;
  }
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("agent compaction e2e", () => {
  test("compacts through the real transition path and preserves continuation state", async () => {
    const harness = await createHarness();
    const progress: string[] = [];
    const conversationKey = "conversation-success";
    await harness.conversations.ensureSystemPrompt(conversationKey, harness.systemPrompts.load());
    await harness.conversations.appendMessages(conversationKey, [
      userMessage("Earlier user request."),
      assistantTextMessage("Earlier assistant reply.", { api: "scripted", provider: "scripted", model: "scripted" }),
      toolResultMessage({
        toolCallId: "done-1",
        toolName: "routine_done",
        content: "Marked done.",
      }),
      userMessage("Second user request."),
      assistantTextMessage("Second assistant reply.", { api: "scripted", provider: "scripted", model: "scripted" }),
    ]);

    const result = await harness.service.reply({
      conversationKey,
      content: "Newest message after compaction.",
      onToolUse: async (message: string) => {
        progress.push(message);
      },
    });

    expect(result.mode).toBe("immediate");
    expect(result.message).toBe("Reply after compaction.");
    expect(progress).toContain("Compacting conversation history for conversation-success (5 messages).");
    expect(progress).toContain("Merging durable memory into core memory.");
    expect(progress).toContain("Compaction complete.");

    const conversation = await harness.conversations.get(conversationKey);
    expect(conversation).toBeTruthy();
    const messages = conversation.messages.map(extractText);
    expect(messages[0]).toContain("Context summary (generated automatically during compaction");
    expect(messages[0]).toContain("Conversation compacted for e2e.");
    expect(messages.at(-2)).toContain("Newest message after compaction.");
    expect(messages.at(-1)).toContain("Reply after compaction.");

    const memoryPath = path.join(tempRoot, ".openelinarotest", "memory/documents/root/core/MEMORY.md");
    expect(fs.existsSync(memoryPath)).toBe(true);
    expect(fs.readFileSync(memoryPath, "utf8")).toContain("User prefers terse replies.");

    expect(harness.requests.some((request) => request.usagePurpose === "conversation_compaction")).toBe(true);
  });

  test("continues the turn when compaction aborts", async () => {
    const harness = await createHarness({
      onCompaction: async () => {
        throw new Error("Model request was aborted. Request was aborted.");
      },
      onReply: async () => assistantTextMessage("Reply despite compaction failure.", {
        api: "scripted",
        provider: "scripted-compaction-e2e",
        model: "scripted-model",
      }),
    });
    const progress: string[] = [];
    const conversationKey = "conversation-abort";
    await harness.conversations.ensureSystemPrompt(conversationKey, harness.systemPrompts.load());
    await harness.conversations.appendMessages(conversationKey, [
      userMessage("Earlier user request."),
      assistantTextMessage("Earlier assistant reply.", { api: "scripted", provider: "scripted", model: "scripted" }),
    ]);

    const result = await harness.service.reply({
      conversationKey,
      content: "Keep going even if compaction aborts.",
      onToolUse: async (message: string) => {
        progress.push(message);
      },
    });

    expect(result.mode).toBe("immediate");
    expect(result.message).toBe("Reply despite compaction failure.");
    expect(progress).toContain("Compaction failed. Continuing without compaction for this turn.");

    const conversation = await harness.conversations.get(conversationKey);
    expect(conversation).toBeTruthy();
    const messages = conversation.messages.map(extractText);
    expect(messages[0]).not.toContain("Context summary (generated automatically during compaction");
    expect(messages.at(-2)).toContain("Keep going even if compaction aborts.");
    expect(messages.at(-1)).toContain("Reply despite compaction failure.");
  });
});
