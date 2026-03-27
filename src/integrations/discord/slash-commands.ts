import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandOptionsOnlyBuilder,
} from "discord.js";
import { getRuntimeConfig } from "../../config/runtime-config";
import { getRuntimeUserFacingToolNames } from "../../tools/tool-registry";
import { telemetry } from "../../services/telemetry";
import {
  MODEL_PROVIDER_CHOICES,
  PROFILE_ACTION_CHOICES,
  PROFILE_AUTH_PROVIDER_CHOICES,
  THINKING_LEVEL_CHOICES,
  ROUTINE_KIND_CHOICES,
  ROUTINE_PRIORITY_CHOICES,
} from "./profile-commands";

const discordTelemetry = telemetry.child({ component: "discord" });

export const TOOL_COMMAND_EXCLUSIONS = new Set<string>([
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

type DerivedToolCommandBuilder = (toolName: string) => SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;
type DerivedToolInputBuilder = (interaction: ChatInputCommandInteraction) => unknown;

export const TOOL_DERIVED_COMMAND_BUILDERS: Partial<Record<string, DerivedToolCommandBuilder>> = {
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

export const TOOL_DERIVED_INPUT_BUILDERS: Partial<Record<string, DerivedToolInputBuilder>> = {
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

export function getAutoRegisteredToolCommandNames() {
  return getRuntimeUserFacingToolNames().filter((name) =>
    !TOOL_COMMAND_EXCLUSIONS.has(name)
  );
}

export function getAutoRegisteredToolCommandNameSet() {
  return new Set<string>(getAutoRegisteredToolCommandNames());
}

function buildAutoRegisteredToolDescription(toolName: string) {
  switch (toolName) {
    case "agent_status":
      return "Inspect recent background agent runs";
    case "launch_agent":
      return "Launch a background coding agent with JSON input";
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

export function buildSlashCommands() {
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

export async function syncSlashCommands(client: Client<true>) {
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
