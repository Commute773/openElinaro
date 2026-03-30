import { ChannelType, type Attachment, type Message } from "discord.js";
import type { AppRequest, ChatPromptContentBlock } from "../../domain/assistant";
import {
  DISCORD_MAX_ATTACHMENT_BYTES as MAX_IMAGE_ATTACHMENT_BYTES,
  DISCORD_MAX_TEXT_ATTACHMENT_BYTES as MAX_TEXT_ATTACHMENT_BYTES,
  DISCORD_DM_BATCH_TIMEOUT_MS,
  DISCORD_MAX_TEXT_ATTACHMENT_CHARS,
  DISCORD_CONTINUED_SUFFIX,
} from "../../config/service-constants";
import { buildChatPromptContent } from "../../services/message-content-service";
import { compressImageForApi } from "../../utils/image-compression";
import { telemetry } from "../../services/infrastructure/telemetry";

const MAX_TEXT_ATTACHMENT_CHARS = DISCORD_MAX_TEXT_ATTACHMENT_CHARS;
const discordTelemetry = telemetry.child({ component: "discord" });

// ---------------------------------------------------------------------------
// Batch types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

export function nextRequestId(prefix: string) {
  return `${prefix}-${Date.now()}`;
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

// ---------------------------------------------------------------------------
// DM message batcher
// ---------------------------------------------------------------------------

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
        discordTelemetry.recordError(error, {
          batchKey,
          eventName: "discord.message.batch_timeout_dispatch",
        });
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

// ---------------------------------------------------------------------------
// Attachment processing
// ---------------------------------------------------------------------------

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

export async function buildAttachmentBlocks(
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
          const compressed = await compressImageForApi(bytes);
          const mimeType = compressed.compressed
            ? compressed.mimeType
            : detectImageMimeType(bytes) ?? normalizeAttachmentMimeType(attachment) ?? "image/png";
          return [
            {
              type: "text" as const,
              text: `Attached image: ${descriptor}.`,
            },
            {
              type: "image" as const,
              data: Buffer.from(compressed.data).toString("base64"),
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

export async function buildMessageRequest(
  conversationKey: string,
  text: string,
  attachments: IterableIterator<Attachment>,
): Promise<AppRequest> {
  const attachmentBlocks = await buildAttachmentBlocks(attachments);
  const chatContent = attachmentBlocks.length > 0
    ? buildChatPromptContent({ text, blocks: attachmentBlocks })
    : undefined;

  return {
    id: nextRequestId("chat"),
    text,
    chatContent,
    conversationKey,
  };
}

export function isStopCommandContent(text: string) {
  return text.trim().toLowerCase() === "/stop";
}

export function isDirectMessage(message: Message): boolean {
  return message.channel.type === ChannelType.DM;
}
