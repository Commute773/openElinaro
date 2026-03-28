import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import type { BaseMessage } from "@langchain/core/messages";
import { defineTool } from "../define-tool";
import { z } from "zod";
import type { ModelService, ActiveExtendedContextStatus, ContextWindowUsage, ModelProviderId, RecordedUsageDailyInspection, RecordedUsageInspection } from "../../services/models/model-service";
import type { RoutinesService } from "../../services/routines-service";
import type { ConversationStore } from "../../services/conversation-store";
import type { ConversationStateTransitionService } from "../../services/conversation-state-transition-service";
import type { SystemPromptService } from "../../services/system-prompt-service";
import { composeSystemPrompt } from "../../services/system-prompt-service";
import type { ReflectionService } from "../../services/reflection-service";
import type { ToolResultStore } from "../../services/tool-result-store";
import type { ToolProgramService } from "../../services/tool-program-service";
import type { AccessControlService } from "../../services/profiles";
import type { AgentToolScope, ToolCatalogCard } from "../../domain/tool-catalog";
import type { ToolLibraryDefinition } from "../../services/tool-library-service";
import { renderExtendedContextStatus, formatTokenCount } from "./tool-group-types";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { telemetry } from "../../services/infrastructure/telemetry";
import type { AppProgressEvent } from "../../domain/assistant";
import type { ToolContext } from "../tool-registry";

const toolTelemetry = telemetry.child({ component: "tool" });
const traceSpan = createTraceSpan(toolTelemetry);

const contextModeSchema = z.enum(["brief", "v", "verbose", "full"]);
const responseFormatSchema = z.enum(["text", "json"]);

const modelContextUsageSchema = z.object({
  conversationKey: z.string().min(1).optional(),
  mode: contextModeSchema.optional(),
});

const usageSummarySchema = z.object({
  conversationKey: z.string().min(1).optional(),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  timezone: z.string().min(1).optional(),
});

const reloadSchema = z.object({
  conversationKey: z.string().min(1).optional(),
});

const compactSchema = z.object({
  conversationKey: z.string().min(1).optional(),
});

const reflectSchema = z.object({
  focus: z.string().min(1).optional(),
});

const newConversationSchema = z.object({
  conversationKey: z.string().min(1).optional(),
  force: z.boolean().optional(),
});

const loadToolLibrarySchema = z.object({
  library: z.string().min(1).optional(),
  scope: z.enum(["chat", "coding-planner", "coding-worker", "direct"]).optional(),
  format: responseFormatSchema.optional(),
});

const toolResultReadSchema = z.object({
  ref: z.string().min(1),
  mode: z.enum(["partial", "full", "summary"]).optional(),
  startLine: z.number().int().min(1).optional(),
  lineCount: z.number().int().min(1).max(400).optional(),
  goal: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  if (value.mode === "summary" && !value.goal?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "goal is required when mode=summary.",
      path: ["goal"],
    });
  }
});

const runToolProgramSchema = z.object({
  objective: z.string().min(8),
  code: z.string().min(1),
  scope: z.enum(["chat", "coding-planner", "coding-worker", "direct"]).optional(),
  allowedTools: z.array(z.string().min(1)).max(24).optional(),
  timeoutMs: z.number().int().min(1_000).max(180_000).optional(),
});

const TOOL_RESULT_SUMMARY_INPUT_CHAR_LIMIT = 10_000;

export interface ConversationLifecycleToolBuildContext {
  models: ModelService;
  routines: RoutinesService;
  conversations: ConversationStore;
  systemPrompts: SystemPromptService;
  transitions: ConversationStateTransitionService;
  reflection: Pick<ReflectionService, "runExplicitReflection"> | undefined;
  toolResults: ToolResultStore;
  toolPrograms: ToolProgramService;
  access: AccessControlService;
  pendingConversationResets: Map<string, string>;
  resolveConversationKey: (input: { conversationKey?: string }, context?: ToolContext) => string | undefined;
  getConversationForTool: (input: { conversationKey?: string }, context?: ToolContext) => Promise<{
    key: string;
    messages: BaseMessage[];
    systemPrompt?: { text: string; version: string; files: string[]; loadedAt: string } | null;
  }>;
  buildRuntimeContext: () => Promise<string>;
  reportProgress: (context: ToolContext | undefined, summary: string, input?: unknown) => Promise<void>;
  getTools: (context?: ToolContext) => StructuredToolInterface[];
  getToolLibraries: (context?: ToolContext, scope?: AgentToolScope) => ToolLibraryDefinition[];
  getAgentDefaultVisibleToolNames: (agentScope: AgentToolScope) => string[];
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value && value.trim()))));
}

