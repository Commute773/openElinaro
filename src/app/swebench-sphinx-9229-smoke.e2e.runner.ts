import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { Message, UserMessage, ToolResultMessage, AssistantMessage } from "../messages/types";
import {
  isUserMessage,
  isToolResultMessage,
  isAssistantMessage,
  assistantTextMessage,
  extractAssistantText,
} from "../messages/types";

import { getTestFixturesDir } from "../test/fixtures";

const repoRoot = process.cwd();
const TEST_ROOT_NAME = ".openelinarotest";
const MACHINE_TEST_ROOT = getTestFixturesDir();
const TURN_LIMIT = Number.parseInt(process.env.OPENELINARO_SWEBENCH_TURN_LIMIT ?? "5", 10);
const RUN_TIMEOUT_MS = Number.parseInt(process.env.OPENELINARO_SWEBENCH_TIMEOUT_MS ?? "180000", 10);
const WAIT_TIMEOUT_MS = Number.parseInt(
  process.env.OPENELINARO_SWEBENCH_WAIT_TIMEOUT_MS ?? String(Math.max(RUN_TIMEOUT_MS + 60_000, 240_000)),
  10,
);
const ARTIFACT_ROOT = path.join(os.tmpdir(), "openelinaro-benchmarks", "swebench", "sphinx-9229-smoke");
const STREAM_OUTPUT = process.env.OPENELINARO_SWEBENCH_STREAM !== "0";

let previousRootDirEnv: string | undefined;
let tempRoot = "";

let runtimeModule: typeof import("./runtime");
let authStoreModule: typeof import("../auth/store");

type TurnRecord = {
  index: number;
  sessionId?: string;
  usagePurpose?: string;
  availableTools: string[];
  latestHumanText: string;
  latestToolName?: string;
  systemPromptPreview: string;
  finishReason?: string;
  responseToolNames?: string[];
  responseToolCallPreviews?: string[];
  responseTextPreview?: string;
  syntheticStop?: boolean;
};

type WorkflowSessionStoreSnapshot = {
  sessions?: Record<string, {
    progressLog?: unknown[];
    messages?: unknown[];
  }>;
};

