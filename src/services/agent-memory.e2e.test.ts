import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getTestFixturesDir } from "../test/fixtures";
import { ScriptedProviderConnector } from "../test/scripted-provider-connector";

const repoRoot = process.cwd();
const MACHINE_TEST_ROOT = getTestFixturesDir();
const HAS_MEMORY_FIXTURES = fs.existsSync(path.join(MACHINE_TEST_ROOT, "memory/index.root.json"));
const NO_HIT_PROMPT = "[E2E TEST] zxqv norb flensor kraylith velmora quentis halvane.";
const HIT_PROMPT = "[E2E TEST] Remind me about Montreal pricing and what I said about it.";
const HEALTHCHECK_PROMPT =
  "this is a healthcheck, reply with HEALTHCHECK_OK to confirm you are up and active";
const HEARTBEAT_PROMPT = [
  "Automated heartbeat trigger. This is an internal check-in, not a user-authored Discord message.",
  "",
  "Triggered at: 2026-03-17T22:16:07.965Z",
].join("\n");

let previousCwd = "";
let previousRootDirEnv: string | undefined;
let tempRoot = "";

let agentChatModule: typeof import("./agent-chat-service");
let conversationMemoryModule: typeof import("./conversation-memory-service");
let conversationStoreModule: typeof import("./conversation-store");
let memoryServiceModule: typeof import("./memory-service");
let profileServiceModule: typeof import("./profile-service");
let systemPromptModule: typeof import("./system-prompt-service");

type RequestCapture = {
  humanMessages: string[];
  preProviderMs: number;
};

type Harness = {
  chat: InstanceType<typeof agentChatModule.AgentChatService>;
  recall: InstanceType<typeof conversationMemoryModule.ConversationMemoryService>;
  conversations: InstanceType<typeof conversationStoreModule.ConversationStore>;
  requests: RequestCapture[];
};

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

