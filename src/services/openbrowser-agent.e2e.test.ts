import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Message, UserMessage, AssistantMessage, ToolResultMessage } from "../messages/types";
import {
  userMessage,
  assistantTextMessage,
  isUserMessage,
  isAssistantMessage,
  isToolResultMessage,
  extractAssistantText,
} from "../messages/types";
import type { ChatPromptContentBlock } from "../domain/assistant";
import type { ScriptedConnectorRequest } from "../test/scripted-provider-connector";
import { updateTestRuntimeConfig } from "../test/runtime-config-test-helpers";
import { PiCore } from "../core/pi-core";

const repoRoot = process.cwd();

let previousCwd = "";
let tempRoot = "";
let conversationStoreModule: typeof import("./conversation/conversation-store");
let transitionServiceModule: typeof import("./conversation/conversation-state-transition-service");
let accessControlModule: typeof import("./profiles/access-control-service");
let agentChatModule: typeof import("./conversation/agent-chat-service");
let memoryServiceModule: typeof import("./memory-service");
let modelServiceModule: typeof import("./models/model-service");
let profileServiceModule: typeof import("./profiles/profile-service");
let projectsServiceModule: typeof import("./projects-service");
let routinesServiceModule: typeof import("./scheduling/routines-service");
let systemPromptModule: typeof import("./system-prompt-service");
let toolResolutionModule: typeof import("./tool-resolution-service");
let toolRegistryModule: typeof import("../functions/tool-registry");

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

function lastTextContent(message: Message) {
  if (isUserMessage(message)) {
    if (typeof message.content === "string") {
      return message.content;
    }
    return message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n\n");
  }
  if (isAssistantMessage(message)) {
    return extractAssistantText(message);
  }
  if (isToolResultMessage(message)) {
    return message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n\n");
  }
  return "";
}

function createScriptedOpenBrowserHandler(expectedArtifactDir: string) {
  const meta = { api: "scripted" as const, provider: "scripted-openbrowser-test", model: "scripted-model" };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

  return async (request: ScriptedConnectorRequest): Promise<AssistantMessage> => {
    const latestTool = [...request.messages]
      .reverse()
      .find((message): message is ToolResultMessage => isToolResultMessage(message));

    if (!latestTool) {
      return {
        role: "assistant",
        content: [
          {
            type: "toolCall" as const,
            id: "search-openbrowser",
            name: "load_tool_library",
            arguments: { library: "browser_automation", scope: "chat" },
          },
        ],
        ...meta,
        usage,
        stopReason: "toolUse",
        timestamp: Date.now(),
      };
    }

    if (latestTool.toolName === "load_tool_library") {
      return {
        role: "assistant",
        content: [
          {
            type: "toolCall" as const,
            id: "openbrowser-run",
            name: "openbrowser",
            arguments: {
              startUrl: "https://example.com",
              artifactDir: expectedArtifactDir,
              actions: [
                { type: "mouse_move", x: 120, y: 80 },
                { type: "screenshot", path: "screenshots/landing.png", format: "png" },
              ],
            },
          },
        ],
        ...meta,
        usage,
        stopReason: "toolUse",
        timestamp: Date.now(),
      };
    }

    if (latestTool.toolName === "openbrowser") {
      return assistantTextMessage("OpenBrowser ran and produced the requested screenshot artifact.", meta);
    }

    const latestHumanMsg = [...request.messages]
      .reverse()
      .find((message): message is UserMessage => isUserMessage(message));
    return assistantTextMessage(`Unhandled test state for: ${latestHumanMsg ? lastTextContent(latestHumanMsg) : "unknown"}`, meta);
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
  // NOTE: In the Pi architecture, scripted model responses need to be wired
  // through ModelService.resolveModelForPurpose or the pi-ai complete()
  // function. The handler is captured but not yet wired.
  const _scriptedHandler = createScriptedOpenBrowserHandler(expectedArtifactDir);

  const transitions = new transitionServiceModule.ConversationStateTransitionService(
    models,
    conversations,
    memory,
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
    access,
  );
  const toolResolver = new toolResolutionModule.ToolResolutionService(toolRegistry);
  const chat = new agentChatModule.AgentChatService({
    routineTools: toolRegistry,
    toolResolver,
    transitions,
    conversations,
    systemPrompts,
    models,
    coreFactory: ({ modelConfig }) =>
      new PiCore({
        model: modelConfig.runtimeModel as any,
        apiKey: modelConfig.apiKey,
        reasoning: modelConfig.reasoning as any,
        providerOptions: modelConfig.providerOptions,
      }),
  });

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

    conversationStoreModule = await importFresh("src/services/conversation/conversation-store.ts");
    transitionServiceModule = await importFresh("src/services/conversation/conversation-state-transition-service.ts");
    accessControlModule = await importFresh("src/services/profiles/access-control-service.ts");
    agentChatModule = await importFresh("src/services/conversation/agent-chat-service.ts");
    memoryServiceModule = await importFresh("src/services/memory-service.ts");
    modelServiceModule = await importFresh("src/services/models/model-service.ts");
    profileServiceModule = await importFresh("src/services/profiles/profile-service.ts");
    projectsServiceModule = await importFresh("src/services/projects-service.ts");
    routinesServiceModule = await importFresh("src/services/scheduling/routines-service.ts");
    systemPromptModule = await importFresh("src/services/system-prompt-service.ts");
    toolResolutionModule = await importFresh("src/services/tool-resolution-service.ts");
    toolRegistryModule = await importFresh("src/functions/tool-registry.ts");
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
