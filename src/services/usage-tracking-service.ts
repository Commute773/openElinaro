import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveRuntimePath } from "./runtime-root";

export interface UsageLedgerCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UsageLedgerRecord {
  id: string;
  createdAt: string;
  profileId: string;
  providerId: string;
  modelId: string;
  sessionId: string;
  conversationKey?: string;
  purpose?: string;
  nonCachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  providerBudgetRemaining?: number | null;
  providerBudgetSource?: string;
  promptDiagnostics?: UsagePromptDiagnostics;
  cost: UsageLedgerCost;
}

export interface UsagePromptBreakdown {
  systemPromptTokens: number;
  userMessageTokens: number;
  assistantReplyTokens: number;
  toolCallInputTokens: number;
  toolResponseTokens: number;
  toolDefinitionTokens: number;
  estimatedTotalTokens: number;
}

export interface UsagePromptContributor {
  kind: "system_prompt" | "message" | "tool_definition";
  role?: "user" | "assistant" | "tool";
  messageIndex?: number;
  toolName?: string;
  tokenCount: number;
  charCount: number;
  preview?: string;
}

export interface UsagePromptDiagnostics {
  version: 1;
  systemPromptChars: number;
  promptMessageCount: number;
  promptMessagesByRole: {
    user: number;
    assistant: number;
    tool: number;
  };
  toolCount: number;
  toolNames: string[];
  approximateBreakdown: UsagePromptBreakdown;
  topContributors: UsagePromptContributor[];
  providerInputTokens?: number;
  approximationDeltaTokens?: number;
}

export interface UsageLedgerSummary {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  nonCachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputToOutputRatio: number | null;
  cacheReadPercentOfInput: number | null;
  cost: UsageLedgerCost;
}

export interface UsageLedgerFilters {
  profileId?: string;
  conversationKey?: string;
  providerId?: string;
  modelId?: string;
}

function normalizeCost(cost?: Partial<UsageLedgerCost> | null): UsageLedgerCost {
  return {
    input: Number(cost?.input ?? 0),
    output: Number(cost?.output ?? 0),
    cacheRead: Number(cost?.cacheRead ?? 0),
    cacheWrite: Number(cost?.cacheWrite ?? 0),
    total: Number(cost?.total ?? 0),
  };
}

function getLocalDateKey(isoTimestamp: string, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(isoTimestamp));
}

function getStorePath() {
  return resolveRuntimePath("model-usage.jsonl");
}

function ensureStoreDir() {
  fs.mkdirSync(path.dirname(getStorePath()), { recursive: true });
}

function readRecords(): UsageLedgerRecord[] {
  ensureStoreDir();
  const storePath = getStorePath();
  if (!fs.existsSync(storePath)) {
    return [];
  }

  const raw = fs.readFileSync(storePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as UsageLedgerRecord];
      } catch {
        return [];
      }
    });
}

function matchesFilters(record: UsageLedgerRecord, filters?: UsageLedgerFilters) {
  if (!filters) {
    return true;
  }

  if (filters.profileId && record.profileId !== filters.profileId) {
    return false;
  }

  if (filters.conversationKey && record.conversationKey !== filters.conversationKey) {
    return false;
  }

  if (filters.providerId && record.providerId !== filters.providerId) {
    return false;
  }

  if (filters.modelId && record.modelId !== filters.modelId) {
    return false;
  }

  return true;
}

function summarizeRecords(records: UsageLedgerRecord[]): UsageLedgerSummary {
  const totals = records.reduce(
    (sum, record) => ({
      requestCount: sum.requestCount + 1,
      inputTokens: sum.inputTokens + record.inputTokens,
      outputTokens: sum.outputTokens + record.outputTokens,
      totalTokens: sum.totalTokens + record.totalTokens,
      nonCachedInputTokens: sum.nonCachedInputTokens + record.nonCachedInputTokens,
      cacheReadTokens: sum.cacheReadTokens + record.cacheReadTokens,
      cacheWriteTokens: sum.cacheWriteTokens + record.cacheWriteTokens,
      cost: {
        input: sum.cost.input + record.cost.input,
        output: sum.cost.output + record.cost.output,
        cacheRead: sum.cost.cacheRead + record.cost.cacheRead,
        cacheWrite: sum.cost.cacheWrite + record.cost.cacheWrite,
        total: sum.cost.total + record.cost.total,
      },
    }),
    {
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      nonCachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
  );

  return {
    ...totals,
    inputToOutputRatio: totals.outputTokens > 0
      ? Number((totals.inputTokens / totals.outputTokens).toFixed(2))
      : null,
    cacheReadPercentOfInput: totals.inputTokens > 0
      ? Number(((totals.cacheReadTokens / totals.inputTokens) * 100).toFixed(2))
      : null,
  };
}

export class UsageTrackingService {
  record(
    record: Omit<UsageLedgerRecord, "id" | "createdAt"> & Partial<Pick<UsageLedgerRecord, "id" | "createdAt">>,
  ) {
    ensureStoreDir();
    const entry: UsageLedgerRecord = {
      id: record.id ?? randomUUID(),
      createdAt: record.createdAt ?? new Date().toISOString(),
      ...record,
      cost: normalizeCost(record.cost),
    };
    fs.appendFileSync(getStorePath(), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return entry;
  }

  list(filters?: UsageLedgerFilters) {
    return readRecords()
      .filter((record) => matchesFilters(record, filters))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  summarize(filters?: UsageLedgerFilters) {
    return summarizeRecords(this.list(filters));
  }

  latest(filters?: UsageLedgerFilters) {
    return this.list(filters).at(-1);
  }

  listByLocalDate(params: {
    localDate: string;
    timezone: string;
    filters?: UsageLedgerFilters;
  }) {
    return this.list(params.filters).filter((record) => getLocalDateKey(record.createdAt, params.timezone) === params.localDate);
  }

  summarizeByLocalDate(params: {
    localDate: string;
    timezone: string;
    filters?: UsageLedgerFilters;
  }) {
    return summarizeRecords(this.listByLocalDate(params));
  }

  latestByLocalDate(params: {
    localDate: string;
    timezone: string;
    filters?: UsageLedgerFilters;
  }) {
    return this.listByLocalDate(params).at(-1);
  }
}
