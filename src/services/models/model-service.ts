import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ConfigurationError, NotFoundError, ValidationError } from "../../domain/errors";
import type {
  Message,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ImageContent,
  ToolCall,
  Tool,
  Usage,
  ThinkingLevel,
} from "../../messages/types";
import { approximateTextTokens } from "../../utils/text-utils";
import {
  approximateContentTokens,
  extractTextFromMessage,
  normalizeChatPromptContent,
  resolveRemoteImageUrl,
} from "../message-content-service";
import {
  UsageTrackingService,
  type UsagePromptDiagnostics,
} from "../usage-tracking-service";
import { CacheMissMonitor, type CacheMissWarning } from "../cache-miss-monitor";
import {
  ModelUsageService,
  type RecordedUsageInspection,
  type RecordedUsageDailyInspection,
} from "./model-usage-service";
import { getClaudeSetupToken } from "../../auth/store";
import type { ProfileRecord, ModelProviderId } from "../../domain/profiles";
import { getRuntimeConfig } from "../../config/runtime-config";
import { resolveRuntimePath } from "../runtime-root";
import { telemetry } from "../infrastructure/telemetry";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { timestamp } from "../../utils/timestamp";

export type { RecordedUsageInspection, RecordedUsageDailyInspection } from "./model-usage-service";
export { ModelUsageService } from "./model-usage-service";

// ---------------------------------------------------------------------------
// Resolved model type (replaces pi-ai Model<Api> dependency)
// ---------------------------------------------------------------------------

export interface ResolvedRuntimeModel {
  selection: ActiveModelSelection;
  apiKey: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

// ---------------------------------------------------------------------------
// Inline Claude model catalog (replaces pi-ai getModels)
// ---------------------------------------------------------------------------

interface ClaudeModelEntry {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}

const CLAUDE_MODEL_CATALOG: ClaudeModelEntry[] = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", contextWindow: 200_000, maxTokens: 32_000, reasoning: true },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 200_000, maxTokens: 16_000, reasoning: true },
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200_000, maxTokens: 16_000, reasoning: true },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000, maxTokens: 8_192, reasoning: true },
];

export type { ModelProviderId } from "../../domain/profiles";
const modelTelemetry = telemetry.child({ component: "model" });
const MAX_ANTHROPIC_BASE64_BYTES = 5 * 1024 * 1024;

const traceSpan = createTraceSpan(modelTelemetry);

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

