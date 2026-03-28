import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ChatPromptContentBlock } from "../domain/assistant";
import { ScriptedProviderConnector, type ScriptedConnectorRequest } from "../test/scripted-provider-connector";
import { updateTestRuntimeConfig } from "../test/runtime-config-test-helpers";

const repoRoot = process.cwd();

let previousCwd = "";
let tempRoot = "";
let conversationStoreModule: typeof import("./conversation-store");
let transitionServiceModule: typeof import("./conversation-state-transition-service");
let accessControlModule: typeof import("./profiles/access-control-service");
let agentChatModule: typeof import("./agent-chat-service");
let memoryServiceModule: typeof import("./memory-service");
let modelServiceModule: typeof import("./models/model-service");
let profileServiceModule: typeof import("./profiles/profile-service");
let projectsServiceModule: typeof import("./projects-service");
let routinesServiceModule: typeof import("./scheduling/routines-service");
let systemPromptModule: typeof import("./system-prompt-service");
let toolResolutionModule: typeof import("./tool-resolution-service");
let toolRegistryModule: typeof import("../tools/tool-registry");

function copyDirectory(relativePath: string) {
  const source = path.join(repoRoot, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }
  fs.cpSync(source, path.join(tempRoot, relativePath), { recursive: true });
}

function ensureStubRunner() {
  const runnerPath = path.join(tempRoot, "stub-openbrowser-runner.py");
  fs.writeFileSync(
    runnerPath,
    [
      "#!/usr/bin/env python3",
      "import json",
      "import sys",
      "from pathlib import Path",
      "",
      "for raw_line in sys.stdin:",
      "    line = raw_line.strip()",
      "    if not line:",
      "        continue",
      "    message = json.loads(line)",
      "    payload = message.get('payload', message)",
      "    artifact_dir = Path(payload['artifactDir'])",
      "    artifact_dir.mkdir(parents=True, exist_ok=True)",
      "    shot_rel = None",
      "    step_results = []",
      "    screenshots = []",
      "    for index, action in enumerate(payload.get('actions', [])):",
      "        result = {'index': index, 'type': action['type'], 'status': 'ok'}",
      "        if action['type'] == 'mouse_move':",
      "            result['detail'] = f\"moved to ({action['x']}, {action['y']})\"",
      "        elif action['type'] == 'screenshot':",
      "            shot_rel = action.get('path', 'screenshots/stub.png')",
      "            shot_path = artifact_dir / shot_rel",
      "            shot_path.parent.mkdir(parents=True, exist_ok=True)",
      "            shot_path.write_bytes(b'stub-image')",
      "            screenshots.append({'path': str(shot_path), 'format': action.get('format', 'png')})",
      "            result['path'] = str(shot_path)",
      "        step_results.append(result)",
      "    output = {",
      "        'ok': True,",
      "        'sessionId': 'stub-session',",
      "        'reusedSession': False,",
      "        'title': 'Stub Browser Page',",
      "        'finalUrl': payload.get('startUrl', 'about:blank'),",
      "        'artifactDir': str(artifact_dir),",
      "        'screenshots': screenshots,",
      "        'stepResults': step_results,",
      "    }",
      "    if isinstance(message, dict) and 'commandId' in message and 'payload' in message:",
      "        sys.stdout.write(json.dumps({'commandId': message['commandId'], 'ok': True, 'result': output}) + '\\n')",
      "        sys.stdout.flush()",
      "        continue",
      "    sys.stdout.write(json.dumps(output))",
      "    sys.stdout.flush()",
      "    break",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(runnerPath, 0o755);
  return runnerPath;
}

function writeSharedPythonFixture() {
  const binDir = path.join(tempRoot, ".openelinarotest", "python", ".venv", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "python"),
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"-c\" ]; then",
      "  printf '[]'",
      "  exit 0",
      "fi",
      "exec python3 \"$@\"",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.mkdirSync(path.join(tempRoot, "python"), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, "python", "requirements.txt"), "# test requirements\n", "utf8");
}

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?test=${Date.now()}-${Math.random()}`) as Promise<T>;
}

function lastTextContent(message: HumanMessage | ToolMessage | AIMessage) {
  if (typeof message.content === "string") {
    return message.content;
  }
  return (message.content as ChatPromptContentBlock[])
    .filter((block): block is Extract<ChatPromptContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
}

function createScriptedOpenBrowserConnector(expectedArtifactDir: string) {
  return new ScriptedProviderConnector(async (request: ScriptedConnectorRequest) => {
    const latestTool = [...request.messages]
      .reverse()
      .find((message): message is ToolMessage => message instanceof ToolMessage);

    if (!latestTool) {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "search-openbrowser",
            name: "load_tool_library",
            args: {
              library: "browser_automation",
              scope: "chat",
            },
            type: "tool_call",
          },
        ],
      });
    }

    if (latestTool.name === "load_tool_library") {
      return new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "openbrowser-run",
            name: "openbrowser",
            args: {
              startUrl: "https://example.com",
              artifactDir: expectedArtifactDir,
              actions: [
                {
                  type: "mouse_move",
                  x: 120,
                  y: 80,
                },
                {
                  type: "screenshot",
                  path: "screenshots/landing.png",
                  format: "png",
                },
              ],
            },
            type: "tool_call",
          },
        ],
      });
    }

    if (latestTool.name === "openbrowser") {
      return new AIMessage("OpenBrowser ran and produced the requested screenshot artifact.");
    }

    const latestHumanMessage = [...request.messages]
      .reverse()
      .find((message): message is HumanMessage => message instanceof HumanMessage);
    return new AIMessage(`Unhandled test state for: ${latestHumanMessage ? lastTextContent(latestHumanMessage) : "unknown"}`);
  }, { providerId: "scripted-openbrowser-test" });
}

function createWorkflowStub() {
  return {
    launchAgent: async () => ({
      id: "workflow-test-run",
      profileId: "root",
      provider: "codex" as const,
      goal: "test goal",
      status: "starting" as const,
      tmuxSession: "openelinaro",
      tmuxWindow: "workflow-test-run",
      workspaceCwd: "/tmp/test",
      createdAt: new Date().toISOString(),
      launchDepth: 1,
      timeoutMs: 300_000,
      eventLog: [],
    }),
    resumeAgent: async () => ({
      id: "workflow-test-run",
      profileId: "root",
      provider: "codex" as const,
      goal: "test goal",
      status: "running" as const,
      tmuxSession: "openelinaro",
      tmuxWindow: "workflow-test-run",
      workspaceCwd: "/tmp/test",
      createdAt: new Date().toISOString(),
      launchDepth: 1,
      timeoutMs: 300_000,
      eventLog: [],
    }),
    steerAgent: async () => ({
      id: "workflow-test-run",
      profileId: "root",
      provider: "codex" as const,
      goal: "test goal",
      status: "running" as const,
      tmuxSession: "openelinaro",
      tmuxWindow: "workflow-test-run",
      workspaceCwd: "/tmp/test",
      createdAt: new Date().toISOString(),
      launchDepth: 1,
      timeoutMs: 300_000,
      eventLog: [],
    }),
    cancelAgent: async () => ({
      id: "workflow-test-run",
      profileId: "root",
      provider: "codex" as const,
      goal: "test goal",
      status: "cancelled" as const,
      tmuxSession: "openelinaro",
      tmuxWindow: "workflow-test-run",
      workspaceCwd: "/tmp/test",
      createdAt: new Date().toISOString(),
      launchDepth: 1,
      timeoutMs: 300_000,
      eventLog: [],
    }),
    getAgentRun: () => undefined,
    listAgentRuns: () => [],
    captureAgentPane: async () => "",
    readAgentTerminal: async () => "",
    listAvailableProviders: () => [],
  };
}

function createHarness(expectedArtifactDir: string) {
  const profiles = new profileServiceModule.ProfileService("root");
  const profile = profiles.getActiveProfile();
  const projects = new projectsServiceModule.ProjectsService(profile, profiles);
  const access = new accessControlModule.AccessControlService(profile, profiles, projects);
  const routines = new routinesServiceModule.RoutinesService();
  const conversations = new conversationStoreModule.ConversationStore();
  const systemPrompts = new systemPromptModule.SystemPromptService();
  const memory = new memoryServiceModule.MemoryService(profile, profiles);
  const models = new modelServiceModule.ModelService(profile);
  const connector = createScriptedOpenBrowserConnector(expectedArtifactDir);
  const buildAssistantContext = () =>
    [
      profiles.buildAssistantContext(profile),
      routines.buildAssistantContext(),
      projects.buildAssistantContext(),
    ]
      .filter(Boolean)
      .join("\n\n");

  const transitions = new transitionServiceModule.ConversationStateTransitionService(
    connector,
    conversations,
    memory,
    models,
    systemPrompts,
  );
  const toolRegistry = new toolRegistryModule.ToolRegistry(
    routines,
    projects,
    models,
    conversations,
    memory,
    systemPrompts,
    transitions,
    createWorkflowStub(),
    access,
  );
  const toolResolver = new toolResolutionModule.ToolResolutionService(toolRegistry);
  const chat = new agentChatModule.AgentChatService(
    connector,
    toolRegistry,
    toolResolver,
    transitions,
    conversations,
    systemPrompts,
    models,
    {
      async buildRecallContext() {
        return "";
      },
    },
  );

  return { chat };
}

describe("OpenBrowser agent e2e", () => {
  beforeAll(async () => {
    previousCwd = process.cwd();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openbrowser-agent-e2e-"));

    copyDirectory("profiles");
    copyDirectory("system_prompt");

    fs.mkdirSync(path.join(tempRoot, ".openelinarotest", "projects"), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, ".openelinarotest", "projects", "registry.json"), JSON.stringify({ version: 1, projects: [] }));
    writeSharedPythonFixture();

    process.chdir(tempRoot);
    updateTestRuntimeConfig((config) => {
      config.openbrowser.enabled = true;
      config.openbrowser.runnerScript = ensureStubRunner();
    });

    conversationStoreModule = await importFresh("src/services/conversation-store.ts");
    transitionServiceModule = await importFresh("src/services/conversation-state-transition-service.ts");
    accessControlModule = await importFresh("src/services/profiles/access-control-service.ts");
    agentChatModule = await importFresh("src/services/agent-chat-service.ts");
    memoryServiceModule = await importFresh("src/services/memory-service.ts");
    modelServiceModule = await importFresh("src/services/models/model-service.ts");
    profileServiceModule = await importFresh("src/services/profiles/profile-service.ts");
    projectsServiceModule = await importFresh("src/services/projects-service.ts");
    routinesServiceModule = await importFresh("src/services/scheduling/routines-service.ts");
    systemPromptModule = await importFresh("src/services/system-prompt-service.ts");
    toolResolutionModule = await importFresh("src/services/tool-resolution-service.ts");
    toolRegistryModule = await importFresh("src/tools/tool-registry.ts");
  });

  afterAll(() => {
    process.chdir(previousCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("agent discovers and uses the openbrowser tool", async () => {
    const expectedArtifactDir = "artifacts/openbrowser-run";
    const harness = createHarness(expectedArtifactDir);
    const toolEvents: string[] = [];
    const conversationKey = `e2e:openbrowser:${Date.now()}`;

    const result = await harness.chat.reply({
      conversationKey,
      content: "Use a browser tool to move the cursor and capture a screenshot.",
      onToolUse: async (event) => {
        toolEvents.push(typeof event === "string" ? event : event.message);
      },
    });

    expect(result.mode).toBe("immediate");
    expect(result.message).toContain("OpenBrowser ran");
    expect(toolEvents.some((entry) => entry.includes("load_tool_library"))).toBe(true);
  });
});
