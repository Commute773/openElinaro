import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider";
import { fromModelMessages, mapStopReasonToFinishReason, toLanguageModelUsage } from "../services/ai-sdk-message-service";
import { extractTextFromMessage } from "../services/message-content-service";
import type { ProviderConnector } from "../connectors/provider-connector";

export type ScriptedConnectorRequest = {
  sessionId?: string;
  conversationKey?: string;
  usagePurpose?: string;
  systemPrompt: string;
  messages: BaseMessage[];
};

function extractProviderMeta(options: LanguageModelV3CallOptions) {
  const metadata = options.providerOptions?.openelinaro;
  return {
    sessionId: typeof metadata?.sessionId === "string" ? metadata.sessionId : undefined,
    conversationKey: typeof metadata?.conversationKey === "string" ? metadata.conversationKey : undefined,
    usagePurpose: typeof metadata?.usagePurpose === "string" ? metadata.usagePurpose : undefined,
  };
}

export function buildScriptedConnectorRequest(options: LanguageModelV3CallOptions): ScriptedConnectorRequest {
  const meta = extractProviderMeta(options);
  return {
    ...meta,
    systemPrompt: options.prompt
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n"),
    messages: fromModelMessages(options.prompt.filter((message) => message.role !== "system")),
  };
}

export function toGenerateResultFromAIMessage(
  message: AIMessage,
  providerId = "scripted-test",
  modelId = "scripted-model",
): LanguageModelV3GenerateResult {
  const content: LanguageModelV3Content[] = [];
  const text = extractTextFromMessage(message).trim();
  if (text) {
    content.push({ type: "text", text });
  }
  for (const toolCall of message.tool_calls ?? []) {
    content.push({
      type: "tool-call",
      toolCallId: toolCall.id ?? `${toolCall.name}-${Date.now()}`,
      toolName: toolCall.name,
      input: JSON.stringify(toolCall.args ?? {}),
    });
  }

  return {
    content,
    finishReason: mapStopReasonToFinishReason(
      message.response_metadata?.stopReason,
      (message.tool_calls?.length ?? 0) > 0,
    ),
    usage: toLanguageModelUsage(message.usage_metadata),
    warnings: Array.isArray(message.response_metadata?.warnings)
      ? message.response_metadata.warnings
          .filter((warning): warning is string => typeof warning === "string")
          .map((warning) => ({
            type: "other" as const,
            message: warning,
          }))
      : [],
    response: {
      modelId:
        typeof message.response_metadata?.model === "string"
          ? message.response_metadata.model
          : modelId,
      timestamp: new Date(),
    },
    request: {
      body: {
        providerId,
      },
    },
  };
}

export class ScriptedProviderConnector implements ProviderConnector {
  readonly providerId: string;
  readonly provider: string;
  readonly specificationVersion = "v3" as const;
  readonly modelId: string;
  readonly supportedUrls = {};

  constructor(
    private readonly handler: (request: ScriptedConnectorRequest) => AIMessage | Promise<AIMessage>,
    options?: {
      providerId?: string;
      modelId?: string;
    },
  ) {
    this.providerId = options?.providerId ?? "scripted-test";
    this.provider = this.providerId;
    this.modelId = options?.modelId ?? "scripted-model";
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const response = await this.handler(buildScriptedConnectorRequest(options));
    return toGenerateResultFromAIMessage(response, this.providerId, this.modelId);
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