export interface HeartbeatModelSelection {
  providerId: ModelProviderId;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

export interface ReflectionModelSelection {
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
  modelUsageService?: ModelUsageService;
}

interface ActiveModelStoreShape {
  version?: number;
  activeModel?: ActiveModelSelection;
  activeModels?: Record<string, ActiveModelSelection>;
}

type RuntimeModelStub = { id: string; name: string };

function getStorePath() {
  return resolveRuntimePath("model-state.json");
}
const DEFAULT_ACTIVE_MODEL: ActiveModelSelection = {
  providerId: "claude",
  modelId: "claude-sonnet-4-6",
  thinkingLevel: "medium",
  extendedContextEnabled: false,
  updatedAt: new Date(0).toISOString(),
};

const PROVIDER_LABELS: Record<ModelProviderId, string> = {
  claude: "Claude",
};

async function ensureStoreDir() {
  await mkdir(path.dirname(getStorePath()), { recursive: true });
}

async function readStore(): Promise<ActiveModelStoreShape> {
  await ensureStoreDir();
  const storePath = getStorePath();
  const file = Bun.file(storePath);
  if (!await file.exists()) {
    return { version: 2, activeModels: {} };
  }

  const parsed = JSON.parse(await file.text()) as ActiveModelStoreShape;
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

async function writeStore(store: ActiveModelStoreShape) {
  await ensureStoreDir();
  await Bun.write(getStorePath(), `${JSON.stringify(store, null, 2)}\n`);
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

async function writeStoredActiveModel(selectionStoreKey: string, selection: ActiveModelSelection) {
  const store = await readStore();
  store.version = 2;
  store.activeModels ??= {};
  store.activeModels[selectionStoreKey] = selection;
  await writeStore(store);
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

export function getExtendedContextWindowOverride(providerId: ModelProviderId, modelId: string) {
  const key = providerModelKey(providerId, modelId);
  return getRuntimeConfig().models.extendedContext[key]?.extendedContextWindow;
}

function supportsExtendedContext(providerId: ModelProviderId, modelId: string) {
  return getExtendedContextWindowOverride(providerId, modelId) !== undefined;
}

export function getSelectedContextWindow(
  profile: Pick<ProfileRecord, "maxContextTokens">,
  selection: Pick<ActiveModelSelection, "providerId" | "modelId" | "extendedContextEnabled">,
  runtimeContextWindow?: number,
) {
  const extended = getExtendedContextWindowOverride(selection.providerId, selection.modelId);
  const uncapped = (extended && selection.extendedContextEnabled)
    ? extended
    : runtimeContextWindow;

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

  const uncapped = getExtendedContextWindowOverride(providerId, modelId) ?? runtimeContextWindow;
  return profile.maxContextTokens
    ? Math.min(profile.maxContextTokens, uncapped ?? profile.maxContextTokens)
    : uncapped;
}

function toolSchemaToJson(tool: Tool) {
  return tool.parameters;
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
    throw new ValidationError("A non-empty model identifier is required.");
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

  throw new NotFoundError("Model", requested);
}


function approximateConversationTokens(params: {
  systemPrompt: string;
  messages: Message[];
  tools: Tool[];
}) {
  const breakdown = approximateConversationTokenBreakdown(params);
  const latestAssistant = [...params.messages]
    .reverse()
    .find((message): message is AssistantMessage => message.role === "assistant") as AssistantMessage | undefined;
  const usage = latestAssistant?.usage;
  const usageEstimate =
    usage?.input && usage?.output
      ? usage.input + usage.output
      : 0;

  return Math.max(breakdown.estimatedTotalTokens, usageEstimate);
}

function approximateConversationTokenBreakdown(params: {
  systemPrompt: string;
  messages: Message[];
  tools: Tool[];
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
    if (message.role === "toolResult") {
      breakdown.toolResponseTokens += approximateTextTokens(extractTextFromMessage(message)) + 24;
      continue;
    }

    if (message.role === "assistant") {
      const assistant = message as AssistantMessage;
      breakdown.assistantReplyTokens += approximateTextTokens(extractTextFromMessage(message));
      const toolCalls = assistant.content.filter((block): block is ToolCall => block.type === "toolCall");
      breakdown.toolCallInputTokens += toolCalls.reduce((toolSum, toolCall) =>
        toolSum + approximateTextTokens(JSON.stringify({
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.arguments ?? {},
        })) + 24, 0);
      continue;
    }

    if (message.role === "user") {
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

  return blocks.map((block) => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }

    const remoteUrl = block.data.length > MAX_ANTHROPIC_BASE64_BYTES
      ? resolveRemoteImageUrl(block.sourceUrl)
      : null;
    if (remoteUrl) {
      return {
        type: "image",
        source: { type: "url", url: remoteUrl },
      };
    }

    return {
      type: "image",
      source: {
        type: "base64",
        media_type: block.mimeType,
        data: block.data,
      },
    };
  });
}

function toAnthropicMessages(messages: Message[]) {
  const normalized: AnthropicRequestMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      normalized.push({ role: "user", content: toAnthropicUserContent(message.content) });
      continue;
    }

    if (message.role === "toolResult") {
      const toolResult = message as ToolResultMessage;
      normalized.push(
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolResult.toolCallId,
              content: extractTextFromMessage(message),
              is_error: toolResult.isError ?? false,
            },
          ],
        },
      );
      continue;
    }

    if (message.role === "assistant") {
      const assistant = message as AssistantMessage;
      const textContent = extractTextFromMessage(message);
      const toolCalls = assistant.content.filter((block): block is ToolCall => block.type === "toolCall");
      const content = [
        ...(textContent
          ? [{ type: "text", text: textContent }]
          : []),
        ...(toolCalls.map((toolCall) => ({
          type: "tool_use",
          id: toolCall.id ?? `tool_${Date.now()}`,
          name: toolCall.name,
          input: toolCall.arguments ?? {},
        }))),
      ];
      normalized.push({ role: "assistant", content });
      continue;
    }
  }
  return normalized;
}

function getClaudeModelCatalog() {
  return new Map(CLAUDE_MODEL_CATALOG.map((model) => [model.id, model]));
}

export function resolveClaudeToken(profileId: string) {
  const token = getClaudeSetupToken(profileId);
  if (!token) {
    throw new ConfigurationError("Claude auth is not configured yet. Use `/auth provider:claude` first.");
  }
  return token;
}

export class ModelService {
  private readonly usageService: ModelUsageService;
  private readonly selectionStoreKey: string;
  private readonly defaultSelectionOverride?: Partial<Pick<ActiveModelSelection, "providerId" | "modelId" | "thinkingLevel">>;

