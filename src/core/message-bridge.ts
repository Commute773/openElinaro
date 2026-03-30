/**
 * Bidirectional converters between pi-ai message types and core message types.
 *
 * Since core types are structurally compatible with pi-ai types, the Pi
 * adapter is near zero-cost — it mostly adds/removes the `api` field on
 * AssistantMessage. Tool and content types are identity mappings.
 */
import type {
  Message as PiMessage,
  UserMessage as PiUserMessage,
  AssistantMessage as PiAssistantMessage,
  ToolResultMessage as PiToolResultMessage,
  Tool as PiTool,
  ToolCall as PiToolCall,
} from "@mariozechner/pi-ai";
import type {
  CoreMessage,
  CoreUserMessage,
  CoreAssistantMessage,
  CoreToolResultMessage,
  CoreToolCall,
  CoreToolDefinition,
} from "./types";

// ---------------------------------------------------------------------------
// Pi → Core
// ---------------------------------------------------------------------------

export function piUserMessageToCore(msg: PiUserMessage): CoreUserMessage {
  return msg; // Structurally identical
}

export function piAssistantMessageToCore(msg: PiAssistantMessage): CoreAssistantMessage {
  // Drop `api` field (pi-ai specific), keep everything else
  return {
    role: "assistant",
    content: msg.content, // TextContent, ThinkingContent, ToolCall are identical
    provider: msg.provider,
    model: msg.model,
    responseId: msg.responseId,
    usage: msg.usage,
    stopReason: msg.stopReason,
    errorMessage: msg.errorMessage,
    timestamp: msg.timestamp,
  };
}

export function piToolResultMessageToCore(msg: PiToolResultMessage): CoreToolResultMessage {
  return msg; // Structurally identical
}

export function piMessageToCore(msg: PiMessage): CoreMessage {
  switch (msg.role) {
    case "user":
      return piUserMessageToCore(msg);
    case "assistant":
      return piAssistantMessageToCore(msg);
    case "toolResult":
      return piToolResultMessageToCore(msg);
  }
}

export function piMessagesToCore(msgs: PiMessage[]): CoreMessage[] {
  return msgs.map(piMessageToCore);
}

export function piToolCallToCore(tc: PiToolCall): CoreToolCall {
  return tc; // Structurally identical
}

export function piToolToCoreDef(tool: PiTool): CoreToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Core → Pi
// ---------------------------------------------------------------------------

/**
 * Convert a core assistant message back to pi-ai format.
 * Requires the original `api` value since core types don't carry it.
 * Falls back to "unknown" if not provided.
 */
export function coreAssistantMessageToPi(
  msg: CoreAssistantMessage,
  api?: string,
): PiAssistantMessage {
  return {
    role: "assistant",
    content: msg.content,
    api: api ?? "unknown",
    provider: msg.provider,
    model: msg.model,
    responseId: msg.responseId,
    usage: msg.usage,
    stopReason: msg.stopReason,
    errorMessage: msg.errorMessage,
    timestamp: msg.timestamp,
  };
}

export function coreUserMessageToPi(msg: CoreUserMessage): PiUserMessage {
  return msg; // Structurally identical
}

export function coreToolResultMessageToPi(msg: CoreToolResultMessage): PiToolResultMessage {
  return msg; // Structurally identical
}

/**
 * Convert a core message back to pi-ai format.
 * For assistant messages, the `api` field defaults to "unknown" since core
 * types don't track it. Callers that need a specific `api` value should
 * handle assistant messages separately via `coreAssistantMessageToPi()`.
 */
export function coreMessageToPi(msg: CoreMessage, defaultApi?: string): PiMessage {
  switch (msg.role) {
    case "user":
      return coreUserMessageToPi(msg);
    case "assistant":
      return coreAssistantMessageToPi(msg, defaultApi);
    case "toolResult":
      return coreToolResultMessageToPi(msg);
  }
}

export function coreMessagesToPi(msgs: CoreMessage[], defaultApi?: string): PiMessage[] {
  return msgs.map((m) => coreMessageToPi(m, defaultApi));
}

export function coreToolCallToPi(tc: CoreToolCall): PiToolCall {
  return tc; // Structurally identical
}
