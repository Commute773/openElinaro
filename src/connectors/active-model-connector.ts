import {
  stream,
  type Context,
  type Message,
  type Tool as PiTool,
  type Usage,
} from "@mariozechner/pi-ai";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { approximateTextTokens } from "../utils/text-utils";
import {
  mapStopReasonToFinishReason,
  stringifyToolResultOutput,
  toLanguageModelUsage,
} from "../services/ai-sdk-message-service";
import { getAssistantDisplayName } from "../config/runtime-identity";
import { InferencePromptDriftMonitor, type InferencePromptDriftWarning } from "../services/inference-prompt-drift-monitor";

import { ModelService } from "../services/model-service";
import { telemetry } from "../services/telemetry";
import { createTraceSpan } from "../utils/telemetry-helpers";
import type {
  UsagePromptBreakdown,
  UsagePromptContributor,
  UsagePromptDiagnostics,
} from "../services/usage-tracking-service";
import type { ProviderConnector } from "./provider-connector";
import { assertSuccessfulProviderResponse } from "./provider-response";

const connectorTelemetry = telemetry.child({ component: "connector" });
const MAX_PROMPT_DIAGNOSTIC_CONTRIBUTORS = 12;
const PROMPT_DIAGNOSTIC_PREVIEW_CHARS = 160;

const traceSpan = createTraceSpan(connectorTelemetry);

function toUsageMetadata(usage: Usage) {
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  const totalTokens = usage.totalTokens > 0 ? usage.totalTokens : inputTokens + usage.output;
  return {
    input_tokens: inputTokens,
    output_tokens: usage.output,
    total_tokens: totalTokens,
    input_token_details: {
      cache_read: usage.cacheRead,
      cache_creation: usage.cacheWrite,
    },
  };
}


