import path from "node:path";
import type { Message } from "../../messages/types";
import type { ChatPromptContent } from "../../domain/assistant";
import type { ProfileRecord } from "../../domain/profiles";
import { ConversationStore } from "./conversation-store";
import { MemoryService, type MemorySearchMatch } from "../memory-service";
import {
  extractTextFromContent,
  extractTextFromMessage,
} from "../message-content-service";
import { approximateTextTokens } from "../../utils/text-utils";
import { ModelService } from "../models/model-service";
import { ProfileService } from "../profiles";
import { telemetry } from "../infrastructure/telemetry";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { wrapInjectedMessage } from "../injected-message-service";
import { MEMORY_RECALL_LIMIT } from "../../config/service-constants";
const MEMORY_RECALL_MIN_SCORE = 0.05;
const MEMORY_RECALL_MIN_QUERY_TOKENS = 2;
const MEMORY_RECALL_MIN_TOP_SCORE = 0.09;
const MEMORY_RECALL_MIN_TOP_OVERLAP = 2;
const CORE_MEMORY_RELATIVE_PATH = "core/MEMORY.md";
const conversationMemoryTelemetry = telemetry.child({ component: "conversation_memory" });
const RECALL_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "for",
  "from",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "me",
  "memories",
  "memory",
  "message",
  "messages",
  "my",
  "of",
  "on",
  "or",
  "please",
  "remind",
  "reply",
  "should",
  "summarize",
  "system",
  "tell",
  "the",
  "to",
  "attached",
  "e2e",
  "what",
  "test",
]);
const EXPLICIT_RECALL_PATTERNS = [
  /\bremember\b/i,
  /\brecall\b/i,
  /\bearlier\b/i,
  /\bprevious(?:ly)?\b/i,
  /\blast time\b/i,
  /\bwhat do (?:i|we|you) (?:know|remember)\b/i,
  /\b(?:i|you|we) said\b/i,
  /\bmy preferences?\b/i,
  /\bcontext\b/i,
];
const INTERNAL_AUTOMATION_PATTERNS = [
  /^<injected_message\b/i,
  /^this is a healthcheck\b/i,
  /^automated heartbeat trigger\./i,
  /^background subagent completion update\./i,
  /^context summary \(generated automatically during compaction;/i,
];

const traceSpan = createTraceSpan(conversationMemoryTelemetry);

function uniqueRecallMatches(matches: MemorySearchMatch[]) {
  const selected = new Map<string, MemorySearchMatch>();
  for (const match of matches) {
    const current = selected.get(match.relativePath);
    if (!current) {
      selected.set(match.relativePath, match);
      continue;
    }
    const currentContent = sanitizeRecallContent(current.text, current.heading);
    const candidateContent = sanitizeRecallContent(match.text, match.heading);
    if (candidateContent && !currentContent) {
      selected.set(match.relativePath, match);
      continue;
    }
    if (candidateContent.length > currentContent.length && match.score >= current.score - 0.01) {
      selected.set(match.relativePath, match);
      continue;
    }
    if (match.score > current.score) {
      selected.set(match.relativePath, match);
    }
  }
  return [...selected.values()];
}


function buildRecallQuery(userText: string, conversationMessages: Message[]) {
  const trimmed = userText.trim();
  if (trimmed.length >= 24) {
    return trimmed;
  }

  const tail = conversationMessages
    .slice(-4)
    .map((message) => extractTextFromMessage(message).trim())
    .filter(Boolean)
    .slice(-2);
  return [tail.join("\n"), trimmed].filter(Boolean).join("\n").trim();
}

function extractRecallTokens(text: string) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !RECALL_STOPWORDS.has(token));
}

