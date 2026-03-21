export type ToolErrorType =
  | "validation_error"
  | "not_found"
  | "configuration_error"
  | "permission_error"
  | "timeout_error"
  | "upstream_error"
  | "tool_unavailable"
  | "tool_error";

export type ToolErrorEnvelope = {
  ok: false;
  tool: string;
  message: string;
  error: {
    type: ToolErrorType;
    retryable: boolean;
  };
  debug: {
    raw: string;
  };
  details?: unknown;
};

function normalizeErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message.trim() || error.name;
  }
  return String(error).trim();
}

function extractErrorDetails(error: unknown) {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const details = (error as { details?: unknown }).details;
  return details === undefined ? undefined : details;
}

function inferToolErrorType(message: string): ToolErrorEnvelope["error"] {
  const text = message.toLowerCase();
  if (
    text.includes("not available in the current visible bundle")
    || text.startsWith("unknown tool:")
    || text.includes("not allowed in this program run")
  ) {
    return { type: "tool_unavailable", retryable: false };
  }
  if (text.includes("not configured") || text.includes("set brave_api_key")) {
    return { type: "configuration_error", retryable: false };
  }
  if (
    text.includes("requires")
    || text.includes("must be")
    || text.includes("is required")
    || text.includes("non-empty")
    || text.includes("expected")
    || text.includes("invalid")
    || text.includes("failed validation")
  ) {
    return { type: "validation_error", retryable: false };
  }
  if (text.includes("not found")) {
    return { type: "not_found", retryable: false };
  }
  if (text.includes("permission denied") || text.includes("eacces") || text.includes("operation not permitted")) {
    return { type: "permission_error", retryable: false };
  }
  if (text.includes("timed out") || text.includes("timeout")) {
    return { type: "timeout_error", retryable: true };
  }
  if (text.includes("api error") || text.includes("rejected ui_lang") || text.includes("upstream")) {
    return { type: "upstream_error", retryable: true };
  }
  return { type: "tool_error", retryable: false };
}

function summarizeToolError(toolName: string, error: ToolErrorEnvelope["error"]) {
  if (error.type === "validation_error") {
    return `Validation failed while running \`${toolName}\`.`;
  }
  if (error.type === "not_found") {
    return `Requested resource was not found while running \`${toolName}\`.`;
  }
  if (error.type === "configuration_error") {
    return `\`${toolName}\` is not configured correctly.`;
  }
  if (error.type === "permission_error") {
    return `Permission was denied while running \`${toolName}\`.`;
  }
  if (error.type === "timeout_error") {
    return `\`${toolName}\` timed out.`;
  }
  if (error.type === "upstream_error") {
    return `Upstream provider error while running \`${toolName}\`.`;
  }
  if (error.type === "tool_unavailable") {
    return `\`${toolName}\` is not available in the current tool bundle.`;
  }
  return `\`${toolName}\` failed.`;
}

export function buildToolErrorEnvelope(toolName: string, error: unknown): ToolErrorEnvelope {
  const raw = normalizeErrorMessage(error) || `Tool ${toolName} failed.`;
  const classified = inferToolErrorType(raw);
  const details = extractErrorDetails(error);
  return {
    ok: false,
    tool: toolName,
    message: summarizeToolError(toolName, classified),
    error: classified,
    debug: {
      raw,
    },
    details,
  };
}

export function stringifyToolErrorEnvelope(toolName: string, error: unknown) {
  return JSON.stringify(buildToolErrorEnvelope(toolName, error), null, 2);
}
