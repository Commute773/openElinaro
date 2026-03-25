import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { updateTestRuntimeConfig } from "../test/runtime-config-test-helpers";
import { SecretStoreService } from "../services/secret-store-service";

const repoRoot = process.cwd();

let previousCwd = "";
let previousRootDirEnv: string | undefined;
let tempRoot = "";
const transportAttempts: string[] = [];

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?test=${Date.now()}-${Math.random()}`) as Promise<T>;
}

function writeProfileRegistry() {
  fs.mkdirSync(path.join(tempRoot, ".openelinarotest", "profiles"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, ".openelinarotest", "profiles/registry.json"),
    `${JSON.stringify({
      version: 1,
      profiles: [
        {
          id: "root",
          name: "Root",
          roles: ["root"],
          memoryNamespace: "root",
          preferredProvider: "openai-codex",
          defaultModelId: "gpt-5.4",
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
}

function writeCodexAuthStore() {
  const secrets = new SecretStoreService();
  secrets.saveProviderAuth({
    provider: "openai-codex",
    type: "oauth",
    credentials: {
      access: "test-access-token",
      refresh: "test-refresh-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    updatedAt: new Date().toISOString(),
  }, "root");
}

function buildProviderResponse(overrides?: Record<string, unknown>) {
  return {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.4",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("ActiveModelConnector", () => {
  beforeAll(() => {
    previousCwd = process.cwd();
    previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-active-model-connector-"));
    process.env.OPENELINARO_ROOT_DIR = tempRoot;
    process.chdir(tempRoot);
    writeProfileRegistry();
    writeCodexAuthStore();

    mock.module("@mariozechner/pi-ai", () => ({
      getModels: () => [{
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-codex-responses",
        provider: "openai-codex",
        input: ["text"],
        reasoning: true,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: 272_000,
        maxTokens: 32_768,
      }],
      stream: (_model: unknown, _context: unknown, options: { transport?: string; sessionId?: string }) => {
        transportAttempts.push(options.transport ?? "auto");
        const callIndex = transportAttempts.length;
        const shouldFailWebsocket = options.sessionId !== "session:thinking";
        const response =
          callIndex === 1 && options.transport === "websocket" && shouldFailWebsocket
            ? buildProviderResponse({
                stopReason: "error",
                errorMessage: "WebSocket closed 1011",
              })
            : buildProviderResponse({
                content: [{ type: "text", text: "fallback ok" }],
              });
        return {
          async *[Symbol.asyncIterator]() {
            if (options.sessionId === "session:thinking") {
              yield { type: "thinking_start" };
            }
          },
          result: async () => response,
        };
      },
    }));

    mock.module("@mariozechner/pi-ai/oauth", () => ({
      getOAuthApiKey: async () => "resolved-test-api-key",
    }));
  });

  afterAll(() => {
    mock.restore();
    process.chdir(previousCwd);
    if (previousRootDirEnv === undefined) {
      delete process.env.OPENELINARO_ROOT_DIR;
    } else {
      process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
    }
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    transportAttempts.length = 0;
    writeProfileRegistry();
    writeCodexAuthStore();
  });

  test("falls back to the default transport when websocket setup fails", async () => {
    const modelModule = await importFresh<typeof import("../services/model-service")>("src/services/model-service.ts");
    const connectorModule = await importFresh<typeof import("./active-model-connector")>("src/connectors/active-model-connector.ts");

    const modelService = new modelModule.ModelService({
      id: "root",
      name: "Root",
      roles: ["root"],
      memoryNamespace: "root",
      preferredProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
    });
    const connector = new connectorModule.ActiveModelConnector(modelService);

    const result = await connector.doGenerate({
      prompt: [
        { role: "system", content: "You are a test system prompt." },
        { role: "user", content: "Say hello." },
      ],
      providerOptions: {
        openelinaro: {
          sessionId: "session:test",
          conversationKey: "conversation:test",
          usagePurpose: "chat_turn",
        },
      },
    } as never);

    expect(transportAttempts).toEqual(["websocket", "sse"]);
    expect(result.content).toEqual([{ type: "text", text: "fallback ok" }]);
  });

  test("uses the configured assistant display name in thinking callbacks", async () => {
    updateTestRuntimeConfig((config) => {
      config.core.assistant.displayName = "Llvind";
    });

    const modelModule = await importFresh<typeof import("../services/model-service")>("src/services/model-service.ts");
    const connectorModule = await importFresh<typeof import("./active-model-connector")>("src/connectors/active-model-connector.ts");

    const modelService = new modelModule.ModelService({
      id: "root",
      name: "Root",
      roles: ["root"],
      memoryNamespace: "root",
      preferredProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
    });
    const connector = new connectorModule.ActiveModelConnector(modelService);
    const messages: string[] = [];
    connector.setThinkingCallback("session:thinking", (message) => {
      messages.push(message);
    });

    await connector.doGenerate({
      prompt: [
        { role: "system", content: "You are a test system prompt." },
        { role: "user", content: "Think quietly." },
      ],
      providerOptions: {
        openelinaro: {
          sessionId: "session:thinking",
          conversationKey: "conversation:test",
          usagePurpose: "chat_turn",
        },
      },
    } as never);

    expect(messages).toEqual(["Llvind is typing..."]);
  });

  test("converts AI SDK v3 file-type image parts to pi-ai image blocks", async () => {
    const modelModule = await importFresh<typeof import("../services/model-service")>("src/services/model-service.ts");
    const connectorModule = await importFresh<typeof import("./active-model-connector")>("src/connectors/active-model-connector.ts");

    const modelService = new modelModule.ModelService({
      id: "root",
      name: "Root",
      roles: ["root"],
      memoryNamespace: "root",
      preferredProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
    });
    const connector = new connectorModule.ActiveModelConnector(modelService);

    // Capture messages sent to the mock stream
    let capturedMessages: Array<{ role: string; content: unknown }> = [];
    const piAi = await import("@mariozechner/pi-ai");
    const originalStream = piAi.stream;
    mock.module("@mariozechner/pi-ai", () => ({
      ...piAi,
      getModels: piAi.getModels,
      stream: (model: unknown, context: { messages?: Array<{ role: string; content: unknown }> }, options: { transport?: string }) => {
        capturedMessages = context.messages ?? [];
        transportAttempts.push(options.transport ?? "auto");
        return {
          async *[Symbol.asyncIterator]() {},
          result: async () => buildProviderResponse({ content: [{ type: "text", text: "saw image" }] }),
        };
      },
    }));

    await connector.doGenerate({
      prompt: [
        { role: "system", content: "Test." },
        {
          role: "user",
          content: [
            { type: "text", text: "Here is an image." },
            // AI SDK v3 converts image parts to file parts:
            { type: "file", data: "iVBORw0KGgo=", mediaType: "image/png", filename: undefined },
          ],
        },
      ],
      providerOptions: {
        openelinaro: {
          sessionId: "session:image-file",
          conversationKey: "conversation:image-file",
          usagePurpose: "chat_turn",
        },
      },
    } as never);

    const userMessage = capturedMessages.find((m) => m.role === "user");
    expect(userMessage).toBeDefined();
    const blocks = userMessage!.content as Array<{ type: string; data?: string; mimeType?: string }>;
    const imageBlock = blocks.find((b) => b.type === "image");
    expect(imageBlock).toBeDefined();
    expect(imageBlock!.data).toBe("iVBORw0KGgo=");
    expect(imageBlock!.mimeType).toBe("image/png");
  });

  test("records prompt diagnostics in the usage ledger", async () => {
    const modelModule = await importFresh<typeof import("../services/model-service")>("src/services/model-service.ts");
    const connectorModule = await importFresh<typeof import("./active-model-connector")>("src/connectors/active-model-connector.ts");

    const modelService = new modelModule.ModelService({
      id: "root",
      name: "Root",
      roles: ["root"],
      memoryNamespace: "root",
      preferredProvider: "openai-codex",
      defaultModelId: "gpt-5.4",
    });
    const connector = new connectorModule.ActiveModelConnector(modelService);

    await connector.doGenerate({
      prompt: [
        { role: "system", content: "You are a test system prompt." },
        { role: "user", content: "Use the tool if needed." },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "demo_tool",
              input: "{\"query\":\"hello\"}",
            },
          ],
        },
        {
          role: "tool",
          content: [{
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "demo_tool",
            output: {
              type: "text",
              value: "tool output",
            },
          }],
        },
      ],
      tools: [{
        type: "function",
        name: "demo_tool",
        description: "Demo tool.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          required: ["query"],
        },
      }],
      providerOptions: {
        openelinaro: {
          sessionId: "session:diagnostics",
          conversationKey: "conversation:diagnostics",
          usagePurpose: "chat_turn",
        },
      },
    } as never);

    const ledgerPath = path.join(tempRoot, ".openelinarotest", "model-usage.jsonl");
    const records = fs.readFileSync(ledgerPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => (
        JSON.parse(line) as {
          conversationKey?: string;
          promptDiagnostics?: {
            toolCount: number;
            toolNames: string[];
            promptMessageCount: number;
            promptMessagesByRole: {
              user: number;
              assistant: number;
              tool: number;
            };
            approximateBreakdown: {
              toolDefinitionTokens: number;
              toolCallInputTokens: number;
              toolResponseTokens: number;
            };
            topContributors: Array<{
              kind: string;
              toolName?: string;
            }>;
            providerInputTokens?: number;
            approximationDeltaTokens?: number;
          };
        }
      ));
    const record = records.find((entry) => entry.conversationKey === "conversation:diagnostics");

    expect(record?.promptDiagnostics).toBeDefined();
    expect(record?.promptDiagnostics).toMatchObject({
      toolCount: 1,
      toolNames: ["demo_tool"],
      promptMessageCount: 3,
      promptMessagesByRole: {
        user: 1,
        assistant: 1,
        tool: 1,
      },
      providerInputTokens: 0,
    });
    expect(record?.promptDiagnostics?.approximateBreakdown.toolDefinitionTokens).toBeGreaterThan(0);
    expect(record?.promptDiagnostics?.approximateBreakdown.toolCallInputTokens).toBeGreaterThan(0);
    expect(record?.promptDiagnostics?.approximateBreakdown.toolResponseTokens).toBeGreaterThan(0);
    expect(record?.promptDiagnostics?.topContributors).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tool_definition", toolName: "demo_tool" }),
      expect.objectContaining({ kind: "message", toolName: "demo_tool" }),
    ]));
    expect(typeof record?.promptDiagnostics?.approximationDeltaTokens).toBe("number");
  });
});
