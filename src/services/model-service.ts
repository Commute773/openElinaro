import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  getModels,
  stream,
  type Api,
  type Context,
  type Message,
  type Model,
  type ThinkingLevel,
  type Usage,
} from "@mariozechner/pi-ai";
import { getOAuthApiKey, type OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { z } from "zod";
import { assertSuccessfulProviderResponse } from "../connectors/provider-response";
import {
  approximateContentTokens,
  extractTextFromMessage,
  normalizeChatPromptContent,
} from "./message-content-service";
import {
  UsageTrackingService,
  type UsagePromptDiagnostics,
  type UsageLedgerRecord,
  type UsageLedgerSummary,
} from "./usage-tracking-service";
import { CacheMissMonitor, type CacheMissWarning } from "./cache-miss-monitor";
import { getClaudeSetupToken, getCodexCredentials, saveCodexCredentials } from "../auth/store";
import type { ProfileRecord } from "../domain/profiles";
import { resolveRuntimePath } from "./runtime-root";
import { telemetry } from "./telemetry";

export type ModelProviderId = "openai-codex" | "claude";
const modelTelemetry = telemetry.child({ component: "model" });

function traceSpan<T>(
  operation: string,
  fn: () => Promise<T>,
  options?: { attributes?: Record<string, unknown> },
) {
  return modelTelemetry.span(operation, options?.attributes ?? {}, fn);
}

export interface ListedProviderModel {
  providerId: ModelProviderId;
  modelId: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  supported: boolean;
  active: boolean;
}

export class AmbiguousModelIdentifierError extends Error {
  readonly candidates: string[];

  constructor(requested: string, candidates: string[]) {
    super(`Model identifier "${requested}" matched multiple provider models: ${candidates.join(", ")}`);
    this.name = "AmbiguousModelIdentifierError";
    this.candidates = candidates;
  }
}

export interface ActiveModelSelection {
  providerId: ModelProviderId;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  extendedContextEnabled: boolean;
  updatedAt: string;
}

export interface ActiveExtendedContextStatus {
  providerId: ModelProviderId;
  modelId: string;
  supported: boolean;
  enabled: boolean;
  standardContextWindow?: number;
  extendedContextWindow?: number;
  activeContextWindow?: number;
}

export interface ContextWindowUsage {
  conversationKey: string;
  providerId: ModelProviderId;
  modelId: string;
  method: "provider_count" | "heuristic_estimate";
  usedTokens: number;
  maxContextTokens: number;
  remainingTokens: number;
  maxOutputTokens?: number;
  remainingReplyBudgetTokens?: number;
  utilizationPercent: number;
  breakdownMethod: "provider_count" | "heuristic_estimate";
  breakdown: {
    systemPromptTokens: number;
    userMessageTokens: number;
    assistantReplyTokens: number;
    toolCallInputTokens: number;
    toolResponseTokens: number;
    toolDefinitionTokens: number;
    estimatedTotalTokens: number;
  };
}

export interface RecordedUsageInspection {
  conversation: UsageLedgerSummary;
  model: UsageLedgerSummary;
  latestConversationRecord?: UsageLedgerRecord;
  latestModelRecord?: UsageLedgerRecord;
  providerBudgetRemaining: number | null;
  providerBudgetSource: string | null;
}

export interface RecordedUsageDailyInspection {
  localDate: string;
  timezone: string;
  conversation: UsageLedgerSummary;
  profileDay: UsageLedgerSummary;
  modelDay: UsageLedgerSummary;
  latestConversationRecord?: UsageLedgerRecord;
  latestProfileDayRecord?: UsageLedgerRecord;
  latestModelDayRecord?: UsageLedgerRecord;
  providerBudgetRemaining: number | null;
  providerBudgetSource: string | null;
}

export interface ActiveModelBenchmark {
  providerId: ModelProviderId;
  modelId: string;
  prompt: string;
  maxTokens: number;
  ttftMs: number | null;
  totalLatencyMs: number;
  generationLatencyMs: number | null;
  outputTokens: number;
  outputTokenSource: "provider_usage" | "heuristic_estimate";
  tokensPerSecond: number | null;
  stopReason: string;
  contentChars: number;
}

export interface ToolSummarizerSelection {
  providerId: ModelProviderId;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

export interface MemoryModelSelection {
  providerId: ModelProviderId;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

interface ModelServiceOptions {
  usageTracking?: UsageTrackingService;
  cacheMissMonitor?: CacheMissMonitor;
  onCacheMissWarning?: (warning: CacheMissWarning) => void;
  selectionStoreKey?: string;
  defaultSelectionOverride?: Partial<Pick<ActiveModelSelection, "providerId" | "modelId" | "thinkingLevel">>;
}

interface ActiveModelStoreShape {
  version?: number;
  activeModel?: ActiveModelSelection;
  activeModels?: Record<string, ActiveModelSelection>;
}

interface ProviderModelStub {
  modelId: string;
  name: string;
}

function getIsoDurationMs(startedAt: string | undefined, endedAt: string | undefined) {
  if (!startedAt || !endedAt) {
    return null;
  }

  const started = Date.parse(startedAt);
  const ended = Date.parse(endedAt);
  if (Number.isNaN(started) || Number.isNaN(ended)) {
    return null;
  }

  return Math.max(0, ended - started);
}

function findLatestBudgetRecord(records: UsageLedgerRecord[]) {
  return [...records].reverse().find((record) => record.providerBudgetRemaining !== null && record.providerBudgetRemaining !== undefined);
}

interface ResolvedRuntimeModel {
  selection: ActiveModelSelection;
  runtimeModel: Model<Api>;
  apiKey: string;
}

type RuntimeModelStub = Pick<Model<Api>, "id" | "name">;

type ActiveModelInferenceOptions = ({
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  thinkingEnabled?: never;
  thinkingBudgetTokens?: never;
  effort?: never;
} | {
  reasoningEffort?: never;
  thinkingEnabled?: boolean;
  thinkingBudgetTokens?: number;
  effort?: "low" | "medium" | "high" | "max";
});

const EMPTY_USAGE_SUMMARY: UsageLedgerSummary = {
  requestCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  nonCachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputToOutputRatio: null,
  cacheReadPercentOfInput: null,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function getStorePath() {
  return resolveRuntimePath("model-state.json");
}
const DEFAULT_ACTIVE_MODEL: ActiveModelSelection = {
  providerId: "openai-codex",
  modelId: "gpt-5.4",
  thinkingLevel: "low",
  extendedContextEnabled: false,
  updatedAt: new Date(0).toISOString(),
};

const PROVIDER_RUNTIME_MAP: Record<ModelProviderId, "openai-codex" | "anthropic"> = {
  "openai-codex": "openai-codex",
  claude: "anthropic",
};

const PROVIDER_LABELS: Record<ModelProviderId, string> = {
  "openai-codex": "OpenAI Codex",
  claude: "Claude",
};

const DEFAULT_TOOL_SUMMARIZER_MODEL_IDS: Record<ModelProviderId, string> = {
  "openai-codex": "gpt-5.1-codex-mini",
  claude: "claude-haiku-4-5",
};

const STANDARD_CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {
  "openai-codex/gpt-5.4": 272_000,
};

const EXTENDED_CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {
  "openai-codex/gpt-5.4": 1_050_000,
};

function timestamp() {
  return new Date().toISOString();
}

function ensureStoreDir() {
  fs.mkdirSync(path.dirname(getStorePath()), { recursive: true });
}

function readStore(): ActiveModelStoreShape {
  ensureStoreDir();
  const storePath = getStorePath();
  if (!fs.existsSync(storePath)) {
    return { version: 2, activeModels: {} };
  }

  const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as ActiveModelStoreShape;
  if (parsed.activeModels) {
    return {
      version: 2,
      activeModels: parsed.activeModels,
    };
  }

  return {
    version: 2,
    activeModels: parsed.activeModel ? { root: parsed.activeModel } : {},
  };
}

function writeStore(store: ActiveModelStoreShape) {
  ensureStoreDir();
  fs.writeFileSync(getStorePath(), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function getDefaultActiveModel(
  profile: ProfileRecord,
  override?: Partial<Pick<ActiveModelSelection, "providerId" | "modelId" | "thinkingLevel">>,
): ActiveModelSelection {
  return {
    providerId: override?.providerId ?? profile.preferredProvider ?? DEFAULT_ACTIVE_MODEL.providerId,
    modelId: override?.modelId ?? profile.defaultModelId ?? DEFAULT_ACTIVE_MODEL.modelId,
    thinkingLevel: normalizeThinkingLevel(
      override?.thinkingLevel ?? profile.defaultThinkingLevel ?? DEFAULT_ACTIVE_MODEL.thinkingLevel,
    ),
    extendedContextEnabled: false,
    updatedAt: DEFAULT_ACTIVE_MODEL.updatedAt,
  };
}

function getDefaultToolSummarizerSelection(profile: ProfileRecord): ToolSummarizerSelection {
  const providerId = profile.toolSummarizerProvider ??
    profile.preferredProvider ??
    DEFAULT_ACTIVE_MODEL.providerId;
  return {
    providerId,
    modelId: profile.toolSummarizerModelId ?? DEFAULT_TOOL_SUMMARIZER_MODEL_IDS[providerId],
    thinkingLevel: "minimal",
  };
}

function getDefaultMemorySelection(profile: ProfileRecord): MemoryModelSelection {
  const providerId = profile.memoryProvider ??
    profile.toolSummarizerProvider ??
    profile.preferredProvider ??
    DEFAULT_ACTIVE_MODEL.providerId;
  return {
    providerId,
    modelId: profile.memoryModelId ??
      profile.toolSummarizerModelId ??
      DEFAULT_TOOL_SUMMARIZER_MODEL_IDS[providerId],
    thinkingLevel: "minimal",
  };
}

function getStoredActiveModel(
  store: ActiveModelStoreShape,
  profile: ProfileRecord,
  selectionStoreKey: string,
  override?: Partial<Pick<ActiveModelSelection, "providerId" | "modelId" | "thinkingLevel">>,
) {
  const activeModel = store.activeModels?.[selectionStoreKey];
  if (activeModel) {
    return activeModel;
  }
  return getDefaultActiveModel(profile, override);
}

function writeStoredActiveModel(selectionStoreKey: string, selection: ActiveModelSelection) {
  const store = readStore();
  store.version = 2;
  store.activeModels ??= {};
  store.activeModels[selectionStoreKey] = selection;
  writeStore(store);
}

function normalizeThinkingLevel(value: unknown): ThinkingLevel {
  switch (value) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value;
    default:
      return DEFAULT_ACTIVE_MODEL.thinkingLevel;
  }
}

function normalizeExtendedContextEnabled(value: unknown) {
  return value === true;
}

function providerModelKey(providerId: ModelProviderId, modelId: string) {
  return `${providerId}/${modelId}`;
}

function getStandardContextWindowOverride(providerId: ModelProviderId, modelId: string) {
  return STANDARD_CONTEXT_WINDOW_OVERRIDES[providerModelKey(providerId, modelId)];
}

function getExtendedContextWindowOverride(providerId: ModelProviderId, modelId: string) {
  return EXTENDED_CONTEXT_WINDOW_OVERRIDES[providerModelKey(providerId, modelId)];
}

function supportsExtendedContext(providerId: ModelProviderId, modelId: string) {
  return Boolean(
    getStandardContextWindowOverride(providerId, modelId) ||
      getExtendedContextWindowOverride(providerId, modelId),
  );
}

function getSelectedContextWindow(
  profile: Pick<ProfileRecord, "maxContextTokens">,
  selection: Pick<ActiveModelSelection, "providerId" | "modelId" | "extendedContextEnabled">,
  runtimeContextWindow?: number,
) {
  const standard = getStandardContextWindowOverride(selection.providerId, selection.modelId);
  const extended = getExtendedContextWindowOverride(selection.providerId, selection.modelId);
  const uncapped = (() => {
    if (!standard && !extended) {
      return runtimeContextWindow;
    }

    if (selection.extendedContextEnabled) {
      return extended ?? runtimeContextWindow ?? standard;
    }

    return standard ?? runtimeContextWindow ?? extended;
  })();

  return profile.maxContextTokens
    ? Math.min(profile.maxContextTokens, uncapped ?? profile.maxContextTokens)
    : uncapped;
}

function getListedContextWindow(
  profile: Pick<ProfileRecord, "maxContextTokens">,
  providerId: ModelProviderId,
  modelId: string,
  activeSelection: ActiveModelSelection,
  runtimeContextWindow?: number,
) {
  if (activeSelection.providerId === providerId && activeSelection.modelId === modelId) {
    return getSelectedContextWindow(profile, activeSelection, runtimeContextWindow);
  }

  const uncapped = (
    getExtendedContextWindowOverride(providerId, modelId) ??
    getStandardContextWindowOverride(providerId, modelId) ??
    runtimeContextWindow
  );
  return profile.maxContextTokens
    ? Math.min(profile.maxContextTokens, uncapped ?? profile.maxContextTokens)
    : uncapped;
}

function extractAccountId(token: string) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid token");
    }

    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as {
      https?: {
        // ChatGPT account ids are embedded under a namespaced claim.
        // The claim path is stable across the OAuth token flow used by pi-ai.
        api?: {
          openai?: {
            com?: {
              auth?: {
                chatgpt_account_id?: string;
              };
            };
          };
        };
      };
    };
    const accountId = payload.https?.api?.openai?.com?.auth?.chatgpt_account_id;
    if (!accountId) {
      throw new Error("Missing account id");
    }
    return accountId;
  } catch {
    throw new Error("Failed to extract the ChatGPT account id from the Codex token.");
  }
}

function toolSchemaToJson(tool: StructuredToolInterface) {
  if ("safeParse" in tool.schema) {
    return z.toJSONSchema(tool.schema as unknown as Parameters<typeof z.toJSONSchema>[0]);
  }
  return tool.schema;
}

function buildAnthropicAuthHeaders(apiKey: string) {
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  });

  if (apiKey.startsWith("sk-ant-oat")) {
    headers.set("authorization", `Bearer ${apiKey}`);
    headers.set("anthropic-beta", "claude-code-20250219,oauth-2025-04-20");
    headers.set("x-app", "cli");
    headers.set("user-agent", "openelinaro/1.0");
  } else {
    headers.set("x-api-key", apiKey);
  }

  return headers;
}

