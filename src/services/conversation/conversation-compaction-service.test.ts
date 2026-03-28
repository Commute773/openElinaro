import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProfileRecord } from "../../domain/profiles";
import type { AssistantMessage } from "../../messages/types";
import { userMessage } from "../../messages/types";

// ---------------------------------------------------------------------------
// Mock pi-ai's complete() so the compaction service never hits a real API.
// ---------------------------------------------------------------------------
type CompleteMock = (model: any, context: any, options?: any) => Promise<AssistantMessage>;
let completeMock: CompleteMock | null = null;

function setCompleteMock(handler: CompleteMock) {
  completeMock = handler;
}

mock.module("@mariozechner/pi-ai", () => ({
  complete: async (model: any, context: any, options?: any) => {
    if (!completeMock) {
      throw new Error("No complete() mock set for this test.");
    }
    return completeMock(model, context, options);
  },
}));

// Import after mock so it takes effect
const { ConversationCompactionService } = await import("./conversation-compaction-service");
const { MemoryService } = await import("../memory-service");
const { ProfileService } = await import("../profiles");

const ROOT_PROFILE: ProfileRecord = {
  id: "root",
  name: "Root",
  roles: ["root"],
  memoryNamespace: "root",
};

let previousCwd = "";
let previousRootDir = "";
let tempRoot = "";

beforeEach(() => {
  previousCwd = process.cwd();
  previousRootDir = process.env.OPENELINARO_ROOT_DIR ?? "";
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-compaction-"));
  process.env.OPENELINARO_ROOT_DIR = tempRoot;
  process.chdir(tempRoot);
  fs.mkdirSync(path.join(tempRoot, ".openelinarotest", "memory", "documents", "root"), { recursive: true });
});

afterEach(() => {
  process.chdir(previousCwd);
  if (previousRootDir) {
    process.env.OPENELINARO_ROOT_DIR = previousRootDir;
  } else {
    delete process.env.OPENELINARO_ROOT_DIR;
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
  completeMock = null;
});

function makeAssistantResponse(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "scripted",
    provider: "scripted-test",
    model: "scripted-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function createMockModelService(handler: (text: string, usagePurpose?: string) => string) {
  return {
    async resolveModelForPurpose(purpose?: string) {
      return {
        selection: { providerId: "scripted-test", modelId: "scripted-model" },
        runtimeModel: { id: "scripted-model", api: "openai-completions", provider: "scripted-test", baseUrl: "", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 },
        apiKey: "test-key",
      };
    },
    async generateMemoryText(params: { systemPrompt: string; userPrompt: string; usagePurpose?: string }) {
      return handler(params.userPrompt, params.usagePurpose);
    },
  } as any;
}

describe("ConversationCompactionService", () => {
  test("parses durable memory from sectioned non-JSON output", async () => {
    setCompleteMock(async () => {
      return makeAssistantResponse([
        "Summary:",
        "- User wants short answers.",
        "",
        "Durable Memory:",
        "- Prefers concise replies.",
        "- Working in the openElinaro repo.",
      ].join("\n"));
    });

    const models = createMockModelService((userPrompt) => {
      if (userPrompt.includes("Prefers concise replies.")) {
        return [
          "# Core Memory",
          "",
          "## Preferences",
          "",
          "- Prefers concise replies.",
          "- Working in the openElinaro repo.",
        ].join("\n");
      }
      return "# Core Memory";
    });

    const service = new ConversationCompactionService(
      models,
      new MemoryService(ROOT_PROFILE, new ProfileService("root")),
    );

    const result = await service.compact({
      conversationKey: "sectioned-compaction",
      systemPrompt: "You are a test system prompt.",
      messages: [userMessage("Keep replies short and direct.")],
    });

    expect(result.summary).toContain("User wants short answers");
    expect(result.memoryFilePath).toBeString();
    expect(result.memoryFilePath).toContain(path.join("core", "MEMORY.md"));
    const saved = fs.readFileSync(result.memoryFilePath!, "utf8");
    expect(saved).toContain("Prefers concise replies.");
  });

  test("recovers durable memory from the summary when memory_markdown is empty", async () => {
    const requests: string[] = [];

    setCompleteMock(async (_model, context) => {
      // The first call is the main compaction, the second is the memory extraction
      const userContent = context.messages[0]?.content;
      const text = typeof userContent === "string" ? userContent : "";
      if (text.includes("Compaction summary:")) {
        requests.push("conversation_compaction_memory");
        return makeAssistantResponse("- User prefers one-line summaries.\n- Root profile owns deployment steps.");
      }
      requests.push("conversation_compaction");
      return makeAssistantResponse(JSON.stringify({
        summary: "User prefers one-line summaries and root handles deploys.",
        memory_markdown: "",
      }));
    });

    const models = createMockModelService((userPrompt, usagePurpose) => {
      if (usagePurpose === "conversation_compaction_core_memory") {
        return [
          "# Core Memory",
          "",
          "## Preferences",
          "",
          "- User prefers one-line summaries.",
          "",
          "## Operations",
          "",
          "- Root profile owns deployment steps.",
        ].join("\n");
      }
      return "";
    });

    const service = new ConversationCompactionService(
      models,
      new MemoryService(ROOT_PROFILE, new ProfileService("root")),
    );

    const result = await service.compact({
      conversationKey: "recovered-memory",
      systemPrompt: "You are a test system prompt.",
      messages: [userMessage("Please remember that I prefer one-line summaries.")],
    });

    expect(requests).toEqual([
      "conversation_compaction",
      "conversation_compaction_memory",
    ]);
    expect(result.memoryFilePath).toBeString();
    expect(result.memoryFilePath).toContain(path.join("core", "MEMORY.md"));
    const saved = fs.readFileSync(result.memoryFilePath!, "utf8");
    expect(saved).toContain("User prefers one-line summaries.");
    expect(saved).toContain("Root profile owns deployment steps.");
  });
});
