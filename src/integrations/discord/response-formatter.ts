import path from "node:path";
import {
  AttachmentBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import type {
  AppProgressEvent,
  AppResponse,
  AppResponseAttachment,
} from "../../domain/assistant";
import { DISCORD_MESSAGE_LIMIT } from "../../config/service-constants";
import { sanitizeDiscordText } from "../../services/discord-response-service";

export function splitIntoChunks(text: string) {
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

export async function deferInteractionReply(
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

export function buildDiscordFiles(response: AppResponse) {
  return buildDiscordAttachmentFiles(response.attachments);
}

export function buildDiscordAttachmentFiles(attachments: AppResponseAttachment[] | undefined) {
  return (attachments ?? []).map((attachment) =>
    new AttachmentBuilder(attachment.path, {
      name: attachment.name ?? path.basename(attachment.path),
    })
  );
}

export function normalizeDiscordProgressUpdate(event: AppProgressEvent) {
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

export async function replyWithChunks(
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

export async function replyWithAppResponse(
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

export async function replyToMessageWithChunks(
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

export async function replyToMessageWithAppResponse(message: Message, response: AppResponse) {
  await replyToMessageWithChunks(message, response.message, {
    files: buildDiscordFiles(response),
  });
  for (const warning of response.warnings ?? []) {
    await replyToMessageWithChunks(message, warning);
  }
}

export async function sendAppResponseToChannel(
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