function buildCodexHeaders(token: string) {
  const headers = new Headers({
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "chatgpt-account-id": extractAccountId(token),
    "OpenAI-Beta": "responses=experimental",
    originator: "openelinaro",
    "User-Agent": `openelinaro (${os.platform()} ${os.release()}; ${os.arch()})`,
  });
  return headers;
}

function extractCandidateString(
  value: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim()) {
      return raw.trim();
    }
  }
  return undefined;
}

function normalizeCodexDiscoveredModels(payload: unknown): ProviderModelStub[] {
  const results = new Map<string, ProviderModelStub>();
  const queue: unknown[] = [payload];

  while (queue.length > 0) {
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (!current || typeof current !== "object") {
      continue;
    }

    const record = current as Record<string, unknown>;
    const modelId = extractCandidateString(record, ["slug", "id", "model_slug", "modelId"]);
    const name = extractCandidateString(record, ["display_name", "displayName", "title", "name"]);
    if (modelId && /^(gpt|o\d)/i.test(modelId)) {
      results.set(modelId, {
        modelId,
        name: name ?? modelId,
      });
    }

    for (const child of Object.values(record)) {
      queue.push(child);
    }
  }

  return [...results.values()].sort((left, right) => left.modelId.localeCompare(right.modelId));
}

function normalizeAnthropicDiscoveredModels(payload: unknown): ProviderModelStub[] {
  const response = payload as {
    data?: Array<{
      id?: string;
      display_name?: string;
      name?: string;
    }>;
  };
  return (response.data ?? [])
    .map((model) => ({
      modelId: model.id?.trim() ?? "",
      name: model.display_name?.trim() || model.name?.trim() || model.id?.trim() || "",
    }))
    .filter((model) => model.modelId.length > 0)
    .sort((left, right) => left.modelId.localeCompare(right.modelId));
}

