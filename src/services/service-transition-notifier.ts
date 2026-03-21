import { REST, Routes } from "discord.js";
import { getRuntimeConfig } from "../config/runtime-config";
import { SecretStoreService } from "./secret-store-service";

const DISCORD_USER_ID_PATTERN = /^\d{15,22}$/;

export function isDiscordUserId(value: string | null | undefined) {
  return Boolean(value?.trim() && DISCORD_USER_ID_PATTERN.test(value.trim()));
}

export function buildServiceTransitionCompletionMessage(params: {
  action: "update" | "rollback";
  status: "completed" | "failed";
  version?: string | null;
}) {
  if (params.action === "update" && params.status === "completed") {
    return `update complete, new version: ${params.version?.trim() || "unknown"}`;
  }

  if (params.action === "update" && params.status === "failed") {
    return "update failed. the previous version should still be running.";
  }

  return null;
}

export async function sendDiscordDirectMessage(params: {
  userId: string;
  message: string;
}) {
  const userId = params.userId.trim();
  const message = params.message.trim();
  if (!isDiscordUserId(userId) || !message) {
    return false;
  }

  const config = getRuntimeConfig();
  const token = new SecretStoreService().resolveSecretRef(config.core.discord.botTokenSecretRef);
  if (!token) {
    return false;
  }

  const rest = new REST({ version: "10" }).setToken(token);
  const channel = await rest.post(Routes.userChannels(), {
    body: { recipient_id: userId },
  }) as { id: string };
  await rest.post(Routes.channelMessages(channel.id), {
    body: { content: message },
  });
  return true;
}