function normalizeContextMode(mode: z.infer<typeof contextModeSchema> | undefined) {
  if (!mode || mode === "brief") {
    return "brief" as const;
  }
  if (mode === "v") {
    return "verbose" as const;
  }
  return mode;
}

function formatRatio(value: number | null) {
  return value === null ? "n/a" : `${value}:1`;
}

function formatPercent(value: number | null | undefined) {
  return value === null || value === undefined ? "n/a" : `${value}%`;
}

function formatUsd(value: number | undefined) {
  if (value === undefined) {
    return "n/a";
  }

  const abs = Math.abs(value);
  const maximumFractionDigits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  const minimumFractionDigits = abs === 0 || abs >= 1 ? 2 : Math.min(4, maximumFractionDigits);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(value);
}

function renderCostBreakdownLine(label: string, total: number, cost: { input: number; output: number; cacheRead: number; cacheWrite: number }) {
  return `${label}: ${formatUsd(total)} (input ${formatUsd(cost.input)}, output ${formatUsd(cost.output)}, cache read ${formatUsd(cost.cacheRead)}, cache write ${formatUsd(cost.cacheWrite)})`;
}

function renderContextSummary(params: {
  usage: ContextWindowUsage;
  recorded: RecordedUsageInspection;
  extendedContext: ActiveExtendedContextStatus;
  runtimeContext: string;
  promptVersion: string;
  systemPromptCharCount: number;
}) {
  const { usage, recorded, extendedContext, runtimeContext, promptVersion, systemPromptCharCount } = params;
  const sharedSections = [
    `Conversation: ${usage.conversationKey}`,
    `Model: ${usage.providerId}/${usage.modelId}`,
    ...renderExtendedContextStatus(extendedContext),
    `Prompt version: ${promptVersion}`,
    `System prompt: ${usage.breakdown.systemPromptTokens} tokens (${systemPromptCharCount} chars)`,
    `Used: ${usage.usedTokens} / ${usage.maxContextTokens} tokens (${usage.utilizationPercent}%)`,
    `Remaining context: ${usage.remainingTokens} tokens`,
    `Remaining reply budget: ${formatTokenCount(usage.remainingReplyBudgetTokens)} tokens`,
    `Method: ${usage.method}`,
    `Breakdown method: ${usage.breakdownMethod}`,
    "Breakdown:",
    `- User messages: ${usage.breakdown.userMessageTokens}`,
    `- Assistant replies: ${usage.breakdown.assistantReplyTokens}`,
    `- Tool call input: ${usage.breakdown.toolCallInputTokens}`,
    `- Tool responses: ${usage.breakdown.toolResponseTokens}`,
    `- Tool definitions: ${usage.breakdown.toolDefinitionTokens}`,
    `- Breakdown total: ${usage.breakdown.estimatedTotalTokens}`,
    "Recorded usage:",
    `- Conversation requests: ${formatTokenCount(recorded.conversation.requestCount)}`,
    `- Conversation input/output: ${formatTokenCount(recorded.conversation.inputTokens)} / ${formatTokenCount(recorded.conversation.outputTokens)} (${formatRatio(recorded.conversation.inputToOutputRatio)})`,
    `- Conversation cost: ${formatUsd(recorded.conversation.cost.total)}`,
    `- Conversation non-cached input: ${formatTokenCount(recorded.conversation.nonCachedInputTokens)}`,
    `- Conversation cache read: ${formatTokenCount(recorded.conversation.cacheReadTokens)} (${formatPercent(recorded.conversation.cacheReadPercentOfInput)} of input)`,
    `- Conversation cache write: ${formatTokenCount(recorded.conversation.cacheWriteTokens)}`,
    `- Last conversation completion: ${recorded.latestConversationRecord
      ? `${recorded.latestConversationRecord.createdAt} input=${formatTokenCount(recorded.latestConversationRecord.inputTokens)} output=${formatTokenCount(recorded.latestConversationRecord.outputTokens)} cache_read=${formatTokenCount(recorded.latestConversationRecord.cacheReadTokens)}`
      : "none recorded"}`,
    `- Active model tracked requests: ${formatTokenCount(recorded.model.requestCount)}`,
    `- Active model input/output: ${formatTokenCount(recorded.model.inputTokens)} / ${formatTokenCount(recorded.model.outputTokens)} (${formatRatio(recorded.model.inputToOutputRatio)})`,
    `- Active model cost: ${formatUsd(recorded.model.cost.total)}`,
    `- Active model cache read: ${formatTokenCount(recorded.model.cacheReadTokens)} (${formatPercent(recorded.model.cacheReadPercentOfInput)} of input)`,
    `- Provider/model budget remaining: ${recorded.providerBudgetRemaining === null
      ? "unavailable"
      : `${formatTokenCount(recorded.providerBudgetRemaining)} (${recorded.providerBudgetSource ?? "provider"})`}`,
  ];

  return {
    brief: `Used: ${formatTokenCount(usage.usedTokens)} / ${formatTokenCount(usage.maxContextTokens)} tokens (${usage.utilizationPercent}%).`,
    verbose: sharedSections.join("\n"),
    full: [
      ...sharedSections,
      runtimeContext
        ? ["Live runtime context (not auto-injected into the chat prompt):", runtimeContext].join("\n")
        : "Live runtime context: none.",
    ].join("\n"),
  };
}

