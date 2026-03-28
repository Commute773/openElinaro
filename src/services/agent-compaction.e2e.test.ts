import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

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
  }) => Promise<AIMessage> | AIMessage;
  onReply?: (request: {
    usagePurpose?: string;
    sessionId?: string;
    humanMessages: string[];
  }) => Promise<AIMessage> | AIMessage;
};

type Harness = {
  service: any;
  conversations: any;
  systemPrompts: any;
  requests: RequestRecord[];
};

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const agentChatModule = await importFresh<typeof import("./agent-chat-service")>("src/services/agent-chat-service.ts");
  const conversationStateTransitionModule = await importFresh<typeof import("./conversation-state-transition-service")>("src/services/conversation-state-transition-service.ts");
  const conversationStoreModule = await importFresh<typeof import("./conversation-store")>("src/services/conversation-store.ts");
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
  const connector = new scriptedConnectorModule.ScriptedProviderConnector(async (request) => {
    const humanMessages = request.messages
      .filter((message): message is HumanMessage => message instanceof HumanMessage)
      .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
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
      return new AIMessage(JSON.stringify({
        summary: "Conversation compacted for e2e.",
        memory_markdown: "- User prefers terse replies.",
      }));
    }

    if (options.onReply) {
      return options.onReply({
        usagePurpose: request.usagePurpose,
        sessionId: request.sessionId,
        humanMessages,
      });
    }

    return new AIMessage("Reply after compaction.");
  }, { providerId: "scripted-compaction-e2e" });

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
    connector,
    conversations,
    memory,
    modelHelpers as any,
    systemPrompts,
  );
  const service = new agentChatModule.AgentChatService(
    connector,
    {
      consumePendingBackgroundExecNotifications() {
        return [];
      },
      consumePendingConversationReset() {
        return null;
      },
    } as any,
    {
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
    modelHelpers as any,
    undefined,
    undefined,
  );

  return {
    service,
    conversations,
    systemPrompts,
    requests,
  };
}

function extractText(message: BaseMessage) {
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
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
      new HumanMessage("Earlier user request."),
      new AIMessage("Earlier assistant reply."),
      new ToolMessage({
        tool_call_id: "done-1",
        name: "routine_done",
        status: "success",
        content: "Marked done.",
      }),
      new HumanMessage("Second user request."),
      new AIMessage("Second assistant reply."),
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
      onReply: async () => new AIMessage("Reply despite compaction failure."),
    });
    const progress: string[] = [];
    const conversationKey = "conversation-abort";
    await harness.conversations.ensureSystemPrompt(conversationKey, harness.systemPrompts.load());
    await harness.conversations.appendMessages(conversationKey, [
      new HumanMessage("Earlier user request."),
      new AIMessage("Earlier assistant reply."),
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
