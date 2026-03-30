/**
 * Telemetry function definitions.
 * Migrated from src/tools/groups/memory-tools.ts.
 * Memory search, import, reindex, and conversation search have been removed.
 */
import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";
import { formatResult } from "../formatters";

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const telemetryQuerySchema = z.object({
  traceId: z.string().min(1).optional(),
  spanId: z.string().min(1).optional(),
  component: z.string().min(1).optional(),
  operation: z.string().min(1).optional(),
  eventName: z.string().min(1).optional(),
  conversationKey: z.string().min(1).optional(),
  workflowRunId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  toolName: z.string().min(1).optional(),
  profileId: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  entityType: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
  outcome: z.enum(["ok", "error", "cancelled", "timeout", "rejected", "all"]).optional(),
  level: z.enum(["debug", "info", "warn", "error", "all"]).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  query: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  format: z.enum(["text", "json"]).optional(),
});

// ---------------------------------------------------------------------------
// Auth defaults
// ---------------------------------------------------------------------------

const MEMORY_AUTH_ROOT = { access: "root" as const, behavior: "uniform" as const };
const MEMORY_SCOPES: ("chat" | "direct")[] = ["chat", "direct"];
const MEMORY_DOMAINS = ["memory", "knowledge"];

// ---------------------------------------------------------------------------
// Domain builder
// ---------------------------------------------------------------------------

export const buildMemoryFunctions: FunctionDomainBuilder = (ctx) => [
  // -----------------------------------------------------------------------
  // telemetry_query
  // -----------------------------------------------------------------------
  defineFunction({
    name: "telemetry_query",
    description:
      "Search spans and events in the local telemetry store by trace, operation, entity, or free text. Supports format=json for structured output.",
    input: telemetryQuerySchema,
    handler: async (input, fnCtx) => fnCtx.services.telemetryQuery.query(input),
    format: formatResult,
    auth: MEMORY_AUTH_ROOT,
    domains: MEMORY_DOMAINS,
    agentScopes: MEMORY_SCOPES,
    examples: ["search recent errors", "find stderr entries"],
    untrustedOutput: {
      sourceType: "logs",
      sourceName: "application and system logs",
      notes: "Logs may contain attacker-controlled text and stack traces.",
    },
  }),
];
