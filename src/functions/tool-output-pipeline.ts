import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppProgressEvent, AppProgressUpdate } from "../domain/assistant";
import { buildToolErrorEnvelope } from "../services/tool-error-service";
import {
  MissingSecretStoreKeyError,
} from "../services/infrastructure/secret-store-service";
import {
  guardUntrustedText,
  type UntrustedContentDescriptor,
  type UntrustedContentSourceType,
} from "../services/prompt-injection-guard-service";
import type { ToolResultStore } from "../services/tool-result-store";
import { telemetry } from "../services/infrastructure/telemetry";
import { attemptOr, attemptOrAsync } from "../utils/result";
import type { ToolContext } from "./tool-registry";
import {
  TOOL_SUMMARY_KEY_LIMIT,
  TOOL_SUMMARY_LIST_LIMIT,
  TOOL_SUMMARY_TEXT_LIMIT,
  TOOL_OUTPUT_CHAR_LIMIT,
} from "../config/service-constants";

const toolRegistryTelemetry = telemetry.child({ component: "tool" });
export const TOOL_CALL_BEHAVIOR_SCHEMA = z.object({
  silent: z.boolean().optional(),
});

/**
 * Untrusted output descriptors for dynamic/legacy tools not in the function layer.
 * Function-layer tools carry their own untrustedOutput in their definitions.
 */
const DYNAMIC_UNTRUSTED_TOOL_DESCRIPTOR_MAP: Record<string, Omit<UntrustedContentDescriptor, "toolName">> = {
  tool_result_read: {
    sourceType: "other",
    sourceName: "stored tool result output",
    notes: "Reopened tool results may contain untrusted content from earlier file, shell, log, or web tool output.",
  },
};

/**
 * Lazily cached map built from function-layer definitions + dynamic tool descriptors.
 * Set by initUntrustedOutputMap() from the ToolRegistry constructor.
 */
let _untrustedToolDescriptorMap: Record<string, Omit<UntrustedContentDescriptor, "toolName">> | null = null;

export function initUntrustedOutputMap(functionRegistryMap: Record<string, { sourceType: string; sourceName: string; notes: string }>) {
  _untrustedToolDescriptorMap = {
    ...(functionRegistryMap as Record<string, Omit<UntrustedContentDescriptor, "toolName">>),
    ...DYNAMIC_UNTRUSTED_TOOL_DESCRIPTOR_MAP,
  };
}

function getUntrustedToolDescriptorMap(): Record<string, Omit<UntrustedContentDescriptor, "toolName">> {
  return _untrustedToolDescriptorMap ?? DYNAMIC_UNTRUSTED_TOOL_DESCRIPTOR_MAP;
}

export const GUARDED_UNTRUSTED_SOURCE_TYPES = new Set<UntrustedContentSourceType>(["email", "communications", "web"]);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isSilentToolInput(input: unknown) {
  return isObjectRecord(input) && input.silent === true;
}

export function stripToolControlInput(input: unknown) {
  if (!isObjectRecord(input)) {
    return input;
  }

  const { silent: _silent, ...rest } = input;
  return rest;
}

export function stringifyToolResult(result: unknown) {
  if (typeof result === "string") {
    return result;
  }

  return attemptOr(() => JSON.stringify(result, null, 2), String(result));
}

export function truncateToolOutput(text: string, limit = TOOL_OUTPUT_CHAR_LIMIT) {
  if (text.length <= limit) {
    return text;
  }

  const notice = `\n...[tool output truncated: showing ${limit} of ${text.length} chars]`;
  const budget = Math.max(0, limit - notice.length);
  return `${text.slice(0, budget)}${notice}`;
}

function truncateToolSummaryText(value: string, limit = TOOL_SUMMARY_TEXT_LIMIT) {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= limit) {
    return singleLine;
  }
  return `${singleLine.slice(0, Math.max(0, limit - 3))}...`;
}

