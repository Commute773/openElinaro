import {
  ChannelType,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { RoutineItemKind, RoutinePriority } from "../../domain/routines";
import type { ModelProviderId } from "../../services/models/model-service";
import { getAuthStatus } from "../../auth/store";
import { ProfileService } from "../../services/profiles";

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

export const MODEL_PROVIDER_CHOICES: { name: string; value: ModelProviderId }[] = [
  { name: "openai-codex", value: "openai-codex" },
  { name: "claude", value: "claude" },
  { name: "zai", value: "zai" },
];

export const PROFILE_ACTION_CHOICES = [
  { name: "show", value: "show" },
  { name: "set", value: "set" },
  { name: "list", value: "list" },
  { name: "auth", value: "auth" },
] as const;

export const PROFILE_AUTH_PROVIDER_CHOICES = [
  { name: "status", value: "status" },
  { name: "codex", value: "codex" },
  { name: "claude", value: "claude" },
  { name: "zai", value: "zai" },
] as const;

export const THINKING_LEVEL_CHOICES = [
  { name: "minimal", value: "minimal" },
  { name: "low", value: "low" },
  { name: "medium", value: "medium" },
  { name: "high", value: "high" },
  { name: "xhigh", value: "xhigh" },
] as const;

const DEFAULT_PROFILE_THINKING_LEVEL = "low";

export type ProfileCommandAction = "list" | "show" | "set" | "auth";

export function getDiscordOptionalSubcommand(interaction: ChatInputCommandInteraction) {
  try {
    return interaction.options.getSubcommand(false) as ProfileCommandAction | null;
  } catch {
    return null;
  }
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

export function getLaunchableDiscordProfiles(activeProfileId: string) {
  const profiles = new ProfileService(activeProfileId);
  const activeProfile = profiles.getProfile(activeProfileId);
  return profiles.listLaunchableProfiles(activeProfile);
}

export function getDiscordTargetProfile(activeProfileId: string, requestedProfileId?: string) {
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

export function formatLaunchableProfileList(activeProfileId: string) {
  const launchableProfiles = getLaunchableDiscordProfiles(activeProfileId);
  return [
    `Active profile: ${activeProfileId}`,
    "Launchable profiles:",
    ...launchableProfiles.map((profile) => formatLaunchableProfileLine(activeProfileId, profile.id)),
  ].join("\n");
}

export function formatLaunchableProfileDetails(activeProfileId: string, targetProfileId: string) {
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
