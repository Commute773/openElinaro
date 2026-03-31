/**
 * Conversation lifecycle function definitions.
 * Migrated from src/tools/groups/conversation-lifecycle-tools.ts.
 */
import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";
import type { ActiveExtendedContextStatus, ContextWindowUsage, ModelProviderId, RecordedUsageDailyInspection, RecordedUsageInspection } from "../../services/models/model-service";
import type { AgentToolScope } from "../../domain/tool-catalog";
import { composeSystemPrompt } from "../../services/system-prompt-service";
import { renderExtendedContextStatus, formatTokenCount } from "./config-functions";
import { formatResult } from "../formatters";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

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

const TOOL_RESULT_SUMMARY_INPUT_CHAR_LIMIT = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Resolve conversation-lifecycle callbacks, throwing if not set. */
function requireCallback<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`FunctionContext.${name} is required for conversation-lifecycle tools but was not set.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Auth / metadata
// ---------------------------------------------------------------------------

const SESSION_AUTH = { access: "anyone" as const, behavior: "role-sensitive" as const };
const SESSION_SCOPES: ("chat" | "direct")[] = ["chat", "direct"];
const SESSION_DOMAINS = ["system", "session"];

const TOOLING_AUTH = { access: "anyone" as const, behavior: "role-sensitive" as const };
const TOOLING_ALL_SCOPES: ("chat" | "coding-planner" | "coding-worker" | "direct")[] = ["chat", "coding-planner", "coding-worker", "direct"];

// ---------------------------------------------------------------------------
// Domain builder
// ---------------------------------------------------------------------------

export const buildConversationLifecycleFunctions: FunctionDomainBuilder = (_ctx) => [
  // -------------------------------------------------------------------------
  // context
  // -------------------------------------------------------------------------
  defineFunction({
    name: "context",
    description:
      "Inspect context-window usage for a saved conversation. Default mode is brief; set mode to v or verbose for token breakdown and cache stats, or full for the existing full dump including live runtime context.",
    input: modelContextUsageSchema,
    handler: async (input, fnCtx) => {
      const getConversation = requireCallback(fnCtx.getConversationForTool, "getConversationForTool");
      const getToolsFn = requireCallback(fnCtx.getTools, "getTools");
      const buildRuntime = requireCallback(fnCtx.buildRuntimeContext, "buildRuntimeContext");

      const conversation = await getConversation(input, fnCtx.toolContext);
      const systemPrompt = composeSystemPrompt(
        conversation.systemPrompt?.text ?? (await fnCtx.services.systemPrompts.load()).text,
      );
      const mode = normalizeContextMode(input.mode);
      const usage = await fnCtx.services.models.inspectContextWindowUsage({
        conversationKey: conversation.key,
        systemPrompt: systemPrompt.text,
        messages: conversation.messages,
        tools: getToolsFn(fnCtx.toolContext),
      });
      const recorded = fnCtx.services.models.inspectRecordedUsage({
        conversationKey: usage.conversationKey,
        providerId: usage.providerId,
        modelId: usage.modelId,
      });
      const extendedContext = await fnCtx.services.models.getActiveExtendedContextStatus();
      const runtimeContext = await buildRuntime();
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
    format: formatResult,
    auth: { ...SESSION_AUTH, note: "Project and profile context are filtered by role." },
    domains: SESSION_DOMAINS,
    agentScopes: SESSION_SCOPES,
    defaultVisibleScopes: ["chat", "direct"],
    examples: ["show context usage", "show context full"],
  }),

  // -------------------------------------------------------------------------
  // usage_summary
  // -------------------------------------------------------------------------
  defineFunction({
    name: "usage_summary",
    description:
      "Show provider-reported LLM usage and USD cost for the active thread plus the current local day, scoped to the active profile.",
    input: usageSummarySchema,
    handler: async (input, fnCtx) => {
      const resolveKey = requireCallback(fnCtx.resolveConversationKey, "resolveConversationKey");

      const conversationKey = resolveKey(input, fnCtx.toolContext);
      const active = await fnCtx.services.models.getActiveModel();
      const timezone = input.timezone?.trim() || fnCtx.services.routines.loadData().settings.timezone;
      const localDate = input.localDate?.trim() || resolveLocalDateKey(new Date(), timezone);
      const recorded = fnCtx.services.models.inspectRecordedUsage({
        conversationKey,
        providerId: active.providerId,
        modelId: active.modelId,
      });
      const daily = fnCtx.services.models.inspectRecordedUsageByLocalDate({
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
    format: formatResult,
    auth: { ...SESSION_AUTH, note: "Usage and cost summaries are limited to the active profile's model-usage ledger records." },
    domains: ["observability", "usage", "session"],
    agentScopes: SESSION_SCOPES,
    defaultVisibleScopes: ["chat", "direct"],
    examples: ["show today's model spend", "show this thread cost"],
  }),

  // -------------------------------------------------------------------------
  // compact
  // -------------------------------------------------------------------------
  defineFunction({
    name: "compact",
    description:
      "Compact the active conversation into a continuation summary and optional durable memory without starting a fresh thread.",
    input: compactSchema,
    handler: async (input, fnCtx) => {
      const resolveKey = requireCallback(fnCtx.resolveConversationKey, "resolveConversationKey");
      const report = requireCallback(fnCtx.reportProgress, "reportProgress");

      const conversationKey = resolveKey(input, fnCtx.toolContext);
      if (!conversationKey) {
        throw new Error(
          "compact needs a conversationKey unless it is called from an active chat thread.",
        );
      }

      const compacted = await fnCtx.services.transitions.compactForContinuation({
        conversationKey,
        onProgress: async (event) => {
          const msg = "message" in event ? String((event as any).message) : event.type;
          return report(fnCtx.toolContext, msg, input);
        },
      });

      return [
        `Compacted conversation ${conversationKey}.`,
        compacted.memoryFilePath
          ? `Memory flushed to ${compacted.memoryFilePath}.`
          : "No durable memory was extracted.",
        `Summary: ${compacted.summary}`,
      ].join("\n");
    },
    format: formatResult,
    auth: { ...SESSION_AUTH, note: "Durable memory writes land in the active profile namespace." },
    domains: SESSION_DOMAINS,
    agentScopes: SESSION_SCOPES,
    defaultVisibleScopes: ["chat", "direct"],
    mutatesState: true,
    examples: ["compact this conversation", "shrink chat history"],
  }),

  // -------------------------------------------------------------------------
  // reload
  // -------------------------------------------------------------------------
  defineFunction({
    name: "reload",
    description:
      "Reload the active thread's system prompt snapshot from local system_prompt markdown files.",
    input: reloadSchema,
    handler: async (input, fnCtx) => {
      const resolveKey = requireCallback(fnCtx.resolveConversationKey, "resolveConversationKey");

      const conversationKey = resolveKey(input, fnCtx.toolContext);
      if (!conversationKey) {
        throw new Error(
          "reload needs a conversationKey unless it is called from an active chat thread.",
        );
      }

      const snapshot = await fnCtx.services.systemPrompts.load();
      const conversation = await fnCtx.services.conversations.replaceSystemPrompt(conversationKey, snapshot);

      return [
        `Reloaded system prompt for ${conversation.key}.`,
        `Version: ${conversation.systemPrompt?.version ?? snapshot.version}`,
        `Files: ${(conversation.systemPrompt?.files ?? snapshot.files).join(", ") || "(none)"}`,
        `Loaded at: ${conversation.systemPrompt?.loadedAt ?? snapshot.loadedAt}`,
      ].join("\n");
    },
    format: formatResult,
    auth: { access: "anyone", behavior: "uniform" },
    domains: SESSION_DOMAINS,
    agentScopes: SESSION_SCOPES,
    defaultVisibleScopes: ["chat", "direct"],
    mutatesState: true,
    examples: ["reload system prompt", "refresh instructions"],
  }),

  // -------------------------------------------------------------------------
  // reflect
  // -------------------------------------------------------------------------
  defineFunction({
    name: "reflect",
    description:
      "Write a private introspective journal entry about recent experience and store it in the active profile's durable reflection journal.",
    input: reflectSchema,
    handler: async (input, fnCtx) => {
      if (!fnCtx.services.reflection) {
        throw new Error("Reflection service is not available in this runtime.");
      }
      const result = await fnCtx.services.reflection.runExplicitReflection({
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
    format: formatResult,
    auth: { ...SESSION_AUTH, note: "Reflection entries are written under the active profile memory namespace." },
    domains: SESSION_DOMAINS,
    agentScopes: SESSION_SCOPES,
    defaultVisibleScopes: ["chat", "direct"],
    mutatesState: true,
    examples: ["write a reflection", "journal about today"],
  }),

  // -------------------------------------------------------------------------
  // new_chat
  // -------------------------------------------------------------------------
  defineFunction({
    name: "new_chat",
    description:
      "Start a fresh conversation. By default this flushes durable memory from the active thread first; set force=true to skip the durable-memory flush and reset immediately. The current thread keeps its existing system-prompt snapshot; use reload explicitly if you want a new prompt snapshot.",
    input: newConversationSchema,
    handler: async (input, fnCtx) => {
      const resolveKey = requireCallback(fnCtx.resolveConversationKey, "resolveConversationKey");
      const report = requireCallback(fnCtx.reportProgress, "reportProgress");
      const pendingResets = requireCallback(fnCtx.pendingConversationResets, "pendingConversationResets");
      const context = fnCtx.toolContext;

      const conversationKey = resolveKey(input, context);
      if (!conversationKey) {
        throw new Error(
          "new_chat needs a conversationKey unless it is called from an active chat thread.",
        );
      }

      await report(
        context,
        `Preparing a fresh conversation for ${conversationKey}.`,
        input,
      );

      const flushMemory = input.force !== true;
      const freshConversation = await fnCtx.services.transitions.startFreshConversation({
        conversationKey,
        flushMemory,
        onProgress: async (event) => {
          const msg = "message" in event ? String((event as any).message) : event.type;
          return report(context, msg, input);
        },
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
        pendingResets.set(conversationKey, resultMessage);
      }

      await report(
        context,
        input.force === true
          ? "Fresh conversation is ready. Durable memory flush was intentionally skipped."
          : freshConversation.memoryFilePath
          ? `Fresh conversation is ready. Memory flushed to ${freshConversation.memoryFilePath}.`
          : "Fresh conversation is ready. No durable memory needed to be saved.",
        input,
      );

      return resultMessage;
    },
    format: formatResult,
    auth: { ...SESSION_AUTH, note: "Starts a fresh chat in the active conversation namespace and optionally skips durable memory writes when force=true." },
    domains: SESSION_DOMAINS,
    agentScopes: SESSION_SCOPES,
    defaultVisibleScopes: ["chat", "direct"],
    mutatesState: true,
    examples: ["start a fresh conversation", "force a fresh chat without durable memory"],
  }),

  // -------------------------------------------------------------------------
  // load_tool_library
  // -------------------------------------------------------------------------
  defineFunction({
    name: "load_tool_library",
    description:
      "List available tool libraries for a scope or load one named library into the current run. Use this when the needed tool family is not already visible. Supports format=json for structured output.",
    input: loadToolLibrarySchema,
    handler: async (input, fnCtx) => {
      const getLibraries = requireCallback(fnCtx.getToolLibraries, "getToolLibraries");
      const getDefaultVisible = requireCallback(fnCtx.getAgentDefaultVisibleToolNames, "getAgentDefaultVisibleToolNames");
      const context = fnCtx.toolContext;
      const scope = (input.scope as AgentToolScope | undefined) ?? "chat";
      const libraries = getLibraries(context, scope);
      const visibleBefore = uniqueStrings([
        ...getDefaultVisible(scope),
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
    format: formatResult,
    auth: { ...TOOLING_AUTH, note: "Visible libraries and activated tools depend on the active profile and scope." },
    domains: ["meta", "tooling"],
    agentScopes: TOOLING_ALL_SCOPES,
    defaultVisibleScopes: ["chat", "coding-planner", "coding-worker", "direct"],
    examples: ["load the web_research library", "load filesystem_read tools"],
  }),

  // -------------------------------------------------------------------------
  // tool_result_read
  // -------------------------------------------------------------------------
  defineFunction({
    name: "tool_result_read",
    description:
      "Reopen a stored tool-result reference as a bounded line slice, the full stored payload, or a summarizer-backed extraction. Prefer mode=summary when you only need specific facts from a large ref instead of the full raw content.",
    input: toolResultReadSchema,
    handler: async (input, fnCtx) => {
      const context = fnCtx.toolContext;

      const record = await fnCtx.services.toolResults.get(input.ref);
      if (!record) {
        throw new Error(`Unknown tool result ref: ${input.ref}`);
      }

      if (
        context?.conversationKey
        && record.namespace !== context.conversationKey
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
        const summarized = await fnCtx.services.models.summarizeToolResult({
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
    format: formatResult,
    auth: { ...TOOLING_AUTH, note: "Stored tool-result refs are scoped to the active conversation or worker session unless the operator reads them directly." },
    domains: ["meta", "tooling", "session"],
    agentScopes: TOOLING_ALL_SCOPES,
    defaultVisibleScopes: ["chat", "coding-planner", "coding-worker", "direct"],
    examples: ["reopen a stored tool result", "summarize a saved tool output by ref"],
  }),

];
