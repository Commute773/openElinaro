import type { z } from "zod";
import type {
  AgentToolScope,
  ToolAuthorizationAccess,
  ToolAuthorizationBehavior,
} from "../domain/tool-catalog";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { BaseMessage } from "@langchain/core/messages";
import type { ToolBuildContext } from "../tools/groups/tool-group-types";
import type { ToolContext } from "../tools/tool-registry";
import type { ToolLibraryDefinition } from "../services/tool-library-service";

// ---------------------------------------------------------------------------
// Surface types
// ---------------------------------------------------------------------------

/** Which surfaces a function should be exposed on. */
export type FunctionSurface = "api" | "discord" | "agent";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface FunctionHttpAnnotation {
  method: HttpMethod;
  /** Express-style path, e.g. "/api/g2/routines/:id/done". */
  path: string;
  /** Optional Zod schema for query params (GET requests). */
  queryParams?: z.ZodObject<any>;
  /** HTTP status code for success. Defaults to 200. */
  successStatus?: number;
  /** Optional transform applied to the handler result before sending as JSON. */
  responseTransform?: (result: unknown) => unknown;
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
  /** The implementation. Receives validated input + context. */
  handler: (input: z.output<TInput>, ctx: FunctionContext) => Promise<unknown>;

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

  // -- Behavioral flags ------------------------------------------------------

  mutatesState?: boolean;
  readsWorkspace?: boolean;
  supportsBackground?: boolean;

  // -- Feature gating --------------------------------------------------------

  /** Feature id from FeatureConfigService. If set, function is excluded when the feature is inactive. */
  featureGate?: string;

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
    messages: BaseMessage[];
    systemPrompt?: { text: string; version: string; files: string[]; loadedAt: string } | null;
  }>;
  /** Build a runtime context string for full context inspection. */
  buildRuntimeContext?: () => Promise<string>;
  /** Report progress for a tool call. */
  reportProgress?: (context: ToolContext | undefined, summary: string, input?: unknown) => Promise<void>;
  /** Get all agent tools for the current context. */
  getTools?: (context?: ToolContext) => StructuredToolInterface[];
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
// Domain builder signature
// ---------------------------------------------------------------------------

/**
 * Each domain file exports a builder function matching this signature.
 * The builder receives the service context and returns function definitions.
 */
export type FunctionDomainBuilder = (ctx: ToolBuildContext) => FunctionDefinition[];
