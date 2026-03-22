import path from "node:path";
import {
  AttachmentBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  MessageFlags,
  Partials,
  SlashCommandBuilder,
  type Attachment,
  type ChatInputCommandInteraction,
  type Message,
  type SlashCommandOptionsOnlyBuilder,
} from "discord.js";
import { OpenElinaroApp } from "../../app/runtime";
import { getAuthStatus, getAuthStatusLines, hasAnyProviderAuth, hasProviderAuth } from "../../auth/store";
import { getRuntimeConfig } from "../../config/runtime-config";
import type {
  AppProgressEvent,
  AppRequest,
  AppResponse,
  AppResponseAttachment,
  ChatPromptContentBlock,
} from "../../domain/assistant";
import type { RoutineItemKind, RoutinePriority, Weekday } from "../../domain/routines";
import type { ModelProviderId } from "../../services/model-service";
import { buildChatPromptContent } from "../../services/message-content-service";
import { AgentHealthcheckService } from "../../services/agent-healthcheck-service";
import { DISCORD_MAX_ATTACHMENT_BYTES as MAX_IMAGE_ATTACHMENT_BYTES, DISCORD_MAX_TEXT_ATTACHMENT_BYTES as MAX_TEXT_ATTACHMENT_BYTES } from "../../config/service-constants";
import { sanitizeDiscordText } from "../../services/discord-response-service";
import { ProfileService } from "../../services/profile-service";
import { SecretStoreService } from "../../services/secret-store-service";
import { telemetry } from "../../services/telemetry";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { getRuntimeUserFacingToolNames } from "../../tools/tool-registry";
import { DiscordAuthSessionManager } from "./auth-session-manager";
import { DiscordRoutinesNotifier } from "./routines-notifier";

const ROUTINE_KIND_CHOICES: { name: string; value: RoutineItemKind }[] = [
  { name: "todo", value: "todo" },
  { name: "routine", value: "routine" },
  { name: "habit", value: "habit" },
  { name: "med", value: "med" },
  { name: "deadline", value: "deadline" },
  { name: "precommitment", value: "precommitment" },
];

const ROUTINE_PRIORITY_CHOICES: { name: string; value: RoutinePriority }[] = [
  { name: "low", value: "low" },
  { name: "medium", value: "medium" },
  { name: "high", value: "high" },
  { name: "urgent", value: "urgent" },
];

const MODEL_PROVIDER_CHOICES: { name: string; value: ModelProviderId }[] = [
  { name: "openai-codex", value: "openai-codex" },
  { name: "claude", value: "claude" },
];

const PROFILE_ACTION_CHOICES = [
  { name: "show", value: "show" },
  { name: "set", value: "set" },
  { name: "list", value: "list" },
  { name: "auth", value: "auth" },
] as const;

const PROFILE_AUTH_PROVIDER_CHOICES = [
  { name: "status", value: "status" },
  { name: "codex", value: "codex" },
  { name: "claude", value: "claude" },
] as const;

const THINKING_LEVEL_CHOICES = [
  { name: "minimal", value: "minimal" },
  { name: "low", value: "low" },
  { name: "medium", value: "medium" },
  { name: "high", value: "high" },
  { name: "xhigh", value: "xhigh" },
] as const;

const DISCORD_MESSAGE_LIMIT = 1_900;
const DISCORD_TYPING_REFRESH_MS = 8_000;
const DISCORD_DM_BATCH_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TEXT_ATTACHMENT_CHARS = 32_000;
const DEFAULT_PROFILE_THINKING_LEVEL = "low";
const DISCORD_CONTINUED_SUFFIX = "/continued";
const discordTelemetry = telemetry.child({ component: "discord" });
const TOOL_COMMAND_EXCLUSIONS = new Set<string>([
  "routine_check",
  "routine_list",
  "routine_add",
  "routine_done",
  "routine_undo_done",
  "routine_snooze",
  "routine_skip",
  "routine_pause",
  "routine_resume",
  "profile_set_defaults",
  "update",
]);
type ProfileCommandAction = "list" | "show" | "set" | "auth";
type DerivedToolCommandBuilder = (toolName: string) => SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;
type DerivedToolInputBuilder = (interaction: ChatInputCommandInteraction) => unknown;

const TOOL_DERIVED_COMMAND_BUILDERS: Partial<Record<string, DerivedToolCommandBuilder>> = {
  new_chat: (toolName) =>
    new SlashCommandBuilder()
      .setName(toolName)
      .setDescription("Start a fresh conversation for your Discord chat session")
      .addBooleanOption((option) =>
        option
          .setName("force")
          .setDescription("Skip the durable-memory flush and reset immediately")
          .setRequired(false),
      ),
  compact: (toolName) =>
    new SlashCommandBuilder()
      .setName(toolName)
      .setDescription("Compact the current Discord conversation into a shorter continuation state"),
  reflect: (toolName) =>
    new SlashCommandBuilder()
      .setName(toolName)
      .setDescription("Write a private reflection entry to the active profile journal")
      .addStringOption((option) =>
        option
          .setName("focus")
          .setDescription("Optional focus for this reflection entry")
          .setRequired(false),
      ),
  reload: (toolName) =>
    new SlashCommandBuilder()
      .setName(toolName)
      .setDescription("Reload the current conversation's system prompt snapshot"),
  context: (toolName) =>
    new SlashCommandBuilder()
      .setName(toolName)
      .setDescription("Show the current context-window token usage")
      .addStringOption((option) =>
        option
          .setName("mode")
          .setDescription("Optional output mode")
          .setRequired(false)
          .addChoices(
            { name: "v", value: "v" },
            { name: "full", value: "full" },
          ),
      ),
};

const TOOL_DERIVED_INPUT_BUILDERS: Partial<Record<string, DerivedToolInputBuilder>> = {
  new_chat: (interaction) => ({
    ...(interaction.options.getBoolean("force") === true ? { force: true } : {}),
  }),
  compact: () => ({}),
  reflect: (interaction) => ({
    focus: interaction.options.getString("focus") ?? undefined,
  }),
  reload: () => ({}),
  context: (interaction) => ({
    ...(interaction.options.getString("mode") ? { mode: interaction.options.getString("mode") } : {}),
  }),
};

const traceSpan = createTraceSpan(discordTelemetry);

function getAutoRegisteredToolCommandNames() {
  return getRuntimeUserFacingToolNames().filter((name) =>
    !TOOL_COMMAND_EXCLUSIONS.has(name)
  );
}

function getAutoRegisteredToolCommandNameSet() {
  return new Set<string>(getAutoRegisteredToolCommandNames());
}

function getDiscordOptionalSubcommand(interaction: ChatInputCommandInteraction) {
  try {
    return interaction.options.getSubcommand(false) as ProfileCommandAction | null;
  } catch {
    return null;
  }
}

function getProfileCommandAction(interaction: ChatInputCommandInteraction): ProfileCommandAction {
  const legacySubcommand = getDiscordOptionalSubcommand(interaction);
  if (legacySubcommand) {
    return legacySubcommand;
  }

  const action = interaction.options.getString("action") as ProfileCommandAction | null;
  if (action) {
    return action;
  }

  if (interaction.options.getString("auth_provider")) {
    return "auth";
  }

  if (interaction.options.getString("model") || interaction.options.getString("provider") || interaction.options.getString("thinking")) {
    return "set";
  }

  return "show";
}

