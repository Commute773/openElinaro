import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ChannelType, MessageFlags, type ChatInputCommandInteraction, type Message } from "discord.js";
import type {
  Message as PiMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
} from "../../messages/types";
import {
  userMessage,
  assistantTextMessage,
  toolResultMessage,
  isUserMessage,
  isAssistantMessage,
  isToolResultMessage,
  extractAssistantText,
} from "../../messages/types";
import type { AppProgressEvent, ChatPromptContentBlock } from "../../domain/assistant";
import { getTestFixturesDir } from "../../test/fixtures";

const repoRoot = process.cwd();
const machineTestRoot = getTestFixturesDir();

let previousCwd = "";
let tempRoot = "";
let sandboxNoteRelativePath = "";
let previousRootDirEnv: string | undefined;

let botModule: typeof import("./bot");
let authSessionManagerModule: typeof import("./auth-session-manager");
let profileServiceModule: typeof import("../../services/profiles/profile-service");
let projectsServiceModule: typeof import("../../services/projects-service");
let accessControlModule: typeof import("../../services/profiles/access-control-service");
let routinesServiceModule: typeof import("../../services/scheduling/routines-service");
let conversationStoreModule: typeof import("../../services/conversation/conversation-store");
let systemPromptModule: typeof import("../../services/system-prompt-service");
let memoryServiceModule: typeof import("../../services/memory-service");
let modelServiceModule: typeof import("../../services/models/model-service");
let transitionServiceModule: typeof import("../../services/conversation/conversation-state-transition-service");
let toolRegistryModule: typeof import("../../tools/tool-registry");
let toolResolutionModule: typeof import("../../services/tool-resolution-service");
let agentChatModule: typeof import("../../services/conversation/agent-chat-service");

const liveStateBefore = {
  authStore: readOptionalFile(path.join(machineTestRoot, "auth-store.json")),
  routines: readOptionalFile(path.join(machineTestRoot, "routines.json")),
  conversations: readOptionalFile(path.join(machineTestRoot, "conversations.json")),
  memoryFiles: listRelativeFiles(path.join(machineTestRoot, "memory")),
};
const RUN_CHILD_SUITE = process.env.OPENELINARO_DISCORD_E2E_CHILD === "1";

function readOptionalFile(filePath: string) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

function listRelativeFiles(root: string) {
  if (!fs.existsSync(root)) {
    return [] as string[];
  }

  const found: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      for (const nested of listRelativeFiles(absolutePath)) {
        found.push(path.join(entry.name, nested));
      }
      continue;
    }
    found.push(entry.name);
  }
  return found.sort();
}