function formatToolSummaryValue(value: unknown, depth = 0): string {
  if (value === null) {
    return "null";
  }

  if (value === undefined) {
    return "undefined";
  }

  if (typeof value === "string") {
    return JSON.stringify(truncateToolSummaryText(value));
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (depth >= 1) {
      return `[${value.length} items]`;
    }

    const items = value
      .slice(0, TOOL_SUMMARY_LIST_LIMIT)
      .map((entry) => formatToolSummaryValue(entry, depth + 1));
    const overflow = value.length > TOOL_SUMMARY_LIST_LIMIT
      ? `, ...+${value.length - TOOL_SUMMARY_LIST_LIMIT}`
      : "";
    return `[${items.join(", ")}${overflow}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (depth >= 1) {
      return `{${entries.length} keys}`;
    }

    const summary = entries
      .slice(0, TOOL_SUMMARY_LIST_LIMIT)
      .map(([key, entry]) => `${key}:${formatToolSummaryValue(entry, depth + 1)}`);
    const overflow = entries.length > TOOL_SUMMARY_LIST_LIMIT
      ? `, ...+${entries.length - TOOL_SUMMARY_LIST_LIMIT}`
      : "";
    return `{${summary.join(", ")}${overflow}}`;
  }

  return JSON.stringify(truncateToolSummaryText(String(value)));
}

const OPENBROWSER_ACTION_KEY_ORDER: Record<string, string[]> = {
  navigate: ["url", "waitMs"],
  wait: ["ms"],
  mouse_move: ["x", "y", "steps"],
  mouse_click: ["x", "y", "button", "clickCount"],
  press: ["key"],
  type: ["text", "submit", "delayMs"],
  evaluate: ["expression", "args", "captureResult"],
  screenshot: ["path", "format", "quality"],
};

function formatOpenBrowserActionSummary(action: unknown, index: number) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return `${index + 1}. ${formatToolSummaryValue(action)}`;
  }

  const record = action as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "unknown";
  const orderedKeys = OPENBROWSER_ACTION_KEY_ORDER[type] ?? [];
  const orderedDetails = orderedKeys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${key}=${formatToolSummaryValue(record[key], 1)}`);
  const extraDetails = Object.entries(record)
    .filter(([key, value]) => key !== "type" && value !== undefined && !orderedKeys.includes(key))
    .map(([key, value]) => `${key}=${formatToolSummaryValue(value, 1)}`);
  const detail = [...orderedDetails, ...extraDetails].join(" ");
  return `${index + 1}. ${type}${detail ? ` ${detail}` : ""}`;
}

function formatOpenBrowserToolUseSummary(input: Record<string, unknown>) {
  const lines = ["tool: `openbrowser`"];
  const metadata = [
    typeof input.startUrl === "string" ? `startUrl=${formatToolSummaryValue(input.startUrl)}` : undefined,
    typeof input.sessionKey === "string" ? `sessionKey=${formatToolSummaryValue(input.sessionKey)}` : undefined,
    typeof input.resetSession === "boolean" ? `resetSession=${String(input.resetSession)}` : undefined,
    typeof input.headless === "boolean" ? `headless=${String(input.headless)}` : undefined,
    typeof input.artifactDir === "string" ? `artifactDir=${formatToolSummaryValue(input.artifactDir)}` : undefined,
  ].filter(Boolean);
  if (metadata.length > 0) {
    lines.push(metadata.join(" "));
  }

  const actions = Array.isArray(input.actions) ? input.actions : [];
  if (actions.length === 0) {
    return lines.join("\n");
  }

  lines.push("actions:");
  lines.push(
    ...actions
      .slice(0, TOOL_SUMMARY_LIST_LIMIT)
      .map((action, index) => formatOpenBrowserActionSummary(action, index)),
  );
  if (actions.length > TOOL_SUMMARY_LIST_LIMIT) {
    lines.push(`...+${actions.length - TOOL_SUMMARY_LIST_LIMIT} more actions`);
  }

  return lines.join("\n");
}

export function formatToolUseSummary(name: string, input: unknown): string {
  if (name === "openbrowser" && input && typeof input === "object" && !Array.isArray(input)) {
    return formatOpenBrowserToolUseSummary(input as Record<string, unknown>);
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input === undefined ? `tool: \`${name}\`` : `tool: \`${name}\` ${formatToolSummaryValue(input)}`;
  }

  const entries = Object.entries(input as Record<string, unknown>)
    .filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return `tool: \`${name}\``;
  }

  const details = entries
    .slice(0, TOOL_SUMMARY_KEY_LIMIT)
    .map(([key, value]) => `${key}=${formatToolSummaryValue(value)}`);
  const overflow = entries.length > TOOL_SUMMARY_KEY_LIMIT
    ? ` ...+${entries.length - TOOL_SUMMARY_KEY_LIMIT}`
    : "";
  return `tool: \`${name}\` ${details.join(" ")}${overflow}`;
}

