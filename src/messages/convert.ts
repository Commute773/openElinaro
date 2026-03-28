/**
 * Bidirectional conversion between LangChain BaseMessage and Pi Message.
 *
 * This module exists ONLY during the migration from LangChain to Pi.
 * It will be deleted in Phase 7 once all consumers use Pi types directly.
 */
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
} from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// LangChain → Pi
// ---------------------------------------------------------------------------

export function langchainToPi(msg: BaseMessage): Message | null {
  const type = msg._getType();
  switch (type) {
    case "human":
      return langchainHumanToPi(msg);
    case "ai":
      return langchainAiToPi(msg as AIMessage);
    case "tool":
      return langchainToolToPi(msg as ToolMessage);
    case "system":
      // Pi system prompts live in Context.systemPrompt, not as a message.
      // Drop SystemMessage when converting to Pi messages.
      return null;
    default:
      return null;
  }
}

function langchainHumanToPi(msg: BaseMessage): UserMessage {
  const content = typeof msg.content === "string"
    ? msg.content
    : msg.content.map((block) => {
        if (typeof block === "string") return { type: "text" as const, text: block };
        if (block.type === "text") return { type: "text" as const, text: block.text as string };
        if (block.type === "image_url") {
          return {
            type: "image" as const,
            data: (block as any).image_url?.url ?? "",
            mimeType: "image/png",
          };
        }
        return { type: "text" as const, text: JSON.stringify(block) };
      });
  return {
    role: "user",
    content,
    timestamp: Date.now(),
  };
}

function langchainAiToPi(msg: AIMessage): AssistantMessage {
  const textContent: TextContent[] = [];

  if (typeof msg.content === "string") {
    if (msg.content) textContent.push({ type: "text", text: msg.content });
  } else {
    for (const block of msg.content) {
      if (typeof block === "string") {
        textContent.push({ type: "text", text: block });
      } else if (block.type === "text") {
        textContent.push({ type: "text", text: block.text as string });
      }
    }
  }

  const toolCalls = (msg.tool_calls ?? []).map((tc) => ({
    type: "toolCall" as const,
    id: tc.id ?? "",
    name: tc.name,
    arguments: tc.args as Record<string, any>,
  }));

  const usage = msg.usage_metadata;

  return {
    role: "assistant",
    content: [...textContent, ...toolCalls],
    api: (msg.response_metadata?.provider as string) ?? "unknown",
    provider: (msg.response_metadata?.provider as string) ?? "unknown",
    model: (msg.response_metadata?.modelId as string) ?? "unknown",
    usage: {
      input: usage?.input_tokens ?? 0,
      output: usage?.output_tokens ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
}

function langchainToolToPi(msg: ToolMessage): ToolResultMessage {
  const text = typeof msg.content === "string"
    ? msg.content
    : JSON.stringify(msg.content);
  return {
    role: "toolResult",
    toolCallId: msg.tool_call_id,
    toolName: msg.name ?? "unknown",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}

/**
 * Convert a full LangChain conversation to Pi messages.
 * Drops SystemMessages (Pi puts system prompt in Context.systemPrompt).
 */
export function langchainMessagesToPi(messages: BaseMessage[]): Message[] {
  const result: Message[] = [];
  for (const msg of messages) {
    const converted = langchainToPi(msg);
    if (converted) result.push(converted);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pi → LangChain
// ---------------------------------------------------------------------------

export function piToLangchain(msg: Message): BaseMessage {
  switch (msg.role) {
    case "user":
      return piUserToLangchain(msg);
    case "assistant":
      return piAssistantToLangchain(msg);
    case "toolResult":
      return piToolResultToLangchain(msg);
  }
}

function piUserToLangchain(msg: UserMessage): HumanMessage {
  if (typeof msg.content === "string") {
    return new HumanMessage(msg.content);
  }
  const blocks = msg.content.map((block) => {
    if (block.type === "text") return { type: "text" as const, text: block.text };
    return { type: "image_url" as const, image_url: { url: block.data } };
  });
  return new HumanMessage({ content: blocks });
}

function piAssistantToLangchain(msg: AssistantMessage): AIMessage {
  const text = msg.content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("");

  const toolCalls = msg.content
    .filter((b): b is { type: "toolCall"; id: string; name: string; arguments: Record<string, any> } => b.type === "toolCall")
    .map((tc) => ({
      id: tc.id,
      name: tc.name,
      args: tc.arguments,
      type: "tool_call" as const,
    }));

  return new AIMessage({
    content: text,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    response_metadata: {
      provider: msg.provider,
      modelId: msg.model,
    },
    usage_metadata: {
      input_tokens: msg.usage.input,
      output_tokens: msg.usage.output,
      total_tokens: msg.usage.totalTokens,
    },
  });
}

function piToolResultToLangchain(msg: ToolResultMessage): ToolMessage {
  const text = msg.content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("");
  return new ToolMessage({
    content: text,
    tool_call_id: msg.toolCallId,
    name: msg.toolName,
  });
}

/**
 * Convert Pi messages back to LangChain format.
 */
export function piMessagesToLangchain(messages: Message[]): BaseMessage[] {
  return messages.map(piToLangchain);
}