function normalizeModelLookupValue(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z0-9-]+[/:]/, "")
    .replace(/^claude-/, "")
    .replace(/^gpt-/, "gpt ")
    .replace(/\b(model|anthropic|openai|codex)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

function stripTrailingDateSuffix(value: string) {
  return value.replace(/[-_]\d{8}$/g, "");
}

function buildModelIdLookupKeys(modelId: string) {
  return Array.from(new Set([
    modelId,
    stripTrailingDateSuffix(modelId),
    modelId.replace(/^claude-/, ""),
    stripTrailingDateSuffix(modelId.replace(/^claude-/, "")),
  ]
    .map((value) => normalizeModelLookupValue(value))
    .filter(Boolean)));
}

function buildModelLookupKeys(model: Pick<ListedProviderModel, "modelId" | "name">) {
  return Array.from(new Set([
    ...buildModelIdLookupKeys(model.modelId),
    model.name,
    model.name.replace(/^Claude\s+/i, ""),
  ]
    .map((value) => normalizeModelLookupValue(value))
    .filter(Boolean)));
}

export function resolveRuntimeModelIdentifier<T extends RuntimeModelStub>(
  requestedModelId: string,
  runtimeModels: T[],
): T | undefined {
  const exactMatch = runtimeModels.find((model) => model.id === requestedModelId);
  if (exactMatch) {
    return exactMatch;
  }

  const strippedRequested = stripTrailingDateSuffix(requestedModelId);
  if (strippedRequested !== requestedModelId) {
    const strippedMatch = runtimeModels.find((model) => model.id === strippedRequested);
    if (strippedMatch) {
      return strippedMatch;
    }
  }

  const requestedKeys = new Set(buildModelIdLookupKeys(requestedModelId));
  const matches = runtimeModels.filter((model) =>
    buildModelIdLookupKeys(model.id).some((key) => requestedKeys.has(key)));
  if (matches.length === 1) {
    return matches[0];
  }

  return undefined;
}

export function resolveListedModelIdentifier(
  requested: string,
  models: ListedProviderModel[],
): ListedProviderModel {
  const normalizedRequested = normalizeModelLookupValue(requested);
  if (!normalizedRequested) {
    throw new Error("A non-empty model identifier is required.");
  }

  const exactMatches = models.filter((model) => buildModelLookupKeys(model).includes(normalizedRequested));
  const exactSupported = exactMatches.filter((model) => model.supported);
  if (exactSupported.length === 1) {
    return exactSupported[0]!;
  }
  if (exactSupported.length > 1) {
    throw new AmbiguousModelIdentifierError(requested, exactSupported.map((model) => model.modelId));
  }
  if (exactMatches.length === 1) {
    return exactMatches[0]!;
  }
  if (exactMatches.length > 1) {
    throw new AmbiguousModelIdentifierError(requested, exactMatches.map((model) => model.modelId));
  }

  const partialMatches = models.filter((model) =>
    buildModelLookupKeys(model).some((key) =>
      key.includes(normalizedRequested) || normalizedRequested.includes(key),
    ));
  const partialSupported = partialMatches.filter((model) => model.supported);
  if (partialSupported.length === 1) {
    return partialSupported[0]!;
  }
  if (partialSupported.length > 1) {
    throw new AmbiguousModelIdentifierError(requested, partialSupported.map((model) => model.modelId));
  }
  if (partialMatches.length === 1) {
    return partialMatches[0]!;
  }
  if (partialMatches.length > 1) {
    throw new AmbiguousModelIdentifierError(requested, partialMatches.map((model) => model.modelId));
  }

  throw new Error(`Model not found in the live catalog: ${requested}`);
}

function approximateTextTokens(text: string) {
  return Math.ceil(text.length / 4);
}

function hrtimeMs(startedAt: bigint, endedAt: bigint) {
  return Number(endedAt - startedAt) / 1_000_000;
}

function approximateConversationTokens(params: {
  systemPrompt: string;
  messages: BaseMessage[];
  tools: StructuredToolInterface[];
}) {
  const breakdown = approximateConversationTokenBreakdown(params);
  const latestAssistant = [...params.messages]
    .reverse()
    .find((message): message is AIMessage => message instanceof AIMessage);
  const usageMetadata = latestAssistant?.usage_metadata;
  const usageEstimate =
    usageMetadata?.input_tokens && usageMetadata?.output_tokens
      ? usageMetadata.input_tokens + usageMetadata.output_tokens
      : 0;

  return Math.max(breakdown.estimatedTotalTokens, usageEstimate);
}

function approximateConversationTokenBreakdown(params: {
  systemPrompt: string;
  messages: BaseMessage[];
  tools: StructuredToolInterface[];
}) {
  const breakdown = {
    systemPromptTokens: approximateTextTokens(params.systemPrompt),
    userMessageTokens: 0,
    assistantReplyTokens: 0,
    toolCallInputTokens: 0,
    toolResponseTokens: 0,
    toolDefinitionTokens: params.tools.reduce((sum, tool) => {
      const schema = toolSchemaToJson(tool);
      return sum + approximateTextTokens(JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: schema,
      }));
    }, 0),
    estimatedTotalTokens: 0,
  };

  for (const message of params.messages) {
    if (message instanceof ToolMessage) {
      breakdown.toolResponseTokens += approximateTextTokens(extractTextFromMessage(message)) + 24;
      continue;
    }

    if (message instanceof AIMessage) {
      breakdown.assistantReplyTokens += approximateTextTokens(extractTextFromMessage(message));
      breakdown.toolCallInputTokens += (message.tool_calls ?? []).reduce((toolSum, toolCall) =>
        toolSum + approximateTextTokens(JSON.stringify({
          id: toolCall.id,
          name: toolCall.name,
          args: toolCall.args ?? {},
        })) + 24, 0);
      continue;
    }

    if (message instanceof HumanMessage || message instanceof SystemMessage) {
      breakdown.userMessageTokens += approximateContentTokens(message.content) + 12;
    }
  }

  breakdown.estimatedTotalTokens =
    breakdown.systemPromptTokens +
    breakdown.userMessageTokens +
    breakdown.assistantReplyTokens +
    breakdown.toolCallInputTokens +
    breakdown.toolResponseTokens +
    breakdown.toolDefinitionTokens;

  return breakdown;
}