export interface DiscordAppRuntime {
  noteDiscordUser(userId: string): void;
  stopConversation(conversationKey: string): { stopped: boolean; message: string };
  handleRequest(
    request: AppRequest,
    options?: {
      onBackgroundResponse?: (response: AppResponse) => Promise<void>;
      onToolUse?: (event: AppProgressEvent) => Promise<void>;
      typingEligible?: boolean;
    },
  ): Promise<AppResponse>;
  invokeRoutineTool(
    name: string,
    input: unknown,
    options?: {
      conversationKey?: string;
      onToolUse?: (event: AppProgressEvent) => Promise<void>;
    },
  ): Promise<string>;
  getActiveModel(): { providerId: ModelProviderId };
  getActiveProfile(): { id: string };
  getAgentRun(runId: string): ReturnType<OpenElinaroApp["getAgentRun"]>;
  listAgentRuns(): ReturnType<OpenElinaroApp["listAgentRuns"]>;
}

export interface DiscordBatchedDirectMessage {
  message: Message;
  content: string;
  attachments: Attachment[];
  reason: "completed" | "timeout";
}

interface PendingDiscordDirectMessageBatch {
  message: Message;
  parts: string[];
  attachments: Attachment[];
  timer?: ReturnType<typeof setTimeout>;
}

function nextRequestId(prefix: string) {
  return `${prefix}-${Date.now()}`;
}

function isDirectMessage(message: Message): boolean {
  return message.channel.type === ChannelType.DM;
}

function getDiscordDirectMessageBatchKey(message: Pick<Message, "author" | "channelId">) {
  return `${message.author.id}:${message.channelId}`;
}

function splitContinuedDiscordMessage(text: string) {
  const trimmed = text.trim();
  if (!trimmed.toLowerCase().endsWith(DISCORD_CONTINUED_SUFFIX)) {
    return {
      content: trimmed,
      continued: false,
    };
  }

  return {
    content: trimmed.slice(0, trimmed.length - DISCORD_CONTINUED_SUFFIX.length).trimEnd(),
    continued: true,
  };
}

function joinDiscordMessageBatchParts(parts: string[]) {
  return parts.filter((part) => part.length > 0).join("\n");
}

export function createDiscordDmMessageBatcher(params: {
  onDispatch: (message: DiscordBatchedDirectMessage) => Promise<void>;
  timeoutMs?: number;
  scheduleTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearScheduledTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const batches = new Map<string, PendingDiscordDirectMessageBatch>();
  const timeoutMs = params.timeoutMs ?? DISCORD_DM_BATCH_TIMEOUT_MS;
  const scheduleTimeout = params.scheduleTimeout ?? ((callback: () => void, delayMs: number) =>
    setTimeout(callback, delayMs));
  const clearScheduledTimeout = params.clearScheduledTimeout ?? ((timer: ReturnType<typeof setTimeout>) =>
    clearTimeout(timer));

  const clearBatchTimer = (batch: PendingDiscordDirectMessageBatch) => {
    if (!batch.timer) {
      return;
    }
    clearScheduledTimeout(batch.timer);
    batch.timer = undefined;
  };

  const dispatchBatch = async (batchKey: string, reason: DiscordBatchedDirectMessage["reason"]) => {
    const batch = batches.get(batchKey);
    if (!batch) {
      return false;
    }

    batches.delete(batchKey);
    clearBatchTimer(batch);

    const content = joinDiscordMessageBatchParts(batch.parts);
    if (!content && batch.attachments.length === 0) {
      return false;
    }

    await params.onDispatch({
      message: batch.message,
      content,
      attachments: [...batch.attachments],
      reason,
    });
    return true;
  };

  const scheduleBatchTimeout = (batchKey: string, batch: PendingDiscordDirectMessageBatch) => {
    clearBatchTimer(batch);
    batch.timer = scheduleTimeout(() => {
      void dispatchBatch(batchKey, "timeout").catch((error) => {
        discordTelemetry.event(
          "discord.message.batch_timeout_dispatch.error",
          {
            batchKey,
            error: error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : String(error),
          },
          { level: "error", outcome: "error" },
        );
      });
    }, timeoutMs);
  };

  return {
    async handleMessage(message: Message) {
      const batchKey = getDiscordDirectMessageBatchKey(message);
      const { content, continued } = splitContinuedDiscordMessage(message.content);
      const attachments = [...message.attachments.values()];
      const existingBatch = batches.get(batchKey);

      if (!continued && !existingBatch) {
        await params.onDispatch({
          message,
          content,
          attachments,
          reason: "completed",
        });
        return "dispatched" as const;
      }

      const batch = existingBatch ?? {
        message,
        parts: [],
        attachments: [],
      };
      if (!existingBatch) {
        batches.set(batchKey, batch);
      }

      batch.message = message;
      if (content) {
        batch.parts.push(content);
      }
      batch.attachments.push(...attachments);

      if (continued) {
        scheduleBatchTimeout(batchKey, batch);
        return "buffered" as const;
      }

      await dispatchBatch(batchKey, "completed");
      return "dispatched" as const;
    },
    clear(message: Pick<Message, "author" | "channelId">) {
      const batchKey = getDiscordDirectMessageBatchKey(message);
      const batch = batches.get(batchKey);
      if (!batch) {
        return false;
      }

      batches.delete(batchKey);
      clearBatchTimer(batch);
      return true;
    },
    hasPending(message: Pick<Message, "author" | "channelId">) {
      return batches.has(getDiscordDirectMessageBatchKey(message));
    },
  };
}

export function createConversationTypingTracker() {
  const states = new Map<string, {
    channel?: {
      sendTyping: () => Promise<unknown>;
    };
    active: boolean;
    timer?: ReturnType<typeof setTimeout>;
  }>();

  const scheduleNextPulse = (conversationKey: string, state: {
    channel?: { sendTyping: () => Promise<unknown> };
    active: boolean;
    timer?: ReturnType<typeof setTimeout>;
  }) => {
    state.timer = setTimeout(() => {
      void pulse(conversationKey);
    }, DISCORD_TYPING_REFRESH_MS);
  };

  const pulse = async (conversationKey: string) => {
    const state = states.get(conversationKey);
    if (!state?.active || !state.channel) {
      return;
    }

    try {
      await state.channel.sendTyping();
    } catch (error) {
      discordTelemetry.event(
        "discord.typing_indicator.error",
        {
          conversationKey,
          error: error instanceof Error ? error.message : String(error),
        },
        { level: "debug", outcome: "error" },
      );
    }

    if (state.active) {
      scheduleNextPulse(conversationKey, state);
    }
  };

  return {
    noteChannel(conversationKey: string, message: Message) {
      if (!("sendTyping" in message.channel) || typeof message.channel.sendTyping !== "function") {
        return;
      }

      const existing = states.get(conversationKey);
      if (existing) {
        existing.channel = message.channel;
        if (existing.active && !existing.timer) {
          void pulse(conversationKey);
        }
        return;
      }

      const state: {
        channel?: {
          sendTyping: () => Promise<unknown>;
        };
        active: boolean;
        timer?: ReturnType<typeof setTimeout>;
      } = {
        channel: message.channel,
        active: false,
      };
      states.set(conversationKey, state);
      if (state.active && !state.timer) {
        void pulse(conversationKey);
      }
    },
    async setActive(conversationKey: string, active: boolean) {
      const state = states.get(conversationKey) ?? {
        active: false,
      };
      states.set(conversationKey, state);

      if (state.active === active) {
        return;
      }

      state.active = active;
      if (!active) {
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = undefined;
        }
        return;
      }

      if (!state.channel) {
        return;
      }

      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
      }
      await pulse(conversationKey);
    },
  };
}