export function buildOpenBrowserProgressUpdates(result: unknown): AppProgressUpdate[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return [];
  }

  const stepResults = (result as { stepResults?: unknown }).stepResults;
  if (!Array.isArray(stepResults)) {
    return [];
  }

  return stepResults.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }

    const step = entry as Record<string, unknown>;
    const screenshotPath = typeof step.path === "string" ? step.path : undefined;
    if (!screenshotPath || !fs.existsSync(screenshotPath)) {
      return [];
    }

    const index = typeof step.index === "number" ? step.index + 1 : "?";
    const type = typeof step.type === "string" ? step.type : "step";
    const detail = typeof step.detail === "string" ? truncateToolSummaryText(step.detail, 180) : undefined;
    return [{
      message: [
        `openbrowser state after action ${index} (${type})`,
        detail,
      ]
        .filter(Boolean)
        .join("\n"),
      attachments: [{
        path: screenshotPath,
        name: path.basename(screenshotPath),
      }],
    }];
  });
}

export function normalizeToolFailure(name: string, error: unknown) {
  if (error instanceof MissingSecretStoreKeyError) {
    const message = error instanceof Error ? error.message : String(error);
    return buildToolErrorEnvelope(
      name,
      `${message} Import the needed secret into the unified secret store, then retry the feature or tool activation flow.`,
    );
  }
  return buildToolErrorEnvelope(name, error);
}

export async function resolveGuardedToolName(toolName: string, input: unknown, toolResults: ToolResultStore) {
  if (toolName !== "tool_result_read") {
    return toolName;
  }
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof (input as { ref?: unknown }).ref !== "string") {
    return toolName;
  }
  const record = await toolResults.get((input as { ref: string }).ref);
  return record?.toolName ?? toolName;
}

export async function getUntrustedToolDescriptor(toolName: string, input: unknown, toolResults: ToolResultStore): Promise<UntrustedContentDescriptor | undefined> {
  const resolvedToolName = await resolveGuardedToolName(toolName, input, toolResults);
  const descriptor = resolvedToolName ? getUntrustedToolDescriptorMap()[resolvedToolName] : undefined;
  if (!descriptor) {
    return undefined;
  }
  if (!GUARDED_UNTRUSTED_SOURCE_TYPES.has(descriptor.sourceType)) {
    return undefined;
  }
  return {
    ...descriptor,
    toolName: resolvedToolName,
  };
}

export async function normalizeToolResult(result: unknown, toolName?: string, input?: unknown, toolResults?: ToolResultStore) {
  const text = truncateToolOutput(stringifyToolResult(result));
  const descriptor = toolName && toolResults ? await getUntrustedToolDescriptor(toolName, input, toolResults) : undefined;
  return descriptor ? guardUntrustedText(text, descriptor) : text;
}

export async function finalizeToolResult(result: unknown, toolName: string, input: unknown, toolResults: ToolResultStore) {
  return normalizeToolResult(result, toolName, input, toolResults);
}

export function guardRuntimeContextSection(
  text: string,
  descriptor: Omit<UntrustedContentDescriptor, "toolName">,
) {
  const normalized = text.trim();
  if (!normalized) {
    return "";
  }
  return guardUntrustedText(normalized, descriptor);
}

export async function notifyToolUse(context: ToolContext | undefined, name: string, input: unknown) {
  if (!context?.onToolUse) {
    return;
  }
  if (isSilentToolInput(input)) {
    return;
  }

  await attemptOrAsync(
    () => context.onToolUse!(formatToolUseSummary(name, stripToolControlInput(input))),
    undefined,
  );
}

function buildToolProgressUpdates(name: string, result: unknown) {
  if (name === "openbrowser") {
    return buildOpenBrowserProgressUpdates(result);
  }
  return [];
}

export async function notifyToolResultProgress(
  context: ToolContext | undefined,
  name: string,
  result: unknown,
  input?: unknown,
) {
  if (!context?.onToolUse) {
    return;
  }
  if (isSilentToolInput(input)) {
    return;
  }

  const updates = buildToolProgressUpdates(name, result);
  for (const update of updates) {
    await attemptOrAsync(() => context.onToolUse!(update), undefined);
  }
}

export async function reportProgress(context: ToolContext | undefined, summary: string, input?: unknown) {
  if (!context?.onToolUse) {
    return;
  }
  if (isSilentToolInput(input)) {
    return;
  }

  await attemptOrAsync(() => context.onToolUse!(summary), undefined);
}