type AnthropicRequestMessage = {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
};

function toAnthropicUserContent(content: unknown): string | Array<Record<string, unknown>> {
  const blocks = normalizeChatPromptContent(content);
  if (blocks.length === 0) {
    return typeof content === "string" ? content : "";
  }

  if (blocks.length === 1 && blocks[0]?.type === "text") {
    return blocks[0].text;
  }

  return blocks.map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : {
          type: "image",
          source: {
            type: "base64",
            media_type: block.mimeType,
            data: block.data,
          },
        }
  );
}

function toAnthropicMessages(messages: BaseMessage[]) {
  const normalized: AnthropicRequestMessage[] = [];
  for (const message of messages) {
    if (message instanceof SystemMessage) {
      continue;
    }

    if (message instanceof HumanMessage) {
      normalized.push({ role: "user", content: toAnthropicUserContent(message.content) });
      continue;
    }

    if (message instanceof ToolMessage) {
      normalized.push(
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: message.tool_call_id,
              content: extractTextFromMessage(message),
              is_error: message.status === "error",
            },
          ],
        },
      );
      continue;
    }

    if (message instanceof AIMessage) {
      const textContent = extractTextFromMessage(message);
      const content = [
        ...(textContent
          ? [{ type: "text", text: textContent }]
          : []),
        ...((message.tool_calls ?? []).map((toolCall) => ({
          type: "tool_use",
          id: toolCall.id ?? `tool_${Date.now()}`,
          name: toolCall.name,
          input: toolCall.args ?? {},
        }))),
      ];
      normalized.push({ role: "assistant", content });
      continue;
    }

    normalized.push({ role: "user", content: toAnthropicUserContent(message.content) });
  }
  return normalized;
}

function getRuntimeCatalog(providerId: ModelProviderId) {
  return new Map(
    getModels(PROVIDER_RUNTIME_MAP[providerId]).map((model) => [model.id, model]),
  );
}

async function resolveCodexApiKey(profileId: string): Promise<OAuthCredentials & { apiKey: string }> {
  const credentials = getCodexCredentials(profileId);
  if (!credentials) {
    throw new Error("Codex auth is not configured yet. Use `/auth provider:codex` first.");
  }

  const result = await getOAuthApiKey("openai-codex", {
    "openai-codex": credentials,
  });
  if (!result) {
    throw new Error("Codex auth could not be resolved.");
  }

  saveCodexCredentials(result.newCredentials, profileId);
  return {
    ...result.newCredentials,
    apiKey: result.apiKey,
  };
}

function resolveClaudeToken(profileId: string) {
  const token = getClaudeSetupToken(profileId);
  if (!token) {
    throw new Error("Claude auth is not configured yet. Use `/auth provider:claude` first.");
  }
  return token;
}