function resolveLocalDateKey(reference: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(reference);
}

function renderUsageSummary(params: {
  conversationKey?: string;
  providerId: ModelProviderId;
  modelId: string;
  recorded: RecordedUsageInspection;
  daily: RecordedUsageDailyInspection;
}) {
  const { conversationKey, providerId, modelId, recorded, daily } = params;
  const lines = [
    `Model usage summary for ${providerId}/${modelId}`,
    `Local day: ${daily.localDate} (${daily.timezone})`,
  ];

  if (conversationKey) {
    lines.push(`Conversation: ${conversationKey}`);
    lines.push(`Conversation total requests: ${formatTokenCount(recorded.conversation.requestCount)}`);
    lines.push(renderCostBreakdownLine("Conversation total cost", recorded.conversation.cost.total, recorded.conversation.cost));
    lines.push(`Conversation today requests: ${formatTokenCount(daily.conversation.requestCount)}`);
    lines.push(renderCostBreakdownLine("Conversation today cost", daily.conversation.cost.total, daily.conversation.cost));
    lines.push(`Last conversation completion today: ${daily.latestConversationRecord?.createdAt ?? "none recorded"}`);
  }

  lines.push(`Profile today requests: ${formatTokenCount(daily.profileDay.requestCount)}`);
  lines.push(renderCostBreakdownLine("Profile today cost", daily.profileDay.cost.total, daily.profileDay.cost));
  lines.push(`Active model total requests: ${formatTokenCount(recorded.model.requestCount)}`);
  lines.push(renderCostBreakdownLine("Active model total cost", recorded.model.cost.total, recorded.model.cost));
  lines.push(`Active model today requests: ${formatTokenCount(daily.modelDay.requestCount)}`);
  lines.push(renderCostBreakdownLine("Active model today cost", daily.modelDay.cost.total, daily.modelDay.cost));
  lines.push(`Last model completion today: ${daily.latestModelDayRecord?.createdAt ?? "none recorded"}`);
  lines.push(`Last profile completion today: ${daily.latestProfileDayRecord?.createdAt ?? "none recorded"}`);
  lines.push(`Provider/model budget remaining: ${daily.providerBudgetRemaining === null
    ? "unavailable"
    : `${formatTokenCount(daily.providerBudgetRemaining)} (${daily.providerBudgetSource ?? "provider"})`}`);

  return lines.join("\n");
}