export async function startDiscordBot() {
  const config = getRuntimeConfig();
  const token = new SecretStoreService().resolveSecretRef(config.core.discord.botTokenSecretRef);
  if (!token) {
    throw new Error(
      `Missing Discord bot token secret ${config.core.discord.botTokenSecretRef}. Run bun src/cli/bootstrap.ts first.`,
    );
  }

  const app = new OpenElinaroApp();
  const healthchecks = new AgentHealthcheckService();
  const typingTracker = createConversationTypingTracker();
  app.setBackgroundConversationNotifier(async ({ conversationKey, response }) => {
    const user = await client.users.fetch(conversationKey);
    const dm = await user.createDM();
    await sendAppResponseToChannel(dm, response);
  });
  app.setConversationActivityNotifier(async ({ conversationKey, active }) => {
    await typingTracker.setActive(conversationKey, active);
  });
  const authManager = new DiscordAuthSessionManager();
  const profileId = app.getActiveProfile().id;
  const handlers = createDiscordEventHandlers({
    app,
    authManager,
    profileId,
    typingTracker,
  });
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  app.setCacheMissWarningNotifier(async (warning) => {
    const userId = app.getNotificationTargetUserId();
    if (!userId) {
      discordTelemetry.event(
        "discord.cache_miss_warning.no_target",
        {
          conversationKey: warning.conversationKey,
          providerId: warning.providerId,
          modelId: warning.modelId,
        },
        { level: "debug" },
      );
      return;
    }

    const user = await client.users.fetch(userId);
    const dm = await user.createDM();
    await dm.send(warning.message);
    discordTelemetry.event("discord.cache_miss_warning.sent", {
      userId,
      conversationKey: warning.conversationKey,
      providerId: warning.providerId,
      modelId: warning.modelId,
    });
  });

  client.once(Events.ClientReady, async (readyClient) => {
    await syncSlashCommands(readyClient);
    new DiscordRoutinesNotifier(readyClient, app).start();
    healthchecks.start({
      run: async ({ requestId, conversationKey, prompt, onBackgroundResponse }) =>
        app.handleRequest(
          {
            id: requestId,
            kind: "chat",
            text: prompt,
            conversationKey,
          },
          {
            onBackgroundResponse: onBackgroundResponse
              ? async (response) => onBackgroundResponse(response.message)
              : undefined,
            onToolUse: async () => {},
            typingEligible: false,
          },
        ),
    });
    discordTelemetry.event("discord.ready", {
      botTag: readyClient.user.tag,
    });
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    await handlers.handleInteraction(interaction);
  });

  client.on(Events.MessageCreate, async (message) => {
    await handlers.handleMessage(message);
  });

  await client.login(token);
}