export class ModelService {
  private readonly usageTracking: UsageTrackingService;
  private readonly cacheMissMonitor: CacheMissMonitor;
  private readonly onCacheMissWarning?: (warning: CacheMissWarning) => void;
  private readonly selectionStoreKey: string;
  private readonly defaultSelectionOverride?: Partial<Pick<ActiveModelSelection, "providerId" | "modelId" | "thinkingLevel">>;

  constructor(
    private readonly profile: ProfileRecord,
    options?: ModelServiceOptions,
  ) {
    this.usageTracking = options?.usageTracking ?? new UsageTrackingService();
    this.cacheMissMonitor = options?.cacheMissMonitor ?? new CacheMissMonitor();
    this.onCacheMissWarning = options?.onCacheMissWarning;
    this.selectionStoreKey = options?.selectionStoreKey?.trim() || profile.id;
    this.defaultSelectionOverride = options?.defaultSelectionOverride;
  }

  getSupportedProviders(): ModelProviderId[] {
    return ["openai-codex", "claude"];
  }

  getProviderLabel(providerId: ModelProviderId) {
    return PROVIDER_LABELS[providerId];
  }

  getToolSummarizerSelection(): ToolSummarizerSelection {
    return getDefaultToolSummarizerSelection(this.profile);
  }

  getMemorySelection(): MemoryModelSelection {
    return getDefaultMemorySelection(this.profile);
  }

  getActiveModel(): ActiveModelSelection {
    const store = readStore();
    const activeModel = getStoredActiveModel(
      store,
      this.profile,
      this.selectionStoreKey,
      this.defaultSelectionOverride,
    );
    return {
      providerId: activeModel.providerId,
      modelId: activeModel.modelId,
      thinkingLevel: normalizeThinkingLevel(activeModel.thinkingLevel),
      extendedContextEnabled: normalizeExtendedContextEnabled(activeModel.extendedContextEnabled),
      updatedAt: activeModel.updatedAt,
    };
  }

  getActiveExtendedContextStatus(): ActiveExtendedContextStatus {
    const active = this.getActiveModel();
    const standardContextWindow = getStandardContextWindowOverride(active.providerId, active.modelId);
    const extendedContextWindow = getExtendedContextWindowOverride(active.providerId, active.modelId);
    const supported = supportsExtendedContext(active.providerId, active.modelId);

    return {
      providerId: active.providerId,
      modelId: active.modelId,
      supported,
      enabled: supported ? active.extendedContextEnabled : false,
      standardContextWindow,
      extendedContextWindow,
      activeContextWindow: getSelectedContextWindow(this.profile, active, extendedContextWindow),
    };
  }

  async listProviderModels(providerId: ModelProviderId): Promise<ListedProviderModel[]> {
    const runtimeCatalog = getRuntimeCatalog(providerId);
    const active = this.getActiveModel();
    const discovered = providerId === "claude"
      ? await this.fetchAnthropicModels()
      : await this.fetchCodexModels();

    return discovered.map((entry) => {
      const runtimeModel = runtimeCatalog.get(entry.modelId) ??
        resolveRuntimeModelIdentifier(entry.modelId, [...runtimeCatalog.values()]);
      return {
        providerId,
        modelId: entry.modelId,
        name: entry.name,
        contextWindow: getListedContextWindow(
          this.profile,
          providerId,
          entry.modelId,
          active,
          runtimeModel?.contextWindow,
        ),
        maxOutputTokens: runtimeModel?.maxTokens,
        reasoning: runtimeModel?.reasoning,
        supported: Boolean(runtimeModel),
        active: active.providerId === providerId &&
          Boolean(resolveRuntimeModelIdentifier(active.modelId, [{
            id: entry.modelId,
            name: entry.name,
          }])),
      };
    });
  }

  async resolveProviderModel(providerId: ModelProviderId, requestedModelId: string) {
    const models = await this.listProviderModels(providerId);
    return resolveListedModelIdentifier(requestedModelId, models);
  }

  async selectActiveModel(providerId: ModelProviderId, modelId: string) {
    const selected = await this.resolveProviderModel(providerId, modelId);
    if (!selected.supported) {
      throw new Error(
        `Model ${providerId}/${selected.modelId} is listed by the provider but is not supported by the current runtime.`,
      );
    }

    const nextSelection: ActiveModelSelection = {
      providerId,
      modelId: selected.modelId,
      thinkingLevel: this.getActiveModel().thinkingLevel,
      extendedContextEnabled:
        supportsExtendedContext(providerId, selected.modelId) &&
        this.getActiveModel().extendedContextEnabled,
      updatedAt: timestamp(),
    };
    writeStoredActiveModel(this.selectionStoreKey, nextSelection);
    return {
      ...selected,
      active: true,
    };
  }

  setThinkingLevel(thinkingLevel: ThinkingLevel) {
    const nextSelection: ActiveModelSelection = {
      ...this.getActiveModel(),
      thinkingLevel,
      updatedAt: timestamp(),
    };
    writeStoredActiveModel(this.selectionStoreKey, nextSelection);
    return nextSelection;
  }

  setStoredSelectionDefaults(selection: Partial<Pick<
    ActiveModelSelection,
    "providerId" | "modelId" | "thinkingLevel" | "extendedContextEnabled"
  >>) {
    const nextSelection: ActiveModelSelection = {
      ...this.getActiveModel(),
      ...selection,
      thinkingLevel: normalizeThinkingLevel(selection.thinkingLevel ?? this.getActiveModel().thinkingLevel),
      extendedContextEnabled: selection.extendedContextEnabled ?? this.getActiveModel().extendedContextEnabled,
      updatedAt: timestamp(),
    };
    writeStoredActiveModel(this.selectionStoreKey, nextSelection);
    return nextSelection;
  }

  setExtendedContextEnabled(enabled: boolean) {
    const active = this.getActiveModel();
    if (enabled && !supportsExtendedContext(active.providerId, active.modelId)) {
      throw new Error(
        `Extended context is not available for ${active.providerId}/${active.modelId}.`,
      );
    }

    const nextSelection: ActiveModelSelection = {
      ...active,
      extendedContextEnabled: enabled && supportsExtendedContext(active.providerId, active.modelId),
      updatedAt: timestamp(),
    };
    writeStoredActiveModel(this.selectionStoreKey, nextSelection);
    return nextSelection;
  }