export function buildConversationLifecycleTools(
  ctx: ConversationLifecycleToolBuildContext,
  context?: ToolContext,
): StructuredToolInterface[] {
  return [
    tool(
      async (input) =>
        traceSpan(
          "tool.context",
          async () => {
            const conversation = await ctx.getConversationForTool(input, context);
            const systemPrompt = composeSystemPrompt(
              conversation.systemPrompt?.text ?? (await ctx.systemPrompts.load()).text,
            );
            const mode = normalizeContextMode(input.mode);
            const usage = await ctx.models.inspectContextWindowUsage({
              conversationKey: conversation.key,
              systemPrompt: systemPrompt.text,
              messages: conversation.messages,
              tools: ctx.getTools(context),
            });
            const recorded = ctx.models.inspectRecordedUsage({
              conversationKey: usage.conversationKey,
              providerId: usage.providerId,
              modelId: usage.modelId,
            });
            const extendedContext = await ctx.models.getActiveExtendedContextStatus();
            const runtimeContext = await ctx.buildRuntimeContext();
            const rendered = renderContextSummary({
              usage,
              recorded,
              extendedContext,
              runtimeContext,
              promptVersion: conversation.systemPrompt?.version ?? "unknown",
              systemPromptCharCount: systemPrompt.charCount,
            });
            return rendered[mode];
          },
          {
            attributes: {
              conversationKey: ctx.resolveConversationKey(input, context),
              mode: normalizeContextMode(input.mode),
            },
          },
        ),
      {
        name: "context",
        description:
          "Inspect context-window usage for a saved conversation. Default mode is brief; set mode to v or verbose for token breakdown and cache stats, or full for the existing full dump including live runtime context.",
        schema: modelContextUsageSchema,
      },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.usage_summary",
          async () => {
            const conversationKey = ctx.resolveConversationKey(input, context);
            const active = await ctx.models.getActiveModel();
            const timezone = input.timezone?.trim() || ctx.routines.loadData().settings.timezone;
            const localDate = input.localDate?.trim() || resolveLocalDateKey(new Date(), timezone);
            const recorded = ctx.models.inspectRecordedUsage({
              conversationKey,
              providerId: active.providerId,
              modelId: active.modelId,
            });
            const daily = ctx.models.inspectRecordedUsageByLocalDate({
              conversationKey,
              providerId: active.providerId,
              modelId: active.modelId,
              localDate,
              timezone,
            });

            return renderUsageSummary({
              conversationKey,
              providerId: active.providerId,
              modelId: active.modelId,
              recorded,
              daily,
            });
          },
          {
            attributes: {
              conversationKey: ctx.resolveConversationKey(input, context),
              localDate: input.localDate,
              timezone: input.timezone,
            },
          },
        ),
      {
        name: "usage_summary",
        description:
          "Show provider-reported LLM usage and USD cost for the active thread plus the current local day, scoped to the active profile.",
        schema: usageSummarySchema,
      },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.compact",
          async () => {
            const conversationKey = ctx.resolveConversationKey(input, context);
            if (!conversationKey) {
              throw new Error(
                "compact needs a conversationKey unless it is called from an active chat thread.",
              );
            }

            const compacted = await ctx.transitions.compactForContinuation({
              conversationKey,
              onProgress: async (message) => ctx.reportProgress(context, message, input),
            });

            return [
              `Compacted conversation ${conversationKey}.`,
              compacted.memoryFilePath
                ? `Memory flushed to ${compacted.memoryFilePath}.`
                : "No durable memory was extracted.",
              `Summary: ${compacted.summary}`,
            ].join("\n");
          },
          {
            attributes: {
              conversationKey: ctx.resolveConversationKey(input, context),
            },
          },
        ),
      {
        name: "compact",
        description:
          "Compact the active conversation into a continuation summary and optional durable memory without starting a fresh thread.",
        schema: compactSchema,
      },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.reload",
          async () => {
            const conversationKey = ctx.resolveConversationKey(input, context);
            if (!conversationKey) {
              throw new Error(
                "reload needs a conversationKey unless it is called from an active chat thread.",
              );
            }

            const snapshot = await ctx.systemPrompts.load();
            const conversation = await ctx.conversations.replaceSystemPrompt(conversationKey, snapshot);

            return [
              `Reloaded system prompt for ${conversation.key}.`,
              `Version: ${conversation.systemPrompt?.version ?? snapshot.version}`,
              `Files: ${(conversation.systemPrompt?.files ?? snapshot.files).join(", ") || "(none)"}`,
              `Loaded at: ${conversation.systemPrompt?.loadedAt ?? snapshot.loadedAt}`,
            ].join("\n");
          },
          {
            attributes: {
              conversationKey: ctx.resolveConversationKey(input, context),
            },
          },
        ),
      {
        name: "reload",
        description:
          "Reload the active thread's system prompt snapshot from local system_prompt markdown files.",
        schema: reloadSchema,
      },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.reflect",
          async () => {
            if (!ctx.reflection) {
              throw new Error("Reflection service is not available in this runtime.");
            }
            const result = await ctx.reflection.runExplicitReflection({
              focus: input.focus,
            });
            if (!result) {
              return "No reflection entry was written.";
            }
            return [
              `Wrote a private reflection entry to ${result.filePath}.`,
              `Mood: ${result.entry.mood}`,
              result.entry.bringUpNextTime
                ? `Bring up next time: ${result.entry.bringUpNextTime}`
                : "",
              "",
              result.entry.body,
            ].filter(Boolean).join("\n");
          },
          {
            attributes: {
              focus: input.focus,
            },
          },
        ),
      {
        name: "reflect",
        description:
          "Write a private introspective journal entry about recent experience and store it in the active profile's durable reflection journal.",
        schema: reflectSchema,
      },
    ),

    buildNewChatTool(ctx, context),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.load_tool_library",
          async () => {
            const scope = (input.scope as AgentToolScope | undefined) ?? "chat";
            const libraries = ctx.getToolLibraries(context, scope);
            const visibleBefore = uniqueStrings([
              ...ctx.getAgentDefaultVisibleToolNames(scope),
              ...(context?.getActiveToolNames?.() ?? []),
            ]);
            const requestedLibraryId = input.library?.trim();

            if (!requestedLibraryId) {
              const renderedLibraries = libraries.map((library) => {
                const alreadyVisible = library.toolNames.filter((name) => visibleBefore.includes(name));
                return {
                  id: library.id,
                  description: library.description,
                  toolNames: [...library.toolNames],
                  alreadyVisible,
                  hiddenToolCount: library.toolNames.length - alreadyVisible.length,
                };
              });
              if (input.format === "json") {
                return {
                  scope,
                  libraries: renderedLibraries,
                  visibleBefore,
                };
              }
              return [
                `Scope: ${scope}`,
                `Visible tool count: ${visibleBefore.length}`,
                "",
                ...renderedLibraries.map((library) => [
                  `Library: ${library.id}`,
                  `Description: ${library.description}`,
                  `Tools: ${library.toolNames.join(", ")}`,
                  library.alreadyVisible.length > 0
                    ? `Already visible: ${library.alreadyVisible.join(", ")}`
                    : "Already visible: (none)",
                  `Hidden tools: ${library.hiddenToolCount}`,
                ].join("\n")),
              ].join("\n");
            }

            const library = libraries.find((entry) => entry.id === requestedLibraryId);
            if (!library) {
              const availableIds = libraries.map((entry) => entry.id);
              if (input.format === "json") {
                return {
                  scope,
                  library: requestedLibraryId,
                  availableLibraries: availableIds,
                  message: `Unknown tool library "${requestedLibraryId}" for scope ${scope}.`,
                };
              }
              return `Unknown tool library "${requestedLibraryId}" for scope ${scope}. Available libraries: ${availableIds.join(", ") || "(none)"}.`;
            }

            const visibleBeforeSet = new Set(visibleBefore);
            const newlyActivated = library.toolNames.filter((name) => !visibleBeforeSet.has(name));
            const alreadyVisible = library.toolNames.filter((name) => visibleBeforeSet.has(name));

            if (newlyActivated.length > 0) {
              context?.activateToolNames?.(newlyActivated);
            }

            const visibleAfter = uniqueStrings([...visibleBefore, ...newlyActivated]);

            if (input.format === "json") {
              return {
                scope,
                library: library.id,
                description: library.description,
                toolNames: [...library.toolNames],
                newlyActivated,
                alreadyVisible,
                visibleAfter,
              };
            }

            return [
              `Scope: ${scope}`,
              `Library: ${library.id}`,
              `Description: ${library.description}`,
              `Tools: ${library.toolNames.join(", ")}`,
              `Newly activated: ${newlyActivated.length > 0 ? newlyActivated.join(", ") : "(none)"}`,
              `Already visible: ${alreadyVisible.length > 0 ? alreadyVisible.join(", ") : "(none)"}`,
              `Visible tool count after load: ${visibleAfter.length}`,
            ].join("\n");
          },
          { attributes: input },
        ),
      {
        name: "load_tool_library",
        description:
          "List available tool libraries for a scope or load one named library into the current run. Use this when the needed tool family is not already visible. Supports format=json for structured output.",
        schema: loadToolLibrarySchema,
      },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.tool_result_read",
          async () => {
            const record = await ctx.toolResults.get(input.ref);
            if (!record) {
              throw new Error(`Unknown tool result ref: ${input.ref}`);
            }

            if (
              context?.conversationKey
              && record.namespace !== context.conversationKey
              && !ctx.access.isRoot()
            ) {
              throw new Error(
                `Tool result ref ${input.ref} belongs to ${record.namespace}, not the active session ${context.conversationKey}.`,
              );
            }

            const mode = input.mode ?? "partial";
            if (mode === "full") {
              return [
                `[tool_result_full ref=${record.ref} tool=${record.toolName} status=${record.status} lines=${record.lineCount} chars=${record.charLength}]`,
                record.content,
              ]
                .filter(Boolean)
                .join("\n");
            }

            if (mode === "summary") {
              const goal = input.goal?.trim();
              if (!goal) {
                throw new Error("tool_result_read summary mode requires a non-empty goal.");
              }

              const output = record.content.slice(0, TOOL_RESULT_SUMMARY_INPUT_CHAR_LIMIT);
              try {
                const summarized = await ctx.models.summarizeToolResult({
                  toolName: record.toolName,
                  goal,
                  output,
                });
                return [
                  `[tool_result_summary ref=${record.ref} tool=${record.toolName} status=${record.status} source_chars=${record.charLength} used_chars=${output.length}]`,
                  summarized,
                ]
                  .filter(Boolean)
                  .join("\n");
              } catch (error) {
                toolTelemetry.event(
                  "tool.tool_result_read.summary_failed",
                  {
                    ref: record.ref,
                    toolName: record.toolName,
                    providerId: ctx.models.getToolSummarizerSelection().providerId,
                    modelId: ctx.models.getToolSummarizerSelection().modelId,
                    error: error instanceof Error ? error.message : String(error),
                  },
                  { level: "warn", outcome: "error" },
                );
                throw error;
              }
            }

            const startLine = input.startLine ?? 1;
            const lineCount = input.lineCount ?? 200;
            const lines = record.content.split(/\r?\n/);
            const sliceStart = Math.max(0, startLine - 1);
            const sliceEnd = Math.min(lines.length, sliceStart + lineCount);
            const slice = lines.slice(sliceStart, sliceEnd).join("\n");

            return [
              `[tool_result_slice ref=${record.ref} tool=${record.toolName} status=${record.status} lines=${sliceStart + 1}-${Math.max(sliceStart + 1, sliceEnd)}/${Math.max(lines.length, 1)} chars=${record.charLength}]`,
              slice,
            ]
              .filter(Boolean)
              .join("\n");
          },
          { attributes: input },
        ),
      {
        name: "tool_result_read",
        description:
          "Reopen a stored tool-result reference as a bounded line slice, the full stored payload, or a summarizer-backed extraction. Prefer mode=summary when you only need specific facts from a large ref instead of the full raw content.",
        schema: toolResultReadSchema,
      },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.run_tool_program",
          async () => {
            const result = await ctx.toolPrograms.run({
              objective: input.objective,
              code: input.code,
              scope: input.scope,
              allowedTools: input.allowedTools,
              timeoutMs: input.timeoutMs,
              context,
            });

            return [
              `Tool program completed: ${result.runId}`,
              `Scope: ${result.scope}`,
              `Summary: ${result.summary}`,
              result.allowedTools.length > 0
                ? `Allowed tools: ${result.allowedTools.join(", ")}`
                : "Allowed tools: (none)",
              result.toolCalls.length > 0
                ? `Tool calls:\n${result.toolCalls.map((entry) =>
                    `- ${entry.name}${entry.artifactPath ? ` -> ${entry.artifactPath}` : ""}: ${entry.preview}`).join("\n")}`
                : "Tool calls: (none)",
              result.artifacts.length > 0
                ? `Artifacts:\n${result.artifacts.map((artifact) =>
                    `- ${artifact.path} (${artifact.mediaType}, ${artifact.byteLength} bytes)`).join("\n")}`
                : "Artifacts: (none)",
              `Manifest: ${result.manifestPath}`,
            ].join("\n");
          },
          { attributes: { scope: input.scope, timeoutMs: input.timeoutMs } },
        ),
      {
        name: "run_tool_program",
        description:
          "Execute JavaScript that orchestrates many tool calls internally and returns only a compact summary plus artifact paths. Use tools.invokeTool(name, input) inside the code and return an object with a summary field. Prefer this for loops, filtering, aggregation, repeated searches/reads, or large intermediate results.",
        schema: runToolProgramSchema,
      },
    ),
  ];
}

