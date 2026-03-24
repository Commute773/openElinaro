import { type StructuredToolInterface } from "@langchain/core/tools";
import { defineTool } from "../define-tool";
import { z } from "zod";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { telemetry } from "../../services/telemetry";
import type { ToolBuildContext } from "./tool-group-types";

const toolTelemetry = telemetry.child({ component: "tool" });
const traceSpan = createTraceSpan(toolTelemetry);

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

export function buildMemoryTools(ctx: ToolBuildContext): StructuredToolInterface[] {
  return [
    defineTool(
      async (input) =>
        traceSpan(
          "tool.memory_import",
          async () => {
            const result = await ctx.memory.importFromDirectory(input.sourcePath);
            return [
              `Imported markdown memory from ${result.sourceRoot}.`,
              `Local document root: ${result.documentRoot}.`,
              `Indexed ${result.indexedDocuments} documents and ${result.indexedChunks} chunks.`,
              `Embedding model: ${result.modelId}.`,
            ].join("\n");
          },
          { attributes: input },
        ),
      {
        name: "memory_import",
        description:
          "Import markdown memory from a caller-provided directory into local storage and rebuild the index.",
        schema: importDirectorySchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.memory_search",
          async () => ctx.memory.search(input),
          { attributes: input },
        ),
      {
        name: "memory_search",
        description:
          "Search imported markdown memory using hybrid vector similarity plus BM25 ranking.",
        schema: memorySearchSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.conversation_search",
          async () => ctx.conversations.searchHistory(input),
          { attributes: input },
        ),
      {
        name: "conversation_search",
        description:
          "Search past conversation history saved to the append-only JSONL archive using BM25 retrieval with opportunistic vector reranking when local embeddings are already warm, then return recent matching excerpts.",
        schema: conversationSearchSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.telemetry_query",
          async () => ctx.telemetryQuery.query(input),
          { attributes: input },
        ),
      {
        name: "telemetry_query",
        description:
          "Search spans and events in the local telemetry store by trace, operation, entity, or free text. Supports format=json for structured output.",
        schema: telemetryQuerySchema,
      },
    ),
    defineTool(
      async () =>
        traceSpan("tool.memory_reindex", async () => {
          const result = await ctx.memory.reindex();
          return [
            `Rebuilt memory index from ${result.sourceRoot}.`,
            `Copied documents into ${result.documentRoot}.`,
            `Indexed ${result.indexedDocuments} documents and ${result.indexedChunks} chunks.`,
            `Embedding model: ${result.modelId}.`,
          ].join("\n");
        }),
      {
        name: "memory_reindex",
        description:
          "Rebuild the local memory vector index from markdown already stored under ~/.openelinaro/memory/documents.",
        schema: z.object({}),
      },
    ),
  ];
}