  getInferenceOptions(selection: ActiveModelSelection): ActiveModelInferenceOptions {
    if (selection.providerId === "claude") {
      if (selection.thinkingLevel === "minimal") {
        return {
          thinkingEnabled: false,
        };
      }

      return {
        thinkingEnabled: true,
        effort: selection.thinkingLevel === "xhigh" ? "max" : selection.thinkingLevel,
      };
    }

    return {
      reasoningEffort: selection.thinkingLevel,
    };
  }

  async summarizeToolResult(params: {
    toolName: string;
    goal: string;
    output: string;
  }) {
    const selection = this.getToolSummarizerSelection();
    return traceSpan(
      "model.summarize_tool_result",
      async () => {
        const runtimeSelection: ActiveModelSelection = {
          ...selection,
          extendedContextEnabled: false,
          updatedAt: timestamp(),
        };
        const resolved = await this.resolveRuntimeModelForSelection(runtimeSelection);
        const context: Context = {
          systemPrompt: [
            "You compress raw tool output for another agent.",
            "Answer only the requested summary goal using the provided tool output.",
            "If the output does not contain enough evidence, return exactly: insufficient evidence",
            "Return plain text only.",
            "Be brief.",
          ].join(" "),
          messages: [
            {
              role: "user",
              content: [
                `Tool: ${params.toolName}`,
                `Goal: ${params.goal.trim()}`,
                "",
                "Tool output:",
                params.output,
              ].join("\n"),
              timestamp: Date.now(),
            } satisfies Message,
          ],
        };
        const sessionId = `tool-summarizer:${this.profile.id}:${Date.now()}`;
        const responseStream = stream(resolved.runtimeModel, context, {
          apiKey: resolved.apiKey,
          sessionId,
          ...this.getInferenceOptions(resolved.selection),
        });
        const response = assertSuccessfulProviderResponse(await responseStream.result(), {
          connector: "tool-summarizer",
          sessionId,
          usagePurpose: "tool_result_summarization",
        });
        this.recordUsage({
          providerId: resolved.selection.providerId,
          modelId: response.model ?? resolved.selection.modelId,
          sessionId,
          purpose: "tool_result_summarization",
          usage: response.usage,
          providerReportedUsage: response.usage,
        });
        const text = response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("")
          .trim();
        return text || "insufficient evidence";
      },
      {
        attributes: {
          profileId: this.profile.id,
          providerId: selection.providerId,
          modelId: selection.modelId,
          toolName: params.toolName,
          goalLength: params.goal.length,
          outputLength: params.output.length,
        },
      },
    );
  }

  async generateMemoryText(params: {
    systemPrompt: string;
    userPrompt: string;
    usagePurpose: string;
    sessionIdPrefix?: string;
  }) {
    const selection = this.getMemorySelection();
    return traceSpan(
      "model.generate_memory_text",
      async () => {
        const runtimeSelection: ActiveModelSelection = {
          ...selection,
          extendedContextEnabled: false,
          updatedAt: timestamp(),
        };
        const resolved = await this.resolveRuntimeModelForSelection(runtimeSelection);
        const context: Context = {
          systemPrompt: params.systemPrompt,
          messages: [{
            role: "user",
            content: params.userPrompt,
            timestamp: Date.now(),
          } satisfies Message],
        };
        const sessionId = `${params.sessionIdPrefix?.trim() || "memory"}:${this.profile.id}:${Date.now()}`;
        const responseStream = stream(resolved.runtimeModel, context, {
          apiKey: resolved.apiKey,
          sessionId,
          ...this.getInferenceOptions(resolved.selection),
        });
        const response = assertSuccessfulProviderResponse(await responseStream.result(), {
          connector: "memory-model",
          sessionId,
          usagePurpose: params.usagePurpose,
        });
        this.recordUsage({
          providerId: resolved.selection.providerId,
          modelId: response.model ?? resolved.selection.modelId,
          sessionId,
          purpose: params.usagePurpose,
          usage: response.usage,
          providerReportedUsage: response.usage,
        });
        return response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("")
          .trim();
      },
      {
        attributes: {
          profileId: this.profile.id,
          providerId: selection.providerId,
          modelId: selection.modelId,
          usagePurpose: params.usagePurpose,
          userPromptLength: params.userPrompt.length,
        },
      },
    );
  }

  async resolveActiveRuntimeModel(): Promise<ResolvedRuntimeModel> {
    const selection = this.getActiveModel();
    return this.resolveRuntimeModelForSelection(selection);
  }

  private async resolveRuntimeModelForSelection(
    selection: ActiveModelSelection,
  ): Promise<ResolvedRuntimeModel> {
    const runtimeProvider = PROVIDER_RUNTIME_MAP[selection.providerId];
    const runtimeModels = getModels(runtimeProvider);
    const runtimeModel = resolveRuntimeModelIdentifier(selection.modelId, runtimeModels);
    if (!runtimeModel) {
      throw new Error(
        `The active model ${selection.providerId}/${selection.modelId} is not supported by the runtime.`,
      );
    }

    return {
      selection,
      runtimeModel: {
        ...runtimeModel,
        contextWindow: getSelectedContextWindow(this.profile, selection, runtimeModel.contextWindow) ??
          runtimeModel.contextWindow,
      },
      apiKey: await this.resolveApiKeyForProvider(selection.providerId),
    };
  }

  private async resolveApiKeyForProvider(providerId: ModelProviderId) {
    if (providerId === "claude") {
      return resolveClaudeToken(this.profile.id);
    }

    const { apiKey } = await resolveCodexApiKey(this.profile.id);
    return apiKey;
  }

  async inspectContextWindowUsage(params: {
    conversationKey: string;
    systemPrompt: string;
    messages: BaseMessage[];
    tools: StructuredToolInterface[];
  }): Promise<ContextWindowUsage> {
    const resolved = await this.resolveActiveRuntimeModel();
    const maxContextTokens = getSelectedContextWindow(
      this.profile,
      resolved.selection,
      resolved.runtimeModel.contextWindow,
    );
    if (!maxContextTokens) {
      throw new Error(`No context window metadata is available for ${resolved.selection.modelId}.`);
    }

    const method = resolved.selection.providerId === "claude" ? "provider_count" : "heuristic_estimate";
    const breakdown = approximateConversationTokenBreakdown(params);
    const usedTokens = resolved.selection.providerId === "claude"
      ? await this.countAnthropicTokens({
          modelId: resolved.runtimeModel.id,
          apiKey: resolved.apiKey,
          systemPrompt: params.systemPrompt,
          messages: params.messages,
          tools: params.tools,
        })
      : approximateConversationTokens(params);
    const remainingTokens = Math.max(0, maxContextTokens - usedTokens);
    const maxOutputTokens = resolved.runtimeModel.maxTokens;
    const utilizationPercent = Number(((usedTokens / maxContextTokens) * 100).toFixed(2));

    return {
      conversationKey: params.conversationKey,
      providerId: resolved.selection.providerId,
      modelId: resolved.selection.modelId,
      method,
      usedTokens,
      maxContextTokens,
      remainingTokens,
      maxOutputTokens,
      remainingReplyBudgetTokens: maxOutputTokens
        ? Math.max(0, Math.min(maxOutputTokens, remainingTokens))
        : undefined,
      utilizationPercent,
      breakdownMethod: "heuristic_estimate",
      breakdown,
    };
  }