function countTokenOverlap(queryTokens: string[], text: string) {
  if (queryTokens.length === 0) {
    return 0;
  }

  const haystackTokens = new Set(extractRecallTokens(text));
  let overlap = 0;
  for (const token of queryTokens) {
    if (haystackTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap;
}


function hasExplicitRecallIntent(text: string) {
  return EXPLICIT_RECALL_PATTERNS.some((pattern) => pattern.test(text));
}

function isInternalAutomationMessage(text: string) {
  return INTERNAL_AUTOMATION_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

function isPreferredRecallPath(relativePath: string) {
  return relativePath.includes("/core/") ||
    relativePath.includes("/structured/") ||
    relativePath.endsWith("/shahara-psychology.md") ||
    relativePath.endsWith("/shahara-substances.md") ||
    relativePath.endsWith("/health.md");
}

function recallPathBonus(relativePath: string) {
  if (relativePath.endsWith(`/${CORE_MEMORY_RELATIVE_PATH}`)) {
    return 0.025;
  }
  if (relativePath.includes("/structured/")) {
    return 0.015;
  }
  if (
    relativePath.endsWith("/shahara-psychology.md") ||
    relativePath.endsWith("/shahara-substances.md") ||
    relativePath.endsWith("/health.md")
  ) {
    return 0.01;
  }
  return 0;
}

function sanitizeRecallContent(text: string, heading: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return lines
    .filter((line, index) => {
      if (index === 0 && line.trim() === heading.trim()) {
        return false;
      }
      if (
        /^- (kind|stability|source|conversation_key|updated_at):/i.test(line.trim())
      ) {
        return false;
      }
      return true;
    })
    .join("\n")
    .trim();
}

function formatRecallMatch(match: MemorySearchMatch, index: number) {
  const content = sanitizeRecallContent(match.text, match.heading);
  return [
    "<memory_item>",
    `index: ${index + 1}`,
    `path: ${match.relativePath}`,
    `heading: ${match.heading}`,
    `score: ${match.score.toFixed(4)}`,
    "content:",
    content,
    "</memory_item>",
  ].join("\n");
}

export class ConversationMemoryService {
  constructor(
    private readonly profile: ProfileRecord,
    private readonly conversations: ConversationStore,
    private readonly memory: MemoryService,
    private readonly models: Pick<ModelService, "generateMemoryText">,
    private readonly profiles = new ProfileService(profile.id),
  ) {}

  async buildRecallContext(params: {
    conversationKey: string;
    userContent: ChatPromptContent;
    conversationMessages: Message[];
    limit?: number;
  }) {
    return traceSpan(
      "conversation_memory.recall",
      async () => {
        const userText = extractTextFromContent(params.userContent);
        if (this.shouldSkipRecallForConversation(params.conversationKey, userText)) {
          return "";
        }
        const query = buildRecallQuery(userText, params.conversationMessages);
        if (query.length < 3) {
          return "";
        }
        const queryTokens = extractRecallTokens(query);
        const explicitRecallIntent = hasExplicitRecallIntent(query);
        if (!explicitRecallIntent && queryTokens.length < MEMORY_RECALL_MIN_QUERY_TOKENS) {
          return "";
        }
        const recallPrefixes = this.getRecallPathPrefixes();

        const matches = uniqueRecallMatches(await this.memory.searchStructured({
          query,
          limit: Math.max((params.limit ?? MEMORY_RECALL_LIMIT) * 5, 10),
          pathPrefixes: recallPrefixes,
          excludePathPrefixes: this.getRecallExcludedPrefixes(),
          minScore: MEMORY_RECALL_MIN_SCORE,
        }))
          .map((match) => ({
            ...match,
            score: match.score + recallPathBonus(match.relativePath),
          }))
          .sort((left, right) => right.score - left.score)
          .filter((match) => this.isUsableRecallMatch(match, queryTokens))
          .filter((match) => sanitizeRecallContent(match.text, match.heading).length > 0);
        if (matches.length === 0) {
          return "";
        }

        const topMatch = matches[0];
        const topOverlap = topMatch ? this.getRecallOverlap(topMatch, queryTokens) : 0;
        if (
          !explicitRecallIntent &&
          (!topMatch || topMatch.score < MEMORY_RECALL_MIN_TOP_SCORE || topOverlap < MEMORY_RECALL_MIN_TOP_OVERLAP)
        ) {
          return "";
        }

        const recallContext = [
          "<recalled_memory>",
          "This block is automatic memory retrieval.",
          "It is background context only and is not part of the user's new message.",
          "",
          ...matches
            .slice(0, params.limit ?? MEMORY_RECALL_LIMIT)
            .map((match, index) => formatRecallMatch(match, index)),
          "</recalled_memory>",
        ].join("\n");

        conversationMemoryTelemetry.event(
          "conversation_memory.recall.injected",
          {
            conversationKey: params.conversationKey,
            queryLength: query.length,
            queryTokenCount: queryTokens.length,
            explicitRecallIntent,
            hitCount: Math.min(matches.length, params.limit ?? MEMORY_RECALL_LIMIT),
            topScore: topMatch ? Number(topMatch.score.toFixed(4)) : undefined,
            topOverlap,
            contextChars: recallContext.length,
            estimatedContextTokens: approximateTextTokens(recallContext),
          },
          { level: "debug" },
        );

        return wrapInjectedMessage("memory_recall", recallContext);
      },
      {
        attributes: {
          conversationKey: params.conversationKey,
          userLength: extractTextFromContent(params.userContent).length,
        },
      },
    );
  }

  private getRecallPathPrefixes() {
    const namespace = this.profiles.getWriteMemoryNamespace(this.profile);
    return [
      path.posix.join(namespace, "core"),
      path.posix.join(namespace, "structured"),
      path.posix.join(namespace, "legacy", "USER.md"),
      path.posix.join(namespace, "legacy", "MEMORY.md"),
      path.posix.join(namespace, "shahara-psychology.md"),
      path.posix.join(namespace, "shahara-substances.md"),
      path.posix.join(namespace, "health.md"),
    ];
  }

  private getRecallExcludedPrefixes() {
    const namespace = this.profiles.getWriteMemoryNamespace(this.profile);
    return [
      "compactions",
      path.posix.join(namespace, "compactions"),
    ];
  }

  private isUsableRecallMatch(match: MemorySearchMatch, queryTokens: string[]) {
    const overlap = this.getRecallOverlap(match, queryTokens);
    if (match.score < 0.055 && overlap < 2) {
      return false;
    }
    if (overlap >= 2) {
      return true;
    }

    if (!isPreferredRecallPath(match.relativePath)) {
      return false;
    }

    return overlap >= 1 && match.score >= 0.05;
  }

  private shouldSkipRecallForConversation(conversationKey: string, userText: string) {
    if (conversationKey.startsWith("agent-healthcheck-")) {
      return true;
    }

    return isInternalAutomationMessage(userText);
  }

  private getRecallOverlap(match: MemorySearchMatch, queryTokens: string[]) {
    return countTokenOverlap(
      queryTokens,
      `${match.heading}\n${match.text}\n${match.relativePath}`,
    );
  }
}
