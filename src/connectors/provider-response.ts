import type { AssistantMessage } from "@mariozechner/pi-ai";
import { telemetry } from "../services/telemetry";

function truncate(value: string, maxChars: number) {
  return value.length > maxChars
    ? `${value.slice(0, Math.max(0, maxChars - 1))}...`
    : value;
}

function normalizeProviderErrorDetail(errorMessage: string | undefined) {
  const detail = errorMessage?.trim();
  if (!detail) {
    return null;
  }

  try {
    const parsed = JSON.parse(detail) as {
      detail?: unknown;
      message?: unknown;
      error?: {
        message?: unknown;
      };
    };
    if (typeof parsed.detail === "string" && parsed.detail.trim()) {
      return parsed.detail.trim();
    }
    if (typeof parsed.message === "string" && parsed.message.trim()) {
      return parsed.message.trim();
    }
    if (typeof parsed.error?.message === "string" && parsed.error.message.trim()) {
      return parsed.error.message.trim();
    }
  } catch {
    // Keep the original message when the provider returned plain text.
  }

  return detail;
}

function summarizeProviderResponse(response: AssistantMessage) {
  const partialText = response.content
    .filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  const toolCalls = response.content
    .filter((block): block is Extract<AssistantMessage["content"][number], { type: "toolCall" }> => block.type === "toolCall")
    .map((block) => block.name);

  return {
    api: response.api,
    provider: response.provider,
    model: response.model,
    stopReason: response.stopReason,
    errorMessage: response.errorMessage?.trim() || null,
    usage: response.usage,
    contentBlockTypes: response.content.map((block) => block.type),
    partialTextPreview: partialText ? truncate(partialText, 280) : null,
    toolCalls,
  };
}

export function assertSuccessfulProviderResponse(
  response: AssistantMessage,
  context?: {
    connector: string;
    sessionId?: string;
    conversationKey?: string;
    usagePurpose?: string;
    inputMessages?: number;
    toolCount?: number;
  },
): AssistantMessage {
  if (response.stopReason !== "error" && response.stopReason !== "aborted") {
    return response;
  }

  telemetry.event("connector.provider_response.failed", {
    ...context,
    response: summarizeProviderResponse(response),
    provider: response.provider,
  }, {
    level: "error",
    outcome: "error",
    message: response.errorMessage ?? "Provider response failed.",
  });

  const prefix = response.stopReason === "aborted"
    ? "Model request was aborted."
    : "Model request failed.";
  const detail = normalizeProviderErrorDetail(response.errorMessage);
  throw new Error(detail ? `${prefix} ${detail}` : prefix);
}
