/**
 * Memory, conversation search, and telemetry function definitions.
 * Migrated from src/tools/groups/memory-tools.ts.
 * These produce agent tools, API routes, and Discord commands from a single source.
 */
import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";

// ---------------------------------------------------------------------------
// Shared schemas (same as memory-tools.ts)
// ---------------------------------------------------------------------------

const importDirectorySchema = z.object({
  sourcePath: z.string().min(1),
});

const memorySearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(10).optional(),
});

const conversationSearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional(),
  contextChars: z.number().int().min(40).max(2_000).optional(),
});

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

const MEMORY_AUTH_ROLE_SENSITIVE = { access: "anyone" as const, behavior: "role-sensitive" as const };
const MEMORY_AUTH_ROOT = { access: "root" as const, behavior: "uniform" as const };
const MEMORY_SCOPES: ("chat" | "direct")[] = ["chat", "direct"];
const MEMORY_DOMAINS = ["memory", "knowledge"];

// ---------------------------------------------------------------------------
// Domain builder
// ---------------------------------------------------------------------------

export const buildMemoryFunctions: FunctionDomainBuilder = (ctx) => [
  // -----------------------------------------------------------------------
  // memory_import
  // -----------------------------------------------------------------------
  defineFunction({
    name: "memory_import",
    description:
      "Import markdown memory from a caller-provided directory into local storage and rebuild the index.",
    input: importDirectorySchema,
    handler: async (input, fnCtx) => {
      const result = await fnCtx.services.memory.importFromDirectory(input.sourcePath);
      return [
        `Imported markdown memory from ${result.sourceRoot}.`,
        `Local document root: ${result.documentRoot}.`,
        `Indexed ${result.indexedDocuments} documents and ${result.indexedChunks} chunks.`,
        `Embedding model: ${result.modelId}.`,
      ].join("\n");
    },
    auth: { ...MEMORY_AUTH_ROLE_SENSITIVE, note: "Memory is written under the active profile namespace." },
    domains: MEMORY_DOMAINS,
    agentScopes: MEMORY_SCOPES,
    mutatesState: true,
  }),

  // -----------------------------------------------------------------------
  // memory_search
  // -----------------------------------------------------------------------
  defineFunction({
    name: "memory_search",
    description:
      "Search imported markdown memory using hybrid vector similarity plus BM25 ranking.",
    input: memorySearchSchema,
    handler: async (input, fnCtx) => fnCtx.services.memory.search(input),
    auth: { ...MEMORY_AUTH_ROLE_SENSITIVE, note: "Memory results are limited to the active profile namespace." },
    domains: MEMORY_DOMAINS,
    agentScopes: MEMORY_SCOPES,
  }),

  // -----------------------------------------------------------------------
  // conversation_search
  // -----------------------------------------------------------------------
  defineFunction({
    name: "conversation_search",
    description:
      "Search past conversation history saved to the append-only JSONL archive using BM25 retrieval with opportunistic vector reranking when local embeddings are already warm, then return recent matching excerpts.",
    input: conversationSearchSchema,
    handler: async (input, fnCtx) => fnCtx.services.conversations.searchHistory(input),
    auth: { ...MEMORY_AUTH_ROLE_SENSITIVE, note: "Results are limited to the append-only conversation archive for the active profile." },
    domains: MEMORY_DOMAINS,
    agentScopes: MEMORY_SCOPES,
  }),

  // -----------------------------------------------------------------------
  // telemetry_query
  // -----------------------------------------------------------------------
  defineFunction({
    name: "telemetry_query",
    description:
      "Search spans and events in the local telemetry store by trace, operation, entity, or free text. Supports format=json for structured output.",
    input: telemetryQuerySchema,
    handler: async (input, fnCtx) => fnCtx.services.telemetryQuery.query(input),
    auth: MEMORY_AUTH_ROOT,
    domains: MEMORY_DOMAINS,
    agentScopes: MEMORY_SCOPES,
  }),

  // -----------------------------------------------------------------------
  // memory_reindex
  // -----------------------------------------------------------------------
  defineFunction({
    name: "memory_reindex",
    description:
      "Rebuild the local memory vector index from markdown already stored under ~/.openelinaro/memory/documents.",
    input: z.object({}),
    handler: async (_input, fnCtx) => {
      const result = await fnCtx.services.memory.reindex();
      return [
        `Rebuilt memory index from ${result.sourceRoot}.`,
        `Copied documents into ${result.documentRoot}.`,
        `Indexed ${result.indexedDocuments} documents and ${result.indexedChunks} chunks.`,
        `Embedding model: ${result.modelId}.`,
      ].join("\n");
    },
    auth: { ...MEMORY_AUTH_ROLE_SENSITIVE, note: "Reindexing only sees memory visible to the active profile." },
    domains: MEMORY_DOMAINS,
    agentScopes: MEMORY_SCOPES,
    mutatesState: true,
  }),
];
