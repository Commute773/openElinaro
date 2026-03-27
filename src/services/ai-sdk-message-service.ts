import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool, type LanguageModelUsage, type ToolSet } from "ai";
import type { LanguageModelV3FinishReason, LanguageModelV3Usage } from "@ai-sdk/provider";
import type { ModelMessage, ToolResultOutput } from "@ai-sdk/provider-utils";
import { extractTextFromMessage, normalizeChatPromptContent, resolveRemoteImageUrl } from "./message-content-service";
import { ToolResultStore } from "./tool-result-store";

const MAX_BASE64_IMAGE_BYTES = 5 * 1024 * 1024;
const TOOL_RESULT_INLINE_CHAR_THRESHOLD = 1_000;
const TOOL_RESULT_REFERENCE_ELIGIBLE_TOOLS = new Set([
  "read_file",
  "list_dir",
  "grep",
  "exec_command",
  "exec_status",
  "exec_output",
  "web_search",
  "web_fetch",
  "conversation_search",
  "memory_search",
  "telemetry_query",
]);

function toToolCallArgs(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  return {};
}

function resolveImageMimeType(mediaType: unknown, image: unknown) {
  if (typeof mediaType === "string" && mediaType.trim()) {
    return mediaType.trim();
  }

  if (typeof image !== "string") {
    return undefined;
  }

  const dataUrlMatch = image.match(/^data:([^;,]+)[;,]/i);
  return dataUrlMatch?.[1]?.trim() || undefined;
}

export function mapStopReasonToFinishReason(stopReason: unknown, hasToolCalls: boolean): LanguageModelV3FinishReason {
  if (hasToolCalls) {
    return { unified: "tool-calls", raw: typeof stopReason === "string" ? stopReason : "tool_calls" };
  }

  switch (stopReason) {
    case "length":
      return { unified: "length", raw: "length" };
    case "content-filter":
      return { unified: "content-filter", raw: "content-filter" };
    case "aborted":
    case "error":
      return { unified: "error", raw: typeof stopReason === "string" ? stopReason : "error" };
    case "stop":
    default:
      return { unified: "stop", raw: typeof stopReason === "string" ? stopReason : "stop" };
  }
}

export function toLanguageModelUsage(usageMetadata: AIMessage["usage_metadata"]): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: usageMetadata?.input_tokens,
      noCache: usageMetadata?.input_tokens !== undefined
        ? Math.max(
            0,
            usageMetadata.input_tokens
              - (usageMetadata.input_token_details?.cache_read ?? 0)
              - (usageMetadata.input_token_details?.cache_creation ?? 0),
          )
        : undefined,
      cacheRead: usageMetadata?.input_token_details?.cache_read,
      cacheWrite: usageMetadata?.input_token_details?.cache_creation,
    },
    outputTokens: {
      total: usageMetadata?.output_tokens,
      text: usageMetadata?.output_tokens,
      reasoning: undefined,
    },
    raw: undefined,
  };
}

export function toV3Usage(usage: LanguageModelUsage | undefined): LanguageModelV3Usage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: {
      total: usage.inputTokens,
      noCache: usage.inputTokenDetails.noCacheTokens,
      cacheRead: usage.inputTokenDetails.cacheReadTokens,
      cacheWrite: usage.inputTokenDetails.cacheWriteTokens,
    },
    outputTokens: {
      total: usage.outputTokens,
      text: usage.outputTokenDetails.textTokens,
      reasoning: usage.outputTokenDetails.reasoningTokens,
    },
    raw: usage.raw,
  };
}

export function stringifyToolResultOutput(output: ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.value, null, 2);
    case "execution-denied":
      return output.reason?.trim() ? output.reason : "Tool execution was denied.";
    case "content":
      return output.value
        .map((part) => {
          if (part.type === "text") {
            return part.text;
          }
          if (part.type === "file-data") {
            return `[file:${part.mediaType}]`;
          }
          if (part.type === "image-data") {
            return `[image:${part.mediaType}]`;
          }
          if (part.type === "file-url" || part.type === "image-url") {
            return String(part.url);
          }
          return JSON.stringify(part);
        })
        .join("\n");
    default:
      return JSON.stringify(output);
  }
}

