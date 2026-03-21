import { getRuntimeConfig } from "../config/runtime-config";
import type { UsageLedgerRecord } from "./usage-tracking-service";

export interface CacheMissWarning {
  providerId: string;
  modelId: string;
  conversationKey?: string;
  purpose?: string;
  nonCachedInputTokens: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheMissTokens: number;
  cacheReadRatio: number;
  previousChatTurnCount: number;
  message: string;
}

export interface CacheMissMonitorConfig {
  minInputTokens: number;
  minMissTokens: number;
  maxCacheReadRatio: number;
  discordCooldownMs: number;
}

const DEFAULT_CONFIG: CacheMissMonitorConfig = {
  minInputTokens: 30_000,
  minMissTokens: 20_000,
  maxCacheReadRatio: 0.2,
  discordCooldownMs: 15 * 60 * 1_000,
};

function formatTokenCount(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

export function getDefaultCacheMissMonitorConfig(): CacheMissMonitorConfig {
  const configured = getRuntimeConfig().core.app.cacheMissMonitor;
  return {
    minInputTokens: Math.max(0, configured.minInputTokens ?? DEFAULT_CONFIG.minInputTokens),
    minMissTokens: Math.max(0, configured.minMissTokens ?? DEFAULT_CONFIG.minMissTokens),
    maxCacheReadRatio: Math.min(1, Math.max(0, configured.maxCacheReadRatio ?? DEFAULT_CONFIG.maxCacheReadRatio)),
    discordCooldownMs: Math.max(0, configured.discordCooldownMs ?? DEFAULT_CONFIG.discordCooldownMs),
  };
}

export class CacheMissMonitor {
  private readonly lastNotificationAt = new Map<string, number>();

  constructor(
    private readonly config: CacheMissMonitorConfig = getDefaultCacheMissMonitorConfig(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  inspect(
    record: UsageLedgerRecord,
    context: { previousChatTurnCount: number },
  ): CacheMissWarning | null {
    if (record.purpose !== "chat_turn") {
      return null;
    }

    if (context.previousChatTurnCount < 1) {
      return null;
    }

    if (record.inputTokens < this.config.minInputTokens) {
      return null;
    }

    const cacheMissTokens = Math.max(0, record.nonCachedInputTokens);
    if (cacheMissTokens < this.config.minMissTokens) {
      return null;
    }

    const cacheReadRatio = record.inputTokens > 0 ? record.cacheReadTokens / record.inputTokens : 0;
    if (cacheReadRatio > this.config.maxCacheReadRatio) {
      return null;
    }

    return {
      providerId: record.providerId,
      modelId: record.modelId,
      conversationKey: record.conversationKey,
      purpose: record.purpose,
      nonCachedInputTokens: record.nonCachedInputTokens,
      inputTokens: record.inputTokens,
      cacheReadTokens: record.cacheReadTokens,
      cacheWriteTokens: record.cacheWriteTokens,
      cacheMissTokens,
      cacheReadRatio,
      previousChatTurnCount: context.previousChatTurnCount,
      message: [
        "Warning: large prompt-cache miss detected.",
        `input=${formatTokenCount(record.inputTokens)}`,
        `non_cached=${formatTokenCount(record.nonCachedInputTokens)}`,
        `cache_read=${formatTokenCount(record.cacheReadTokens)} (${formatPercent(cacheReadRatio)})`,
        `cache_write=${formatTokenCount(record.cacheWriteTokens)}`,
        `cache_miss=${formatTokenCount(cacheMissTokens)}`,
        `provider=${record.providerId}`,
        `model=${record.modelId}`,
        record.conversationKey ? `conversation=${record.conversationKey}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    };
  }

  shouldNotify(warning: CacheMissWarning) {
    const key = warning.conversationKey || `${warning.providerId}:${warning.modelId}`;
    const now = this.now();
    const last = this.lastNotificationAt.get(key);
    if (last !== undefined && now - last < this.config.discordCooldownMs) {
      return false;
    }
    this.lastNotificationAt.set(key, now);
    return true;
  }
}
