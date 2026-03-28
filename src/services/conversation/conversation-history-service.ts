import fs from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { BaseMessage, StoredMessage } from "@langchain/core/messages";
import { mapChatMessagesToStoredMessages } from "@langchain/core/messages";
import { extractTextFromMessage } from "../message-content-service";
import {
  buildDocumentFrequencies,
  countTerms,
  dotProduct,
  extractContextSnippet,
  rankHybridMatches,
  scoreBm25,
  tokenize,
} from "../hybrid-search";
import { getDefaultProfileId } from "../profiles";
import { assertTestRuntimeRootIsIsolated, resolveRuntimePath } from "../runtime-root";
import { telemetry } from "../infrastructure/telemetry";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import {
  EMBEDDING_MODEL_ID,
  embedTexts,
  isEmbeddingExtractorReady,
} from "../text-embedding-service";

const INDEX_VERSION = 2;
const conversationHistoryTelemetry = telemetry.child({ component: "conversation_history" });
const DEFAULT_SEARCH_LIMIT = 5;
const DEFAULT_CONTEXT_CHARS = 180;
const MIN_SEARCH_CANDIDATES = 20;

function getConversationHistoryRoot() {
  return resolveRuntimePath("conversation-history");
}

const traceSpan = createTraceSpan(conversationHistoryTelemetry);

type ConversationHistoryMessageEntry = {
  version: number;
  kind: "message";
  profileId: string;
  conversationKey: string;
  occurredAt: string;
  messageIndex: number;
  messageType: string;
  role: string;
  text: string;
  storedMessage: StoredMessage;
};

type ConversationHistoryRollbackEntry = {
  version: number;
  kind: "rollback";
  profileId: string;
  conversationKey: string;
  occurredAt: string;
  removedCount: number;
};

type ConversationHistoryEntry = ConversationHistoryMessageEntry | ConversationHistoryRollbackEntry;

type ConversationHistoryIndexRecord = {
  conversationKey: string;
  occurredAt: string;
  messageIndex: number;
  messageType: string;
  role: string;
  text: string;
  searchText: string;
  tokenCount: number;
  termFrequencies: Record<string, number>;
  journalLine: number;
};

type ConversationHistoryIndex = {
  version: number;
  builtAt: string;
  modelId: string;
  journalPath: string;
  journalSize: number;
  journalMtimeMs: number;
  indexedMessages: number;
  messages: ConversationHistoryIndexRecord[];
  documentFrequencies: Record<string, number>;
  averageMessageLength: number;
};

type SearchParams = {
  query: string;
  limit?: number;
  contextChars?: number;
};

export type RecentConversationHistoryEntry = {
  conversationKey: string;
  occurredAt: string;
  messageIndex: number;
  role: string;
  text: string;
};

type SearchResult = {
  entry: ConversationHistoryIndexRecord;
  score: number;
  vectorScore: number;
  bm25Score: number;
};

type ConversationHistoryServiceOptions = {
  embedTexts?: (texts: string[]) => Promise<number[][]>;
  profileId?: string;
};

function normalizeProfileId(profileId?: string) {
  return profileId?.trim() || getDefaultProfileId();
}

function roleFromStoredMessageType(type: string) {
  switch (type) {
    case "human":
      return "user";
    case "ai":
      return "assistant";
    case "tool":
      return "tool";
    case "system":
      return "system";
    default:
      return type;
  }
}

function ensureHistoryDirectory() {
  fs.mkdirSync(getConversationHistoryRoot(), { recursive: true });
}