function formatStoredToolResultMessage(params: {
  ref: string;
  toolName: string;
  status: "success" | "error";
  charLength: number;
  lineCount: number;
}) {
  return `[tool_result_ref ref=${params.ref} reopen_with=tool_result_read tool=${params.toolName} status=${params.status} chars=${params.charLength} lines=${params.lineCount}]`;
}

function toModelMessage(message: BaseMessage): ModelMessage | null {
  if (message instanceof SystemMessage) {
    return {
      role: "system",
      content: extractTextFromMessage(message),
    };
  }

  if (message instanceof HumanMessage) {
    const blocks = normalizeChatPromptContent(message.content);
    if (blocks.length === 0) {
      return {
        role: "user",
        content: typeof message.content === "string" ? message.content : extractTextFromMessage(message),
      };
    }

    return {
      role: "user",
      content: blocks.map((block) => {
        if (block.type === "text") {
          return { type: "text" as const, text: block.text };
        }

        const remoteUrl = block.data.length > MAX_BASE64_IMAGE_BYTES
          ? resolveRemoteImageUrl(block.sourceUrl)
          : null;
        if (remoteUrl) {
          return { type: "image" as const, image: new URL(remoteUrl) };
        }

        return {
          type: "image" as const,
          image: block.data,
          mediaType: block.mimeType,
        };
      }),
    };
  }

  if (message instanceof AIMessage) {
    const text = extractTextFromMessage(message);
    const parts = [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...((message.tool_calls ?? []).map((toolCall) => ({
        type: "tool-call" as const,
        toolCallId: toolCall.id ?? `${toolCall.name}-${Date.now()}`,
        toolName: toolCall.name,
        input: toolCall.args,
      }))),
    ];

    return {
      role: "assistant",
      content: parts.length === 1 && parts[0]?.type === "text" ? parts[0].text : parts,
    };
  }

  if (message instanceof ToolMessage) {
    return {
      role: "tool",
      content: [
        {
          type: "tool-result" as const,
          toolCallId: message.tool_call_id,
          toolName: message.name ?? "tool",
          output: {
            type: message.status === "error" ? "error-text" : "text",
            value: extractTextFromMessage(message),
          },
        },
      ],
    };
  }

  return null;
}

export function toModelMessages(messages: BaseMessage[]): ModelMessage[] {
  return messages
    .map((message) => toModelMessage(message))
    .filter((message): message is ModelMessage => message !== null);
}

function fromUserMessage(message: Extract<ModelMessage, { role: "user" }>) {
  if (typeof message.content === "string") {
    return new HumanMessage(message.content);
  }

  const content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  > = [];
  for (const part of message.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
      continue;
    }

    if (part.type === "image") {
      const mimeType = resolveImageMimeType(part.mediaType, part.image) ?? "image/*";
      content.push({
        type: "image",
        data: typeof part.image === "string" ? part.image : String(part.image),
        mimeType,
      });
    }
  }

  return new HumanMessage(content);
}

export function fromAssistantMessage(
  message: Extract<ModelMessage, { role: "assistant" }>,
  options?: {
    warnings?: string[];
    usage?: LanguageModelV3Usage;
    modelId?: string;
    provider?: string;
    finishReason?: LanguageModelV3FinishReason;
  },
) {
  const parts = typeof message.content === "string"
    ? [{ type: "text" as const, text: message.content }]
    : message.content;
  const text = parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");

  return new AIMessage({
    content: text,
    tool_calls: parts
      .filter((part): part is Extract<typeof part, { type: "tool-call" }> => part.type === "tool-call")
      .map((part) => ({
        id: part.toolCallId,
        name: part.toolName,
        args: toToolCallArgs(part.input),
        type: "tool_call" as const,
      })),
    response_metadata: {
      provider: options?.provider,
      model: options?.modelId,
      stopReason: options?.finishReason?.raw,
      warnings: options?.warnings,
    },
    usage_metadata: options?.usage
      ? {
          input_tokens: options.usage.inputTokens.total ?? 0,
          output_tokens: options.usage.outputTokens.total ?? 0,
          total_tokens:
            (options.usage.inputTokens.total ?? 0)
            + (options.usage.outputTokens.total ?? 0),
          input_token_details: {
            cache_read: options.usage.inputTokens.cacheRead ?? 0,
            cache_creation: options.usage.inputTokens.cacheWrite ?? 0,
          },
        }
      : undefined,
  });
}