  recordUsage(params: {
    providerId: ModelProviderId;
    modelId: string;
    sessionId: string;
    conversationKey?: string;
    purpose?: string;
    usage: Usage;
    providerReportedUsage?: Usage;
    providerBudgetRemaining?: number | null;
    providerBudgetSource?: string;
    promptDiagnostics?: UsagePromptDiagnostics;
  }) {
    const previousChatTurns = params.conversationKey
      ? this.usageTracking
        .list({
          profileId: this.profile.id,
          conversationKey: params.conversationKey,
        })
        .filter((record) => record.purpose === "chat_turn")
      : [];
    const previousChatTurnCount = previousChatTurns.length;
    const previousChatTurn = previousChatTurns.at(-1);
    const inputTokens = params.usage.input + params.usage.cacheRead + params.usage.cacheWrite;
    const totalTokens = params.usage.totalTokens > 0
      ? params.usage.totalTokens
      : inputTokens + params.usage.output;
    const promptDiagnostics = params.promptDiagnostics
      ? {
          ...params.promptDiagnostics,
          providerInputTokens: inputTokens,
          approximationDeltaTokens:
            inputTokens - params.promptDiagnostics.approximateBreakdown.estimatedTotalTokens,
        } satisfies UsagePromptDiagnostics
      : undefined;

    const record = this.usageTracking.record({
      profileId: this.profile.id,
      providerId: params.providerId,
      modelId: params.modelId,
      sessionId: params.sessionId,
      conversationKey: params.conversationKey,
      purpose: params.purpose,
      nonCachedInputTokens: params.usage.input,
      cacheReadTokens: params.usage.cacheRead,
      cacheWriteTokens: params.usage.cacheWrite,
      inputTokens,
      outputTokens: params.usage.output,
      totalTokens,
      providerBudgetRemaining: params.providerBudgetRemaining ?? null,
      providerBudgetSource: params.providerBudgetSource,
      promptDiagnostics,
      cost: params.providerReportedUsage?.cost ?? params.usage.cost,
    });
    const cacheMissWarning = this.cacheMissMonitor.inspect(record, { previousChatTurnCount });
    const previousChatTurnGapMs = getIsoDurationMs(previousChatTurn?.createdAt, record.createdAt);

    if (cacheMissWarning) {
      modelTelemetry.event(
        "model.cache.large_miss",
        {
          sessionId: params.sessionId,
          providerId: cacheMissWarning.providerId,
          modelId: cacheMissWarning.modelId,
          conversationKey: cacheMissWarning.conversationKey,
          purpose: cacheMissWarning.purpose,
          inputTokens: cacheMissWarning.inputTokens,
          cacheReadTokens: cacheMissWarning.cacheReadTokens,
          cacheWriteTokens: cacheMissWarning.cacheWriteTokens,
          cacheMissTokens: cacheMissWarning.cacheMissTokens,
          cacheReadRatio: Number(cacheMissWarning.cacheReadRatio.toFixed(4)),
          previousChatTurnCount: cacheMissWarning.previousChatTurnCount,
          previousChatTurnCreatedAt: previousChatTurn?.createdAt,
          previousChatTurnGapMs,
          providerReportedUsage: params.providerReportedUsage
            ? {
                input: params.providerReportedUsage.input,
                output: params.providerReportedUsage.output,
                cacheRead: params.providerReportedUsage.cacheRead,
                cacheWrite: params.providerReportedUsage.cacheWrite,
                totalTokens: params.providerReportedUsage.totalTokens,
              }
            : undefined,
        },
        { level: "warn" },
      );

      if (this.cacheMissMonitor.shouldNotify(cacheMissWarning)) {
        this.onCacheMissWarning?.(cacheMissWarning);
      }
    }

    return {
      record,
      warnings: cacheMissWarning ? [cacheMissWarning.message] : [],
    };
  }

  inspectRecordedUsage(params: {
    conversationKey?: string;
    providerId: ModelProviderId;
    modelId: string;
  }): RecordedUsageInspection {
    const conversationFilters = params.conversationKey
      ? {
          profileId: this.profile.id,
          conversationKey: params.conversationKey,
        }
      : undefined;
    const conversation = params.conversationKey
      ? this.usageTracking.summarize(conversationFilters)
      : EMPTY_USAGE_SUMMARY;
    const latestConversationRecord = params.conversationKey
      ? this.usageTracking.latest(conversationFilters)
      : undefined;
    const modelFilters = {
      profileId: this.profile.id,
      providerId: params.providerId,
      modelId: params.modelId,
    };
    const latestModelRecord = this.usageTracking.latest(modelFilters);
    const latestBudgetRecord = findLatestBudgetRecord(this.usageTracking.list(modelFilters));

    return {
      conversation,
      model: this.usageTracking.summarize(modelFilters),
      latestConversationRecord,
      latestModelRecord,
      providerBudgetRemaining: latestBudgetRecord?.providerBudgetRemaining ?? null,
      providerBudgetSource: latestBudgetRecord?.providerBudgetSource ?? null,
    };
  }

