import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Message, ToolResultMessage } from "../messages/types";
import { isToolResultMessage } from "../messages/types";

import { getTestFixturesDir } from "../test/fixtures";

const repoRoot = process.cwd();
const TEST_ROOT_NAME = ".openelinarotest";
const MACHINE_TEST_ROOT = getTestFixturesDir();

let previousRootDirEnv: string | undefined;
let tempRoot = "";

let runtimeModule: typeof import("./runtime");
let authStoreModule: typeof import("../auth/store");
let conversationStoreModule: typeof import("../services/conversation/conversation-store");

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?runner=${Date.now()}-${Math.random()}`) as Promise<T>;
}

function copyDirectory(relativePath: string) {
  const source = path.join(repoRoot, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }
  fs.cpSync(source, path.join(tempRoot, relativePath), { recursive: true });
}

function copyMachineTestDirectory(relativePath: string) {
  const source = path.join(MACHINE_TEST_ROOT, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }
  fs.cpSync(source, path.join(tempRoot, TEST_ROOT_NAME, relativePath), { recursive: true });
}

function copyFile(relativePath: string) {
  const source = path.join(MACHINE_TEST_ROOT, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }
  const destination = path.join(tempRoot, TEST_ROOT_NAME, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function resolveTestPath(...segments: string[]) {
  return path.join(tempRoot, TEST_ROOT_NAME, ...segments);
}

function writeProfileRegistry(providerId: "openai-codex" | "claude") {
  const defaultModelId = providerId === "openai-codex"
    ? "gpt-5.4"
    : "claude-opus-4-6-20260301";
  const toolSummarizerModelId = providerId === "openai-codex"
    ? "gpt-5.4"
    : "claude-haiku-4-5";
  fs.mkdirSync(resolveTestPath("profiles"), { recursive: true });
  fs.writeFileSync(
    resolveTestPath("profiles", "registry.json"),
    `${JSON.stringify({
      version: 1,
      profiles: [
        {
          id: "root",
          name: "Root",
          roles: ["root"],
          memoryNamespace: "root",
          preferredProvider: providerId,
          defaultModelId,
          toolSummarizerProvider: providerId,
          toolSummarizerModelId,
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
}

function writeProjectRegistry() {
  fs.mkdirSync(resolveTestPath("projects"), { recursive: true });
  fs.writeFileSync(
    resolveTestPath("projects", "registry.json"),
    `${JSON.stringify({ version: 1, projects: [] }, null, 2)}\n`,
    "utf8",
  );
}

function writeWorkspaceFixture() {
  fs.mkdirSync(resolveTestPath("memory", "root"), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, "README.md"), "# live model e2e workspace\n", "utf8");
  fs.writeFileSync(
    path.join(tempRoot, "package.json"),
    `${JSON.stringify({ name: "openelinaro-live-model-e2e", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
}

function readUsageLedger() {
  const ledgerPath = resolveTestPath("model-usage.jsonl");
  if (!fs.existsSync(ledgerPath)) {
    return [] as Array<Record<string, unknown>>;
  }
  return fs.readFileSync(ledgerPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function getToolResultMessageText(message: ToolResultMessage) {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

async function main() {
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-live-model-e2e-"));
  process.env.OPENELINARO_ROOT_DIR = tempRoot;

  copyDirectory("system_prompt");
  copyMachineTestDirectory("system_prompt");
  copyMachineTestDirectory("assistant_context");
  copyFile("auth-store.json");
  writeProjectRegistry();
  writeWorkspaceFixture();

  authStoreModule = await importFresh("src/auth/store.ts");
  const providerId = authStoreModule.hasProviderAuth("openai-codex", "root")
    ? "openai-codex"
    : authStoreModule.hasProviderAuth("claude", "root")
      ? "claude"
      : null;
  if (!providerId) {
    throw new Error(
      `No root provider auth is configured in ${path.join(MACHINE_TEST_ROOT, "auth-store.json")}. Configure root auth before running the live model e2e test.`,
    );
  }

  writeProfileRegistry(providerId);
  runtimeModule = await importFresh("src/app/runtime.ts");
  conversationStoreModule = await importFresh("src/services/conversation/conversation-store.ts");

  const app = new runtimeModule.OpenElinaroApp({ profileId: "root" });

  const conversationKey = `e2e:tool-result-ref:${Date.now()}`;
  const toolUseEvents: string[] = [];

  const response = await app.handleRequest(
    {
      id: `e2e:tool-result-ref:${Date.now()}`,
      kind: "chat",
      conversationKey,
      text: [
        "This is a live integration test for stored tool-result refs.",
        "Use exec_command exactly once.",
        "Run this exact command: for i in {1..80}; do echo noise-$i; done; echo FINAL_FLAG=raspberry",
        "The exec_command result should come back as a tool_result_ref because it is large.",
        "Then call tool_result_read on that ref with mode=summary and goal=\"Return only the value after FINAL_FLAG=.\"",
        "Reply with the extracted value only, or a very short sentence containing it.",
      ].join("\n"),
    },
    {
      onToolUse: async (event) => {
        toolUseEvents.push(typeof event === "string" ? event : event.message);
      },
    },
  );

  assert.match(response.message.toLowerCase(), /raspberry/);
  assert.doesNotMatch(response.message, /noise-1/);
  assert(toolUseEvents.some((entry) => entry.includes("exec_command")));
  assert(toolUseEvents.some((entry) => entry.includes("tool_result_read")));

  const store = new conversationStoreModule.ConversationStore();
  await waitFor(async () => {
    const conversation = await store.get(conversationKey);
    return conversation.messages.some((message: Message) => isToolResultMessage(message) && message.toolName === "tool_result_read");
  });
  const conversation = await store.get(conversationKey);
  const execToolMessage = [...conversation.messages]
    .reverse()
    .find((message): message is ToolResultMessage => isToolResultMessage(message) && message.toolName === "exec_command");
  const readToolMessage = [...conversation.messages]
    .reverse()
    .find((message): message is ToolResultMessage => isToolResultMessage(message) && message.toolName === "tool_result_read");

  assert(execToolMessage);
  assert(readToolMessage);
  const execToolText = getToolResultMessageText(execToolMessage);
  const readToolText = getToolResultMessageText(readToolMessage);
  assert.match(execToolText, /\[tool_result_ref\b/);
  assert.doesNotMatch(execToolText, /noise-1/);
  assert.match(readToolText.toLowerCase(), /raspberry/);
  assert.doesNotMatch(readToolText, /noise-1/);

  const ledger = readUsageLedger();
  assert(ledger.some((entry) => entry.purpose === "tool_result_summarization"));

  console.log("LIVE_MODEL_E2E_OK");
}

main()
  .then(() => {
    if (previousRootDirEnv === undefined) {
      delete process.env.OPENELINARO_ROOT_DIR;
    } else {
      process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
    }
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    if (previousRootDirEnv === undefined) {
      delete process.env.OPENELINARO_ROOT_DIR;
    } else {
      process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
    }
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    process.exit(1);
  });
