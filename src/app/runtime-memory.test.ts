import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { LanguageModelV3CallOptions, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  buildScriptedConnectorRequest,
  toGenerateResultFromAIMessage,
  type ScriptedConnectorRequest,
} from "../test/scripted-provider-connector";
import { updateTestRuntimeConfig } from "../test/runtime-config-test-helpers";

const repoRoot = process.cwd();
const previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;

let previousCwd = "";
let tempRoot = "";

let runtimeModule: typeof import("./runtime");
let activeConnectorModule: typeof import("../connectors/active-model-connector");
let memoryServiceModule: typeof import("../services/memory-service");
let conversationMemoryModule: typeof import("../services/conversation-memory-service");

let originalDoGenerate: typeof activeConnectorModule.ActiveModelConnector.prototype.doGenerate;
let originalEnsureReady: typeof memoryServiceModule.MemoryService.prototype.ensureReady;
let originalBuildRecallContext: typeof conversationMemoryModule.ConversationMemoryService.prototype.buildRecallContext;

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?test=${Date.now()}-${Math.random()}`) as Promise<T>;
}

function writeRuntimeFixture() {
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
  fs.mkdirSync(path.join(tempRoot, ".openelinarotest", "projects"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, ".openelinarotest", "projects/registry.json"),
    `${JSON.stringify({ version: 1, projects: [] }, null, 2)}\n`,
    "utf8",
  );
  fs.mkdirSync(path.join(tempRoot, ".openelinarotest", "memory/documents/root"), { recursive: true });
}

function latestHumanText(request: ScriptedConnectorRequest) {
  const message = [...request.messages]
    .reverse()
    .find((entry): entry is HumanMessage => entry instanceof HumanMessage);
  if (!message) {
    return "";
  }
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

beforeAll(async () => {
  activeConnectorModule = await importFresh<typeof import("../connectors/active-model-connector")>(
    "src/connectors/active-model-connector.ts",
  );
  memoryServiceModule = await importFresh<typeof import("../services/memory-service")>(
    "src/services/memory-service.ts",
  );
  conversationMemoryModule = await importFresh<typeof import("../services/conversation-memory-service")>(
    "src/services/conversation-memory-service.ts",
  );
  runtimeModule = await importFresh<typeof import("./runtime")>("src/app/runtime.ts");

  originalDoGenerate = activeConnectorModule.ActiveModelConnector.prototype.doGenerate;
  originalEnsureReady = memoryServiceModule.MemoryService.prototype.ensureReady;
  originalBuildRecallContext = conversationMemoryModule.ConversationMemoryService.prototype.buildRecallContext;

  memoryServiceModule.MemoryService.prototype.ensureReady = async function ensureReady() {
    return {} as Awaited<ReturnType<typeof originalEnsureReady>>;
  };
  activeConnectorModule.ActiveModelConnector.prototype.doGenerate = async function doGenerate(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3GenerateResult> {
    const request = await buildScriptedConnectorRequest(options);
    return toGenerateResultFromAIMessage(
      new AIMessage(`Acknowledged: ${latestHumanText(request)}`),
      "active-model-router",
      "scripted-model",
    );
  };
});

afterAll(() => {
  activeConnectorModule.ActiveModelConnector.prototype.doGenerate = originalDoGenerate;
  memoryServiceModule.MemoryService.prototype.ensureReady = originalEnsureReady;
  conversationMemoryModule.ConversationMemoryService.prototype.buildRecallContext = originalBuildRecallContext;

  if (previousRootDirEnv === undefined) {
    delete process.env.OPENELINARO_ROOT_DIR;
  } else {
    process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
  }
});

beforeEach(() => {
  previousCwd = process.cwd();
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-runtime-memory-"));
  process.chdir(tempRoot);
  process.env.OPENELINARO_ROOT_DIR = tempRoot;
  writeRuntimeFixture();
  updateTestRuntimeConfig((config) => {
    config.core.app.automaticConversationMemoryEnabled = true;
  });
});

afterEach(() => {
  process.chdir(previousCwd);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("OpenElinaroApp automatic memory recall", () => {
  test("injects recalled memory by default", async () => {
    let recallCalls = 0;
    conversationMemoryModule.ConversationMemoryService.prototype.buildRecallContext = async function buildRecallContext() {
      recallCalls += 1;
      return "<recalled_memory>\nRemember the user's style.\n</recalled_memory>";
    };

    const app = new runtimeModule.OpenElinaroApp();
    const response = await app.handleRequest({
      id: "request-1",
      kind: "chat",
      text: "How should you answer me?",
    });

    expect(recallCalls).toBe(1);
    expect(response.message).toContain("<recalled_memory>");
    expect(response.message).toContain("How should you answer me?");
  });

  test("disables recalled memory injection when config disables it", async () => {
    let recallCalls = 0;
    updateTestRuntimeConfig((config) => {
      config.core.app.automaticConversationMemoryEnabled = false;
    });
    conversationMemoryModule.ConversationMemoryService.prototype.buildRecallContext = async function buildRecallContext() {
      recallCalls += 1;
      return "<recalled_memory>\nShould never be used.\n</recalled_memory>";
    };

    const app = new runtimeModule.OpenElinaroApp();
    const response = await app.handleRequest({
      id: "request-2",
      kind: "chat",
      text: "Keep it clean.",
    });

    expect(recallCalls).toBe(0);
    expect(response.message).toContain("Keep it clean.");
    expect(response.message).not.toContain("<recalled_memory>");
  });
});
