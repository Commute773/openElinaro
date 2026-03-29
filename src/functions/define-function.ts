import type { z } from "zod";
import type { Tool } from "@mariozechner/pi-ai";
import type {
  AgentToolScope,
  ToolAuthorizationAccess,
  ToolAuthorizationBehavior,
} from "../domain/tool-catalog";
import type { Message } from "../messages/types";
import type { ToolBuildContext } from "../tools/groups/tool-group-types";
import type { ToolContext } from "../tools/tool-registry";
import type { ToolLibraryDefinition } from "../services/tool-library-service";
import type { FeatureId } from "../services/feature-config-service";

// ---------------------------------------------------------------------------
// Surface types
// ---------------------------------------------------------------------------

/** Which surfaces a function should be exposed on. */
export type FunctionSurface = "api" | "discord" | "agent";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * API path prefix prepended to all generated routes.
 * Function definitions use relative paths (e.g. "/routines/:id/done")
 * and this prefix is applied during route and OpenAPI generation.
 */
export const API_PATH_PREFIX = "/api/g2";

export interface FunctionHttpAnnotation {
  method: HttpMethod;
  /** Relative path (e.g. "/routines/:id/done"). The API_PATH_PREFIX is prepended at generation time. */
  path: string;
  /** Optional Zod schema for query params (GET requests). */
  queryParams?: z.ZodObject<Record<string, z.ZodType>>;
  /** HTTP status code for success. Defaults to 200. */
  successStatus?: number;
  /** Optional transform applied to the handler result before sending as JSON. */
  responseTransform?(result: unknown): unknown;
}

export interface FunctionDiscordAnnotation {
  /** Override the auto-generated slash command description. */
  description?: string;
  /** Custom mapper from Discord interaction to handler input. */
  inputMapper?: (interaction: unknown) => unknown;
}

// ---------------------------------------------------------------------------
// Function definition
// ---------------------------------------------------------------------------

export interface FunctionDefinition<
  TInput extends z.ZodType = z.ZodType,
  TOutput = unknown,
> {
  /** Unique function name. Should match a ToolName when exposed as an agent tool. */
  name: string;
  /** Human-readable description used across all surfaces. */
  description: string;
  /** Zod schema for input validation. */
  input: TInput;
  /** Optional Zod schema for output (drives OpenAPI response generation). */
  output?: z.ZodType<TOutput>;
  /** The implementation. Receives validated input + context.
   *  Method syntax enables bivariant checking so specific definitions can be
   *  stored in generic FunctionDefinition[] arrays. */
  handler(input: z.output<TInput>, ctx: FunctionContext): Promise<TOutput>;

  // -- Surface control -------------------------------------------------------

  /** Which surfaces to expose on. Defaults to all three: ["api", "discord", "agent"]. */
  surfaces?: FunctionSurface[];

  // -- HTTP surface ----------------------------------------------------------

  http?: FunctionHttpAnnotation;

  // -- Discord surface -------------------------------------------------------

  discord?: FunctionDiscordAnnotation;

  // -- Authorization ---------------------------------------------------------

  auth: {
    access: ToolAuthorizationAccess;
    behavior: ToolAuthorizationBehavior;
    note?: string;
  };

  // -- Catalog metadata ------------------------------------------------------

  domains: string[];
  tags?: string[];
  examples?: string[];
  agentScopes: AgentToolScope[];
  defaultVisibleScopes?: AgentToolScope[];

  // -- Surface formatting ----------------------------------------------------

  /**
   * Format the handler result as a string for the agent tool surface.
   * When set, the handler returns structured data and this function converts
   * it to a human-readable string for the model. If not set, the handler
   * result is used directly (backwards-compatible with string-returning handlers).
   */
  agentFormat?(result: TOutput): string;

  // -- Behavioral flags ------------------------------------------------------

  mutatesState?: boolean;
  readsWorkspace?: boolean;
  supportsBackground?: boolean;

  // -- Feature gating --------------------------------------------------------

  /** Feature id from FeatureConfigService. If set, function is excluded when the feature is inactive. */
  featureGate?: FeatureId;

  // -- Untrusted output guarding ---------------------------------------------

  untrustedOutput?: {
    sourceType: string;
    sourceName: string;
    notes: string;
  };
}

// ---------------------------------------------------------------------------
// Runtime context passed to every handler
// ---------------------------------------------------------------------------

export interface FunctionContext {
  /** The resolved service dependencies. */
  services: ToolBuildContext;
  /** Conversation key, when available. */
  conversationKey?: string;
  /** Agent tool context (progress callbacks, scope activation, etc.). */
  toolContext?: ToolContext;

  // -- Conversation-lifecycle callbacks (set by ToolRegistry) ----------------

  /** Pending conversation resets map. */
  pendingConversationResets?: Map<string, string>;
  /** Resolve a conversation key from tool input and context. */
  resolveConversationKey?: (input: { conversationKey?: string }, context?: ToolContext) => string | undefined;
  /** Get a conversation with an ensured system prompt. */
  getConversationForTool?: (input: { conversationKey?: string }, context?: ToolContext) => Promise<{
    key: string;
    messages: Message[];
    systemPrompt?: { text: string; version: string; files: string[]; loadedAt: string } | null;
  }>;
  /** Build a runtime context string for full context inspection. */
  buildRuntimeContext?: () => Promise<string>;
  /** Report progress for a tool call. */
  reportProgress?: (context: ToolContext | undefined, summary: string, input?: unknown) => Promise<void>;
  /** Get all agent tools as pi-ai Tool definitions. */
  getTools?: (context?: ToolContext) => Tool[];
  /** Get tool libraries for the current context and scope. */
  getToolLibraries?: (context?: ToolContext, scope?: AgentToolScope) => ToolLibraryDefinition[];
  /** Get default visible tool names for a given scope. */
  getAgentDefaultVisibleToolNames?: (agentScope: AgentToolScope) => string[];
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Define a unified function. Returns the definition object unchanged — this is
 * a typed identity function that ensures the definition satisfies the interface.
 */
export function defineFunction<
  TInput extends z.ZodType,
  TOutput = unknown,
>(def: FunctionDefinition<TInput, TOutput>): FunctionDefinition<TInput, TOutput> {
  return def;
}

// ---------------------------------------------------------------------------
// Auto-derived HTTP annotation
// ---------------------------------------------------------------------------

/**
 * Derive an HTTP annotation from the function definition when none is explicit.
 * - Method: POST if the function mutates state, GET otherwise.
 * - Path: function name with underscores converted to slashes.
 *   e.g. "finance_summary" → "/finance/summary"
 */
export function deriveHttpAnnotation(def: FunctionDefinition): { method: HttpMethod; path: string } {
  return {
    method: def.mutatesState ? "POST" : "GET",
    path: "/" + def.name.replaceAll("_", "/"),
  };
}

// ---------------------------------------------------------------------------
// Domain builder signature
// ---------------------------------------------------------------------------

/**
 * Each domain file exports a builder function matching this signature.
 * The builder receives the service context and returns function definitions.
 */
export type FunctionDomainBuilder = (ctx: ToolBuildContext) => FunctionDefinition[];