export function createDiscordEventHandlers(params: {
  app: DiscordAppRuntime;
  authManager: DiscordAuthSessionManager;
  profileId?: string;
  typingTracker?: ReturnType<typeof createConversationTypingTracker>;
}) {
  const profileId = params.profileId ?? params.app.getActiveProfile().id;

  const dispatchDirectMessage = async ({
    message,
    content,
    attachments,
    reason,
  }: DiscordBatchedDirectMessage) => {
    params.typingTracker?.noteChannel(message.author.id, message);
    const request = await buildMessageRequest(message.author.id, content, attachments.values());
    const response = await discordTelemetry.run({
      component: "discord",
      conversationKey: message.author.id,
      attributes: {
        userId: message.author.id,
        channelId: message.channelId,
        isDirectMessage: true,
        requestKind: request.kind,
        contentLength: content.length,
        attachmentCount: attachments.length,
        requestId: request.id,
        batchReason: reason,
      },
    }, async () => {
      discordTelemetry.event("discord.message.received", {
        userId: message.author.id,
        channelId: message.channelId,
        isDirectMessage: true,
        requestKind: request.kind,
        contentLength: content.length,
        attachmentCount: attachments.length,
        requestId: request.id,
        batchReason: reason,
      });
      return traceSpan(
        "discord.dm_request",
        async () => params.app.handleRequest(request, {
          onBackgroundResponse: async (queuedResponse) => {
            await replyToMessageWithAppResponse(message, queuedResponse);
          },
          onToolUse: async (event) => {
            const update = normalizeDiscordProgressUpdate(event);
            await replyToMessageWithChunks(message, update.message, {
              files: update.files,
            });
          },
        }),
        {
          attributes: {
            userId: message.author.id,
            requestKind: request.kind,
            requestId: request.id,
            batchReason: reason,
          },
        },
      );
    });
    await replyToMessageWithAppResponse(message, response);
  };

  const dmMessageBatcher = createDiscordDmMessageBatcher({
    onDispatch: dispatchDirectMessage,
  });

  return {
    handleInteraction: async (interaction: Interaction) => {
      if (!interaction.isChatInputCommand()) {
        return;
      }

      try {
        params.app.noteDiscordUser(interaction.user.id);
        await traceSpan(
          "discord.interaction",
          async () =>
            handleSlashCommand({
              interaction,
              app: params.app,
              authManager: params.authManager,
              profileId,
            }),
          {
            attributes: {
              commandName: interaction.commandName,
              userId: interaction.user.id,
              channelId: interaction.channelId,
            },
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (interaction.replied) {
          await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
        } else if (interaction.deferred) {
          await interaction.editReply({ content: message });
        } else {
          await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
        }
      }
    },
    handleMessage: async (message: Message) => {
      if (message.author.bot) {
        return;
      }

      params.app.noteDiscordUser(message.author.id);
      const content = message.content.trim();
      const hasAttachments = message.attachments.size > 0;
      if (!content && !hasAttachments) {
        if (!hasAnyProviderAuth(profileId)) {
          await replyToMessageWithChunks(message, "There's no auth setup yet. Use `/auth` to set it up.");
        }
        return;
      }

      if (
        isDirectMessage(message) &&
        content &&
        params.authManager.consumePromptResponse(message.author.id, content)
      ) {
        dmMessageBatcher.clear(message);
        return;
      }

      if (isDirectMessage(message) && content && isStopCommandContent(content)) {
        dmMessageBatcher.clear(message);
        const stopped = params.app.stopConversation(message.author.id);
        await replyToMessageWithChunks(message, stopped.message);
        return;
      }

      if (!hasAnyProviderAuth(profileId)) {
        await replyToMessageWithChunks(message, "There's no auth setup yet. Use `/auth` to set it up.");
        return;
      }

      if (!isDirectMessage(message)) {
        return;
      }

      try {
        await dmMessageBatcher.handleMessage(message);
      } catch (error) {
        discordTelemetry.event(
          "discord.message.error",
          {
            userId: message.author.id,
            channelId: message.channelId,
            error: error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : String(error),
          },
          { level: "error", outcome: "error" },
        );
        await replyToMessageWithChunks(message, error instanceof Error ? error.message : String(error));
      }
    },
  };
}

async function handleSlashCommand(params: {
  interaction: ChatInputCommandInteraction;
  app: DiscordAppRuntime;
  authManager: DiscordAuthSessionManager;
  profileId: string;
}) {
  const { interaction, app, authManager, profileId } = params;

  if (interaction.commandName === "hello") {
    await replyWithChunks(interaction, "Hello world from openelinaro.");
    return;
  }

  if (interaction.commandName === "auth") {
    const provider = interaction.options.getString("provider", true);
    const targetProfile = getDiscordTargetProfile(
      profileId,
      interaction.options.getString("profile") ?? undefined,
    );

    if (provider === "status") {
      await replyWithChunks(interaction, getAuthStatusLines(targetProfile.id).join("\n"), {
        ephemeral: true,
      });
      return;
    }

    if (provider === "codex") {
      await replyWithChunks(interaction, `Check your DMs to continue Codex auth for profile ${targetProfile.id}.`, {
        ephemeral: true,
      });
      await beginDirectMessageAuth(interaction, () =>
        authManager.startCodexOAuthFlowForProfile(targetProfile.id, interaction.user.id, async (text) => {
          const dm = await interaction.user.createDM();
          await dm.send(text);
        }),
      );
      return;
    }

    await replyWithChunks(interaction, `Check your DMs to continue Claude auth for profile ${targetProfile.id}.`, {
      ephemeral: true,
    });
    await beginDirectMessageAuth(interaction, () =>
      authManager.startClaudeSetupTokenFlowForProfile(targetProfile.id, interaction.user.id, async (text) => {
        const dm = await interaction.user.createDM();
        await dm.send(text);
      }),
    );
    return;
  }

  if (interaction.commandName === "profile") {
    const legacySubcommand = getDiscordOptionalSubcommand(interaction);
    const action = getProfileCommandAction(interaction);

    if (action === "list") {
      await replyWithChunks(
        interaction,
        formatLaunchableProfileList(profileId),
        { ephemeral: true },
      );
      return;
    }

    const targetProfile = getDiscordTargetProfile(
      profileId,
      interaction.options.getString("profile") ?? undefined,
    );

    if (action === "show") {
      await replyWithChunks(interaction, formatLaunchableProfileDetails(profileId, targetProfile.id), {
        ephemeral: true,
      });
      return;
    }

    if (action === "set") {
      const modelId = interaction.options.getString("model") ?? undefined;
      const provider = legacySubcommand === "auth"
        ? null
        : interaction.options.getString("provider") as ModelProviderId | null;
      const thinkingLevel = interaction.options.getString("thinking") ?? undefined;
      if (!modelId && !thinkingLevel) {
        throw new Error("Provide model and/or thinking to update profile defaults.");
      }
      await invokeDiscordToolAndReply(interaction, app, "profile_set_defaults", {
        profileId: targetProfile.id,
        ...(provider ? { provider } : {}),
        ...(modelId ? { modelId } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      });
      return;
    }

    const provider = legacySubcommand === "auth"
      ? interaction.options.getString("provider")
      : interaction.options.getString("auth_provider");
    if (!provider) {
      throw new Error("auth_provider is required when action=auth.");
    }
    if (provider === "status") {
      await replyWithChunks(interaction, getAuthStatusLines(targetProfile.id).join("\n"), {
        ephemeral: true,
      });
      return;
    }

    if (provider === "codex") {
      await replyWithChunks(interaction, `Check your DMs to continue Codex auth for profile ${targetProfile.id}.`, {
        ephemeral: true,
      });
      await beginDirectMessageAuth(interaction, () =>
        authManager.startCodexOAuthFlowForProfile(targetProfile.id, interaction.user.id, async (text) => {
          const dm = await interaction.user.createDM();
          await dm.send(text);
        }),
      );
      return;
    }

    await replyWithChunks(interaction, `Check your DMs to continue Claude auth for profile ${targetProfile.id}.`, {
      ephemeral: true,
    });
    await beginDirectMessageAuth(interaction, () =>
      authManager.startClaudeSetupTokenFlowForProfile(targetProfile.id, interaction.user.id, async (text) => {
        const dm = await interaction.user.createDM();
        await dm.send(text);
      }),
    );
    return;
  }

  if (interaction.commandName === "workflow") {
    await deferInteractionReply(interaction);
    const action = interaction.options.getString("action", true);

    if (action === "demo") {
      await replyWithChunks(interaction, "Demo workflow is no longer available. Use launch_agent tool from chat instead.");
      return;
    }

    const runId = interaction.options.getString("run_id") ?? undefined;
    const run = runId ? app.getAgentRun(runId) : app.listAgentRuns().at(-1);
    if (!run) {
      await replyWithChunks(interaction, "No agent run found.");
      return;
    }

    await replyWithChunks(
      interaction,
      [
        `Run: ${run.id}`,
        `Provider: ${run.provider}`,
        `Status: ${run.status}`,
        `Goal: ${run.goal}`,
        run.workspaceCwd ? `Workspace: ${run.workspaceCwd}` : "",
        `Summary: ${run.resultSummary ?? "pending"}`,
      ].join("\n"),
    );
    return;
  }

  if (interaction.commandName === "update") {
    const confirm = interaction.options.getBoolean("confirm") ?? false;
    if (!confirm) {
      const preview = await app.invokeRoutineTool("update_preview", {});
      await replyWithChunks(
        interaction,
        [
          preview,
          "",
          "This syncs the source checkout, shows the latest remote tag, and tells you whether deployment is still pending. Run `/update confirm:true` to deploy if needed.",
        ].join("\n"),
      );
      return;
    }
    await deferInteractionReply(interaction);
    await app.invokeRoutineTool("update", {}, {
      conversationKey: getDiscordConversationKey(interaction),
    });
    await replyWithChunks(
      interaction,
      "updating... don't send messages. you'll get `update complete` when it's done.",
    );
    return;
  }

  if (interaction.commandName === "stop") {
    await replyWithChunks(interaction, app.stopConversation(getDiscordConversationKey(interaction)).message);
    return;
  }

  if (getAutoRegisteredToolCommandNameSet().has(interaction.commandName)) {
    await invokeDerivedToolCommand(interaction, app, interaction.commandName);
    return;
  }

  if (interaction.commandName === "routine") {
    await handleRoutineCommand(interaction, app);
    return;
  }

  if (interaction.commandName === "todo") {
    const text = interaction.options.getString("text", true);
    await invokeDiscordToolAndReply(interaction, app, "routine_add", {
      title: text,
      kind: "todo",
      priority: "medium",
      description: text,
      scheduleKind: "once",
      dueAt: new Date().toISOString(),
    });
    return;
  }

  if (interaction.commandName === "med") {
    const text = interaction.options.getString("text", true);
    await invokeDiscordToolAndReply(interaction, app, "routine_add", {
      title: text,
      kind: "med",
      priority: "high",
      description: text,
      scheduleKind: "manual",
    });
    return;
  }

  const activeModel = app.getActiveModel();
  if (!hasProviderAuth(activeModel.providerId, profileId)) {
    await replyWithChunks(
      interaction,
      `${activeModel.providerId} chat auth is not set up yet. Use \`/auth provider:${activeModel.providerId === "openai-codex" ? "codex" : "claude"}\`.`,
      {
        ephemeral: true,
      },
    );
    return;
  }

  if (interaction.commandName === "chat") {
    await deferInteractionReply(interaction);
    const text = interaction.options.getString("text", true);
    const response = await app.handleRequest(
      {
        id: nextRequestId("chat"),
        kind: "chat",
        text,
        conversationKey: interaction.user.id,
      },
      {
        onBackgroundResponse: async (queuedResponse) => {
          await replyWithAppResponse(interaction, queuedResponse);
        },
        onToolUse: async (event) => {
          const update = normalizeDiscordProgressUpdate(event);
          await replyWithChunks(interaction, update.message, {
            files: update.files,
          });
        },
      },
    );
    await replyWithAppResponse(interaction, response);
  }
}

function buildSlashCommands() {
  return [
    new SlashCommandBuilder().setName("hello").setDescription("Minimal hello-world check"),
    new SlashCommandBuilder()
      .setName("auth")
      .setDescription("Set up or inspect provider auth")
      .addStringOption((option) =>
        option
          .setName("provider")
          .setDescription("Which auth flow to run")
          .setRequired(true)
          .addChoices(
            { name: "status", value: "status" },
            { name: "codex", value: "codex" },
            { name: "claude", value: "claude" },
          ),
      )
      .addStringOption((option) =>
        option
          .setName("profile")
          .setDescription("Launchable profile id to configure; defaults to the active profile")
          .setRequired(false),
      ),
    new SlashCommandBuilder()
      .setName("profile")
      .setDescription("Inspect or update launchable profile settings")
      .addStringOption((option) =>
        option
          .setName("action")
          .setDescription("Defaults to show; inferred from model/thinking or auth_provider when omitted")
          .setRequired(false)
          .addChoices(...PROFILE_ACTION_CHOICES),
      )
      .addStringOption((option) =>
        option
          .setName("profile")
          .setDescription("Profile id; defaults to the active profile")
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName("provider")
          .setDescription("Model provider; auto-detected from model when omitted")
          .setRequired(false)
          .addChoices(...MODEL_PROVIDER_CHOICES),
      )
      .addStringOption((option) =>
        option
          .setName("model")
          .setDescription("Model id or shorthand such as gpt or opus")
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName("thinking")
          .setDescription("Default thinking level")
          .setRequired(false)
          .addChoices(...THINKING_LEVEL_CHOICES),
      )
      .addStringOption((option) =>
        option
          .setName("auth_provider")
          .setDescription("Auth status or provider flow; implies action=auth when supplied")
          .setRequired(false)
          .addChoices(...PROFILE_AUTH_PROVIDER_CHOICES),
      ),
    new SlashCommandBuilder()
      .setName("workflow")
      .setDescription("Create or inspect background workflows")
      .addStringOption((option) =>
        option
          .setName("action")
          .setDescription("Workflow action")
          .setRequired(true)
          .addChoices(
            { name: "demo", value: "demo" },
            { name: "status", value: "status" },
          ),
      )
      .addStringOption((option) =>
        option
          .setName("run_id")
          .setDescription("Workflow run id for status lookup")
          .setRequired(false),
      ),
    new SlashCommandBuilder()
      .setName("update")
      .setDescription("Preview or apply the latest fast-forward git changes into the source workspace")
      .addBooleanOption((option) =>
        option
          .setName("confirm")
          .setDescription("Set true to apply the update. Omit or set false to preview only.")
          .setRequired(false),
      ),
    new SlashCommandBuilder()
      .setName("stop")
      .setDescription("Immediately halt the current Discord conversation agent"),
    ...getAutoRegisteredToolCommandNames().map((toolName) =>
      buildDerivedToolSlashCommand(toolName)),
    new SlashCommandBuilder()
      .setName("routine")
      .setDescription("Manage routines, meds, deadlines, and recurring work")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("add")
          .setDescription("Add a routine item")
          .addStringOption((option) =>
            option.setName("title").setDescription("Title").setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("kind")
              .setDescription("Routine item kind")
              .setRequired(true)
              .addChoices(...ROUTINE_KIND_CHOICES),
          )
          .addStringOption((option) =>
            option
              .setName("priority")
              .setDescription("Priority")
              .setRequired(false)
              .addChoices(...ROUTINE_PRIORITY_CHOICES),
          )
          .addStringOption((option) =>
            option
              .setName("schedule")
              .setDescription("Schedule kind")
              .setRequired(false)
              .addChoices(
                { name: "manual", value: "manual" },
                { name: "once", value: "once" },
                { name: "daily", value: "daily" },
                { name: "weekly", value: "weekly" },
                { name: "interval", value: "interval" },
                { name: "monthly", value: "monthly" },
              ),
          )
          .addStringOption((option) =>
            option
              .setName("time")
              .setDescription("Time as HH:MM for daily/weekly/interval/monthly")
              .setRequired(false),
          )
          .addStringOption((option) =>
            option
              .setName("days")
              .setDescription("Comma-separated weekdays for weekly, e.g. mon,wed,fri")
              .setRequired(false),
          )
          .addStringOption((option) =>
            option
              .setName("due_at")
              .setDescription("Once due time, ISO or YYYY-MM-DD HH:MM")
              .setRequired(false),
          )
          .addIntegerOption((option) =>
            option
              .setName("every_days")
              .setDescription("Interval length in days")
              .setRequired(false)
              .setMinValue(1),
          )
          .addIntegerOption((option) =>
            option
              .setName("day_of_month")
              .setDescription("Day of month for monthly schedules")
              .setRequired(false)
              .setMinValue(1)
              .setMaxValue(31),
          )
          .addStringOption((option) =>
            option
              .setName("notes")
              .setDescription("Description or notes")
              .setRequired(false),
          )
          .addStringOption((option) =>
            option
              .setName("dose")
              .setDescription("Medication dose")
              .setRequired(false),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("list").setDescription("List known routine items"),
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("check").setDescription("Show what needs attention right now"),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("done")
          .setDescription("Mark a routine item completed")
          .addStringOption((option) =>
            option.setName("id").setDescription("Routine item id").setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("undo")
          .setDescription("Undo the most recent completion for a routine item")
          .addStringOption((option) =>
            option.setName("id").setDescription("Routine item id").setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("snooze")
          .setDescription("Snooze a routine item")
          .addStringOption((option) =>
            option.setName("id").setDescription("Routine item id").setRequired(true),
          )
          .addIntegerOption((option) =>
            option
              .setName("minutes")
              .setDescription("Snooze length in minutes")
              .setRequired(true)
              .setMinValue(1),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("skip")
          .setDescription("Skip the current occurrence of a routine item")
          .addStringOption((option) =>
            option.setName("id").setDescription("Routine item id").setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("pause")
          .setDescription("Pause a routine item")
          .addStringOption((option) =>
            option.setName("id").setDescription("Routine item id").setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("resume")
          .setDescription("Resume a paused routine item")
          .addStringOption((option) =>
            option.setName("id").setDescription("Routine item id").setRequired(true),
          ),
      ),
    new SlashCommandBuilder()
      .setName("todo")
      .setDescription("Save a todo item")
      .addStringOption((option) =>
        option.setName("text").setDescription("Todo text").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("med")
      .setDescription("Log a medication item")
      .addStringOption((option) =>
        option.setName("text").setDescription("Medication text").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("chat")
      .setDescription("Send a chat message to the assistant")
      .addStringOption((option) =>
        option.setName("text").setDescription("Message text").setRequired(true),
      ),
  ].map((command) => command.toJSON());
}

function buildAutoRegisteredToolDescription(toolName: string) {
  switch (toolName) {
    case "workflow_status":
      return "Inspect recent background workflow runs";
    case "launch_coding_agent":
      return "Launch a background coding run with JSON input";
    case "new_chat":
      return "Start a fresh conversation for your Discord chat session";
    case "context":
      return "Show the current context-window token usage";
    case "reflect":
      return "Write a private reflection entry";
    default:
      return `Invoke ${toolName} with optional JSON input.`;
  }
}

function buildDerivedToolSlashCommand(toolName: string) {
  const builder = TOOL_DERIVED_COMMAND_BUILDERS[toolName];
  if (builder) {
    return builder(toolName);
  }
  return new SlashCommandBuilder()
    .setName(toolName)
    .setDescription(buildAutoRegisteredToolDescription(toolName))
    .addStringOption((option) =>
      option
        .setName("input")
        .setDescription("Optional JSON object input")
        .setRequired(false),
    );
}

async function syncSlashCommands(client: Client<true>) {
  const commands = buildSlashCommands();
  const guildIds = getRuntimeConfig().core.discord.guildIds;

  if (guildIds.length === 0) {
    await client.application.commands.set(commands);
    discordTelemetry.event("discord.commands.synced", {
      scope: "global",
      count: commands.length,
    });
    return;
  }

  for (const guildId of guildIds) {
    const guild = await client.guilds.fetch(guildId);
    await guild.commands.set(commands);
    discordTelemetry.event("discord.commands.synced", {
      scope: "guild",
      guildId,
      count: commands.length,
    });
  }
}

async function handleRoutineCommand(
  interaction: ChatInputCommandInteraction,
  app: DiscordAppRuntime,
) {
  const subcommand = interaction.options.getSubcommand(true);

  if (subcommand === "add") {
    await invokeDiscordToolAndReply(interaction, app, "routine_add", {
      title: interaction.options.getString("title", true),
      kind: interaction.options.getString("kind", true),
      priority: interaction.options.getString("priority") ?? undefined,
      description: interaction.options.getString("notes") ?? undefined,
      dose: interaction.options.getString("dose") ?? undefined,
      scheduleKind: interaction.options.getString("schedule") ?? "manual",
      dueAt: interaction.options.getString("due_at") ?? undefined,
      time: interaction.options.getString("time") ?? undefined,
      days: parseWeekdays(interaction.options.getString("days")),
      everyDays: interaction.options.getInteger("every_days") ?? undefined,
      dayOfMonth: interaction.options.getInteger("day_of_month") ?? undefined,
    });
    return;
  }

  if (subcommand === "list") {
    await invokeDiscordToolAndReply(interaction, app, "routine_list", {});
    return;
  }

  if (subcommand === "check") {
    await invokeDiscordToolAndReply(interaction, app, "routine_check", {});
    return;
  }

  const id = interaction.options.getString("id", true);

  if (subcommand === "done") {
    await invokeDiscordToolAndReply(interaction, app, "routine_done", { id });
    return;
  }

  if (subcommand === "undo") {
    await invokeDiscordToolAndReply(interaction, app, "routine_undo_done", { id });
    return;
  }

  if (subcommand === "snooze") {
    await invokeDiscordToolAndReply(interaction, app, "routine_snooze", {
      id,
      minutes: interaction.options.getInteger("minutes", true),
    });
    return;
  }

  if (subcommand === "skip") {
    await invokeDiscordToolAndReply(interaction, app, "routine_skip", { id });
    return;
  }

  if (subcommand === "pause") {
    await invokeDiscordToolAndReply(interaction, app, "routine_pause", { id });
    return;
  }

  await invokeDiscordToolAndReply(interaction, app, "routine_resume", { id });
}

async function invokeDerivedToolCommand(
  interaction: ChatInputCommandInteraction,
  app: DiscordAppRuntime,
  toolName: string,
) {
  const derivedInputBuilder = TOOL_DERIVED_INPUT_BUILDERS[toolName];
  const input = derivedInputBuilder
    ? derivedInputBuilder(interaction)
    : (() => {
        const rawInput = interaction.options.getString("input");
        return rawInput ? parseJsonObject(rawInput) : {};
      })();
  await invokeDiscordToolAndReply(interaction, app, toolName, input);
}

async function invokeDiscordToolAndReply(
  interaction: ChatInputCommandInteraction,
  app: DiscordAppRuntime,
  toolName: string,
  input: unknown,
) {
  await deferInteractionReply(interaction);
  const response = await app.invokeRoutineTool(toolName, input, {
    conversationKey: getDiscordConversationKey(interaction),
    onToolUse: async (event) => {
      const update = normalizeDiscordProgressUpdate(event);
      await replyWithChunks(interaction, update.message, {
        files: update.files,
      });
    },
  });
  await replyWithChunks(interaction, response);
}

function getDiscordConversationKey(interaction: ChatInputCommandInteraction) {
  return interaction.user.id;
}

function parseJsonObject(value: string) {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool input must be a JSON object.");
  }
  return parsed;
}

function parseWeekdays(value: string | null): Weekday[] | undefined {
  if (!value) {
    return undefined;
  }
  const days = value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (days.length === 0) {
    return undefined;
  }
  for (const day of days) {
    if (!["mon", "tue", "wed", "thu", "fri", "sat", "sun"].includes(day)) {
      throw new Error("Weekdays must be mon,tue,wed,thu,fri,sat,sun.");
    }
  }
  return Array.from(new Set(days)) as Weekday[];
}

function formatAttachmentSize(sizeBytes: number | undefined) {
  if (!sizeBytes || sizeBytes <= 0) {
    return "unknown size";
  }

  if (sizeBytes < 1_024) {
    return `${sizeBytes} B`;
  }

  if (sizeBytes < 1_024 * 1_024) {
    return `${(sizeBytes / 1_024).toFixed(1)} KB`;
  }

  return `${(sizeBytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function normalizeAttachmentMimeType(attachment: Pick<Attachment, "contentType" | "name">) {
  const normalized = attachment.contentType?.split(";")[0]?.trim().toLowerCase();
  if (normalized) {
    return normalized;
  }

  const name = attachment.name?.toLowerCase() ?? "";
  if (/\.(png)$/.test(name)) {
    return "image/png";
  }
  if (/\.(jpe?g)$/.test(name)) {
    return "image/jpeg";
  }
  if (/\.(gif)$/.test(name)) {
    return "image/gif";
  }
  if (/\.(webp)$/.test(name)) {
    return "image/webp";
  }
  if (/\.(md|markdown)$/.test(name)) {
    return "text/markdown";
  }
  if (/\.(txt|log|csv|json|ya?ml|xml|html?|css|js|jsx|ts|tsx|py|rs|go|java|c|cc|cpp|h|hpp|sh)$/.test(name)) {
    return "text/plain";
  }
  return undefined;
}

function isImageAttachment(attachment: Pick<Attachment, "contentType" | "name">) {
  return normalizeAttachmentMimeType(attachment)?.startsWith("image/") ?? false;
}

function detectImageMimeType(bytes: Uint8Array) {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  return undefined;
}

function isTextAttachment(attachment: Pick<Attachment, "contentType" | "name">) {
  const mimeType = normalizeAttachmentMimeType(attachment);
  if (!mimeType) {
    return false;
  }

  return (
    mimeType.startsWith("text/") ||
    [
      "application/json",
      "application/ld+json",
      "application/xml",
      "application/javascript",
      "application/typescript",
      "application/x-sh",
      "application/x-httpd-php",
    ].includes(mimeType)
  );
}

function buildAttachmentDescriptor(attachment: Pick<Attachment, "name" | "size" | "contentType">) {
  const name = attachment.name ?? "attachment";
  const mimeType = normalizeAttachmentMimeType(attachment) ?? "unknown";
  return `${name} (${mimeType}, ${formatAttachmentSize(attachment.size)})`;
}

async function downloadAttachment(attachment: Pick<Attachment, "url" | "name">) {
  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`download failed with ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function truncateAttachmentText(text: string) {
  if (text.length <= MAX_TEXT_ATTACHMENT_CHARS) {
    return {
      text,
      truncated: false,
    };
  }

  return {
    text: `${text.slice(0, MAX_TEXT_ATTACHMENT_CHARS)}\n[truncated]`,
    truncated: true,
  };
}

async function buildAttachmentBlocks(
  attachments: IterableIterator<Attachment>,
): Promise<ChatPromptContentBlock[]> {
  const resolved = await Promise.all(
    [...attachments].map(async (attachment) => {
      const descriptor = buildAttachmentDescriptor(attachment);

      try {
        if (isImageAttachment(attachment)) {
          if ((attachment.size ?? 0) > MAX_IMAGE_ATTACHMENT_BYTES) {
            return [{
              type: "text" as const,
              text: `Attached image: ${descriptor}. Skipped because it exceeds the ${formatAttachmentSize(MAX_IMAGE_ATTACHMENT_BYTES)} inline limit.`,
            }];
          }

          const bytes = await downloadAttachment(attachment);
          const mimeType = detectImageMimeType(bytes) ?? normalizeAttachmentMimeType(attachment) ?? "image/png";
          return [
            {
              type: "text" as const,
              text: `Attached image: ${descriptor}.`,
            },
            {
              type: "image" as const,
              data: Buffer.from(bytes).toString("base64"),
              mimeType,
              sourceUrl: attachment.url,
            },
          ];
        }

        if (isTextAttachment(attachment)) {
          if ((attachment.size ?? 0) > MAX_TEXT_ATTACHMENT_BYTES) {
            return [{
              type: "text" as const,
              text: `Attached file: ${descriptor}. Skipped because it exceeds the ${formatAttachmentSize(MAX_TEXT_ATTACHMENT_BYTES)} inline limit.`,
            }];
          }

          const bytes = await downloadAttachment(attachment);
          const decoded = new TextDecoder().decode(bytes);
          const { text, truncated } = truncateAttachmentText(decoded);
          return [{
            type: "text" as const,
            text: [
              `Attached file: ${descriptor}.${truncated ? " The inlined contents were truncated." : ""}`,
              "--- file contents start ---",
              text,
              "--- file contents end ---",
            ].join("\n"),
          }];
        }

        return [{
          type: "text" as const,
          text: `Attached file: ${descriptor}. Binary content was not inlined.`,
        }];
      } catch (error) {
        return [{
          type: "text" as const,
          text: `Attached file: ${descriptor}. It could not be downloaded: ${error instanceof Error ? error.message : String(error)}.`,
        }];
      }
    }),
  );

  return resolved.flat();
}

async function buildMessageRequest(
  conversationKey: string,
  text: string,
  attachments: IterableIterator<Attachment>,
): Promise<AppRequest> {
  if (text.toLowerCase().startsWith("todo ")) {
    const title = text.slice(5).trim();
    return {
      id: nextRequestId("todo"),
      kind: "todo",
      text,
      conversationKey,
      todoTitle: title,
    };
  }

  if (text.toLowerCase().startsWith("med ")) {
    return {
      id: nextRequestId("med"),
      kind: "medication",
      text,
      conversationKey,
      medicationName: text.slice(4).trim(),
    };
  }

  const attachmentBlocks = await buildAttachmentBlocks(attachments);
  const chatContent = attachmentBlocks.length > 0
    ? buildChatPromptContent({ text, blocks: attachmentBlocks })
    : undefined;

  return {
    id: nextRequestId("chat"),
    kind: "chat",
    text,
    chatContent,
    conversationKey,
  };
}

function isStopCommandContent(text: string) {
  return text.trim().toLowerCase() === "/stop";
}

function getLaunchableDiscordProfiles(activeProfileId: string) {
  const profiles = new ProfileService(activeProfileId);
  const activeProfile = profiles.getProfile(activeProfileId);
  return profiles.listLaunchableProfiles(activeProfile);
}

function getDiscordTargetProfile(activeProfileId: string, requestedProfileId?: string) {
  const targetProfileId = requestedProfileId?.trim() || activeProfileId;
  const launchableProfiles = getLaunchableDiscordProfiles(activeProfileId);
  const targetProfile = launchableProfiles.find((profile) => profile.id === targetProfileId);
  if (!targetProfile) {
    throw new Error(`Profile not found or not launchable: ${targetProfileId}`);
  }
  return targetProfile;
}

function formatLaunchableProfileLine(activeProfileId: string, targetProfileId: string) {
  const targetProfile = getDiscordTargetProfile(activeProfileId, targetProfileId);
  const auth = getAuthStatus(targetProfile.id);
  const authSummary = auth.any
    ? [auth.codex ? "codex" : "", auth.claude ? "claude" : ""].filter(Boolean).join(", ")
    : "missing";
  return [
    `- ${targetProfile.id} (${targetProfile.name})`,
    `roles=${targetProfile.roles.join(",")}`,
    targetProfile.preferredProvider ? `provider=${targetProfile.preferredProvider}` : "",
    targetProfile.defaultModelId ? `model=${targetProfile.defaultModelId}` : "",
    `thinking=${targetProfile.defaultThinkingLevel ?? DEFAULT_PROFILE_THINKING_LEVEL}`,
    `auth=${authSummary}`,
  ]
    .filter(Boolean)
    .join(" ");
}

function formatLaunchableProfileList(activeProfileId: string) {
  const launchableProfiles = getLaunchableDiscordProfiles(activeProfileId);
  return [
    `Active profile: ${activeProfileId}`,
    "Launchable profiles:",
    ...launchableProfiles.map((profile) => formatLaunchableProfileLine(activeProfileId, profile.id)),
  ].join("\n");
}

function formatLaunchableProfileDetails(activeProfileId: string, targetProfileId: string) {
  const targetProfile = getDiscordTargetProfile(activeProfileId, targetProfileId);
  const auth = getAuthStatus(targetProfile.id);
  return [
    `Profile: ${targetProfile.id}`,
    `Name: ${targetProfile.name}`,
    `Roles: ${targetProfile.roles.join(", ")}`,
    `Memory namespace: ${targetProfile.memoryNamespace}`,
    `Execution: ${targetProfile.execution?.kind ?? "local"}`,
    targetProfile.shellUser ? `Shell user: ${targetProfile.shellUser}` : "",
    targetProfile.preferredProvider ? `Preferred provider: ${targetProfile.preferredProvider}` : "",
    targetProfile.defaultModelId ? `Default model: ${targetProfile.defaultModelId}` : "",
    `Default thinking: ${targetProfile.defaultThinkingLevel ?? DEFAULT_PROFILE_THINKING_LEVEL}`,
    `Codex auth: ${auth.codex ? "configured" : "missing"}`,
    `Claude auth: ${auth.claude ? "configured" : "missing"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function beginDirectMessageAuth(
  interaction: ChatInputCommandInteraction,
  run: () => Promise<void>,
) {
  if (interaction.channel?.type === ChannelType.DM) {
    await run();
    return;
  }

  const dm = await interaction.user.createDM();
  await dm.send("Starting auth flow here in DM.");
  await run();
}

async function withTypingIndicator<T>(message: Message, run: () => Promise<T>) {
  if (!("sendTyping" in message.channel)) {
    return run();
  }

  let isActive = true;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scheduleNextPulse = () => {
    timer = setTimeout(() => {
      void pulseTyping();
    }, DISCORD_TYPING_REFRESH_MS);
  };

  const pulseTyping = async () => {
    if (!isActive) {
      return;
    }

    try {
      if ("sendTyping" in message.channel && typeof message.channel.sendTyping === "function") {
        await message.channel.sendTyping();
      }
    } catch (error) {
      discordTelemetry.event(
        "discord.typing_indicator.error",
        {
          userId: message.author.id,
          channelId: message.channelId,
          error: error instanceof Error ? error.message : String(error),
        },
        { level: "debug", outcome: "error" },
      );
      return;
    }

    if (isActive) {
      scheduleNextPulse();
    }
  };

  await pulseTyping();

  try {
    return await run();
  } finally {
    isActive = false;
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function splitIntoChunks(text: string) {
  if (text.length <= DISCORD_MESSAGE_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > DISCORD_MESSAGE_LIMIT) {
    const candidate = remaining.slice(0, DISCORD_MESSAGE_LIMIT);
    const splitIndex = Math.max(candidate.lastIndexOf("\n"), candidate.lastIndexOf(" "));
    const safeIndex = splitIndex > 0 ? splitIndex : DISCORD_MESSAGE_LIMIT;
    chunks.push(remaining.slice(0, safeIndex).trimEnd());
    remaining = remaining.slice(safeIndex).trimStart();
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

async function deferInteractionReply(
  interaction: ChatInputCommandInteraction,
  options?: { ephemeral?: boolean },
) {
  if (interaction.replied || interaction.deferred) {
    return;
  }

  await interaction.deferReply({
    flags: options?.ephemeral ? MessageFlags.Ephemeral : undefined,
  });
}

function buildDiscordFiles(response: AppResponse) {
  return buildDiscordAttachmentFiles(response.attachments);
}

function buildDiscordAttachmentFiles(attachments: AppResponseAttachment[] | undefined) {
  return (attachments ?? []).map((attachment) =>
    new AttachmentBuilder(attachment.path, {
      name: attachment.name ?? path.basename(attachment.path),
    })
  );
}

function normalizeDiscordProgressUpdate(event: AppProgressEvent) {
  if (typeof event === "string") {
    return {
      message: event,
      files: undefined,
    };
  }

  return {
    message: event.message,
    files: buildDiscordAttachmentFiles(event.attachments),
  };
}

async function replyWithChunks(
  interaction: ChatInputCommandInteraction,
  text: string,
  options?: { ephemeral?: boolean; files?: AttachmentBuilder[] },
) {
  const chunks = splitIntoChunks(sanitizeDiscordText(text));
  const [firstChunk, ...rest] = chunks;
  if (!interaction.replied && !interaction.deferred) {
    await interaction.reply({
      content: firstChunk,
      files: options?.files,
      flags: options?.ephemeral ? MessageFlags.Ephemeral : undefined,
    });
  } else if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({ content: firstChunk, files: options?.files });
  } else {
    await interaction.followUp({
      content: firstChunk,
      files: options?.files,
      flags: options?.ephemeral ? MessageFlags.Ephemeral : undefined,
    });
  }
  for (const chunk of rest) {
    await interaction.followUp({
      content: chunk,
      flags: options?.ephemeral ? MessageFlags.Ephemeral : undefined,
    });
  }
}

async function replyWithAppResponse(
  interaction: ChatInputCommandInteraction,
  response: AppResponse,
  options?: { ephemeral?: boolean },
) {
  await replyWithChunks(interaction, response.message, {
    ...options,
    files: buildDiscordFiles(response),
  });
  for (const warning of response.warnings ?? []) {
    await replyWithChunks(interaction, warning, options);
  }
}

async function replyToMessageWithChunks(
  message: Message,
  text: string,
  options?: { files?: AttachmentBuilder[] },
) {
  if (!message.channel.isSendable()) {
    throw new Error("Discord message channel is not sendable.");
  }

  const chunks = splitIntoChunks(sanitizeDiscordText(text));
  const [firstChunk, ...rest] = chunks;
  await message.channel.send({
    content: firstChunk,
    files: options?.files,
  });
  for (const chunk of rest) {
    await message.channel.send(chunk);
  }
}

async function replyToMessageWithAppResponse(message: Message, response: AppResponse) {
  await replyToMessageWithChunks(message, response.message, {
    files: buildDiscordFiles(response),
  });
  for (const warning of response.warnings ?? []) {
    await replyToMessageWithChunks(message, warning);
  }
}

async function sendAppResponseToChannel(
  channel: { send: (payload: string | { content: string; files?: AttachmentBuilder[] }) => Promise<unknown> },
  response: AppResponse,
) {
  const chunks = splitIntoChunks(response.message);
  const [firstChunk, ...rest] = chunks;
  await channel.send({
    content: firstChunk ?? "(no content)",
    files: buildDiscordFiles(response),
  });
  for (const chunk of rest) {
    await channel.send(chunk);
  }
  for (const warning of response.warnings ?? []) {
    for (const chunk of splitIntoChunks(warning)) {
      await channel.send(chunk);
    }
  }
}
