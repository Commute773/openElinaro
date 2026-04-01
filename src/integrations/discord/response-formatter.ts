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
import { TurnRenderer } from "../../services/turn-renderer";

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

export function formatStreamEventForDiscord(event: AppProgressEvent): { message: string; files?: AttachmentBuilder[] } {
  switch (event.type) {
    case "thinking":
      return { message: `*${event.text.length > 200 ? event.text.slice(0, 200) + "..." : event.text}*` };
    case "tool_start":
      return { message: `Using tool: \`${event.name}\`` };
    case "tool_end":
      return { message: event.isError ? `Tool failed: \`${event.name}\`${event.error ? ` — ${event.error}` : ""}` : `Tool completed: \`${event.name}\`${event.summary ? ` — ${event.summary}` : ""}` };
    case "tool_progress":
      return { message: `Running \`${event.name}\`... (${event.elapsed?.toFixed(0) ?? "?"}s)` };
    case "tool_summary":
      return { message: event.summary };
    case "task_started":
      return { message: `Task started: ${event.description ?? event.taskId}` };
    case "task_progress":
      return { message: `Task progress: ${event.taskId} (${event.toolUses ?? 0} tools, ${((event.durationMs ?? 0) / 1000).toFixed(1)}s)` };
    case "task_completed":
      return { message: `Task ${event.status ?? "completed"}: ${event.summary ?? event.taskId}` };
    case "text":
      return { message: event.text };
    case "agent_init":
      return { message: `Agent initialized: model=${event.model ?? "unknown"}, ${event.toolCount ?? 0} tools` };
    case "compaction":
      return { message: `Compacting conversation (trigger: ${event.trigger ?? "unknown"})` };
    case "result":
      return { message: `Completed in ${event.turns} turns, ${(event.durationMs / 1000).toFixed(1)}s, $${event.costUsd.toFixed(4)}` };
    case "error":
      return { message: `Error: ${event.message}` };
    case "status":
      return { message: event.message };
    case "progress":
      return { message: event.message, files: buildDiscordAttachmentFiles(event.attachments) };
    default:
      return { message: JSON.stringify(event) };
  }
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

// ---------------------------------------------------------------------------
// DiscordTurnSession — single-message editing with TurnRenderer
// ---------------------------------------------------------------------------

/** Minimum interval between Discord message edits (ms). */
const EDIT_THROTTLE_MS = 1_200;

/**
 * Manages a single Discord message that gets edited as the agent turn
 * progresses. Uses TurnRenderer to accumulate stream events and produce
 * a text snapshot. Throttles edits to respect Discord rate limits.
 */
export class DiscordTurnSession {
  private renderer = new TurnRenderer();
  private sentMessage: Message | null = null;
  private lastEditTime = 0;
  private pendingEdit: ReturnType<typeof setTimeout> | null = null;
  private channel: { send: (payload: string | { content: string }) => Promise<Message> };

  constructor(
    private target: Message | ChatInputCommandInteraction,
  ) {
    if ("channel" in target && target.channel?.isSendable()) {
      this.channel = target.channel as { send: (payload: string | { content: string }) => Promise<Message> };
    } else {
      // Interaction — we'll use editReply/followUp instead
      this.channel = null as any;
    }
  }

  /** Feed a stream event; triggers message create or edit. */
  async push(event: AppProgressEvent): Promise<void> {
    this.renderer.push(event);
    await this.flush(false);
  }

  /** Finalize with the agent's response text and do a final edit/send. */
  async finish(response: AppResponse): Promise<void> {
    // Add final text to renderer if it has content
    if (response.message) {
      this.renderer.push({ type: "text", text: response.message });
    }
    // Cancel any pending throttled edit — we'll do a final one now
    if (this.pendingEdit) {
      clearTimeout(this.pendingEdit);
      this.pendingEdit = null;
    }
    await this.flush(true);

    // Send warnings as separate messages
    for (const warning of response.warnings ?? []) {
      await this.sendNew(warning);
    }
  }

  // ── Private ──────────────────────────────────────────────────────────

  private async flush(force: boolean): Promise<void> {
    if (this.renderer.empty) return;
    const text = sanitizeDiscordText(this.renderer.snapshot(DISCORD_MESSAGE_LIMIT));
    if (!text) return;

    if (!this.sentMessage) {
      // First event — create the message
      await this.createMessage(text);
      this.lastEditTime = Date.now();
      return;
    }

    if (force) {
      await this.editMessage(text);
      return;
    }

    // Throttle: schedule an edit if we're within the cooldown
    const elapsed = Date.now() - this.lastEditTime;
    if (elapsed >= EDIT_THROTTLE_MS) {
      await this.editMessage(text);
      this.lastEditTime = Date.now();
    } else if (!this.pendingEdit) {
      const delay = EDIT_THROTTLE_MS - elapsed;
      this.pendingEdit = setTimeout(async () => {
        this.pendingEdit = null;
        const snapshot = sanitizeDiscordText(this.renderer.snapshot(DISCORD_MESSAGE_LIMIT));
        if (snapshot && this.sentMessage) {
          await this.editMessage(snapshot);
          this.lastEditTime = Date.now();
        }
      }, delay);
    }
  }

  private async createMessage(text: string): Promise<void> {
    if (this.isInteraction(this.target)) {
      // Interaction: edit the deferred reply
      const msg = await this.target.editReply({ content: text });
      this.sentMessage = msg as Message;
    } else {
      // DM: send a new message
      this.sentMessage = await this.channel.send({ content: text });
    }
  }

  private async editMessage(text: string): Promise<void> {
    if (!this.sentMessage) return;
    if (this.isInteraction(this.target)) {
      await this.target.editReply({ content: text });
    } else {
      await this.sentMessage.edit({ content: text });
    }
  }

  private async sendNew(text: string): Promise<void> {
    const chunks = splitIntoChunks(sanitizeDiscordText(text));
    if (this.isInteraction(this.target)) {
      for (const chunk of chunks) {
        await this.target.followUp({ content: chunk });
      }
    } else {
      for (const chunk of chunks) {
        await this.channel.send(chunk);
      }
    }
  }

  private isInteraction(target: Message | ChatInputCommandInteraction): target is ChatInputCommandInteraction {
    return "editReply" in target && typeof target.editReply === "function";
  }
}