function appendJsonlLines(filePath: string, lines: string[]) {
  if (lines.length === 0) {
    return;
  }
  assertTestRuntimeRootIsIsolated("Conversation history");
  ensureHistoryDirectory();
  fs.appendFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function emptyIndex(journalPath: string): ConversationHistoryIndex {
  return {
    version: INDEX_VERSION,
    builtAt: new Date().toISOString(),
    modelId: EMBEDDING_MODEL_ID,
    journalPath,
    journalSize: 0,
    journalMtimeMs: 0,
    indexedMessages: 0,
    messages: [],
    documentFrequencies: {},
    averageMessageLength: 0,
  };
}

function formatConversationSearchResults(
  query: string,
  results: SearchResult[],
  journalPath: string,
  contextChars: number,
) {
  if (results.length === 0) {
    return `No conversation hits found for "${query}". Journal: ${journalPath}`;
  }

  return [
    `Conversation hits for "${query}" (most recent relevant matches):`,
    ...results.map((result, index) =>
      [
        `${index + 1}. conversation=${result.entry.conversationKey}`,
        `time: ${result.entry.occurredAt}`,
        `message: #${result.entry.messageIndex} role=${result.entry.role} type=${result.entry.messageType}`,
        `scores: hybrid=${result.score.toFixed(4)} vector=${result.vectorScore.toFixed(4)} bm25=${result.bm25Score.toFixed(4)}`,
        `excerpt: ${extractContextSnippet(result.entry.text, query, contextChars)}`,
      ].join("\n")
    ),
  ].join("\n\n");
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export class ConversationHistoryService {
  private index: ConversationHistoryIndex | null = null;
  private initializePromise: Promise<ConversationHistoryIndex> | null = null;
  private readonly profileId: string;
  private readonly embedTextsFn: (texts: string[]) => Promise<number[][]>;
  private readonly allowColdEmbeddingSearch: boolean;

  constructor(options?: ConversationHistoryServiceOptions) {
    this.profileId = normalizeProfileId(options?.profileId);
    this.embedTextsFn = options?.embedTexts ?? embedTexts;
    this.allowColdEmbeddingSearch = Boolean(options?.embedTexts);
  }

  recordAppendedMessages(params: {
    conversationKey: string;
    messages: BaseMessage[];
    startingIndex: number;
    occurredAt: string;
  }) {
    if (params.messages.length === 0) {
      return;
    }

    const storedMessages = mapChatMessagesToStoredMessages(params.messages);
    const lines = storedMessages.map((storedMessage, index) => {
      const message = params.messages[index];
      const entry: ConversationHistoryMessageEntry = {
        version: INDEX_VERSION,
        kind: "message",
        profileId: this.profileId,
        conversationKey: params.conversationKey,
        occurredAt: params.occurredAt,
        messageIndex: params.startingIndex + index + 1,
        messageType: storedMessage.type,
        role: roleFromStoredMessageType(storedMessage.type),
        text: message ? extractTextFromMessage(message).trim() : "",
        storedMessage,
      };
      return JSON.stringify(entry);
    });

    appendJsonlLines(this.getJournalPath(), lines);
    this.index = null;
  }

  recordRollback(params: {
    conversationKey: string;
    removedCount: number;
    occurredAt: string;
  }) {
    if (params.removedCount <= 0) {
      return;
    }

    const entry: ConversationHistoryRollbackEntry = {
      version: INDEX_VERSION,
      kind: "rollback",
      profileId: this.profileId,
      conversationKey: params.conversationKey,
      occurredAt: params.occurredAt,
      removedCount: params.removedCount,
    };
    appendJsonlLines(this.getJournalPath(), [JSON.stringify(entry)]);
    this.index = null;
  }

  async search(params: SearchParams) {
    return traceSpan(
      "conversation_history.search",
      async () => {
        const query = params.query.trim();
        if (!query) {
          throw new Error("query is required");
        }

        const index = await this.loadOrBuildIndex();
        if (index.messages.length === 0) {
          return `Conversation archive is empty. Journal: ${index.journalPath}`;
        }

        const queryTokens = tokenize(query);
        const bm25Scores = index.messages.map((entry) =>
          scoreBm25({
            documentLength: entry.tokenCount,
            averageDocumentLength: index.averageMessageLength,
            totalDocuments: index.messages.length,
            queryTokens,
            termFrequencies: entry.termFrequencies,
            documentFrequencies: index.documentFrequencies,
          })
        );

        const limit = Math.min(Math.max(params.limit ?? DEFAULT_SEARCH_LIMIT, 1), 20);
        const contextChars = Math.min(
          Math.max(params.contextChars ?? DEFAULT_CONTEXT_CHARS, 40),
          2_000,
        );
        const candidateLimit = Math.max(limit * 4, MIN_SEARCH_CANDIDATES);
        const candidateIndexes = this.buildCandidateIndexes({
          entries: index.messages,
          bm25Scores,
          candidateLimit,
        });
        const candidates = candidateIndexes
          .map((entryIndex) => ({
            entry: index.messages[entryIndex],
            bm25Score: bm25Scores[entryIndex] ?? 0,
          }))
          .filter(
            (candidate): candidate is {
              entry: ConversationHistoryIndexRecord;
              bm25Score: number;
            } => isDefined(candidate.entry),
          );
        const candidateEntries = candidates.map((candidate) => candidate.entry);
        const candidateBm25Scores = candidates.map((candidate) => candidate.bm25Score);
        const candidateVectorScores = await this.computeVectorScores({
          query,
          entries: candidateEntries,
        });
        const results = rankHybridMatches({
          items: candidateEntries,
          vectorScores: candidateVectorScores,
          bm25Scores: candidateBm25Scores,
        })
          .map((result) => ({
            entry: result.item,
            score: result.score,
            vectorScore: result.vectorScore,
            bm25Score: result.bm25Score,
          }))
          .sort((left, right) =>
            right.score - left.score ||
            right.entry.occurredAt.localeCompare(left.entry.occurredAt) ||
            right.entry.journalLine - left.entry.journalLine
          )
          .slice(0, candidateLimit)
          .sort((left, right) =>
            right.entry.occurredAt.localeCompare(left.entry.occurredAt) ||
            right.entry.journalLine - left.entry.journalLine ||
            right.score - left.score
          )
          .slice(0, limit);

        return formatConversationSearchResults(query, results, index.journalPath, contextChars);
      },
      {
        attributes: {
          queryLength: params.query.length,
          limit: params.limit ?? DEFAULT_SEARCH_LIMIT,
          contextChars: params.contextChars ?? DEFAULT_CONTEXT_CHARS,
          profileId: this.profileId,
        },
      },
    );
  }

  async listRecentMessages(params?: {
    limit?: number;
    since?: string;
    conversationKey?: string;
  }): Promise<RecentConversationHistoryEntry[]> {
    const index = await this.loadOrBuildIndex();
    const sinceMs = params?.since ? Date.parse(params.since) : Number.NEGATIVE_INFINITY;
    const limit = Math.min(Math.max(params?.limit ?? 20, 1), 200);
    return [...index.messages]
      .filter((entry) => entry.text.trim().length > 0)
      .filter((entry) => !params?.conversationKey || entry.conversationKey === params.conversationKey)
      .filter((entry) => {
        const occurredAtMs = Date.parse(entry.occurredAt);
        return Number.isFinite(occurredAtMs) ? occurredAtMs >= sinceMs : true;
      })
      .sort((left, right) =>
        right.occurredAt.localeCompare(left.occurredAt) ||
        right.journalLine - left.journalLine
      )
      .slice(0, limit)
      .map((entry) => ({
        conversationKey: entry.conversationKey,
        occurredAt: entry.occurredAt,
        messageIndex: entry.messageIndex,
        role: entry.role,
        text: entry.text,
      }));
  }

  private buildCandidateIndexes(params: {
    entries: ConversationHistoryIndexRecord[];
    bm25Scores: number[];
    candidateLimit: number;
  }) {
    const rankedLexicalMatches = params.entries
      .map((entry, index) => ({
        entry,
        index,
        bm25Score: params.bm25Scores[index] ?? 0,
      }))
      .filter((candidate) => candidate.bm25Score > 0)
      .sort(
        (left, right) =>
          right.bm25Score - left.bm25Score ||
          right.entry.occurredAt.localeCompare(left.entry.occurredAt) ||
          right.entry.journalLine - left.entry.journalLine,
      )
      .slice(0, params.candidateLimit);

    const indexes = rankedLexicalMatches.map((candidate) => candidate.index);
    const recentFloor = Math.min(params.entries.length, params.candidateLimit);
    for (
      let index = params.entries.length - 1;
      index >= 0 && indexes.length < recentFloor;
      index -= 1
    ) {
      if (!indexes.includes(index)) {
        indexes.push(index);
      }
    }

    return indexes;
  }

  private async computeVectorScores(params: {
    query: string;
    entries: ConversationHistoryIndexRecord[];
  }) {
    const defaultScores = params.entries.map(() => 0);
    if (params.entries.length === 0) {
      return defaultScores;
    }

    if (!this.allowColdEmbeddingSearch && !isEmbeddingExtractorReady()) {
      conversationHistoryTelemetry.event("conversation_history.search.embedding_skipped_cold", {
        candidateCount: params.entries.length,
        modelId: EMBEDDING_MODEL_ID,
        profileId: this.profileId,
      });
      return defaultScores;
    }

    try {
      const vectors = await this.embedTextsFn([
        params.query,
        ...params.entries.map((entry) => entry.searchText),
      ]);
      const queryVector = vectors[0] ?? [];
      return params.entries.map((_, index) => dotProduct(queryVector, vectors[index + 1] ?? []));
    } catch (error) {
      conversationHistoryTelemetry.event(
        "conversation_history.search.embedding_failed",
        {
          error: error instanceof Error ? error.message : String(error),
          modelId: EMBEDDING_MODEL_ID,
          candidateCount: params.entries.length,
        },
        { level: "warn", outcome: "error" },
      );
      return defaultScores;
    }
  }

  private async loadOrBuildIndex(force = false) {
    if (!force && this.index) {
      return this.index;
    }
    if (!force && this.initializePromise) {
      return this.initializePromise;
    }

    const job = traceSpan("conversation_history.index.build", async () => {
      if (!force) {
        const existing = await this.readExistingIndex();
        if (existing) {
          this.index = existing;
          return existing;
        }
      }

      const built = await this.buildIndex();
      this.index = built;
      ensureHistoryDirectory();
      await Bun.write(this.getIndexPath(), `${JSON.stringify(built, null, 2)}\n`);
      return built;
    });

    this.initializePromise = job;
    try {
      return await job;
    } finally {
      this.initializePromise = null;
    }
  }

  private async readExistingIndex() {
    try {
      const raw = await Bun.file(this.getIndexPath()).text();
      const parsed = JSON.parse(raw) as ConversationHistoryIndex;
      const journalStat = await stat(this.getJournalPath()).catch(() => null);
      const journalSize = journalStat?.size ?? 0;
      const journalMtimeMs = journalStat?.mtimeMs ?? 0;
      if (parsed.version !== INDEX_VERSION || parsed.journalSize !== journalSize || parsed.journalMtimeMs !== journalMtimeMs) {
        return null;
      }
      return parsed;
    } catch (error) {
      conversationHistoryTelemetry.event("conversation_history.index_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      }, { level: "debug", outcome: "error" });
      return null;
    }
  }

  private async buildIndex(): Promise<ConversationHistoryIndex> {
    ensureHistoryDirectory();
    const journalPath = this.getJournalPath();
    const journalStat = await stat(journalPath).catch(() => null);
    if (!journalStat?.isFile() || journalStat.size === 0) {
      return emptyIndex(journalPath);
    }

    const raw = await Bun.file(journalPath).text();
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const messages: ConversationHistoryIndexRecord[] = [];

    for (const [lineIndex, line] of lines.entries()) {
      try {
        const entry = JSON.parse(line) as ConversationHistoryEntry;
        if (entry.kind === "message" && entry.profileId === this.profileId) {
          const searchText = [entry.conversationKey, entry.role, entry.text].filter(Boolean).join("\n");
          if (!searchText.trim()) {
            continue;
          }

          const tokens = tokenize(searchText);
          messages.push({
            conversationKey: entry.conversationKey,
            occurredAt: entry.occurredAt,
            messageIndex: entry.messageIndex,
            messageType: entry.messageType,
            role: entry.role,
            text: entry.text,
            searchText,
            tokenCount: tokens.length,
            termFrequencies: countTerms(tokens),
            journalLine: lineIndex + 1,
          });
        }
      } catch (error) {
        conversationHistoryTelemetry.event(
          "conversation_history.index.invalid_jsonl_line",
          {
            line: lineIndex + 1,
            error: error instanceof Error ? error.message : String(error),
            journalPath,
          },
          { level: "warn", outcome: "error" },
        );
      }
    }
    const documentFrequencies = buildDocumentFrequencies(messages.map((entry) => entry.termFrequencies));
    const totalMessageLength = messages.reduce((sum, entry) => sum + entry.tokenCount, 0);

    return {
      version: INDEX_VERSION,
      builtAt: new Date().toISOString(),
      modelId: EMBEDDING_MODEL_ID,
      journalPath,
      journalSize: journalStat.size,
      journalMtimeMs: journalStat.mtimeMs,
      indexedMessages: messages.length,
      messages,
      documentFrequencies,
      averageMessageLength: messages.length > 0 ? totalMessageLength / messages.length : 0,
    };
  }

  private getJournalPath() {
    return path.join(getConversationHistoryRoot(), `events.${this.profileId}.jsonl`);
  }

  private getIndexPath() {
    return path.join(getConversationHistoryRoot(), `index.${this.profileId}.json`);
  }
}