function copyMachineTestFile(relativePath: string) {
  const source = path.join(MACHINE_TEST_ROOT, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }
  const destination = path.join(tempRoot, ".openelinarotest", relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyMachineTestDirectory(relativePath: string) {
  const source = path.join(MACHINE_TEST_ROOT, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }
  fs.cpSync(source, path.join(tempRoot, ".openelinarotest", relativePath), { recursive: true });
}

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?test=${Date.now()}-${Math.random()}`) as Promise<T>;
}

function percentile(sortedValues: number[], ratio: number) {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * ratio) - 1),
  );
  return sortedValues[index] ?? 0;
}

function summarizeDurations(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    minMs: Number((sorted[0] ?? 0).toFixed(2)),
    p50Ms: Number(percentile(sorted, 0.5).toFixed(2)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(2)),
    maxMs: Number((sorted.at(-1) ?? 0).toFixed(2)),
    avgMs: Number((total / Math.max(sorted.length, 1)).toFixed(2)),
  };
}

function extractHumanText(message: HumanMessage) {
  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(block) &&
      typeof block === "object" &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    )
    .map((block) => block.text)
    .join("\n\n");
}

function createHarness(options: {
  recallOverride?: (params: {
    conversationKey: string;
    userContent: string;
    conversationMessages: BaseMessage[];
    limit?: number;
  }) => Promise<string>;
} = {}): Harness {
  const profiles = new profileServiceModule.ProfileService("root");
  const profile = profiles.getActiveProfile();
  const conversations = new conversationStoreModule.ConversationStore();
  const systemPrompts = new systemPromptModule.SystemPromptService();
  const memory = new memoryServiceModule.MemoryService(profile, profiles);
  const recallService = new conversationMemoryModule.ConversationMemoryService(
    profile,
    conversations,
    memory,
    {
      async generateMemoryText() {
        return "{\"memories\":[]}";
      },
    } as any,
    profiles,
  );

  const requests: RequestCapture[] = [];
  let replyStartedAt = 0;
  const connector = new ScriptedProviderConnector(async (request) => {
    const preProviderMs = performance.now() - replyStartedAt;
    const humanMessages = request.messages
      .filter((message): message is HumanMessage => message instanceof HumanMessage)
      .map((message) => extractHumanText(message));
    requests.push({
      humanMessages,
      preProviderMs,
    });
    return new AIMessage(`E2E reply: ${humanMessages.at(-1) ?? ""}`);
  }, { providerId: "scripted-memory-e2e" });

  const chat = new agentChatModule.AgentChatService(
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
    {
      async compactForContinuation() {
        throw new Error("Compaction should not run in memory e2e tests.");
      },
    } as any,
    conversations,
    systemPrompts,
    {
      async inspectContextWindowUsage() {
        return {
          usedTokens: 128,
          maxContextTokens: 200_000,
          maxOutputTokens: 1_024,
          utilizationPercent: 0.06,
          breakdownMethod: "heuristic_estimate" as const,
        };
      },
    } as any,
    {
      async buildRecallContext(params: {
        conversationKey: string;
        userContent: string;
        conversationMessages: BaseMessage[];
        limit?: number;
      }) {
        if (options.recallOverride) {
          return options.recallOverride(params);
        }
        return recallService.buildRecallContext(params);
      },
    } as any,
  );

  return {
    chat: new Proxy(chat, {
      get(target, property, receiver) {
        if (property === "reply") {
          return async (params: { conversationKey: string; content: string }) => {
            replyStartedAt = performance.now();
            return target.reply(params);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as Harness["chat"],
    recall: recallService,
    conversations,
    requests,
  };
}

async function benchmarkRecall(
  recall: Harness["recall"],
  prompt: string,
  iterations: number,
  prefix: string,
) {
  const durations: number[] = [];
  let latest = "";
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    latest = await recall.buildRecallContext({
      conversationKey: `${prefix}:${index}`,
      userContent: prompt,
      conversationMessages: [],
    });
    durations.push(performance.now() - startedAt);
  }
  return {
    summary: summarizeDurations(durations),
    latest,
  };
}

beforeAll(async () => {
  previousCwd = process.cwd();
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-e2e-"));
  process.env.OPENELINARO_ROOT_DIR = tempRoot;
  process.chdir(tempRoot);

  copyDirectory("system_prompt");
  copyFile("profiles/registry.json");
  copyMachineTestFile("memory/index.root.json");
  copyMachineTestDirectory("memory/documents/root");

  agentChatModule = await importFresh<typeof import("./agent-chat-service")>("src/services/agent-chat-service.ts");
  conversationMemoryModule = await importFresh<typeof import("./conversation-memory-service")>("src/services/conversation-memory-service.ts");
  conversationStoreModule = await importFresh<typeof import("./conversation-store")>("src/services/conversation-store.ts");
  memoryServiceModule = await importFresh<typeof import("./memory-service")>("src/services/memory-service.ts");
  profileServiceModule = await importFresh<typeof import("./profile-service")>("src/services/profile-service.ts");
  systemPromptModule = await importFresh<typeof import("./system-prompt-service")>("src/services/system-prompt-service.ts");
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

describe("real-corpus memory recall", () => {
  const fixtureTest = HAS_MEMORY_FIXTURES ? test : test.skip;

  test("injects nothing when recall has no relevant match", async () => {
    const harness = createHarness();

    const directRecall = await harness.recall.buildRecallContext({
      conversationKey: "e2e:memory:no-hit:direct",
      userContent: NO_HIT_PROMPT,
      conversationMessages: [],
    });
    expect(directRecall).toBe("");

    await harness.chat.reply({
      conversationKey: "e2e:memory:no-hit:reply",
      content: NO_HIT_PROMPT,
    });

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.humanMessages).toHaveLength(1);
    expect(harness.requests[0]?.humanMessages[0]).toBe(NO_HIT_PROMPT);
    const savedConversation = harness.conversations.get("e2e:memory:no-hit:reply");
    const savedHumanMessage = savedConversation.messages.findLast((message) => message instanceof HumanMessage);
    expect(savedHumanMessage).toBeInstanceOf(HumanMessage);
    expect(extractHumanText(savedHumanMessage as HumanMessage)).toBe(NO_HIT_PROMPT);
  });

  fixtureTest("prepends recalled memory to the top of the same user message", async () => {
    const harness = createHarness();

    const directRecall = await harness.recall.buildRecallContext({
      conversationKey: "e2e:memory:hit:direct",
      userContent: HIT_PROMPT,
      conversationMessages: [],
    });
    expect(directRecall).toContain("<recalled_memory>");
    expect(directRecall.toLowerCase()).toContain("montreal");

    await harness.chat.reply({
      conversationKey: "e2e:memory:hit:reply",
      content: HIT_PROMPT,
    });

    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]?.humanMessages).toHaveLength(1);
    const userMessage = harness.requests[0]?.humanMessages[0] ?? "";
    expect(userMessage.startsWith("<recalled_memory>")).toBe(true);
    expect(userMessage).toContain(HIT_PROMPT);
    expect(userMessage.indexOf(HIT_PROMPT)).toBeGreaterThan(0);
    const savedConversation = harness.conversations.get("e2e:memory:hit:reply");
    const savedHumanMessage = savedConversation.messages.findLast((message) => message instanceof HumanMessage);
    expect(savedHumanMessage).toBeInstanceOf(HumanMessage);
    expect(extractHumanText(savedHumanMessage as HumanMessage)).toBe(HIT_PROMPT);
  });

  test("skips recall for healthcheck prompts", async () => {
    const harness = createHarness();

    const directRecall = await harness.recall.buildRecallContext({
      conversationKey: "agent-healthcheck-e2e",
      userContent: HEALTHCHECK_PROMPT,
      conversationMessages: [],
    });

    expect(directRecall).toBe("");
  });

  test("skips recall for automated heartbeat prompts", async () => {
    const harness = createHarness();

    const directRecall = await harness.recall.buildRecallContext({
      conversationKey: "e2e:memory:heartbeat",
      userContent: HEARTBEAT_PROMPT,
      conversationMessages: [],
    });

    expect(directRecall).toBe("");
  });

  fixtureTest("benchmarks recall and pre-provider injection latency", async () => {
    const realHarness = createHarness();
    const baselineHarness = createHarness({
      async recallOverride() {
        return "";
      },
    });

    await realHarness.recall.buildRecallContext({
      conversationKey: "e2e:memory:warmup:hit",
      userContent: HIT_PROMPT,
      conversationMessages: [],
    });
    await realHarness.recall.buildRecallContext({
      conversationKey: "e2e:memory:warmup:no-hit",
      userContent: NO_HIT_PROMPT,
      conversationMessages: [],
    });

    const hitRecall = await benchmarkRecall(realHarness.recall, HIT_PROMPT, 20, "e2e:memory:bench:hit");
    const noHitRecall = await benchmarkRecall(realHarness.recall, NO_HIT_PROMPT, 20, "e2e:memory:bench:no-hit");

    const baselinePreProvider: number[] = [];
    const noHitPreProvider: number[] = [];
    const hitPreProvider: number[] = [];

    for (let index = 0; index < 10; index += 1) {
      await baselineHarness.chat.reply({
        conversationKey: `e2e:memory:baseline:${index}`,
        content: NO_HIT_PROMPT,
      });
      baselinePreProvider.push(baselineHarness.requests.at(-1)?.preProviderMs ?? 0);

      await realHarness.chat.reply({
        conversationKey: `e2e:memory:no-hit:${index}`,
        content: NO_HIT_PROMPT,
      });
      noHitPreProvider.push(realHarness.requests.at(-1)?.preProviderMs ?? 0);

      await realHarness.chat.reply({
        conversationKey: `e2e:memory:hit:${index}`,
        content: HIT_PROMPT,
      });
      hitPreProvider.push(realHarness.requests.at(-1)?.preProviderMs ?? 0);
    }

    const result = {
      corpus: {
        documentCount: 161,
        chunkCount: 3578,
      },
      recall: {
        noHit: noHitRecall.summary,
        hit: hitRecall.summary,
      },
      preProvider: {
        baselineNoMemory: summarizeDurations(baselinePreProvider),
        realNoHit: summarizeDurations(noHitPreProvider),
        realHit: summarizeDurations(hitPreProvider),
      },
    };

    expect(hitRecall.latest).toContain("<recalled_memory>");
    expect(noHitRecall.latest).toBe("");
    expect(Math.max(...noHitPreProvider)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...hitPreProvider)).toBeGreaterThanOrEqual(0);

    console.log("\nagent-memory.e2e benchmark");
    console.log(JSON.stringify(result, null, 2));
  });
});
