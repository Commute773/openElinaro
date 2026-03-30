import type { Usage } from "@mariozechner/pi-ai";
import type { ProfileRecord, ModelProviderId } from "../../domain/profiles";
import { CacheMissMonitor, type CacheMissWarning } from "../cache-miss-monitor";
import { telemetry } from "../infrastructure/telemetry";
import {
  UsageTrackingService,
  type UsageLedgerRecord,
  type UsageLedgerSummary,
  type UsagePromptDiagnostics,
} from "../usage-tracking-service";

export type { ModelProviderId } from "../../domain/profiles";

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

const modelTelemetry = telemetry.child({ component: "model" });

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

export class ModelUsageService {
  private readonly usageTracking: UsageTrackingService;
  private readonly cacheMissMonitor: CacheMissMonitor;
  private readonly onCacheMissWarning?: (warning: CacheMissWarning) => void;

  constructor(
    private readonly profile: ProfileRecord,
    options?: {
      usageTracking?: UsageTrackingService;
      cacheMissMonitor?: CacheMissMonitor;
      onCacheMissWarning?: (warning: CacheMissWarning) => void;
    },
  ) {
    this.usageTracking = options?.usageTracking ?? new UsageTrackingService();
    this.cacheMissMonitor = options?.cacheMissMonitor ?? new CacheMissMonitor();
    this.onCacheMissWarning = options?.onCacheMissWarning;
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
}
