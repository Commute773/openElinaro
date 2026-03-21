import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AIMessage } from "@langchain/core/messages";
import { beforeAll, afterAll, describe, expect, mock, test } from "bun:test";
import type { AssistantMessage, Context, Message, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";

const repoRoot = process.cwd();

let previousCwd = "";
let previousRootDirEnv: string | undefined;
let tempRoot = "";
const observedToolResultIdsBySession = new Map<string, string[]>();

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?test=${Date.now()}-${Math.random()}`) as Promise<T>;
}

function writeTestProfileRegistry() {
  fs.mkdirSync(path.join(tempRoot, ".openelinarotest", "profiles"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, ".openelinarotest", "profiles/registry.json"),
    `${JSON.stringify({
      version: 1,
      profiles: [
        {
          id: "restricted",
          name: "Restricted",
          roles: ["restricted"],
          memoryNamespace: "restricted",
          preferredProvider: "claude",
          defaultModelId: "claude-opus-4-6",
          maxSubagentDepth: 1,
        },
      ],
    }, null, 2)}\n`,
  );
}

function writeWorkspaceFixture() {
  fs.mkdirSync(path.join(tempRoot, ".openelinarotest", "memory/documents/restricted"), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, "workspace", "TODO.md"), "- inspect docs\n", "utf8");
}

function buildResponse(overrides?: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-4-6",
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

function isToolResultMessage(message: Message) {
  return message.role === "toolResult";
}

function getAssistantToolCalls(message: Message): ToolCall[] {
  if (message.role !== "assistant") {
    return [];
  }

  return message.content.filter((part): part is ToolCall => part.type === "toolCall");
}

function isAssistantToolUseMessage(message: Message) {
  return getAssistantToolCalls(message).length > 0;
}

function getAssistantToolUseIds(message: Message) {
  return getAssistantToolCalls(message).map((part) => part.id);
}

function getLatestAssistantToolUseMessage(messages: Message[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && isAssistantToolUseMessage(message)) {
      return message;
    }
  }
  return undefined;
}

describe("workflow anthropic tool result ordering e2e", () => {
  beforeAll(() => {
    previousCwd = process.cwd();
    previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-anthropic-workflow-e2e-"));
    process.env.OPENELINARO_ROOT_DIR = tempRoot;
    process.chdir(tempRoot);
    observedToolResultIdsBySession.clear();

    writeTestProfileRegistry();
    writeWorkspaceFixture();

    mock.module("@mariozechner/pi-ai", () => ({
      getModels: () => [
        {
          id: "claude-opus-4-6",
          name: "Claude Opus 4.6",
          contextWindow: 200_000,
          maxTokens: 8_192,
          reasoning: true,
        },
      ],
      stream: (_model: unknown, context: Context, options?: { sessionId?: string }) => {
        const sessionId = options?.sessionId ?? "session-unknown";
        const toolUseMessage = getLatestAssistantToolUseMessage(context.messages);
        const toolResultMessages = context.messages.filter(isToolResultMessage);
        observedToolResultIdsBySession.set(
          sessionId,
          toolResultMessages.map((message: ToolResultMessage) => message.toolCallId),
        );

        const response = (() => {
          if (sessionId.endsWith(":draft-plan")) {
            if (toolResultMessages.some((message: ToolResultMessage) => message.toolCallId === "toolu_complete_task")) {
              return buildResponse({
                stopReason: "stop",
                content: [{ type: "text", text: "Task submitted." }],
              });
            }

            return buildResponse({
              stopReason: "toolUse",
              content: [
                {
                  type: "toolCall",
                  id: "toolu_complete_task",
                  name: "complete_coding_task",
                  arguments: {
                    status: "completed",
                    summary: "Drafted the milestone plan.",
                    filesTouched: [],
                    commandsRun: [],
                    verificationCommands: [],
                    blockers: [],
                  },
                },
              ],
            });
          }

          if (toolResultMessages.some((message: ToolResultMessage) => message.toolCallId === "toolu_report_plan")) {
            return buildResponse({
              stopReason: "stop",
              content: [{ type: "text", text: "Plan submitted." }],
            });
          }

          if (!toolUseMessage) {
            return buildResponse({
              stopReason: "toolUse",
              content: [
                {
                  type: "toolCall",
                  id: "toolu_list_dir",
                  name: "list_dir",
                  arguments: {
                    path: path.join(tempRoot, "workspace"),
                    recursive: false,
                  },
                },
                {
                  type: "toolCall",
                  id: "toolu_read_file",
                  name: "read_file",
                  arguments: {
                    path: path.join(tempRoot, "workspace", "TODO.md"),
                  },
                },
              ],
            });
          }

          const matchingToolResultIds = new Set(
            toolResultMessages.map((message: ToolResultMessage) => message.toolCallId),
          );
          const toolUseIds: string[] = getAssistantToolUseIds(toolUseMessage);

          const missingIds = toolUseIds.filter((id) => !matchingToolResultIds.has(id));
          if (toolResultMessages.length !== toolUseIds.length || missingIds.length > 0) {
            return buildResponse({
              stopReason: "error",
              errorMessage: JSON.stringify({
                type: "error",
                error: {
                  type: "invalid_request_error",
                  message:
                    `messages.2: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${missingIds.join(", ") || toolUseIds.join(", ")}. Each \`tool_use\` block must have a corresponding \`tool_result\` block in the next message.`,
                },
                request_id: "req_test_missing_tool_result",
              }),
            });
          }

          return buildResponse({
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "toolu_report_plan",
                name: "report_plan",
                arguments: {
                  summary: "Plan generated after inspecting the workspace and TODO file.",
                  tasks: [
                    {
                      id: "draft-plan",
                      title: "Draft the next milestone plan",
                      executionMode: "serial",
                      dependsOn: [],
                      acceptanceCriteria: ["Summarize the next milestone."],
                      verificationCommands: [],
                    },
                  ],
                },
              },
            ],
          });
        })();

        return {
          async *[Symbol.asyncIterator]() {},
          result: async () => response,
        };
      },
    }));

    mock.module("@mariozechner/pi-ai/oauth", () => ({
      getOAuthApiKey: async () => null,
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
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("preserves every tool_result for Anthropic multi-tool planner turns", async () => {
    const authStore = await importFresh<typeof import("../auth/store")>("src/auth/store.ts");
    const profileModule = await importFresh<typeof import("../services/profile-service")>("src/services/profile-service.ts");
    const modelModule = await importFresh<typeof import("../services/model-service")>("src/services/model-service.ts");
    const connectorModule = await importFresh<typeof import("../connectors/active-model-connector")>("src/connectors/active-model-connector.ts");
    const toolRegistryModule = await importFresh<typeof import("../tools/routine-tool-registry")>("src/tools/routine-tool-registry.ts");
    const toolResolverModule = await importFresh<typeof import("../services/tool-resolution-service")>("src/services/tool-resolution-service.ts");
    const projectsModule = await importFresh<typeof import("../services/projects-service")>("src/services/projects-service.ts");
    const accessModule = await importFresh<typeof import("../services/access-control-service")>("src/services/access-control-service.ts");
    const routinesModule = await importFresh<typeof import("../services/routines-service")>("src/services/routines-service.ts");
    const conversationsModule = await importFresh<typeof import("../services/conversation-store")>("src/services/conversation-store.ts");
    const memoryModule = await importFresh<typeof import("../services/memory-service")>("src/services/memory-service.ts");
    const systemPromptModule = await importFresh<typeof import("../services/system-prompt-service")>("src/services/system-prompt-service.ts");
    const transitionModule = await importFresh<typeof import("../services/conversation-state-transition-service")>("src/services/conversation-state-transition-service.ts");
    const shellModule = await importFresh<typeof import("../services/shell-service")>("src/services/shell-service.ts");
    const workflowSessionStoreModule = await importFresh<typeof import("../services/workflow-session-store")>("src/services/workflow-session-store.ts");
    const workflowModule = await importFresh<typeof import("./workflow-graph")>("src/orchestration/workflow-graph.ts");
    const scriptedConnectorModule = await importFresh<typeof import("../test/scripted-provider-connector")>("src/test/scripted-provider-connector.ts");

    authStore.saveClaudeSetupToken("sk-ant-oat01-test-token", "restricted");

    const profiles = new profileModule.ProfileService("restricted");
    const profile = profiles.getActiveProfile();
    const projects = new projectsModule.ProjectsService(profile, profiles);
    const access = new accessModule.AccessControlService(profile, profiles, projects);
    const routines = new routinesModule.RoutinesService();
    const conversations = new conversationsModule.ConversationStore();
    const memory = new memoryModule.MemoryService(profile, profiles);
    const systemPrompts = new systemPromptModule.SystemPromptService();
    const fallbackConnector = new scriptedConnectorModule.ScriptedProviderConnector(
      async () => new AIMessage("unused"),
      { providerId: "scripted-fallback" },
    );
    const models = new modelModule.ModelService(profile);
    const transitions = new transitionModule.ConversationStateTransitionService(
      fallbackConnector,
      conversations,
      memory,
      models,
      systemPrompts,
    );
    const connector = new connectorModule.ActiveModelConnector(models);
    const toolRegistry = new toolRegistryModule.RoutineToolRegistry(
      routines,
      projects,
      models,
      conversations,
      memory,
      systemPrompts,
      transitions,
      {
        launchCodingAgent: () => {
          throw new Error("not used in this test");
        },
        resumeCodingAgent: () => {
          throw new Error("not used in this test");
        },
        steerCodingAgent: () => {
          throw new Error("not used in this test");
        },
        cancelCodingAgent: () => {
          throw new Error("not used in this test");
        },
        getWorkflowRun: () => undefined,
        listWorkflowRuns: () => [],
      },
      access,
    );
    const toolResolver = new toolResolverModule.ToolResolutionService(toolRegistry);
    const shell = new shellModule.ShellService(access, profiles.buildProfileShellEnvironment(profile));

    const run = {
      id: "run-anthropic-tool-result-repro",
      kind: "coding-agent" as const,
      goal: "Inspect the workspace and draft a plan.",
      profileId: "restricted",
      status: "queued" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspaceCwd: path.join(tempRoot, "workspace"),
      timeoutMs: 60_000,
      executionLog: [],
      taskReports: [],
    };

    const completedRun = await workflowModule.executeWorkflowRun(run, {
      connector,
      toolResolver,
      shell,
      workflowSessions: new workflowSessionStoreModule.WorkflowSessionStore(),
      baseSystemPrompt: "You are OpenElinaro.",
      assistantContext: "Execution mode: background coding subagent.",
    });

    expect(completedRun.status).toBe("completed");
    expect(completedRun.plan?.tasks).toHaveLength(1);
    const plannerToolResultIds = observedToolResultIdsBySession.get("run-anthropic-tool-result-repro:plan") ?? [];
    expect(plannerToolResultIds).toContain("toolu_list_dir");
    expect(plannerToolResultIds).toContain("toolu_read_file");
  });
});
