import { describe, expect, test } from "bun:test";
import { CacheMissMonitor } from "./cache-miss-monitor";
import type { UsageLedgerRecord } from "./usage-tracking-service";

function buildRecord(overrides?: Partial<UsageLedgerRecord>): UsageLedgerRecord {
  return {
    id: "record-1",
    createdAt: "2026-03-12T12:00:00.000Z",
    profileId: "root",
    providerId: "openai-codex",
    modelId: "gpt-5.4",
    sessionId: "conversation-1",
    conversationKey: "conversation-1",
    purpose: "chat_turn",
    nonCachedInputTokens: 38_000,
    cacheReadTokens: 2_000,
    cacheWriteTokens: 0,
    inputTokens: 40_000,
    outputTokens: 900,
    totalTokens: 40_900,
    providerBudgetRemaining: null,
    providerBudgetSource: undefined,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
    ...overrides,
  };
}

describe("CacheMissMonitor", () => {
  test("flags a large cache miss on an ongoing chat conversation", () => {
    const monitor = new CacheMissMonitor({
      minInputTokens: 30_000,
      minMissTokens: 20_000,
      maxCacheReadRatio: 0.2,
      discordCooldownMs: 1_000,
    });

    const warning = monitor.inspect(buildRecord(), { previousChatTurnCount: 2 });

    expect(warning).not.toBeNull();
    expect(warning?.cacheMissTokens).toBe(38_000);
    expect(warning?.message).toContain("large prompt-cache miss detected");
    expect(warning?.message).toContain("conversation=conversation-1");
    expect(warning?.message).toContain("cache_write=0");
  });

  test("does not flag the first chat turn", () => {
    const monitor = new CacheMissMonitor({
      minInputTokens: 30_000,
      minMissTokens: 20_000,
      maxCacheReadRatio: 0.2,
      discordCooldownMs: 1_000,
    });

    const warning = monitor.inspect(buildRecord(), { previousChatTurnCount: 0 });

    expect(warning).toBeNull();
  });

  test("does not flag healthy cache reuse", () => {
    const monitor = new CacheMissMonitor({
      minInputTokens: 30_000,
      minMissTokens: 20_000,
      maxCacheReadRatio: 0.2,
      discordCooldownMs: 1_000,
    });

    const warning = monitor.inspect(
      buildRecord({
        cacheReadTokens: 32_000,
        nonCachedInputTokens: 8_000,
      }),
      { previousChatTurnCount: 3 },
    );

    expect(warning).toBeNull();
  });

  test("does not treat prompt cache creation as a cache miss", () => {
    const monitor = new CacheMissMonitor({
      minInputTokens: 30_000,
      minMissTokens: 20_000,
      maxCacheReadRatio: 0.2,
      discordCooldownMs: 1_000,
    });

    const warning = monitor.inspect(
      buildRecord({
        nonCachedInputTokens: 3,
        cacheReadTokens: 5_369,
        cacheWriteTokens: 75_549,
        inputTokens: 80_921,
      }),
      { previousChatTurnCount: 3 },
    );

    expect(warning).toBeNull();
  });

  test("suppresses repeated notifications during the cooldown window", () => {
    let now = 10_000;
    const monitor = new CacheMissMonitor(
      {
        minInputTokens: 30_000,
        minMissTokens: 20_000,
        maxCacheReadRatio: 0.2,
        discordCooldownMs: 5_000,
      },
      () => now,
    );

    const warning = monitor.inspect(buildRecord(), { previousChatTurnCount: 2 });
    expect(warning).not.toBeNull();
    expect(monitor.shouldNotify(warning!)).toBe(true);
    expect(monitor.shouldNotify(warning!)).toBe(false);

    now += 5_001;
    expect(monitor.shouldNotify(warning!)).toBe(true);
  });
});
