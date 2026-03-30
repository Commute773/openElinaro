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

function formatLlmRecallBlock(content: string) {
  return [
    "<llm_recalled_memory>",
    content,
    "</llm_recalled_memory>",
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

}
