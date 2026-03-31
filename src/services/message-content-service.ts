import type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ImageContent,
} from "../messages/types";
import type {
  ChatImageContentBlock,
  ChatPromptContent,
  ChatPromptContentBlock,
  ChatTextContentBlock,
} from "../domain/assistant";
import { attemptOr } from "../utils/result";

const APPROXIMATE_IMAGE_TOKENS = 1_024;
const REMOTE_IMAGE_PROTOCOLS = new Set(["http:", "https:"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTextBlock(value: unknown): value is ChatTextContentBlock {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isImageBlock(value: unknown): value is ChatImageContentBlock {
  return (
    isRecord(value) &&
    value.type === "image" &&
    typeof value.data === "string" &&
    typeof value.mimeType === "string" &&
    (value.sourceUrl === undefined || typeof value.sourceUrl === "string")
  );
}

function normalizeSourceUrl(sourceUrl: unknown) {
  if (typeof sourceUrl !== "string") {
    return undefined;
  }

  const trimmed = sourceUrl.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeChatPromptContent(content: unknown): ChatPromptContentBlock[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const normalized: ChatPromptContentBlock[] = [];
  for (const block of content) {
    if (isTextBlock(block)) {
      normalized.push({
        type: "text",
        text: block.text,
      });
      continue;
    }

    if (isImageBlock(block)) {
      const sourceUrl = normalizeSourceUrl(block.sourceUrl);
      normalized.push({
        type: "image",
        data: block.data,
        mimeType: block.mimeType,
        ...(sourceUrl ? { sourceUrl } : {}),
      });
    }
  }

  return normalized;
}

export function resolveRemoteImageUrl(sourceUrl: unknown) {
  const normalized = normalizeSourceUrl(sourceUrl);
  if (!normalized) {
    return null;
  }

  return attemptOr(() => {
    const url = new URL(normalized);
    if (!REMOTE_IMAGE_PROTOCOLS.has(url.protocol)) {
      return null;
    }
    return url.toString();
  }, null);
}

export function buildChatPromptContent(params: {
  text?: string;
  blocks?: ChatPromptContentBlock[];
}): ChatPromptContent {
  const normalizedText = params.text?.trim() ?? "";
  const blocks = [...(params.blocks ?? [])];

  if (blocks.length === 0) {
    return normalizedText;
  }

  return [
    ...(normalizedText ? [{ type: "text", text: normalizedText } satisfies ChatTextContentBlock] : []),
    ...blocks,
  ];
}

export function prependTextToChatPromptContent(content: ChatPromptContent, text: string): ChatPromptContent {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return content;
  }

  const blocks = normalizeChatPromptContent(content);
  if (blocks.length === 0) {
    return normalizedText;
  }

  const firstBlock = blocks[0];
  if (firstBlock?.type === "text") {
    return [
      { type: "text", text: `${normalizedText}\n\n${firstBlock.text}` },
      ...blocks.slice(1),
    ];
  }

  return [
    { type: "text", text: normalizedText },
    ...blocks,
  ];
}

export function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  return normalizeChatPromptContent(content)
    .filter((block): block is ChatTextContentBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
}

export function extractTextFromMessage(message: Message): string {
  if (message.role === "user") {
    const user = message as UserMessage;
    if (typeof user.content === "string") {
      return user.content;
    }
    return (user.content as (TextContent | ImageContent)[])
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("\n\n");
  }

  if (message.role === "assistant") {
    const assistant = message as AssistantMessage;
    return assistant.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  if (message.role === "toolResult") {
    const toolResult = message as ToolResultMessage;
    return toolResult.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("\n\n");
  }

  return "";
}

export function approximateContentTokens(content: unknown) {
  const blocks = normalizeChatPromptContent(content);
  if (blocks.length === 0) {
    return 0;
  }

  const textTokens = blocks
    .filter((block): block is ChatTextContentBlock => block.type === "text")
    .reduce((sum, block) => sum + Math.ceil(block.text.length / 4), 0);
  const imageTokens = blocks
    .filter((block): block is ChatImageContentBlock => block.type === "image")
    .length * APPROXIMATE_IMAGE_TOKENS;
  return textTokens + imageTokens;
}

export function toPiUserContent(content: unknown) {
  const blocks = normalizeChatPromptContent(content);
  if (blocks.length === 0) {
    return typeof content === "string" ? content : "";
  }

  if (blocks.length === 1 && blocks[0]?.type === "text") {
    return blocks[0].text;
  }

  return blocks.map((block) =>
    block.type === "text"
      ? { type: "text" as const, text: block.text }
      : { type: "image" as const, data: block.data, mimeType: block.mimeType }
  );
}