function compactPreview(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= PROMPT_DIAGNOSTIC_PREVIEW_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, PROMPT_DIAGNOSTIC_PREVIEW_CHARS - 3)).trimEnd()}...`;
}

function stringifyMessageContent(content: Message["content"]) {
  if (typeof content === "string") {
    return content;
  }
  return JSON.stringify(content);
}

function estimateAssistantToolCallTokens(message: Message) {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return 0;
  }

  return message.content.reduce((sum, part) => {
    if (part.type !== "toolCall") {
      return sum;
    }
    return sum + approximateTextTokens(JSON.stringify({
      id: part.id,
      name: part.name,
      args: part.arguments ?? {},
    })) + 24;
  }, 0);
}

function buildPromptDiagnostics(params: {
  systemPrompt: string;
  messages: Message[];
  tools: PiTool[];
}): UsagePromptDiagnostics {
  const breakdown: UsagePromptBreakdown = {
    systemPromptTokens: approximateTextTokens(params.systemPrompt),
    userMessageTokens: 0,
    assistantReplyTokens: 0,
    toolCallInputTokens: 0,
    toolResponseTokens: 0,
    toolDefinitionTokens: 0,
    estimatedTotalTokens: 0,
  };
  const contributors: UsagePromptContributor[] = [];
  const promptMessagesByRole = {
    user: 0,
    assistant: 0,
    tool: 0,
  };

  if (params.systemPrompt.trim()) {
    contributors.push({
      kind: "system_prompt",
      tokenCount: breakdown.systemPromptTokens,
      charCount: params.systemPrompt.length,
      preview: compactPreview(params.systemPrompt),
    });
  }

  params.messages.forEach((message, index) => {
    const text = stringifyMessageContent(message.content);
    const charCount = text.length;

    if (message.role === "user") {
      const tokenCount = approximateTextTokens(text) + 12;
      breakdown.userMessageTokens += tokenCount;
      promptMessagesByRole.user += 1;
      contributors.push({
        kind: "message",
        role: "user",
        messageIndex: index + 1,
        tokenCount,
        charCount,
        preview: compactPreview(text),
      });
      return;
    }

    if (message.role === "assistant") {
      const replyTokens = approximateTextTokens(text);
      const toolCallTokens = estimateAssistantToolCallTokens(message);
      breakdown.assistantReplyTokens += replyTokens;
      breakdown.toolCallInputTokens += toolCallTokens;
      promptMessagesByRole.assistant += 1;
      contributors.push({
        kind: "message",
        role: "assistant",
        messageIndex: index + 1,
        tokenCount: replyTokens + toolCallTokens,
        charCount,
        preview: compactPreview(text),
      });
      return;
    }

    if (message.role === "toolResult") {
      const tokenCount = approximateTextTokens(text) + 24;
      breakdown.toolResponseTokens += tokenCount;
      promptMessagesByRole.tool += 1;
      contributors.push({
        kind: "message",
        role: "tool",
        messageIndex: index + 1,
        toolName: message.toolName,
        tokenCount,
        charCount,
        preview: compactPreview(text),
      });
    }
  });

  for (const tool of params.tools) {
    const serialized = JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    });
    const tokenCount = approximateTextTokens(serialized);
    breakdown.toolDefinitionTokens += tokenCount;
    contributors.push({
      kind: "tool_definition",
      toolName: tool.name,
      tokenCount,
      charCount: serialized.length,
      preview: compactPreview(serialized),
    });
  }

  breakdown.estimatedTotalTokens =
    breakdown.systemPromptTokens +
    breakdown.userMessageTokens +
    breakdown.assistantReplyTokens +
    breakdown.toolCallInputTokens +
    breakdown.toolResponseTokens +
    breakdown.toolDefinitionTokens;

  return {
    version: 1,
    systemPromptChars: params.systemPrompt.length,
    promptMessageCount: params.messages.length,
    promptMessagesByRole,
    toolCount: params.tools.length,
    toolNames: params.tools.map((tool) => tool.name),
    approximateBreakdown: breakdown,
    topContributors: contributors
      .sort((left, right) => right.tokenCount - left.tokenCount)
      .slice(0, MAX_PROMPT_DIAGNOSTIC_CONTRIBUTORS),
  };
}

function toPiTool(toolDefinition: NonNullable<LanguageModelV3CallOptions["tools"]>[number]): PiTool {
  if (toolDefinition.type !== "function") {
    throw new Error(`Provider-defined tool ${toolDefinition.name} is not supported by the active model connector.`);
  }

  return {
    name: toolDefinition.name,
    description: toolDefinition.description ?? toolDefinition.name,
    parameters: toolDefinition.inputSchema as PiTool["parameters"],
  };
}

function toToolCallArgs(input: unknown) {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input;
  }
  return {};
}

type OpenElinaroProviderOptions = {
  sessionId?: string;
  conversationKey?: string;
  usagePurpose?: string;
};

function resolveProviderOptions(options: LanguageModelV3CallOptions): OpenElinaroProviderOptions {
  const metadata = options.providerOptions?.openelinaro;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }

  return metadata as OpenElinaroProviderOptions;
}

function resolveTransportPreference(providerId: string, sessionId: string | undefined) {
  if (providerId !== "openai-codex" || !sessionId) {
    return undefined;
  }
  return "websocket" as const;
}

function shouldRetryWithDefaultTransport(
  error: unknown,
  attemptedTransport: "websocket" | "auto" | "sse" | undefined,
) {
  if (attemptedTransport !== "websocket") {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\bwebsocket\b/i.test(message) || /\b1011\b/.test(message);
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

function toPiMessages(message: ModelMessage): Message[] {
  switch (message.role) {
    case "system":
      return [];
    case "user":
      if (typeof message.content === "string") {
        return [{
          role: "user",
          content: message.content,
          timestamp: Date.now(),
        }];
      }

      {
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
            continue;
          }
          // AI SDK v3 converts image parts to file parts internally
          if (part.type === "file" && typeof part.mediaType === "string" && part.mediaType.startsWith("image/")) {
            const imageData = part.data;
            content.push({
              type: "image",
              data: typeof imageData === "string"
                ? imageData
                : imageData instanceof Uint8Array
                  ? Buffer.from(imageData).toString("base64")
                  : String(imageData),
              mimeType: part.mediaType,
            });
          }
        }
        return [{
          role: "user",
          content,
          timestamp: Date.now(),
        }];
      }
    case "tool":
        return message.content.flatMap((part) => {
        if (part.type !== "tool-result") {
          return [];
        }
        return [{
          role: "toolResult",
          toolCallId: part.toolCallId,
          toolName: part.toolName ?? "tool",
          content: [{
            type: "text",
            text: stringifyToolResultOutput(part.output),
          }],
          isError: part.output.type === "error-text" || part.output.type === "error-json",
          timestamp: Date.now(),
        }];
      });
    case "assistant": {
      const parts = typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
      const content: Array<
        | { type: "text"; text: string }
        | { type: "toolCall"; id: string; name: string; arguments: object }
      > = [];
      for (const part of parts) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text });
          continue;
        }
        if (part.type === "tool-call") {
          content.push({
            type: "toolCall",
            id: part.toolCallId,
            name: part.toolName,
            arguments: toToolCallArgs(part.input),
          });
        }
      }
      return [{
        role: "assistant",
        api: "openai-codex-responses",
        provider: "active-model-router",
        model: "unknown",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: parts.some((part) => part.type === "tool-call") ? "toolUse" : "stop",
        timestamp: Date.now(),
        content,
      }];
    }
  }
}

export class ActiveModelConnector implements ProviderConnector {
  readonly providerId = "active-model-router";
  readonly provider = this.providerId;
  readonly specificationVersion = "v3" as const;
  readonly modelId = "active-model-router";
  readonly supportedUrls = {};
  private readonly promptDriftMonitor = new InferencePromptDriftMonitor();
  private readonly thinkingCallbacks = new Map<string, (message: string) => Promise<void> | void>();
  private onPromptDriftWarning?: (warning: InferencePromptDriftWarning) => void;

  constructor(private readonly modelService: ModelService) {}

  setPromptDriftWarningCallback(callback?: (warning: InferencePromptDriftWarning) => void) {
    this.onPromptDriftWarning = callback;
  }

  setThinkingCallback(sessionId: string, callback?: (message: string) => Promise<void> | void) {
    if (!callback) {
      this.thinkingCallbacks.delete(sessionId);
      return;
    }

    this.thinkingCallbacks.set(sessionId, callback);
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    return traceSpan(
      "connector.active_model.generate",
      async () => {
        const providerOptions = resolveProviderOptions(options);
        const resolved = await this.modelService.resolveModelForPurpose(providerOptions.usagePurpose);
        const systemPrompt = options.prompt
          .filter((message) => message.role === "system")
          .map((message) => message.content)
          .join("\n\n");
        const messages = options.prompt
          .filter((message) => message.role !== "system")
          .flatMap((message) => toPiMessages(message));
        const imageBlockCount = messages
          .filter((msg) => msg.role === "user" && Array.isArray(msg.content))
          .reduce((count, msg) => count + (msg.content as Array<{ type: string }>).filter((b) => b.type === "image").length, 0);
        if (imageBlockCount > 0) {
          connectorTelemetry.event(
            "connector.active_model.image_blocks",
            {
              sessionId: providerOptions.sessionId,
              imageBlockCount,
              modelInput: JSON.stringify(resolved.runtimeModel.input),
            },
            { level: "info" },
          );
        }
        const context: Context = {
          systemPrompt,
          messages,
          tools: options.tools?.map(toPiTool),
        };
        const promptDiagnostics = buildPromptDiagnostics({
          systemPrompt,
          messages,
          tools: context.tools ?? [],
        });
        const sessionId = typeof providerOptions.sessionId === "string"
          ? providerOptions.sessionId
          : `session-${Date.now()}`;
        const promptDriftWarning = this.promptDriftMonitor.inspect({
          sessionId,
          prompt: options.prompt,
        });

        if (promptDriftWarning) {
          const conversationKey = providerOptions.conversationKey;
          const purpose = providerOptions.usagePurpose;
          connectorTelemetry.event(
            "model.prompt.non_append_mutation",
            {
              sessionId,
              conversationKey,
              purpose,
              providerId: resolved.selection.providerId,
              modelId: resolved.selection.modelId,
              previousPromptLength: promptDriftWarning.previousPromptLength,
              currentPromptLength: promptDriftWarning.currentPromptLength,
              sharedPrefixLength: promptDriftWarning.sharedPrefixLength,
              removedLength: promptDriftWarning.removedLength,
              addedLength: promptDriftWarning.addedLength,
              sharedPrefixPercentOfPrevious: Number(
                promptDriftWarning.sharedPrefixPercentOfPrevious.toFixed(4),
              ),
              firstChangedMessageIndex: promptDriftWarning.firstChangedMessageIndex,
              previousChangedMessageRole: promptDriftWarning.previousChangedMessageRole,
              currentChangedMessageRole: promptDriftWarning.currentChangedMessageRole,
              previousChangedMessagePreview: promptDriftWarning.previousChangedMessagePreview,
              currentChangedMessagePreview: promptDriftWarning.currentChangedMessagePreview,
              removedPreview: promptDriftWarning.removedPreview,
              addedPreview: promptDriftWarning.addedPreview,
            },
            { level: "warn" },
          );

          if (this.onPromptDriftWarning) {
            try {
              this.onPromptDriftWarning(promptDriftWarning);
            } catch {
              // best-effort notification
            }
          }
        }

        const executeRequest = async (transport: "websocket" | "auto" | "sse" | undefined) => {
          const thinkingCallback = this.thinkingCallbacks.get(sessionId);
          const responseStream = stream(resolved.runtimeModel, context, {
            apiKey: resolved.apiKey,
            sessionId,
            transport,
            signal: options.abortSignal,
            ...(options.maxOutputTokens != null && { maxTokens: options.maxOutputTokens }),
            ...this.modelService.getInferenceOptions(resolved.selection),
          });
          let thinkingReported = false;
          for await (const event of responseStream) {
            if (event.type !== "thinking_start" || thinkingReported || !thinkingCallback) {
              continue;
            }

            thinkingReported = true;
            void Promise.resolve(thinkingCallback(`${getAssistantDisplayName()} is thinking...`)).catch((error) => {
              connectorTelemetry.event(
                "connector.active_model.thinking_callback.error",
                {
                  sessionId,
                  conversationKey: providerOptions.conversationKey,
                  usagePurpose: providerOptions.usagePurpose,
                  error: error instanceof Error ? error.message : String(error),
                },
                { level: "debug", outcome: "error" },
              );
            });
          }
          const response = await responseStream.result();
          return assertSuccessfulProviderResponse(response, {
            connector: this.providerId,
            sessionId,
            conversationKey: providerOptions.conversationKey,
            usagePurpose: providerOptions.usagePurpose,
            inputMessages: messages.length,
            toolCount: options.tools?.length ?? 0,
          });
        };
        const preferredTransport = resolveTransportPreference(resolved.selection.providerId, sessionId);
        let response;
        try {
          response = await executeRequest(preferredTransport);
        } catch (error) {
          if (!shouldRetryWithDefaultTransport(error, preferredTransport)) {
            throw error;
          }
          connectorTelemetry.event(
            "connector.active_model.transport_fallback",
            {
              sessionId,
              conversationKey: providerOptions.conversationKey,
              usagePurpose: providerOptions.usagePurpose,
              providerId: resolved.selection.providerId,
              modelId: resolved.selection.modelId,
              attemptedTransport: preferredTransport,
              fallbackTransport: "sse",
              error: error instanceof Error ? error.message : String(error),
            },
            { level: "warn" },
          );
          response = await executeRequest("sse");
        }

        const modelId = response.model ?? resolved.selection.modelId;
        const recordedUsage = this.modelService.recordUsage({
          providerId: resolved.selection.providerId,
          modelId,
          sessionId,
          conversationKey: providerOptions.conversationKey,
          purpose: providerOptions.usagePurpose,
          usage: response.usage,
          providerReportedUsage: response.usage,
          promptDiagnostics,
        });

        const content: LanguageModelV3Content[] = [];
        const text = response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("")
          .trim();
        if (text) {
          content.push({ type: "text", text });
        }
        const toolCalls = response.content.filter((block) => block.type === "toolCall");
        for (const toolCall of toolCalls) {
          content.push({
            type: "tool-call",
            toolCallId: toolCall.id ?? `${toolCall.name}-${Date.now()}`,
            toolName: toolCall.name,
            input: JSON.stringify(toolCall.arguments ?? {}),
          });
        }

        return {
          content,
          finishReason: mapStopReasonToFinishReason(response.stopReason, toolCalls.length > 0),
          usage: toLanguageModelUsage(toUsageMetadata(response.usage)),
          warnings: [
            ...recordedUsage.warnings,
            ...(promptDriftWarning ? [promptDriftWarning.message] : []),
          ].map((warning) => ({
            type: "other" as const,
            message: warning,
          })),
          request: {
            body: {
              systemPrompt,
              messageCount: messages.length,
              toolCount: options.tools?.length ?? 0,
            },
          },
          response: {
            modelId,
            timestamp: new Date(),
          },
        };
      },
      {
        attributes: {
          providerId: this.providerId,
          sessionId: resolveProviderOptions(options).sessionId,
          inputMessages: options.prompt.length,
          toolCount: options.tools?.length ?? 0,
        },
      },
    );
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const generated = await this.doGenerate(options);
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({
          type: "stream-start",
          warnings: generated.warnings,
        });

        let textIndex = 0;
        for (const part of generated.content) {
          if (part.type === "text") {
            const id = `text-${textIndex++}`;
            controller.enqueue({ type: "text-start", id });
            controller.enqueue({ type: "text-delta", id, delta: part.text });
            controller.enqueue({ type: "text-end", id });
            continue;
          }

          if (part.type === "tool-call") {
            controller.enqueue(part);
          }
        }

        controller.enqueue({
          type: "finish",
          usage: generated.usage,
          finishReason: generated.finishReason,
        });
        controller.close();
      },
    });

    return {
      stream,
      request: generated.request,
      response: generated.response
        ? {
            headers: generated.response.headers,
          }
        : undefined,
    };
  }
}