type LiveStreamState = {
  eventLogCount: number;
  sessionProgressCounts: Map<string, number>;
  sessionMessageCounts: Map<string, number>;
  lastRunStatus?: string;
};

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?runner=${Date.now()}-${Math.random()}`) as Promise<T>;
}

function resolveTestPath(...segments: string[]) {
  return path.join(tempRoot, TEST_ROOT_NAME, ...segments);
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
  fs.cpSync(source, resolveTestPath(relativePath), { recursive: true });
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function readJsonIfExists<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function readJsonLinesIfExists(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function preview(text: string, limit = 220) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function latestHumanText(messages: readonly Message[]) {
  const human = [...messages]
    .reverse()
    .find((message): message is UserMessage => isUserMessage(message));
  if (!human) {
    return "";
  }
  return typeof human.content === "string" ? human.content : JSON.stringify(human.content);
}

function latestToolName(messages: readonly Message[]) {
  const tool = [...messages]
    .reverse()
    .find((message): message is ToolResultMessage => isToolResultMessage(message));
  return tool?.toolName;
}

function extractToolNamesFromResult(message: AssistantMessage) {
  return message.content
    .filter((block): block is import("../messages/types").ToolCall => block.type === "toolCall")
    .map((block) => block.name);
}

function extractTextFromResult(message: AssistantMessage) {
  return message.content
    .filter((block): block is import("../messages/types").TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function extractToolCallPreviewsFromResult(message: AssistantMessage) {
  return message.content
    .filter((block): block is import("../messages/types").ToolCall => block.type === "toolCall")
    .map((block) => {
      const rawInput = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {});
      return `${block.name}(${preview(rawInput, 180)})`;
    });
}

function normalizeStopReason(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

function ensureArtifactRoot() {
  fs.mkdirSync(ARTIFACT_ROOT, { recursive: true });
}

function streamLine(message: string) {
  if (!STREAM_OUTPUT) {
    return;
  }
  console.log(message);
}

function streamTurn(record: TurnRecord) {
  const lane = record.usagePurpose ?? record.sessionId ?? "unknown-session";
  const finish = record.finishReason ?? "unknown";
  const toolNames = record.responseToolNames?.length ? record.responseToolNames.join(",") : "(none)";
  const prefix = record.syntheticStop ? "[smoke][synthetic-turn]" : "[smoke][turn]";
  streamLine(`${prefix} ${record.index} lane=${lane} finish=${finish} tools=${toolNames}`);
  for (const toolPreview of record.responseToolCallPreviews ?? []) {
    streamLine(`[smoke][turn ${record.index}] call ${toolPreview}`);
  }
  if (record.responseTextPreview) {
    streamLine(`[smoke][turn ${record.index}] text ${record.responseTextPreview}`);
  }
}

function formatStoredToolContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  if (content && typeof content === "object") {
    return JSON.stringify(content);
  }
  return String(content ?? "");
}

function extractStoredToolResult(message: unknown) {
  if (!message || typeof message !== "object") {
    return null;
  }
  const stored = message as {
    type?: unknown;
    data?: {
      name?: unknown;
      status?: unknown;
      content?: unknown;
    };
  };
  if (stored.type !== "tool") {
    return null;
  }
  return {
    name: typeof stored.data?.name === "string" ? stored.data.name : "unknown_tool",
    status: typeof stored.data?.status === "string" ? stored.data.status : "unknown",
    content: formatStoredToolContent(stored.data?.content),
  };
}

function streamNewWorkflowOutput(
  state: LiveStreamState,
  run: {
    status: string;
    eventLog: Array<{ kind: string; timestamp: string; summary?: string }>;
  } | undefined,
  sessionStorePath: string,
) {
  if (run && run.status !== state.lastRunStatus) {
    streamLine(`[smoke][run] status=${run.status}`);
    state.lastRunStatus = run.status;
  }

  if (run) {
    const newEventLog = run.eventLog.slice(state.eventLogCount);
    for (const entry of newEventLog) {
      streamLine(`[smoke][run] ${entry.kind}${entry.summary ? `: ${entry.summary}` : ""}`);
    }
    state.eventLogCount = run.eventLog.length;
  }

  const sessions = readJsonIfExists<WorkflowSessionStoreSnapshot>(sessionStorePath)?.sessions ?? {};
  for (const [sessionKey, session] of Object.entries(sessions)) {
    const progressLog = Array.isArray(session?.progressLog)
      ? session.progressLog.filter((value): value is string => typeof value === "string")
      : [];
    const seenCount = state.sessionProgressCounts.get(sessionKey) ?? 0;
    for (const entry of progressLog.slice(seenCount)) {
      streamLine(`[smoke][session ${sessionKey}] ${entry}`);
    }
    state.sessionProgressCounts.set(sessionKey, progressLog.length);

    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const seenMessageCount = state.sessionMessageCounts.get(sessionKey) ?? 0;
    for (const message of messages.slice(seenMessageCount)) {
      const toolResult = extractStoredToolResult(message);
      if (!toolResult) {
        continue;
      }
      streamLine(
        `[smoke][tool-result ${sessionKey}] ${toolResult.name} status=${toolResult.status} ${preview(toolResult.content, 500)}`,
      );
    }
    state.sessionMessageCounts.set(sessionKey, messages.length);
  }
}

function writeArtifact(artifact: Record<string, unknown>) {
  ensureArtifactRoot();
  const artifactPath = path.join(ARTIFACT_ROOT, `${timestampSlug()}.json`);
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifactPath;
}

function writeAuthStoreForSmokeProfile() {
  const sourcePath = path.join(MACHINE_TEST_ROOT, "auth-store.json");
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing ${sourcePath}.`);
  }

  const parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as {
    version?: number;
    profiles?: Record<string, { providers?: Record<string, unknown> }>;
  };
  const rootProviders = parsed.profiles?.root?.providers;
  if (!rootProviders?.["openai-codex"]) {
    throw new Error("Root openai-codex auth is required for the Sphinx 9229 smoke runner.");
  }

  const destination = resolveTestPath("auth-store.json");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(
    destination,
    `${JSON.stringify({
      version: 2,
      profiles: {
        root: { providers: rootProviders },
        "swebench-smoke": { providers: rootProviders },
      },
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function writeProfileRegistry(workspaceRoot: string) {
  const shellUser = process.env.USER?.trim() || process.env.LOGNAME?.trim() || "codex";
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
          preferredProvider: "openai-codex",
          defaultModelId: "gpt-5.4",
          toolSummarizerProvider: "openai-codex",
          toolSummarizerModelId: "gpt-5.4",
          subagentPreferredProvider: "openai-codex",
          subagentDefaultModelId: "gpt-5.4",
          maxSubagentDepth: 1,
        },
        {
          id: "swebench-smoke",
          name: "SWE-bench Smoke",
          roles: ["swebench-smoke"],
          memoryNamespace: "swebench-smoke",
          pathRoots: [workspaceRoot],
          shellUser,
          preferredProvider: "openai-codex",
          defaultModelId: "gpt-5.4",
          maxSubagentDepth: 0,
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

function writeWorkspaceFixture(workspaceRoot: string) {
  fs.mkdirSync(resolveTestPath("memory", "documents", "root"), { recursive: true });
  fs.mkdirSync(resolveTestPath("memory", "documents", "swebench-smoke"), { recursive: true });

  fs.mkdirSync(path.join(workspaceRoot, "sphinx", "ext", "autodoc"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "tests", "roots", "test-ext-autodoc", "target"), { recursive: true });

  fs.writeFileSync(
    path.join(workspaceRoot, "README.md"),
    [
      "# Reduced Sphinx 9229 smoke fixture",
      "",
      "This workspace is an isolated reproduction for a live subagent smoke test.",
      "It only contains the files needed to orient the agent around the alias-doccomment bug.",
      "",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(workspaceRoot, "TASK.md"),
    [
      "# SWE-bench task: sphinx-doc__sphinx-9229",
      "",
      "Bug summary:",
      "- autodoc class aliases sometimes render the generic `alias of ...` fallback even when the alias has an explicit variable comment.",
      "- The expected behavior is that the variable comment wins for alias classes.",
      "",
      "Relevant files in this reduced fixture:",
      "- `sphinx/ext/autodoc/__init__.py` contains the buggy alias-doc handling path.",
      "- `tests/roots/test-ext-autodoc/target/classes.py` defines alias classes with and without a variable comment.",
      "- `tests/test_ext_autodoc_autoclass.py` shows the expected rendered output.",
      "",
      "Gold-patch shape from upstream Sphinx:",
      "- `get_doc()` should suppress the fallback alias text when a variable comment exists.",
      "- `add_content()` should only insert the generic alias text when no variable comment exists.",
      "",
      "Smoke-test instruction:",
      "- Start solving the task normally, but focus on inspection and identifying the first concrete edit.",
      "- The harness will stop the run after a small number of model turns so we can inspect workflow logs before a full run.",
      "",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(workspaceRoot, "sphinx", "ext", "autodoc", "__init__.py"),
    [
      "from __future__ import annotations",
      "",
      "from typing import List, Optional",
      "",
      "",
      "class FakeAnalyzer:",
      "    def __init__(self, attr_docs: dict[tuple[str, str], list[str]]):",
      "        self.attr_docs = attr_docs",
      "",
      "",
      "class ClassDocumenter:",
      "    def __init__(self, objpath: list[str], doc_as_attr: bool, analyzer: FakeAnalyzer):",
      "        self.objpath = objpath",
      "        self.doc_as_attr = doc_as_attr",
      "        self.analyzer = analyzer",
      "        self.object = '.'.join(objpath)",
      "",
      "    def get_doc(self, ignore: int | None = None) -> Optional[List[List[str]]]:",
      "        if self.doc_as_attr:",
      "            # Buggy behavior: alias classes return early even when a variable comment exists.",
      "            return None",
      "        return [['class docstring']]",
      "",
      "    def get_variable_comment(self) -> Optional[List[str]]:",
      "        key = ('', '.'.join(self.objpath))",
      "        return list(self.analyzer.attr_docs.get(key, [])) or None",
      "",
      "    def add_content(self) -> list[str]:",
      "        if self.doc_as_attr:",
      "            return [f'alias of {self.object}']",
      "        return ['class docstring']",
      "",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(workspaceRoot, "tests", "roots", "test-ext-autodoc", "target", "classes.py"),
    [
      "class Foo:",
      "    pass",
      "",
      "",
      "class Bar:",
      "    pass",
      "",
      "",
      "Alias = Foo",
      "#: docstring",
      "OtherAlias = Bar",
      "",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(workspaceRoot, "tests", "test_ext_autodoc_autoclass.py"),
    [
      "def test_class_alias_without_doccomment_uses_alias_fallback():",
      "    actual = [",
      "        '',",
      "        '.. py:attribute:: Alias',",
      "        ' :module: target.classes',",
      "        '',",
      "        ' alias of :class:`target.classes.Foo`',",
      "        '',",
      "    ]",
      "    assert actual[-2] == ' alias of :class:`target.classes.Foo`'",
      "",
      "",
      "def test_class_alias_having_doccomment_uses_comment_instead_of_alias_fallback():",
      "    actual = [",
      "        '',",
      "        '.. py:attribute:: OtherAlias',",
      "        ' :module: target.classes',",
      "        '',",
      "        ' docstring',",
      "        '',",
      "    ]",
      "    assert actual[-2] == ' docstring'",
      "",
    ].join("\n"),
    "utf8",
  );
}

function ensureSmokePytestEnvironment(workspaceRoot: string) {
  const venvRoot = path.join(workspaceRoot, ".venv");
  const binDir = path.join(venvRoot, "bin");
  const pythonBin = path.join(binDir, "python");
  const pytestMarker = path.join(binDir, "pytest");

  if (!fs.existsSync(pythonBin)) {
    execFileSync("python3", ["-m", "venv", venvRoot], {
      cwd: workspaceRoot,
      stdio: "pipe",
    });
  }

  if (!fs.existsSync(pytestMarker)) {
    execFileSync(pythonBin, ["-m", "pip", "install", "-q", "pytest"], {
      cwd: workspaceRoot,
      stdio: "pipe",
    });
  }

  process.env.PATH = [binDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

function buildSyntheticStopAssistantMessage(availableTools: string[]): AssistantMessage {
  const meta = { api: "openai-responses" as const, provider: "openai-codex", model: "gpt-5.4" };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

  if (availableTools.includes("complete_coding_task")) {
    return {
      role: "assistant",
      content: [
        {
          type: "toolCall" as const,
          id: "smoke-stop-task",
          name: "complete_coding_task",
          arguments: {
            status: "blocked",
            summary: `Smoke test stopped after ${TURN_LIMIT} model turns. Inspect the workflow logs before running the full task.`,
            filesTouched: [],
            commandsRun: [],
            verificationCommands: [],
            blockers: [`turn limit reached after ${TURN_LIMIT} model turns`],
          },
        },
      ],
      api: meta.api,
      provider: meta.provider,
      model: meta.model,
      usage,
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
  }

  if (availableTools.includes("report_plan")) {
    return {
      role: "assistant",
      content: [
        {
          type: "toolCall" as const,
          id: "smoke-stop-plan",
          name: "report_plan",
          arguments: {
            summary: `Smoke test stopped during planning after ${TURN_LIMIT} model turns. Continue with the reduced Sphinx 9229 task in a full run once the harness logs look healthy.`,
            tasks: [
              {
                id: "inspect-reduced-sphinx-9229",
                title: "Inspect the reduced Sphinx 9229 reproduction and identify the first edit",
                executionMode: "serial",
                dependsOn: [],
                acceptanceCriteria: [
                  "Identify why alias classes with variable comments still render the generic alias fallback.",
                  "Point to the first file that needs an edit.",
                ],
                verificationCommands: [],
              },
            ],
          },
        },
      ],
      api: meta.api,
      provider: meta.provider,
      model: meta.model,
      usage,
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
  }

  throw new Error(
    `Smoke test turn limit reached after ${TURN_LIMIT} model turns, but no workflow submission tool was available.`,
  );
}

async function main() {
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-swebench-sphinx-9229-smoke-"));
  process.env.OPENELINARO_ROOT_DIR = tempRoot;

  const workspaceRoot = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  copyDirectory("system_prompt");
  copyMachineTestDirectory("system_prompt");
  copyMachineTestDirectory("assistant_context");
  writeAuthStoreForSmokeProfile();
  writeProjectRegistry();
  writeProfileRegistry(workspaceRoot);
  writeWorkspaceFixture(workspaceRoot);
  ensureSmokePytestEnvironment(workspaceRoot);

  authStoreModule = await importFresh("src/auth/store.ts");
  assert.equal(authStoreModule.hasProviderAuth("openai-codex", "swebench-smoke"), true);

  runtimeModule = await importFresh("src/app/runtime.ts");

  // In the Pi migration, model calls go through pi-ai.complete() which is a
  // standalone function rather than a class method. The smoke runner captures
  // turn metadata through the runtime's onToolUse callback and inspects stored
  // workflow artefacts, so we no longer need to intercept every model call.
  // Turn recording below is populated from the runtime's tool-use events.
  const turnRecords: TurnRecord[] = [];
  const liveStreamState: LiveStreamState = {
    eventLogCount: 0,
    sessionProgressCounts: new Map<string, number>(),
    sessionMessageCounts: new Map<string, number>(),
  };
  let realModelTurnCount = 0;

  try {
    const app = new runtimeModule.OpenElinaroApp({ profileId: "root" });
    const launchResponse = await app.invokeRoutineTool("launch_agent", {
      profile: "swebench-smoke",
      cwd: workspaceRoot,
      timeoutMs: RUN_TIMEOUT_MS,
      goal: [
        "Solve the reduced reproduction of SWE-bench task sphinx-doc__sphinx-9229 in the current sandboxed workspace.",
        "Start by reading TASK.md and the relevant source and test files.",
        "The bug is that autodoc alias classes still render the generic alias fallback even when a variable comment exists.",
        "Work only inside this workspace and treat it as a real coding subagent run.",
      ].join(" "),
    });

    const runId = launchResponse.match(/Run id: (run-[a-z0-9-]+)/i)?.[1];
    assert.ok(runId, "Expected launch_agent to return a run id.");
    streamLine(`[smoke][launch] ${launchResponse.replace(/\n/g, " | ")}`);

    try {
      await waitFor(() => {
        const run = app.getAgentRun(runId!);
        streamNewWorkflowOutput(
          liveStreamState,
          run,
          resolveTestPath("workflow-sessions.json"),
        );
        return run?.status === "completed" || run?.status === "failed" || run?.status === "cancelled";
      }, WAIT_TIMEOUT_MS);
    } catch (error) {
      const partialArtifactPath = writeArtifact({
        createdAt: new Date().toISOString(),
        turnLimit: TURN_LIMIT,
        runTimeoutMs: RUN_TIMEOUT_MS,
        waitTimeoutMs: WAIT_TIMEOUT_MS,
        realModelTurnCount,
        launchResponse,
        workspaceRoot,
        run: app.getAgentRun(runId!),
        turnRecords,
        workflowSessions: readJsonIfExists<Record<string, unknown>>(resolveTestPath("workflow-sessions.json")),
        workflows: readJsonIfExists<Record<string, unknown>>(resolveTestPath("workflows.json")),
        modelUsage: readJsonLinesIfExists(resolveTestPath("model-usage.jsonl")),
        workflowSessionHistory: readJsonIfExists<Record<string, unknown>>(resolveTestPath("workflow-session-history.json")),
        runnerError: error instanceof Error ? error.message : String(error),
      });
      console.error(`SWEBENCH_SPHINX_9229_SMOKE_PARTIAL_ARTIFACT=${partialArtifactPath}`);
      throw error;
    }

    const run = app.getAgentRun(runId!);
    assert.ok(run, "Expected workflow run to be readable after completion.");
    streamNewWorkflowOutput(
      liveStreamState,
      run,
      resolveTestPath("workflow-sessions.json"),
    );

    const artifactPath = writeArtifact({
      createdAt: new Date().toISOString(),
      turnLimit: TURN_LIMIT,
      runTimeoutMs: RUN_TIMEOUT_MS,
      waitTimeoutMs: WAIT_TIMEOUT_MS,
      realModelTurnCount,
      launchResponse,
      workspaceRoot,
      run,
      turnRecords,
      workflowSessions: readJsonIfExists<Record<string, unknown>>(resolveTestPath("workflow-sessions.json")),
      workflows: readJsonIfExists<Record<string, unknown>>(resolveTestPath("workflows.json")),
      modelUsage: readJsonLinesIfExists(resolveTestPath("model-usage.jsonl")),
      workflowSessionHistory: readJsonIfExists<Record<string, unknown>>(resolveTestPath("workflow-session-history.json")),
    });

    console.log(`SWEBENCH_SPHINX_9229_SMOKE_ARTIFACT=${artifactPath}`);
    console.log(`SWEBENCH_SPHINX_9229_SMOKE_STATUS=${run.status}`);
    console.log(`SWEBENCH_SPHINX_9229_SMOKE_REAL_TURNS=${realModelTurnCount}`);
    console.log("SWEBENCH_SPHINX_9229_SMOKE_OK");
  } finally {
    // No connector prototype to restore in the Pi architecture
  }
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
