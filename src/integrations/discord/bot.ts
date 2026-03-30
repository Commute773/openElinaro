import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
} from "discord.js";
import { OpenElinaroApp } from "../../app/runtime";
import { getAuthStatusLines, hasAnyProviderAuth, hasProviderAuth } from "../../auth/store";
import { getRuntimeConfig } from "../../config/runtime-config";
import type {
  AppProgressEvent,
  AppRequest,
  AppResponse,
} from "../../domain/assistant";
import type { Weekday } from "../../domain/routines";
import type { ModelProviderId } from "../../services/models/model-service";
import { AgentHealthcheckService } from "../../services/agent-healthcheck-service";
import { SecretStoreService } from "../../services/infrastructure/secret-store-service";
import { telemetry } from "../../services/infrastructure/telemetry";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { DiscordAuthSessionManager } from "./auth-session-manager";
import {
  getDiscordOptionalSubcommand,
  getProfileCommandAction,
  getDiscordTargetProfile,
  formatLaunchableProfileList,
  formatLaunchableProfileDetails,
  beginDirectMessageAuth,
} from "./profile-commands";
import { DiscordRoutinesNotifier } from "./routines-notifier";
import {
  TOOL_DERIVED_INPUT_BUILDERS,
  getAutoRegisteredToolCommandNameSet,
  setFunctionLayerDescriptions,
  syncSlashCommands,
} from "./slash-commands";

// Re-export submodules so existing imports from "./bot" keep working
export {
  createDiscordDmMessageBatcher,
  type DiscordBatchedDirectMessage,
  nextRequestId,
  buildMessageRequest,
  buildAttachmentBlocks,
  isStopCommandContent,
  isDirectMessage,
} from "./message-handler";
export {
  splitIntoChunks,
  deferInteractionReply,
  buildDiscordFiles,
  buildDiscordAttachmentFiles,
  normalizeDiscordProgressUpdate,
  replyWithChunks,
  replyWithAppResponse,
  replyToMessageWithChunks,
  replyToMessageWithAppResponse,
  sendAppResponseToChannel,
} from "./response-formatter";
export {
  createConversationTypingTracker,
  withTypingIndicator,
} from "./typing-manager";

// Import from submodules for internal use
import {
  createDiscordDmMessageBatcher,
  type DiscordBatchedDirectMessage,
  nextRequestId,
  buildMessageRequest,
  isStopCommandContent,
  isDirectMessage,
} from "./message-handler";
import {
  deferInteractionReply,
  normalizeDiscordProgressUpdate,
  replyWithChunks,
  replyWithAppResponse,
  replyToMessageWithChunks,
  replyToMessageWithAppResponse,
  sendAppResponseToChannel,
} from "./response-formatter";
import { createConversationTypingTracker } from "./typing-manager";

const discordTelemetry = telemetry.child({ component: "discord" });
const traceSpan = createTraceSpan(discordTelemetry);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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
  getActiveModel(): Promise<{ providerId: ModelProviderId }> | { providerId: ModelProviderId };
  getActiveProfile(): { id: string };
}

// ---------------------------------------------------------------------------
// Bot entry point
// ---------------------------------------------------------------------------

export async function startDiscordBot(options?: { app?: OpenElinaroApp }) {
  const config = getRuntimeConfig();
  const token = new SecretStoreService().resolveSecretRef(config.core.discord.botTokenSecretRef);
  if (!token) {
    throw new Error(
      `Missing Discord bot token secret ${config.core.discord.botTokenSecretRef}. Run bun src/cli/bootstrap.ts first.`,
    );
  }

  const app = options?.app ?? new OpenElinaroApp();
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

  app.setPromptDriftWarningNotifier(async (warning) => {
    const userId = app.getNotificationTargetUserId();
    if (!userId) {
      discordTelemetry.event(
        "discord.prompt_drift_warning.no_target",
        { sessionId: warning.sessionId },
        { level: "debug" },
      );
      return;
    }

    const user = await client.users.fetch(userId);
    const dm = await user.createDM();
    const pct = (warning.sharedPrefixPercentOfPrevious * 100).toFixed(1);
    await dm.send(
      `⚠️ Prompt prefix mutation detected (session \`${warning.sessionId}\`): shared prefix ${pct}% of previous prompt. Removed ${warning.removedLength} chars, added ${warning.addedLength} chars at message index ${warning.firstChangedMessageIndex}.`,
    );
    discordTelemetry.event("discord.prompt_drift_warning.sent", {
      userId,
      sessionId: warning.sessionId,
      sharedPrefixPercentOfPrevious: warning.sharedPrefixPercentOfPrevious,
    });
  });

  // Start healthcheck watcher before Discord connects so deploys don't
  // time out waiting for the Discord gateway.
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

  client.once(Events.ClientReady, async (readyClient) => {
    // Populate function-layer descriptions for richer slash command metadata
    const fnRegistry = app.getFunctionRegistry?.();
    if (fnRegistry) {
      const descriptions = new Map<string, string>();
      for (const def of fnRegistry.getDefinitions({ surface: "discord" })) {
        const desc = def.discord?.description ?? def.description;
        descriptions.set(def.name, desc);
      }
      setFunctionLayerDescriptions(descriptions);
    }
    await syncSlashCommands(readyClient);
    new DiscordRoutinesNotifier(readyClient, app).start();
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

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

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
        discordTelemetry.recordError(error, {
          userId: message.author.id,
          channelId: message.channelId,
          eventName: "discord.message",
        });
        await replyToMessageWithChunks(message, error instanceof Error ? error.message : String(error));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Slash command handling
// ---------------------------------------------------------------------------

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

    if (provider === "zai") {
      await replyWithChunks(interaction, `Check your DMs to continue Z.ai auth for profile ${targetProfile.id}.`, {
        ephemeral: true,
      });
      await beginDirectMessageAuth(interaction, () =>
        authManager.startZaiApiKeyFlowForProfile(targetProfile.id, interaction.user.id, async (text) => {
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

    if (provider === "zai") {
      await replyWithChunks(interaction, `Check your DMs to continue Z.ai auth for profile ${targetProfile.id}.`, {
        ephemeral: true,
      });
      await beginDirectMessageAuth(interaction, () =>
        authManager.startZaiApiKeyFlowForProfile(targetProfile.id, interaction.user.id, async (text) => {
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
    await replyWithChunks(interaction, "Workflow commands are no longer available. Subagent infrastructure has been removed.");
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
    const updateResult = await app.invokeRoutineTool("update", {}, {
      conversationKey: getDiscordConversationKey(interaction),
    });
    const resultText = typeof updateResult === "string" ? updateResult : String(updateResult ?? "");
    if (resultText.includes("Update skipped") || resultText.includes("Nothing to deploy") || resultText.includes("already at version")) {
      await replyWithChunks(interaction, resultText);
    } else {
      await replyWithChunks(
        interaction,
        "updating... don't send messages. you'll get `update complete` when it's done.",
      );
    }
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

  const activeModel = await app.getActiveModel();
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

// ---------------------------------------------------------------------------
// Slash command helpers
// ---------------------------------------------------------------------------

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
