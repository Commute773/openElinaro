/**
 * Swappable Agent Core — type definitions.
 *
 * These types define the abstraction boundary between the harness
 * (Discord, profiles, domain tools, conversation storage) and the
 * core (agent loop, model interaction, native tools).
 *
 * Core message types are structurally compatible with pi-ai's plain
 * JSON message types so the Pi adapter is near zero-cost.
 */

// ---------------------------------------------------------------------------
// Core Manifest — declares what a core handles natively
// ---------------------------------------------------------------------------

export interface CoreManifest {
  /** Unique identifier for this core implementation. */
  id: string;
  /** Tool names this core handles natively. Harness won't send these as tool definitions. */
  nativeTools: NativeToolMapping[];
  /** Features this core handles internally. Harness disables its own implementation for "core_owns". */
  nativeFeatures: CoreFeatureDeclaration[];
  /** What this core needs from the harness. */
  requires: CoreRequirements;
}

export interface NativeToolMapping {
  /** The harness tool name (e.g., "read_file") */
  harnessToolName: string;
  /** The core's internal tool name (e.g., "Read" for Claude SDK) */
  coreToolName: string;
  /** Whether the harness should still receive results/notifications from this tool */
  reportResultsToHarness: boolean;
}

export type CoreFeatureId =
  | "agent_loop"
  | "compaction"
  | "context_management"
  | "session_persistence"
  | "cost_tracking"
  | "streaming"
  | "permission_control"
  | "file_checkpointing"
  | "thinking"
  | "tool_result_summarization";

export interface CoreFeatureDeclaration {
  feature: CoreFeatureId;
  /** How the harness should interact with this feature. */
  mode: "core_owns" | "harness_owns" | "shared";
  /** If shared, what hook/callback the core exposes for harness integration. */
  integrationPoint?: string;
}

export interface CoreRequirements {
  systemPrompt: boolean;
  messageHistory: boolean;
  toolExecution: boolean;
  toolDefinitions: boolean;
}

// ---------------------------------------------------------------------------
// Core Message Types — harness-owned, structurally compatible with pi-ai
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
  /** Original Zod schema, when available. Cores that accept Zod input (e.g., Claude Agent SDK) use this for proper schema passthrough. */
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
}

// ---------------------------------------------------------------------------
// The Core Interface
// ---------------------------------------------------------------------------

export interface AgentCore {
  readonly manifest: CoreManifest;
  /** Run the agent loop: call model, execute tools, repeat until done. */
  run(options: CoreRunOptions): Promise<CoreRunResult>;
}

// ---------------------------------------------------------------------------
// Core Factory — harness uses this to create a core per turn
// ---------------------------------------------------------------------------

export type CoreFactory = (params: {
  /** Resolved model information from the harness's model service. */
  modelConfig: CoreModelConfig;
}) => AgentCore;

/** Thinking/reasoning level for model inference. */
export type CoreThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface CoreModelConfig {
  providerId: string;
  modelId: string;
  apiKey?: string;
  reasoning?: CoreThinkingLevel;
  providerOptions?: Record<string, unknown>;
  /** Opaque runtime model object for adapter-specific cores (e.g., pi-ai Model). */
  runtimeModel?: unknown;
}