function copyFileIfExists(relativePath: string) {
  const source = path.join(machineTestRoot, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }

  const destination = path.join(tempRoot, ".openelinarotest", relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyDirectory(relativePath: string) {
  const source = path.join(repoRoot, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }
  fs.cpSync(source, path.join(tempRoot, relativePath), { recursive: true });
}

function writeAuthStoreFixture() {
  const authStorePath = path.join(tempRoot, ".openelinarotest", "auth-store.json");
  fs.mkdirSync(path.dirname(authStorePath), { recursive: true });
  fs.writeFileSync(
    authStorePath,
    `${JSON.stringify({
      version: 2,
      profiles: {
        root: {
          providers: {
            "openai-codex": {
              provider: "openai-codex",
              type: "oauth",
              credentials: {
                access: "test-access-token",
              },
              updatedAt: "2026-03-21T00:00:00.000Z",
            },
          },
        },
      },
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function writeProfileRegistryFixture() {
  const registryPath = path.join(tempRoot, ".openelinarotest", "profiles", "registry.json");
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(
    registryPath,
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
      ],
    }, null, 2)}\n`,
    "utf8",
  );
}

function writeProjectRegistryFixture() {
  const projectDocsDir = path.join(tempRoot, ".openelinarotest", "projects", "discord-sandbox");
  const projectRegistryPath = path.join(tempRoot, ".openelinarotest", "projects", "registry.json");
  fs.mkdirSync(projectDocsDir, { recursive: true });
  fs.writeFileSync(path.join(projectDocsDir, "README.md"), "# Discord Sandbox\n", "utf8");
  fs.writeFileSync(
    projectRegistryPath,
    `${JSON.stringify({
      version: 1,
      projects: [
        {
          id: "discord-sandbox",
          name: "Discord Sandbox",
          status: "active",
          workspacePath: path.join(tempRoot, "sandbox"),
          summary: "Temp Discord e2e workspace.",
          currentState: "Available for slash-command tests.",
          state: "Isolated test project registry entry.",
          future: "Stay local to the Discord e2e temp root.",
          nextFocus: ["Support project tool tests."],
          structure: ["workspace/: temp sandbox"],
          tags: ["test"],
          docs: {
            readme: "projects/discord-sandbox/README.md",
          },
          priority: "medium",
        },
      ],
      jobs: [],
    }, null, 2)}\n`,
    "utf8",
  );
}

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?test=${Date.now()}-${Math.random()}`) as Promise<T>;
}

function lastTextContent(message: PiMessage) {
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

function extractTrailingUserText(text: string) {
  return text
    .replace(/<recalled_memory>[\s\S]*?<\/recalled_memory>\s*/g, "")
    .trim()
    .split(/\n\n+/)
    .at(-1)
    ?.trim() ?? text.trim();
}

type ScriptedConnectorRequest = {
  sessionId?: string;
  conversationKey?: string;
  usagePurpose?: string;
  systemPrompt: string;
  messages: PiMessage[];
};

function defaultScriptedHandler(request: ScriptedConnectorRequest): AssistantMessage {
  if (request.usagePurpose === "conversation_compaction") {
    return assistantTextMessage(
      JSON.stringify({
        summary: "Conversation compacted for the Discord e2e harness.",
        memory_markdown: "",
      }),
      { api: "scripted", provider: "scripted-discord-test", model: "scripted-model" },
    );
  }

  if (request.usagePurpose === "conversation_opening") {
    return assistantTextMessage("What do you want to work on next?", {
      api: "scripted",
      provider: "scripted-discord-test",
      model: "scripted-model",
    });
  }

  const latestMessage = request.messages.at(-1);
  if (isToolResultMessage(latestMessage!) && latestMessage!.toolName === "new_chat") {
    return assistantTextMessage("Fresh thread prepared.", {
      api: "scripted",
      provider: "scripted-discord-test",
      model: "scripted-model",
    });
  }

  const latestHumanMessage = [...request.messages]
    .reverse()
    .find((message): message is UserMessage => isUserMessage(message));
  const text = latestHumanMessage ? extractTrailingUserText(lastTextContent(latestHumanMessage)) : "";

  if (/start over/i.test(text)) {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    return {
      role: "assistant",
      content: [
        {
          type: "toolCall" as const,
          id: "tool-new-1",
          name: "new_chat",
          arguments: {},
        },
      ],
      api: "scripted",
      provider: "scripted-discord-test",
      model: "scripted-model",
      usage,
      stopReason: "toolUse",
      timestamp: Date.now(),
    };
  }

  return assistantTextMessage(`Acknowledged: ${text}`, {
    api: "scripted",
    provider: "scripted-discord-test",
    model: "scripted-model",
  });
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

function createDiscordAppHarness(options?: {
  connectorHandler?: (request: ScriptedConnectorRequest) => AssistantMessage | Promise<AssistantMessage>;
}) {
  const profiles = new profileServiceModule.ProfileService("root");
  const profile = profiles.getActiveProfile();
  const projects = new projectsServiceModule.ProjectsService(profile, profiles);
  const access = new accessControlModule.AccessControlService(profile, profiles, projects);
  const routines = new routinesServiceModule.RoutinesService();
  const conversations = new conversationStoreModule.ConversationStore();
  const systemPrompts = new systemPromptModule.SystemPromptService();
  const memory = new memoryServiceModule.MemoryService(profile, profiles);
  const models = new modelServiceModule.ModelService(profile);
  // NOTE: In the Pi architecture, scripted model responses require mocking
  // ModelService.resolveModelForPurpose or the pi-ai complete() function.
  // The connectorHandler is captured but not wired into the chat service
  // until a proper scripted model adapter is added.
  const _scriptedHandler = options?.connectorHandler ?? defaultScriptedHandler;
  const buildAssistantContext = () =>
    [
      profiles.buildAssistantContext(profile),
      routines.buildAssistantContext(),
      projects.buildAssistantContext(),
    ]
      .filter(Boolean)
      .join("\n\n");

  models.inspectContextWindowUsage = async ({ conversationKey }) => ({
    conversationKey,
    providerId: (await models.getActiveModel()).providerId,
    modelId: (await models.getActiveModel()).modelId,
    method: "heuristic_estimate",
    usedTokens: 128,
    maxContextTokens: 8_192,
    remainingTokens: 8_064,
    maxOutputTokens: 1_024,
    remainingReplyBudgetTokens: 1_024,
    utilizationPercent: 1.56,
    breakdownMethod: "heuristic_estimate",
    breakdown: {
      systemPromptTokens: 32,
      userMessageTokens: 32,
      assistantReplyTokens: 32,
      toolCallInputTokens: 0,
      toolResponseTokens: 0,
      toolDefinitionTokens: 32,
      estimatedTotalTokens: 128,
    },
  });

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
    createWorkflowStub(),
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
  });

  return {
    profile,
    routines,
    conversations,
    chat,
    app: {
      noteDiscordUser(userId: string) {
        routines.noteNotificationTargetUserId(userId);
      },
      stopConversation(conversationKey: string) {
        return chat.stopConversation(conversationKey);
      },
      async handleRequest(
        request: { id: string; kind: string; text: string; chatContent?: string | ChatPromptContentBlock[]; conversationKey?: string; todoTitle?: string; medicationName?: string; medicationDueAt?: string },
        options?: {
          onBackgroundResponse?: (response: { requestId: string; mode: "immediate" | "accepted"; message: string; warnings?: string[] }) => Promise<void>;
          onToolUse?: (event: AppProgressEvent) => Promise<void>;
        },
      ) {
        if (request.kind === "chat") {
          const result = await chat.reply({
            conversationKey: request.conversationKey ?? request.id,
            content: request.chatContent ?? request.text,
            systemContext: buildAssistantContext(),
            onBackgroundResponse: options?.onBackgroundResponse
              ? async (response) => {
                  await options.onBackgroundResponse?.({
                    requestId: request.id,
                    mode: response.mode,
                    message: response.message,
                    warnings: response.warnings,
                  });
                }
              : undefined,
            onToolUse: options?.onToolUse,
          });
          return {
            requestId: request.id,
            mode: result.mode,
            message: result.message,
            warnings: result.warnings,
          };
        }

        if (request.kind === "todo") {
          const message = await toolRegistry.invoke("routine_add", {
            title: request.todoTitle ?? request.text,
            kind: "todo",
            priority: "medium",
            description: request.text,
            scheduleKind: "once",
            dueAt: new Date().toISOString(),
          });
          return {
            requestId: request.id,
            mode: "immediate" as const,
            message,
          };
        }

        if (request.kind === "medication") {
          const message = await toolRegistry.invoke("routine_add", {
            title: request.medicationName ?? request.text,
            kind: "med",
            priority: "high",
            description: request.text,
            scheduleKind: request.medicationDueAt ? "once" : "manual",
            dueAt: request.medicationDueAt,
          });
          return {
            requestId: request.id,
            mode: "immediate" as const,
            message,
          };
        }

        throw new Error(`Unsupported test request kind: ${request.kind}`);
      },
      invokeRoutineTool(
        name: string,
        input: unknown,
        options?: {
          conversationKey?: string;
          onToolUse?: (event: AppProgressEvent) => Promise<void>;
        },
      ) {
        return toolRegistry.invoke(name, input, {
          conversationKey: options?.conversationKey,
          onToolUse: options?.onToolUse,
        });
      },
      getActiveModel() {
        return models.getActiveModel();
      },
      getActiveProfile() {
        return profile;
      },
      getAgentRun() {
        return undefined;
      },
      listAgentRuns() {
        return [] as never[];
      },
    },
  };
}

class FakeCommandOptions {
  constructor(
    private readonly values: Record<string, unknown>,
    private readonly subcommand?: string,
  ) {}

  getString(name: string, required?: boolean) {
    const value = this.values[name];
    if (value == null) {
      if (required) {
        throw new Error(`Missing string option: ${name}`);
      }
      return null;
    }
    return String(value);
  }

  getInteger(name: string, required?: boolean) {
    const value = this.values[name];
    if (value == null) {
      if (required) {
        throw new Error(`Missing integer option: ${name}`);
      }
      return null;
    }
    return Number(value);
  }

  getBoolean(name: string, required?: boolean) {
    const value = this.values[name];
    if (value == null) {
      if (required) {
        throw new Error(`Missing boolean option: ${name}`);
      }
      return null;
    }
    return Boolean(value);
  }

  getSubcommand(required?: boolean) {
    if (!this.subcommand && required) {
      throw new Error("Missing subcommand");
    }
    return this.subcommand ?? null;
  }
}

class FakeInteraction {
  replied = false;
  deferred = false;
  readonly replies: Array<{ content?: string; flags?: MessageFlags; files?: unknown[] }> = [];
  readonly user = {
    id: "discord-user",
    createDM: async () => ({
      sent: [] as string[],
      async send(text: string) {
        this.sent.push(text);
      },
    }),
  };
  readonly channel = { type: ChannelType.DM };
  readonly channelId = "discord-channel";
  readonly options: FakeCommandOptions;

  constructor(
    readonly commandName: string,
    values: Record<string, unknown> = {},
    subcommand?: string,
  ) {
    this.options = new FakeCommandOptions(values, subcommand);
  }

  isChatInputCommand() {
    return true;
  }

  async reply(payload: string | { content?: string; flags?: MessageFlags; files?: unknown[] }) {
    this.replied = true;
    if (typeof payload === "string") {
      this.replies.push({ content: payload });
      return;
    }
    this.replies.push(payload);
  }

  async deferReply() {
    this.deferred = true;
  }

  async editReply(payload: { content?: string; files?: unknown[] }) {
    this.replied = true;
    this.replies.push({ content: payload.content, files: payload.files });
  }

  async followUp(payload: { content?: string; flags?: MessageFlags; files?: unknown[] }) {
    this.replies.push(payload);
  }
}

class FakeDirectMessage {
  readonly replies: string[] = [];
  readonly replyPayloads: Array<{ content?: string; files?: unknown[] }> = [];
  readonly author = {
    id: "discord-user",
    bot: false,
  };
  readonly channelId = "discord-dm";
  readonly attachments = new Map<string, {
    name: string;
    contentType?: string;
    size?: number;
    url: string;
  }>();
  readonly channel: {
    type: ChannelType.DM;
    typingPulses: number;
    isSendable: () => boolean;
    sendTyping: () => Promise<void>;
    send: (payload: string | { content?: string; files?: unknown[] }) => Promise<void>;
  };

  constructor(readonly content: string) {
    this.channel = {
      type: ChannelType.DM,
      typingPulses: 0,
      isSendable: () => true,
      sendTyping: async () => {
        this.channel.typingPulses += 1;
      },
      send: async (payload: string | { content?: string; files?: unknown[] }) => {
        if (typeof payload === "string") {
          this.replies.push(payload);
          this.replyPayloads.push({ content: payload });
          return;
        }

        this.replies.push(payload.content ?? "");
        this.replyPayloads.push(payload);
      },
    };
  }

  async reply(payload: string | { content?: string; files?: unknown[] }) {
    if (typeof payload === "string") {
      this.replies.push(payload);
      this.replyPayloads.push({ content: payload });
      return;
    }

    this.replies.push(payload.content ?? "");
    this.replyPayloads.push(payload);
  }
}

if (RUN_CHILD_SUITE) {
  beforeAll(async () => {
    previousCwd = process.cwd();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-discord-e2e-"));
    sandboxNoteRelativePath = path.join("sandbox", "discord-note.md");
    previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
    process.env.OPENELINARO_ROOT_DIR = tempRoot;

    copyDirectory("system_prompt");
    copyFileIfExists("model-state.json");

    fs.mkdirSync(path.join(tempRoot, "sandbox"), { recursive: true });
    writeAuthStoreFixture();
    writeProfileRegistryFixture();
    writeProjectRegistryFixture();
    fs.writeFileSync(
      path.join(tempRoot, sandboxNoteRelativePath),
      "This file lives only in the temp Discord e2e workspace.\n",
    );

    process.chdir(tempRoot);

    botModule = await importFresh("src/integrations/discord/bot.ts");
    authSessionManagerModule = await importFresh("src/integrations/discord/auth-session-manager.ts");
    profileServiceModule = await importFresh("src/services/profiles/profile-service.ts");
    projectsServiceModule = await importFresh("src/services/projects-service.ts");
    accessControlModule = await importFresh("src/services/profiles/access-control-service.ts");
    routinesServiceModule = await importFresh("src/services/scheduling/routines-service.ts");
    conversationStoreModule = await importFresh("src/services/conversation/conversation-store.ts");
    systemPromptModule = await importFresh("src/services/system-prompt-service.ts");
    memoryServiceModule = await importFresh("src/services/memory-service.ts");
    modelServiceModule = await importFresh("src/services/models/model-service.ts");
    transitionServiceModule = await importFresh("src/services/conversation/conversation-state-transition-service.ts");
    toolRegistryModule = await importFresh("src/tools/tool-registry.ts");
    toolResolutionModule = await importFresh("src/services/tool-resolution-service.ts");
    agentChatModule = await importFresh("src/services/conversation/agent-chat-service.ts");
  });

  afterAll(() => {
    process.chdir(previousCwd);
    if (previousRootDirEnv === undefined) {
      delete process.env.OPENELINARO_ROOT_DIR;
    } else {
      process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("discord e2e flows", () => {
    test("reports the cloned current auth status via slash command", async () => {
      const harness = createDiscordAppHarness();
      const authManager = new authSessionManagerModule.DiscordAuthSessionManager();
      const handlers = botModule.createDiscordEventHandlers({
        app: harness.app,
        authManager,
        profileId: harness.profile.id,
      });
      const interaction = new FakeInteraction("auth", { provider: "status" });

      await handlers.handleInteraction(interaction as unknown as ChatInputCommandInteraction);

      expect(interaction.replies).toHaveLength(1);
      expect(interaction.replies[0]?.content).toContain("profile: root");
      expect(interaction.replies[0]?.content).toContain("codex: configured");
    });

    test("supports the profile settings flow without requiring subcommands", async () => {
      const harness = createDiscordAppHarness();
      const authManager = new authSessionManagerModule.DiscordAuthSessionManager();
      const handlers = botModule.createDiscordEventHandlers({
        app: harness.app,
        authManager,
        profileId: harness.profile.id,
      });

      const showBefore = new FakeInteraction("profile", { profile: "root" });
      await handlers.handleInteraction(showBefore as unknown as ChatInputCommandInteraction);
      expect(showBefore.replies[0]?.content).toContain("Profile: root");
      expect(showBefore.replies[0]?.content).toContain("Default thinking: low");

      const setDefaults = new FakeInteraction("profile", { profile: "root", thinking: "high" });
      await handlers.handleInteraction(setDefaults as unknown as ChatInputCommandInteraction);
      expect(setDefaults.replies.map((reply) => reply.content).join("\n")).toContain("Default thinking level: high.");

      const showAfter = new FakeInteraction("profile", { profile: "root" });
      await handlers.handleInteraction(showAfter as unknown as ChatInputCommandInteraction);
      expect(showAfter.replies[0]?.content).toContain("Default thinking: high");
    });

    test("routes DM todo messages and slash routine listing inside the temp clone only", async () => {
      const harness = createDiscordAppHarness();
      const authManager = new authSessionManagerModule.DiscordAuthSessionManager();
      const handlers = botModule.createDiscordEventHandlers({
        app: harness.app,
        authManager,
        profileId: harness.profile.id,
      });
      const todoMessage = new FakeDirectMessage("todo buy oat milk");

      await handlers.handleMessage(todoMessage as unknown as Message);

      expect(todoMessage.replies).toHaveLength(1);
      expect(todoMessage.replies[0]).toContain("Saved routine item");

      const listInteraction = new FakeInteraction("routine", {}, "list");
      await handlers.handleInteraction(listInteraction as unknown as ChatInputCommandInteraction);

      expect(listInteraction.replies.map((reply) => reply.content).join("\n")).toContain("buy oat milk");
      expect(readOptionalFile(path.join(tempRoot, ".openelinarotest", "routines.json"))).toContain("buy oat milk");
      expect(readOptionalFile(path.join(machineTestRoot, "routines.json"))).toBe(liveStateBefore.routines);
    });

  test("invokes slash tool commands against the temp project and system-prompt clone", async () => {
      const harness = createDiscordAppHarness();
      const authManager = new authSessionManagerModule.DiscordAuthSessionManager();
      const handlers = botModule.createDiscordEventHandlers({
        app: harness.app,
        authManager,
        profileId: harness.profile.id,
      });
      const conversationKey = "reload-user";
      const seedMessage = new FakeDirectMessage("hello before reload");
      seedMessage.author.id = conversationKey;
      await handlers.handleMessage(seedMessage as unknown as Message);

      const tempPromptPath = path.join(tempRoot, "system_prompt", "40-docs-and-reload.md");
      const repoPromptPath = path.join(repoRoot, "system_prompt", "40-docs-and-reload.md");
      const tempPromptMarker = "\n\nReload marker from the temp Discord e2e clone.\n";
      fs.writeFileSync(tempPromptPath, `${fs.readFileSync(tempPromptPath, "utf8").trimEnd()}${tempPromptMarker}`);

      const reloadInteraction = new FakeInteraction("reload");
      reloadInteraction.user.id = conversationKey;
      await handlers.handleInteraction(reloadInteraction as unknown as ChatInputCommandInteraction);

      const projectListInteraction = new FakeInteraction("project_list", {
        input: JSON.stringify({ limit: 5 }),
      });
      await handlers.handleInteraction(projectListInteraction as unknown as ChatInputCommandInteraction);

      expect(reloadInteraction.replies.map((reply) => reply.content).join("\n"))
        .toContain(`Reloaded system prompt for ${conversationKey}.`);
      expect(projectListInteraction.replies.map((reply) => reply.content).join("\n"))
        .toContain("workspace=");
      expect((await harness.conversations.get(conversationKey)).systemPrompt?.text)
        .toContain("Reload marker from the temp Discord e2e clone.");
    expect(fs.readFileSync(repoPromptPath, "utf8")).not.toContain("Reload marker from the temp Discord e2e clone.");
  });

  test("ingests Discord attachments and preserves images as multimodal user content", async () => {
    const harness = createDiscordAppHarness();
    const authManager = new authSessionManagerModule.DiscordAuthSessionManager();
    const handlers = botModule.createDiscordEventHandlers({
      app: harness.app,
      authManager,
      profileId: harness.profile.id,
    });

    const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO0pQn8AAAAASUVORK5CYII=";
    const textBody = "# Attached note\n\nHello from Discord.\n";
    const message = new FakeDirectMessage("");
    message.attachments.set("image-1", {
      name: "pixel.png",
      contentType: "image/png",
      size: Buffer.from(imageBase64, "base64").length,
      url: `data:image/png;base64,${imageBase64}`,
    });
    message.attachments.set("text-1", {
      name: "note.md",
      contentType: "text/markdown",
      size: Buffer.byteLength(textBody, "utf8"),
      url: `data:text/markdown;base64,${Buffer.from(textBody, "utf8").toString("base64")}`,
    });

    await handlers.handleMessage(message as unknown as Message);

    expect(message.replies[0]).toContain("Acknowledged:");

    const storedConversation = await harness.conversations.get(message.author.id);
    const firstMessage = storedConversation.messages.find((entry) =>
      isUserMessage(entry) && typeof entry.content !== "string"
    );
    expect(firstMessage).toBeDefined();
    expect(isUserMessage(firstMessage!)).toBe(true);

    const blocks = (firstMessage as UserMessage).content as ChatPromptContentBlock[];
    expect(blocks.some((block) => block.type === "image" && block.mimeType === "image/png")).toBe(true);
    expect(
      blocks.some((block) =>
        block.type === "image"
        && block.sourceUrl === `data:image/png;base64,${imageBase64}`
      ),
    ).toBe(true);
    expect(
      blocks.some((block) => block.type === "text" && block.text.includes("Attached image: pixel.png")),
    ).toBe(true);
    expect(
      blocks.some((block) => block.type === "text" && block.text.includes("--- file contents start ---")),
    ).toBe(true);
    expect(
      blocks.some((block) => block.type === "text" && block.text.includes("Hello from Discord.")),
    ).toBe(true);
  });

  test("preserves WebP attachment mime types in multimodal Discord content", async () => {
    const harness = createDiscordAppHarness();
    const authManager = new authSessionManagerModule.DiscordAuthSessionManager();
    const handlers = botModule.createDiscordEventHandlers({
      app: harness.app,
      authManager,
      profileId: harness.profile.id,
    });

    const imageBase64 = "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoIAAgAAkA4JaQAA3AA/vuUAAA=";
    const message = new FakeDirectMessage("");
    message.author.id = "discord-user-webp";
    message.attachments.set("image-1", {
      name: "pixel.webp",
      contentType: "image/webp",
      size: Buffer.from(imageBase64, "base64").length,
      url: `data:image/webp;base64,${imageBase64}`,
    });

    await handlers.handleMessage(message as unknown as Message);

    const storedConversation = await harness.conversations.get(message.author.id);
    const firstMessage = [...storedConversation.messages].reverse().find((entry) =>
      isUserMessage(entry) && typeof entry.content !== "string"
    );
    const blocks = (firstMessage as UserMessage).content as ChatPromptContentBlock[];

    expect(blocks.some((block) => block.type === "image" && block.mimeType === "image/webp")).toBe(true);
  });

  test("prefers detected image bytes over Discord attachment mime metadata", async () => {
    const harness = createDiscordAppHarness();
    const authManager = new authSessionManagerModule.DiscordAuthSessionManager();
    const handlers = botModule.createDiscordEventHandlers({
      app: harness.app,
      authManager,
      profileId: harness.profile.id,
    });

    const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO0pQn8AAAAASUVORK5CYII=";
    const message = new FakeDirectMessage("");
    message.author.id = "discord-user-mime-mismatch";
    message.attachments.set("image-1", {
      name: "pixel.png",
      contentType: "image/webp",
      size: Buffer.from(imageBase64, "base64").length,
      url: `data:image/png;base64,${imageBase64}`,
    });

    await handlers.handleMessage(message as unknown as Message);

    const storedConversation = await harness.conversations.get(message.author.id);
    const firstMessage = [...storedConversation.messages].reverse().find((entry) =>
      isUserMessage(entry) && typeof entry.content !== "string"
    );
    const blocks = (firstMessage as UserMessage).content as ChatPromptContentBlock[];

    expect(blocks.some((block) => block.type === "image" && block.mimeType === "image/png")).toBe(true);
    expect(blocks.some((block) => block.type === "image" && block.mimeType === "image/webp")).toBe(false);
  });

  test("combines continued DM fragments before dispatching to the assistant", async () => {
    const seenTexts: string[] = [];
    const harness = createDiscordAppHarness({
      connectorHandler: async (request) => {
        const latestHumanMsg = [...request.messages]
          .reverse()
          .find((message): message is UserMessage => isUserMessage(message));
        const text = latestHumanMsg ? extractTrailingUserText(lastTextContent(latestHumanMsg)) : "";
        seenTexts.push(text);
        return assistantTextMessage(`Acknowledged: ${text}`, {
          api: "scripted",
          provider: "scripted-discord-test",
          model: "scripted-model",
        });
      },
    });
    const authManager = new authSessionManagerModule.DiscordAuthSessionManager();
    const handlers = botModule.createDiscordEventHandlers({
      app: harness.app,
      authManager,
      profileId: harness.profile.id,
    });

    const firstMessage = new FakeDirectMessage("alpha /continued");
    const secondMessage = new FakeDirectMessage("beta /continued");
    const finalMessage = new FakeDirectMessage("gamma");

    await handlers.handleMessage(firstMessage as unknown as Message);
    await handlers.handleMessage(secondMessage as unknown as Message);
    await handlers.handleMessage(finalMessage as unknown as Message);

    expect(firstMessage.replies).toHaveLength(0);
    expect(secondMessage.replies).toHaveLength(0);
    expect(finalMessage.replies[0]).toContain("Acknowledged: alpha\nbeta\ngamma");
    expect(seenTexts.at(-1)).toBe("alpha\nbeta\ngamma");

    const storedConversation = await harness.conversations.get(finalMessage.author.id);
    const latestHumanMsg = [...storedConversation.messages]
      .reverse()
      .find((entry): entry is UserMessage => isUserMessage(entry));
    expect(latestHumanMsg).toBeDefined();
    expect(isUserMessage(latestHumanMsg!)).toBe(true);
    expect(extractTrailingUserText(lastTextContent(latestHumanMsg!))).toBe("alpha\nbeta\ngamma");
  });

  test("sends attached files back over Discord when the app response includes them", async () => {
    const authManager = new authSessionManagerModule.DiscordAuthSessionManager();
    const deliveredFile = path.join(tempRoot, "sandbox", "delivered.txt");
    fs.writeFileSync(deliveredFile, "discord delivery\n", "utf8");
    const handlers = botModule.createDiscordEventHandlers({
      app: {
        noteDiscordUser() {},
        stopConversation() {
          return { stopped: false, message: "No active agent is running for this conversation." };
        },
        async handleRequest(request: { id: string }) {
          return {
            requestId: request.id,
            mode: "immediate" as const,
            message: "Here is the file you asked for.",
            attachments: [{ path: deliveredFile, name: "delivered.txt" }],
          };
        },
        async invokeRoutineTool() {
          return "";
        },
        getActiveModel() {
          return { providerId: "openai-codex" as const };
        },
        getActiveProfile() {
          return { id: "root" };
        },
          getAgentRun() {
          return undefined;
        },
        listAgentRuns() {
          return [];
        },
      },
      authManager,
      profileId: "root",
    });
    const message = new FakeDirectMessage("send me the file");

    await handlers.handleMessage(message as unknown as Message);

    expect(message.replyPayloads[0]?.content).toContain("Here is the file you asked for.");
    expect((message.replyPayloads[0]?.files ?? [])).toHaveLength(1);
  });

  test("uses update preview by default through the custom command", async () => {
    const invoked: string[] = [];
    const authManager = new authSessionManagerModule.DiscordAuthSessionManager();
    const handlers = botModule.createDiscordEventHandlers({
      app: {
        noteDiscordUser() {},
        stopConversation() {
          return { stopped: false, message: "No active agent is running for this conversation." };
        },
        async handleRequest(request: { id: string }) {
          return {
            requestId: request.id,
            mode: "immediate" as const,
            message: "unused",
          };
        },
        async invokeRoutineTool(name: string) {
          invoked.push(name);
          if (name === "update_preview") {
            return "## 2026.03.21.38\n- Trivial README wording cleanup.";
          }
          throw new Error(`Unexpected tool: ${name}`);
        },
        getActiveModel() {
          return { providerId: "openai-codex" as const };
        },
        getActiveProfile() {
          return { id: "root" };
        },
          getAgentRun() {
          return undefined;
        },
        listAgentRuns() {
          return [];
        },
      },
      authManager,
      profileId: "root",
    });
    const interaction = new FakeInteraction("update");

    await handlers.handleInteraction(interaction as unknown as ChatInputCommandInteraction);

    expect(invoked).toEqual(["update_preview"]);
    const replyText = interaction.replies.map((reply) => reply.content).join("\n");
    expect(replyText).toContain("## 2026.03.21.38");
    expect(replyText).toContain("This syncs the source checkout, shows the latest remote tag, and tells you whether deployment is still pending.");
  });

  test("shows updating message when update is actually scheduled", async () => {
    const invoked: string[] = [];
    const authManager = new authSessionManagerModule.DiscordAuthSessionManager();
    const handlers = botModule.createDiscordEventHandlers({
      app: {
        noteDiscordUser() {},
        stopConversation() {
          return { stopped: false, message: "No active agent is running for this conversation." };
        },
        async handleRequest(request: { id: string }) {
          return {
            requestId: request.id,
            mode: "immediate" as const,
            message: "unused",
          };
        },
        async invokeRoutineTool(name: string) {
          invoked.push(name);
          if (name === "update") {
            return "Scheduled detached update helper.\nhelperLabel: com.openelinaro.bot.update-helper\nIMPORTANT: the update has been SCHEDULED but is NOT complete yet.";
          }
          throw new Error(`Unexpected tool: ${name}`);
        },
        getActiveModel() {
          return { providerId: "openai-codex" as const };
        },
        getActiveProfile() {
          return { id: "root" };
        },
          getAgentRun() {
          return undefined;
        },
        listAgentRuns() {
          return [];
        },
      },
      authManager,
      profileId: "root",
    });
    const interaction = new FakeInteraction("update", { confirm: true });

    await handlers.handleInteraction(interaction as unknown as ChatInputCommandInteraction);

    expect(invoked).toEqual(["update"]);
    const replyText = interaction.replies.map((reply) => reply.content).join("\n");
    expect(replyText).toContain("updating... don't send messages. you'll get `update complete` when it's done.");
    expect(replyText).not.toContain("Update skipped");
  });

  test("shows skip message instead of updating when versions already match", async () => {
    const invoked: string[] = [];
    const authManager = new authSessionManagerModule.DiscordAuthSessionManager();
    const handlers = botModule.createDiscordEventHandlers({
      app: {
        noteDiscordUser() {},
        stopConversation() {
          return { stopped: false, message: "No active agent is running for this conversation." };
        },
        async handleRequest(request: { id: string }) {
          return {
            requestId: request.id,
            mode: "immediate" as const,
            message: "unused",
          };
        },
        async invokeRoutineTool(name: string) {
          invoked.push(name);
          if (name === "update") {
            return "Update skipped: the deployed service is already at version 2026.03.24.4, which matches the pulled source version.\n\nNothing to deploy.";
          }
          throw new Error(`Unexpected tool: ${name}`);
        },
        getActiveModel() {
          return { providerId: "openai-codex" as const };
        },
        getActiveProfile() {
          return { id: "root" };
        },
          getAgentRun() {
          return undefined;
        },
        listAgentRuns() {
          return [];
        },
      },
      authManager,
      profileId: "root",
    });
    const interaction = new FakeInteraction("update", { confirm: true });

    await handlers.handleInteraction(interaction as unknown as ChatInputCommandInteraction);

    expect(invoked).toEqual(["update"]);
    const replyText = interaction.replies.map((reply) => reply.content).join("\n");
    // Must NOT say "updating" when there's nothing to update
    expect(replyText).not.toContain("updating... don't send messages");
    // Must show the actual skip reason so the user knows what happened
    expect(replyText).toContain("Update skipped");
    expect(replyText).toContain("already at version");
  });

  test("emulates an ablative Discord thread with compact and new inside the temp clone only", async () => {
    const harness = createDiscordAppHarness();
    const authManager = new authSessionManagerModule.DiscordAuthSessionManager();
    const handlers = botModule.createDiscordEventHandlers({
      app: harness.app,
      authManager,
      profileId: harness.profile.id,
    });
    const conversationKey = "discord-user";
    const helloMessage = new FakeDirectMessage("hello from the ablative thread");
    helloMessage.author.id = conversationKey;
    const resetMessage = new FakeDirectMessage("start over now");
    resetMessage.author.id = conversationKey;

    await handlers.handleMessage(helloMessage as unknown as Message);

    const compactInteraction = new FakeInteraction("compact", {
      input: JSON.stringify({ conversationKey }),
    });
    compactInteraction.user.id = conversationKey;
    await handlers.handleInteraction(compactInteraction as unknown as ChatInputCommandInteraction);

    await handlers.handleMessage(resetMessage as unknown as Message);

    const storedConversation = await harness.conversations.get(conversationKey);
    const tempMemoryRoot = path.join(tempRoot, ".openelinarotest", "memory");
    const tempMemoryFiles = listRelativeFiles(tempMemoryRoot);

    expect(helloMessage.replies[0]).toContain("Acknowledged: hello from the ablative thread");
    expect(compactInteraction.replies.map((reply) => reply.content).join("\n"))
      .toContain(`Compacted conversation ${conversationKey}.`);
    expect(compactInteraction.replies.map((reply) => reply.content).join("\n"))
      .toContain("Memory flushed to");
    expect(resetMessage.replies.join("\n")).toContain(`Started a new conversation for ${conversationKey}.`);
    expect(storedConversation.messages).toHaveLength(1);
    expect(isAssistantMessage(storedConversation.messages[0]!)).toBe(true);
    expect(lastTextContent(storedConversation.messages[0]!)).toContain("What do you want to work on next?");
    expect(tempMemoryFiles.some((entry) => entry.includes("documents/root/core/MEMORY.md"))).toBe(true);
    expect(readOptionalFile(path.join(machineTestRoot, "conversations.json"))).toBe(liveStateBefore.conversations);
    expect(listRelativeFiles(path.join(machineTestRoot, "memory"))).toEqual(liveStateBefore.memoryFiles);
  });

  test("supports new_chat force=true as a fast Discord reset without durable memory writes", async () => {
    const harness = createDiscordAppHarness();
    const authManager = new authSessionManagerModule.DiscordAuthSessionManager();
    const handlers = botModule.createDiscordEventHandlers({
      app: harness.app,
      authManager,
      profileId: harness.profile.id,
    });
    const conversationKey = "discord-user";
    const helloMessage = new FakeDirectMessage("hello before force reset");
    helloMessage.author.id = conversationKey;
    const fastResetInteraction = new FakeInteraction("new_chat", { force: true });
    fastResetInteraction.user.id = conversationKey;
    const tempMemoryRoot = path.join(tempRoot, ".openelinarotest", "memory");
    const memoryFilesBefore = listRelativeFiles(tempMemoryRoot);

    await handlers.handleMessage(helloMessage as unknown as Message);
    await handlers.handleInteraction(fastResetInteraction as unknown as ChatInputCommandInteraction);

    const storedConversation = await harness.conversations.get(conversationKey);

    expect(helloMessage.replies[0]).toContain("Acknowledged: hello before force reset");
    expect(fastResetInteraction.replies.map((reply) => reply.content).join("\n"))
      .toContain(`Started a new conversation for ${conversationKey}.`);
    expect(fastResetInteraction.replies.map((reply) => reply.content).join("\n"))
      .toContain("Durable memory flush was intentionally skipped.");
    expect(storedConversation.messages).toHaveLength(1);
    expect(isAssistantMessage(storedConversation.messages[0]!)).toBe(true);
    expect(lastTextContent(storedConversation.messages[0]!)).toContain("What do you want to work on next?");
    expect(listRelativeFiles(tempMemoryRoot)).toEqual(memoryFilesBefore);
    expect(readOptionalFile(path.join(machineTestRoot, "conversations.json"))).toBe(liveStateBefore.conversations);
    expect(listRelativeFiles(path.join(machineTestRoot, "memory"))).toEqual(liveStateBefore.memoryFiles);
  });

  test("keeps the DM typing indicator active while the main agent is still working", async () => {
    const releaseFirstTurnRef: { current?: () => void } = {};
    const firstTurnGate = new Promise<void>((resolve) => {
      releaseFirstTurnRef.current = resolve;
    });
    let firstTurnSeen = false;
    const harness = createDiscordAppHarness({
      connectorHandler: async (request) => {
        const latestHumanMsg = [...request.messages]
          .reverse()
          .find((message): message is UserMessage => isUserMessage(message));
        const text = latestHumanMsg ? extractTrailingUserText(lastTextContent(latestHumanMsg)) : "";
        if (text === "hold the line" && !firstTurnSeen) {
          firstTurnSeen = true;
          await firstTurnGate;
          return assistantTextMessage("First turn finished.", {
            api: "scripted",
            provider: "scripted-discord-test",
            model: "scripted-model",
          });
        }
        return assistantTextMessage(`Acknowledged: ${text}`, {
          api: "scripted",
          provider: "scripted-discord-test",
          model: "scripted-model",
        });
      },
    });
    const authManager = new authSessionManagerModule.DiscordAuthSessionManager();
    const typingTracker = botModule.createConversationTypingTracker();
    harness.chat.setConversationActivityNotifier(async ({ conversationKey, active }) => {
      await typingTracker.setActive(conversationKey, active);
    });
    const handlers = botModule.createDiscordEventHandlers({
      app: harness.app,
      authManager,
      profileId: harness.profile.id,
      typingTracker,
    });

    const firstMessage = new FakeDirectMessage("hold the line");
    const queuedMessage = new FakeDirectMessage("next turn please");

    const firstPromise = handlers.handleMessage(firstMessage as unknown as Message);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(firstMessage.channel.typingPulses).toBeGreaterThan(0);

    const queuedPromise = handlers.handleMessage(queuedMessage as unknown as Message);
    releaseFirstTurnRef.current?.();

    await firstPromise;
    await queuedPromise;

    expect(firstMessage.replies[0]).toContain("First turn finished.");
    expect(queuedMessage.replies.some((reply) => reply.includes("message accepted"))).toBe(true);
  });
  });
} else {
  describe("discord e2e flows", () => {
    test("passes in an isolated child process", () => {
      execFileSync(
        "bun",
        ["test", path.join(repoRoot, "src/integrations/discord/bot.e2e.test.ts")],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            OPENELINARO_DISCORD_E2E_CHILD: "1",
          },
          stdio: "pipe",
        },
      );
    }, 20_000);
  });
}