async function fromToolMessage(
  message: Extract<ModelMessage, { role: "tool" }>,
  options?: {
    toolResultStore?: ToolResultStore;
    toolResultNamespace?: string;
  },
): Promise<ToolMessage[]> {
  const results: ToolMessage[] = [];
  for (const part of message.content) {
    if (part.type !== "tool-result") {
      continue;
    }

    const rawContent = stringifyToolResultOutput(part.output);
    const status =
      part.output.type === "error-text" || part.output.type === "error-json"
        ? "error"
        : "success";
    const toolName = part.toolName ?? "tool";
    const shouldStoreReference =
      Boolean(options?.toolResultStore && options?.toolResultNamespace)
      && rawContent.length > TOOL_RESULT_INLINE_CHAR_THRESHOLD
      && TOOL_RESULT_REFERENCE_ELIGIBLE_TOOLS.has(toolName);

    if (shouldStoreReference) {
      const stored = await options!.toolResultStore!.save({
        namespace: options!.toolResultNamespace!,
        toolCallId: part.toolCallId,
        toolName,
        status,
        content: rawContent,
      });
      results.push(
        new ToolMessage({
          content: formatStoredToolResultMessage({
            ref: stored.ref,
            toolName: stored.toolName,
            status: stored.status,
            charLength: stored.charLength,
            lineCount: stored.lineCount,
          }),
          tool_call_id: part.toolCallId,
          name: toolName,
          status,
          additional_kwargs: {
            openelinaroToolResultRef: stored.ref,
            openelinaroToolResultNamespace: stored.namespace,
          },
        }),
      );
      continue;
    }

    results.push(
      new ToolMessage({
        content: rawContent,
        tool_call_id: part.toolCallId,
        name: toolName,
        status,
      }),
    );
  }
  return results;
}

export async function fromModelMessages(messages: ModelMessage[]): Promise<BaseMessage[]> {
  const results: BaseMessage[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        results.push(new SystemMessage(message.content));
        break;
      case "user":
        results.push(fromUserMessage(message));
        break;
      case "assistant":
        results.push(fromAssistantMessage(message));
        break;
      case "tool":
        results.push(...await fromToolMessage(message));
        break;
    }
  }
  return results;
}

export async function appendResponseMessages(
  baseMessages: BaseMessage[],
  responseMessages: ModelMessage[],
  options?: {
    warnings?: string[];
    usage?: LanguageModelV3Usage;
    modelId?: string;
    provider?: string;
    finishReason?: LanguageModelV3FinishReason;
    toolResultStore?: ToolResultStore;
    toolResultNamespace?: string;
  },
): Promise<BaseMessage[]> {
  const nextMessages = [...baseMessages];
  for (let index = 0; index < responseMessages.length; index += 1) {
    const message = responseMessages[index]!;
    if (message.role === "assistant") {
      nextMessages.push(
        fromAssistantMessage(message, index === responseMessages.length - 1 ? options : undefined),
      );
      continue;
    }

    if (message.role === "tool") {
      nextMessages.push(...await fromToolMessage(message, options));
      continue;
    }

    if (message.role === "user") {
      nextMessages.push(fromUserMessage(message));
      continue;
    }

    nextMessages.push(new SystemMessage(message.content));
  }
  return nextMessages;
}

export function toToolSet(tools: StructuredToolInterface[]): ToolSet {
  return Object.fromEntries(
    tools.map((entry) => [
      entry.name,
      tool({
        description: entry.description,
        inputSchema: entry.schema as never,
        execute: async (input: unknown) =>
          (entry as { invoke: (arg: unknown) => Promise<unknown> }).invoke(input),
      }),
    ]),
  ) as ToolSet;
}