  constructor(
    private readonly profile: ProfileRecord,
    options?: ModelServiceOptions,
  ) {
    this.usageService = options?.modelUsageService ?? new ModelUsageService(profile, {
      usageTracking: options?.usageTracking,
      cacheMissMonitor: options?.cacheMissMonitor,
      onCacheMissWarning: options?.onCacheMissWarning,
    });
    this.selectionStoreKey = options?.selectionStoreKey?.trim() || profile.id;
    this.defaultSelectionOverride = options?.defaultSelectionOverride;
  }

  getSupportedProviders(): ModelProviderId[] {
    return ["claude"];
  }

  getProviderLabel(providerId: ModelProviderId) {
    return PROVIDER_LABELS[providerId];
  }

  // TODO: Secondary model selections (tool summarizer, memory, heartbeat, reflection)
  // have been removed. The Claude SDK handles tool summarization natively.
  // Memory extraction will be rebuilt as a short-lived SDK instance launched pre-compaction.

  /** @deprecated Stub — will be rebuilt as short-lived SDK instance. Always returns empty string. */
  async generateMemoryText(_params: {
    systemPrompt: string;
    userPrompt: string;
    usagePurpose: string;
    sessionIdPrefix?: string;
    selection?: Pick<ActiveModelSelection, "providerId" | "modelId" | "thinkingLevel">;
  }): Promise<string> {
    return "";
  }

  /** @deprecated Stub — will be rebuilt. */
  getReflectionSelection(): { providerId: ModelProviderId; modelId: string; thinkingLevel: ThinkingLevel } {
    return { providerId: "claude", modelId: "claude-sonnet-4-5", thinkingLevel: "minimal" };
  }

  /** @deprecated Stub — will be rebuilt. */
  async summarizeToolResult(_params: {
    toolName: string;
    goal: string;
    output: string;
  }): Promise<string> {
    return "insufficient evidence";
  }

  /** @deprecated Stub — will be rebuilt. */
  async benchmarkActiveModel(_params?: {
    prompt?: string;
    maxTokens?: number;
  }): Promise<ActiveModelBenchmark> {
    throw new Error("benchmarkActiveModel has been removed. Will be rebuilt with direct API call.");
  }

