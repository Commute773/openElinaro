import {
  ChannelType,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { RoutineItemKind, RoutinePriority } from "../../domain/routines";
import { MODEL_PROVIDER_IDS, THINKING_LEVELS } from "../../domain/profiles";
import type { ModelProviderId } from "../../domain/profiles";
import { getAuthStatus } from "../../auth/store";
import { ProfileService } from "../../services/profiles";
import { attemptOr } from "../../utils/result";

export const ROUTINE_KIND_CHOICES: { name: string; value: RoutineItemKind }[] = [
  { name: "todo", value: "todo" },
  { name: "routine", value: "routine" },
  { name: "habit", value: "habit" },
  { name: "med", value: "med" },
  { name: "deadline", value: "deadline" },
  { name: "precommitment", value: "precommitment" },
];

export const ROUTINE_PRIORITY_CHOICES: { name: string; value: RoutinePriority }[] = [
  { name: "low", value: "low" },
  { name: "medium", value: "medium" },
  { name: "high", value: "high" },
  { name: "urgent", value: "urgent" },
];

export const MODEL_PROVIDER_CHOICES: { name: string; value: ModelProviderId }[] =
  MODEL_PROVIDER_IDS.map((id) => ({ name: id, value: id }));

export const PROFILE_ACTION_CHOICES = [
  { name: "show", value: "show" },
  { name: "set", value: "set" },
  { name: "list", value: "list" },
  { name: "auth", value: "auth" },
] as const;

export const PROFILE_AUTH_PROVIDER_CHOICES = [
  { name: "status", value: "status" },
  { name: "claude", value: "claude" },
] as const;

export const THINKING_LEVEL_CHOICES =
  THINKING_LEVELS.map((level) => ({ name: level, value: level }));

const DEFAULT_PROFILE_THINKING_LEVEL = "low";

export type ProfileCommandAction = "list" | "show" | "set" | "auth";

export function getDiscordOptionalSubcommand(interaction: ChatInputCommandInteraction) {
  return attemptOr(
    () => interaction.options.getSubcommand(false) as ProfileCommandAction | null,
    null,
  );
}

export function getProfileCommandAction(interaction: ChatInputCommandInteraction): ProfileCommandAction {
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

export function getDiscordTargetProfile(activeProfileId: string, requestedProfileId?: string) {
  const targetProfileId = requestedProfileId?.trim() || activeProfileId;
  if (targetProfileId !== activeProfileId) {
    throw new Error(`Profile not found or not launchable: ${targetProfileId}`);
  }
  const profiles = new ProfileService(activeProfileId);
  return profiles.getProfile(activeProfileId);
}

function formatLaunchableProfileLine(activeProfileId: string, targetProfileId: string) {
  const targetProfile = getDiscordTargetProfile(activeProfileId, targetProfileId);
  const auth = getAuthStatus(targetProfile.id);
  const authSummary = auth.any
    ? auth.claude ? "claude" : ""
    : "missing";
  return [
    `- ${targetProfile.id} (${targetProfile.name})`,
    targetProfile.preferredProvider ? `provider=${targetProfile.preferredProvider}` : "",
    targetProfile.defaultModelId ? `model=${targetProfile.defaultModelId}` : "",
    `thinking=${targetProfile.defaultThinkingLevel ?? DEFAULT_PROFILE_THINKING_LEVEL}`,
    `auth=${authSummary}`,
  ]
    .filter(Boolean)
    .join(" ");
}

export function formatLaunchableProfileList(activeProfileId: string) {
  return [
    `Active profile: ${activeProfileId}`,
    "Profiles:",
    formatLaunchableProfileLine(activeProfileId, activeProfileId),
  ].join("\n");
}

export function formatLaunchableProfileDetails(activeProfileId: string, targetProfileId: string) {
  const targetProfile = getDiscordTargetProfile(activeProfileId, targetProfileId);
  const auth = getAuthStatus(targetProfile.id);
  return [
    `Profile: ${targetProfile.id}`,
    `Name: ${targetProfile.name}`,
    `Memory namespace: ${targetProfile.memoryNamespace}`,
    `Execution: ${targetProfile.execution?.kind ?? "local"}`,
    targetProfile.shellUser ? `Shell user: ${targetProfile.shellUser}` : "",
    targetProfile.preferredProvider ? `Preferred provider: ${targetProfile.preferredProvider}` : "",
    targetProfile.defaultModelId ? `Default model: ${targetProfile.defaultModelId}` : "",
    `Default thinking: ${targetProfile.defaultThinkingLevel ?? DEFAULT_PROFILE_THINKING_LEVEL}`,
    `Codex auth: ${auth.codex ? "configured" : "missing"}`,
    `Claude auth: ${auth.claude ? "configured" : "missing"}`,
    `Z.ai auth: ${auth.zai ? "configured" : "missing"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function beginDirectMessageAuth(
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
