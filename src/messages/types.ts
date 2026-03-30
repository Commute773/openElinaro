/**
 * Canonical message types for the agent system.
 *
 * Re-exports core types as the single source of truth.
 * pi-ai types are an implementation detail of PiCore only.
 */
export type {
  CoreMessage as Message,
  CoreUserMessage as UserMessage,
  CoreAssistantMessage as AssistantMessage,
  CoreToolResultMessage as ToolResultMessage,
  CoreTextContent as TextContent,
  CoreThinkingContent as ThinkingContent,
  CoreImageContent as ImageContent,
  CoreToolCall as ToolCall,
  CoreUsage as Usage,
  CoreStopReason as StopReason,
  CoreToolDefinition as Tool,
  CoreThinkingLevel as ThinkingLevel,
} from "../core/types";

import type {
  CoreMessage as Message,
  CoreUserMessage as UserMessage,
  CoreAssistantMessage as AssistantMessage,
  CoreToolResultMessage as ToolResultMessage,
  CoreTextContent as TextContent,
  CoreImageContent as ImageContent,
} from "../core/types";

// ---------------------------------------------------------------------------
// Helper constructors
// ---------------------------------------------------------------------------

export function userMessage(content: string | (TextContent | ImageContent)[]): UserMessage {
  return { role: "user", content, timestamp: Date.now() };
}

export function assistantTextMessage(text: string, meta?: {
  provider?: string;
  model?: string;
}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: meta?.provider ?? "unknown",
    model: meta?.model ?? "unknown",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export function toolResultMessage(params: {
  toolCallId: string;
  toolName: string;
  content: string;
  isError?: boolean;
  details?: unknown;
}): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName,
    content: [{ type: "text", text: params.content }],
    details: params.details,
    isError: params.isError ?? false,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

export function isUserMessage(msg: Message): msg is UserMessage {
  return msg.role === "user";
}

export function isAssistantMessage(msg: Message): msg is AssistantMessage {
  return msg.role === "assistant";
}

export function isToolResultMessage(msg: Message): msg is ToolResultMessage {
  return msg.role === "toolResult";
}

/**
 * Extract the final text from an assistant message's content blocks.
 */
export function extractAssistantText(msg: AssistantMessage): string {
  return msg.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}
