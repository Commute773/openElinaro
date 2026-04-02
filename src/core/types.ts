/**
 * Core type definitions for the Claude Agent SDK integration.
 *
 * These types define the message and tool shapes used between
 * the harness (Discord, profiles, domain tools, conversation storage)
 * and the Claude SDK core.
 */

import type { AgentStreamEvent } from "../domain/assistant";

// ---------------------------------------------------------------------------
// Core Message Types
// ---------------------------------------------------------------------------

export interface CoreTextContent {
  type: "text";
  text: string;
  /** Opaque signature for multi-turn continuity (passthrough). */
  textSignature?: string;
}

export interface CoreThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

export interface CoreImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface CoreToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
  /** Opaque signature for multi-turn continuity (passthrough). */
  thoughtSignature?: string;
}

export interface CoreUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type CoreStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface CoreUserMessage {
  role: "user";
  content: string | (CoreTextContent | CoreImageContent)[];
  timestamp: number;
}

export interface CoreAssistantMessage {
  role: "assistant";
  content: (CoreTextContent | CoreThinkingContent | CoreToolCall)[];
  provider: string;
  model: string;
  responseId?: string;
  usage: CoreUsage;
  stopReason: CoreStopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface CoreToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (CoreTextContent | CoreImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export type CoreMessage =
  | CoreUserMessage
  | CoreAssistantMessage
  | CoreToolResultMessage;

// ---------------------------------------------------------------------------
// Core Tool Definition
// ---------------------------------------------------------------------------

export interface CoreToolDefinition {
  name: string;
  description: string;
  /** JSON Schema object for the tool parameters. */
  parameters: Record<string, unknown>;
  /** Original Zod schema, when available. The Claude Agent SDK uses this for proper schema passthrough. */
  zodSchema?: unknown;
}

// ---------------------------------------------------------------------------
// Core Tool Executor — harness provides this for domain tool execution
// ---------------------------------------------------------------------------

export type CoreToolExecutor = (
  toolCall: CoreToolCall,
  signal?: AbortSignal,
) => Promise<CoreToolResultMessage>;

// ---------------------------------------------------------------------------
// Core Harness Hooks — optional callbacks the core calls at lifecycle points
// ---------------------------------------------------------------------------

export interface CoreHarnessHooks {
  /** Called before compaction. Harness can persist memory. */
  onPreCompact?: (summary: string) => Promise<void>;
  /** Called when usage data is available from a model response. */
  onUsage?: (usage: CoreUsage) => void;
  /** Called for tool authorization checks. Return true to allow. */
  canUseTool?: (toolName: string, input: Record<string, unknown>) => boolean;
}

// ---------------------------------------------------------------------------
// Core Run Options & Result
// ---------------------------------------------------------------------------

export interface CoreRunOptions {
  systemPrompt: string;
  messages: CoreMessage[];
  /** Domain tools the harness wants the core to offer to the model. */
  tools: CoreToolDefinition[];
  /** Harness callback to execute domain tools. */
  executeTool: CoreToolExecutor;
  maxSteps?: number;
  signal?: AbortSignal;
  /** Called after each assistant message (including intermediate tool-calling steps). */
  onAssistantMessage?: (msg: CoreAssistantMessage) => void;
  /** Called after each tool result. */
  onToolResult?: (result: CoreToolResultMessage) => void;
  /** Harness hooks the core should call at lifecycle points (if supported). */
  hooks?: CoreHarnessHooks;
  /** Structured log callback for core-internal events (SDK tool calls, system messages, etc.). */
  onLog?: (event: string, data: Record<string, unknown>) => void;
  /** Called when the core has a progress update worth showing on the user-facing surface (Discord, API, etc.). */
  onProgress?: (event: AgentStreamEvent) => Promise<void>;
}

export interface CoreRunResult {
  /** All new messages produced during this run (assistant + tool results). */
  newMessages: CoreMessage[];
  /** The final assistant message (without tool calls, or the last before step limit). */
  finalMessage: CoreAssistantMessage | undefined;
  /** Number of model round-trips executed. */
  steps: number;
  /** Aggregated usage across all model calls in this run. */
  totalUsage?: CoreUsage;
  /** SDK-managed session ID for cross-turn continuity (returned by cores that persist sessions). */
  sdkSessionId?: string;
  /** Opaque handle to a persistent SDK session for reuse across turns. */
  sessionHandle?: unknown;
}

/** Thinking/reasoning level for model inference. */
export type CoreThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface CoreModelConfig {
  modelId: string;
  apiKey?: string;
  reasoning?: CoreThinkingLevel;
  providerOptions?: Record<string, unknown>;
}