function buildNewChatTool(
  ctx: ConversationLifecycleToolBuildContext,
  context?: ToolContext,
): StructuredToolInterface {
  return buildFreshConversationTool(
    {
      name: "new_chat",
      spanName: "tool.new_chat",
      errorLabel: "new_chat",
      description:
        "Start a fresh conversation. By default this flushes durable memory from the active thread first; set force=true to skip the durable-memory flush and reset immediately. The current thread keeps its existing system-prompt snapshot; use reload explicitly if you want a new prompt snapshot.",
      preparingProgress: "Preparing a fresh conversation for {conversationKey}.",
      successProgressWithMemory:
        "Fresh conversation is ready. Memory flushed to {memoryFilePath}.",
      successProgressWithoutMemory:
        "Fresh conversation is ready. No durable memory needed to be saved.",
      forceSuccessProgress:
        "Fresh conversation is ready. Durable memory flush was intentionally skipped.",
    },
    ctx,
    context,
  );
}

function buildFreshConversationTool(
  config: {
    name: "new_chat";
    spanName: "tool.new_chat";
    errorLabel: "new_chat";
    description: string;
    preparingProgress: string;
    successProgressWithMemory: string;
    successProgressWithoutMemory: string;
    forceSuccessProgress: string;
  },
  ctx: ConversationLifecycleToolBuildContext,
  context?: ToolContext,
): StructuredToolInterface {
  return defineTool(
    async (input) =>
      traceSpan(
        config.spanName,
        async () => {
          const conversationKey = ctx.resolveConversationKey(input, context);
          if (!conversationKey) {
            throw new Error(
              `${config.errorLabel} needs a conversationKey unless it is called from an active chat thread.`,
            );
          }

          await ctx.reportProgress(
            context,
            config.preparingProgress.replace("{conversationKey}", conversationKey),
            input,
          );

          const flushMemory = input.force !== true;
          const freshConversation = await ctx.transitions.startFreshConversation({
            conversationKey,
            flushMemory,
            onProgress: async (message) => ctx.reportProgress(context, message, input),
          });

          const resultMessage = [
            `Started a new conversation for ${conversationKey}.`,
            `Assistant: ${freshConversation.openingLine}`,
            `System prompt version: ${freshConversation.systemPrompt.version}.`,
            input.force === true || freshConversation.memoryFlushSkipped
              ? "Durable memory flush was intentionally skipped."
              : freshConversation.memoryFilePath
              ? `Memory flushed to ${freshConversation.memoryFilePath}.`
              : "No durable memory was flushed.",
          ].join("\n");

          if (context?.invocationSource === "chat") {
            ctx.pendingConversationResets.set(conversationKey, resultMessage);
          }

          await ctx.reportProgress(
            context,
            input.force === true
              ? config.forceSuccessProgress
              : freshConversation.memoryFilePath
              ? config.successProgressWithMemory.replace(
                  "{memoryFilePath}",
                  freshConversation.memoryFilePath,
                )
              : config.successProgressWithoutMemory,
            input,
          );

          return resultMessage;
        },
        {
          attributes: {
            conversationKey: ctx.resolveConversationKey(input, context),
          },
        },
      ),
    {
      name: config.name,
      description: config.description,
      schema: newConversationSchema,
    },
  );
}