  inspectRecordedUsageByLocalDate(params: {
    conversationKey?: string;
    providerId: ModelProviderId;
    modelId: string;
    localDate: string;
    timezone: string;
  }): RecordedUsageDailyInspection {
    const conversationFilters = params.conversationKey
      ? {
          profileId: this.profile.id,
          conversationKey: params.conversationKey,
        }
      : undefined;
    const profileDayFilters = { profileId: this.profile.id };
    const modelDayFilters = {
      profileId: this.profile.id,
      providerId: params.providerId,
      modelId: params.modelId,
    };
    const listParams = {
      localDate: params.localDate,
      timezone: params.timezone,
    };
    const latestModelDayRecord = this.usageTracking.latestByLocalDate({
      ...listParams,
      filters: modelDayFilters,
    });
    const latestBudgetRecord = findLatestBudgetRecord(this.usageTracking.list(modelDayFilters));

    return {
      localDate: params.localDate,
      timezone: params.timezone,
      conversation: params.conversationKey
        ? this.usageTracking.summarizeByLocalDate({
            ...listParams,
            filters: conversationFilters,
          })
        : EMPTY_USAGE_SUMMARY,
      profileDay: this.usageTracking.summarizeByLocalDate({
        ...listParams,
        filters: profileDayFilters,
      }),
      modelDay: this.usageTracking.summarizeByLocalDate({
        ...listParams,
        filters: modelDayFilters,
      }),
      latestConversationRecord: params.conversationKey
        ? this.usageTracking.latestByLocalDate({
            ...listParams,
            filters: conversationFilters,
          })
        : undefined,
      latestProfileDayRecord: this.usageTracking.latestByLocalDate({
        ...listParams,
        filters: profileDayFilters,
      }),
      latestModelDayRecord,
      providerBudgetRemaining: latestBudgetRecord?.providerBudgetRemaining ?? null,
      providerBudgetSource: latestBudgetRecord?.providerBudgetSource ?? null,
    };
  }

  async benchmarkActiveModel(params?: {
    prompt?: string;
    maxTokens?: number;
  }): Promise<ActiveModelBenchmark> {
    const prompt = params?.prompt?.trim() || [
      "Output the numbers 1 through 200 separated by single spaces.",
      "Do not add any prose, labels, or punctuation other than spaces.",
    ].join(" ");
    const maxTokens = Math.min(Math.max(params?.maxTokens ?? 384, 32), 1_024);

    return traceSpan(
      "model.benchmark",
      async () => {
        const resolved = await this.resolveActiveRuntimeModel();
        const context: Context = {
          systemPrompt:
            "You are running a throughput benchmark. Follow the user instruction exactly and return only the requested output.",
          messages: [
            {
              role: "user",
              content: prompt,
              timestamp: Date.now(),
            } satisfies Message,
          ],
        };

        const startedAt = process.hrtime.bigint();
        let firstOutputAt: bigint | null = null;
        const responseStream = stream(resolved.runtimeModel, context, {
          apiKey: resolved.apiKey,
          maxTokens,
          ...this.getInferenceOptions(resolved.selection),
        });

        for await (const event of responseStream) {
          if (
            event.type === "text_delta" ||
            event.type === "thinking_delta" ||
            event.type === "toolcall_delta" ||
            event.type === "text_end" ||
            event.type === "thinking_end" ||
            event.type === "toolcall_end"
          ) {
            firstOutputAt ??= process.hrtime.bigint();
          }
        }

        const completed = await responseStream.result();
        const endedAt = process.hrtime.bigint();
        const generatedText = completed.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        const outputTokens = completed.usage.output > 0
          ? completed.usage.output
          : approximateTextTokens(generatedText);
        const outputTokenSource = completed.usage.output > 0
          ? "provider_usage"
          : "heuristic_estimate";
        const totalLatencyMs = hrtimeMs(startedAt, endedAt);
        const ttftMs = firstOutputAt ? hrtimeMs(startedAt, firstOutputAt) : null;
        const generationLatencyMs = firstOutputAt ? hrtimeMs(firstOutputAt, endedAt) : null;
        const tokensPerSecond =
          generationLatencyMs && generationLatencyMs > 0
            ? Number((outputTokens / (generationLatencyMs / 1_000)).toFixed(2))
            : null;

        return {
          providerId: resolved.selection.providerId,
          modelId: resolved.selection.modelId,
          prompt,
          maxTokens,
          ttftMs: ttftMs === null ? null : Number(ttftMs.toFixed(2)),
          totalLatencyMs: Number(totalLatencyMs.toFixed(2)),
          generationLatencyMs:
            generationLatencyMs === null ? null : Number(generationLatencyMs.toFixed(2)),
          outputTokens,
          outputTokenSource,
          tokensPerSecond,
          stopReason: completed.stopReason,
          contentChars: generatedText.length,
        };
      },
      {
        attributes: {
          promptLength: prompt.length,
          maxTokens,
        },
      },
    );
  }

  private async fetchCodexModels(): Promise<ProviderModelStub[]> {
    const { apiKey } = await resolveCodexApiKey(this.profile.id);
    const response = await fetch("https://chatgpt.com/backend-api/models", {
      headers: buildCodexHeaders(apiKey),
    });
    if (!response.ok) {
      throw new Error(`Codex model listing failed with HTTP ${response.status}.`);
    }

    const payload = await response.json();
    const models = normalizeCodexDiscoveredModels(payload);
    if (models.length === 0) {
      throw new Error("Codex returned an empty or unrecognized model catalog.");
    }
    return models;
  }

  private async fetchAnthropicModels(): Promise<ProviderModelStub[]> {
    const response = await fetch("https://api.anthropic.com/v1/models", {
      headers: buildAnthropicAuthHeaders(resolveClaudeToken(this.profile.id)),
    });
    if (!response.ok) {
      throw new Error(`Claude model listing failed with HTTP ${response.status}.`);
    }

    const payload = await response.json();
    const models = normalizeAnthropicDiscoveredModels(payload);
    if (models.length === 0) {
      throw new Error("Claude returned an empty model catalog.");
    }
    return models;
  }

  private async countAnthropicTokens(params: {
    modelId: string;
    apiKey: string;
    systemPrompt: string;
    messages: BaseMessage[];
    tools: StructuredToolInterface[];
  }) {
    const response = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: buildAnthropicAuthHeaders(params.apiKey),
      body: JSON.stringify({
        model: params.modelId,
        system: params.systemPrompt,
        messages: toAnthropicMessages(params.messages),
        tools: params.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: toolSchemaToJson(tool),
        })),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Claude token counting failed with HTTP ${response.status}: ${errorText || response.statusText}`,
      );
    }

    const payload = await response.json() as { input_tokens?: number };
    if (typeof payload.input_tokens !== "number") {
      throw new Error("Claude token counting returned an unexpected payload.");
    }
    return payload.input_tokens;
  }
}