  async getActiveModel(): Promise<ActiveModelSelection> {
    const store = await readStore();
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

  async getActiveExtendedContextStatus(): Promise<ActiveExtendedContextStatus> {
    const active = await this.getActiveModel();
    const catalog = getClaudeModelCatalog();
    const runtimeModel = resolveRuntimeModelIdentifier(active.modelId, [...catalog.values()]);
    const runtimeContextWindow = runtimeModel?.contextWindow;
    const extendedContextWindow = getExtendedContextWindowOverride(active.providerId, active.modelId);
    const supported = extendedContextWindow !== undefined;

    return {
      providerId: active.providerId,
      modelId: active.modelId,
      supported,
      enabled: supported ? active.extendedContextEnabled : false,
      standardContextWindow: runtimeContextWindow,
      extendedContextWindow,
      activeContextWindow: getSelectedContextWindow(this.profile, active, runtimeContextWindow),
    };
  }

  async listProviderModels(providerId: ModelProviderId): Promise<ListedProviderModel[]> {
    if (providerId !== "claude") {
      return [];
    }
    const runtimeModels = CLAUDE_MODEL_CATALOG;
    const active = await this.getActiveModel();

    return runtimeModels.map((model) => ({
      providerId,
      modelId: model.id,
      name: model.name,
      contextWindow: getListedContextWindow(
        this.profile,
        providerId,
        model.id,
        active,
        model.contextWindow,
      ),
      maxOutputTokens: model.maxTokens,
      reasoning: model.reasoning,
      supported: true,
      active: active.providerId === providerId &&
        Boolean(resolveRuntimeModelIdentifier(active.modelId, [{
          id: model.id,
          name: model.name,
        }])),
    }));
  }

  async resolveProviderModel(providerId: ModelProviderId, requestedModelId: string) {
    const models = await this.listProviderModels(providerId);
    return resolveListedModelIdentifier(requestedModelId, models);
  }

  async selectActiveModel(providerId: ModelProviderId, modelId: string) {
    const selected = await this.resolveProviderModel(providerId, modelId);
    if (!selected.supported) {
      throw new ValidationError(
        `Model ${providerId}/${selected.modelId} is listed by the provider but is not supported by the current runtime.`,
      );
    }

    const current = await this.getActiveModel();
    const nextSelection: ActiveModelSelection = {
      providerId,
      modelId: selected.modelId,
      thinkingLevel: current.thinkingLevel,
      extendedContextEnabled:
        supportsExtendedContext(providerId, selected.modelId) &&
        current.extendedContextEnabled,
      updatedAt: timestamp(),
    };
    await writeStoredActiveModel(this.selectionStoreKey, nextSelection);
    return {
      ...selected,
      active: true,
    };
  }

  async setThinkingLevel(thinkingLevel: ThinkingLevel) {
    const nextSelection: ActiveModelSelection = {
      ...await this.getActiveModel(),
      thinkingLevel,
      updatedAt: timestamp(),
    };
    await writeStoredActiveModel(this.selectionStoreKey, nextSelection);
    return nextSelection;
  }

  async setStoredSelectionDefaults(selection: Partial<Pick<
    ActiveModelSelection,
    "providerId" | "modelId" | "thinkingLevel" | "extendedContextEnabled"
  >>) {
    const current = await this.getActiveModel();
    const nextSelection: ActiveModelSelection = {
      ...current,
      ...selection,
      thinkingLevel: normalizeThinkingLevel(selection.thinkingLevel ?? current.thinkingLevel),
      extendedContextEnabled: selection.extendedContextEnabled ?? current.extendedContextEnabled,
      updatedAt: timestamp(),
    };
    await writeStoredActiveModel(this.selectionStoreKey, nextSelection);
    return nextSelection;
  }

  async setExtendedContextEnabled(enabled: boolean) {
    const active = await this.getActiveModel();
    if (enabled && !supportsExtendedContext(active.providerId, active.modelId)) {
      throw new ValidationError(
        `Extended context is not available for ${active.providerId}/${active.modelId}.`,
      );
    }

    const nextSelection: ActiveModelSelection = {
      ...active,
      extendedContextEnabled: enabled && supportsExtendedContext(active.providerId, active.modelId),
      updatedAt: timestamp(),
    };
    await writeStoredActiveModel(this.selectionStoreKey, nextSelection);
    return nextSelection;
  }

  async resolveModelForPurpose(purpose?: string): Promise<ResolvedRuntimeModel> {
    const selection = await this.getActiveModel();
    const apiKey = resolveClaudeToken(this.profile.id);
    const catalog = getClaudeModelCatalog();
    const model = resolveRuntimeModelIdentifier(selection.modelId, [...catalog.values()]);
    return {
      selection,
      apiKey,
      contextWindow: model?.contextWindow,
      maxOutputTokens: model?.maxTokens,
    };
  }

  async inspectContextWindowUsage(params: {
    conversationKey: string;
    systemPrompt: string;
    messages: Message[];
    tools: Tool[];
  }): Promise<ContextWindowUsage> {
    const resolved = await this.resolveModelForPurpose();
    const maxContextTokens = getSelectedContextWindow(
      this.profile,
      resolved.selection,
      resolved.contextWindow,
    );
    if (!maxContextTokens) {
      throw new ConfigurationError(`No context window metadata is available for ${resolved.selection.modelId}.`);
    }

    const method: ContextWindowUsage["method"] = "provider_count";
    const breakdown = approximateConversationTokenBreakdown(params);
    const catalog = getClaudeModelCatalog();
    const model = resolveRuntimeModelIdentifier(resolved.selection.modelId, [...catalog.values()]);
    const usedTokens = await this.countAnthropicTokens({
      modelId: model?.id ?? resolved.selection.modelId,
      apiKey: resolved.apiKey,
      systemPrompt: params.systemPrompt,
      messages: params.messages,
      tools: params.tools,
    });
    const remainingTokens = Math.max(0, maxContextTokens - usedTokens);
    const maxOutputTokens = resolved.maxOutputTokens;
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
    return this.usageService.recordUsage(params);
  }

  inspectRecordedUsage(params: {
    conversationKey?: string;
    providerId: ModelProviderId;
    modelId: string;
  }): RecordedUsageInspection {
    return this.usageService.inspectRecordedUsage(params);
  }

  inspectRecordedUsageByLocalDate(params: {
    conversationKey?: string;
    providerId: ModelProviderId;
    modelId: string;
    localDate: string;
    timezone: string;
  }): RecordedUsageDailyInspection {
    return this.usageService.inspectRecordedUsageByLocalDate(params);
  }

  // TODO: benchmarkActiveModel removed (used pi-ai streamSimple). Rebuild with direct API call if needed.

  private async countAnthropicTokens(params: {
    modelId: string;
    apiKey: string;
    systemPrompt: string;
    messages: Message[];
    tools: Tool[];
  }) {
    // The Anthropic count_tokens API requires at least one message.
    // When the conversation is empty, fall back to heuristic estimation.
    const anthropicMessages = toAnthropicMessages(params.messages);
    if (anthropicMessages.length === 0) {
      return approximateConversationTokens(params);
    }

    const response = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: buildAnthropicAuthHeaders(params.apiKey),
      body: JSON.stringify({
        model: params.modelId,
        system: params.systemPrompt,
        messages: anthropicMessages,
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
