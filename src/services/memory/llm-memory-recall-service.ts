import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { complete } from "@mariozechner/pi-ai";
import type { TextContent } from "@mariozechner/pi-ai";
import type { ProfileRecord } from "../../domain/profiles";
import type { ModelService } from "../models/model-service";
import { ProfileService } from "../profiles";
import { resolveRuntimePath } from "../runtime-root";
import { telemetry } from "../infrastructure/telemetry";
import { createTraceSpan } from "../../utils/telemetry-helpers";

const llmRecallTelemetry = telemetry.child({ component: "llm_memory_recall" });
const traceSpan = createTraceSpan(llmRecallTelemetry);

const MAX_MEMORY_CORPUS_CHARS = 120_000;
const MAX_RECALL_RESULTS = 5;

export type LlmRecallMatch = {
  path: string;
  heading: string;
  content: string;
  reason: string;
};

const RECALL_SYSTEM_PROMPT = [
  "You are a memory recall agent. You have been given a corpus of memory documents.",
  "When the user sends a message, identify which memories are relevant to that message.",
  "Return a JSON array of up to 5 relevant memories. Each entry has:",
  '  { "path": "category/slug.md", "heading": "title", "content": "relevant excerpt", "reason": "why this is relevant" }',
  "",
  "Rules:",
  "- Only return memories that are genuinely relevant to the user's message",
  "- If nothing is relevant, return an empty array: []",
  "- Prefer specific, actionable memories over vague matches",
  "- Keep content excerpts concise (1-3 bullets or sentences)",
  "- Return valid JSON only, no markdown fences, no explanation",
].join("\n");

function stripCodeFence(text: string) {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseRecallResponse(raw: string): LlmRecallMatch[] {
  const cleaned = stripCodeFence(raw);
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item: any) =>
          typeof item.path === "string" &&
          typeof item.heading === "string" &&
          typeof item.content === "string",
      )
      .slice(0, MAX_RECALL_RESULTS)
      .map((item: any) => ({
        path: item.path,
        heading: item.heading,
        content: item.content,
        reason: item.reason ?? "",
      }));
  } catch {
    const firstBracket = cleaned.indexOf("[");
    const lastBracket = cleaned.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      try {
        const parsed = JSON.parse(cleaned.slice(firstBracket, lastBracket + 1));
        if (Array.isArray(parsed)) {
          return parsed
            .filter(
              (item: any) =>
                typeof item.path === "string" &&
                typeof item.heading === "string",
            )
            .slice(0, MAX_RECALL_RESULTS);
        }
      } catch {
        // fall through
      }
    }
    return [];
  }
}

/**
 * LLM-based memory recall service.
 *
 * Loads all memory markdown files into the system prompt as a cached corpus,
 * then queries the LLM with each user message to surface relevant memories.
 * Uses a stable sessionId so the provider can cache the system prompt prefix
 * across calls.
 */
export class LlmMemoryRecallService {
  private corpusCache: { text: string; builtAt: number } | null = null;
  private readonly profiles: ProfileService;
  private readonly sessionId: string;

  constructor(
    private readonly profile: ProfileRecord,
    private readonly models: Pick<ModelService, "resolveMemoryRecallModel">,
    profiles?: ProfileService,
  ) {
    this.profiles = profiles ?? new ProfileService(profile.id);
    // Stable session ID so the provider caches the system prompt prefix
    this.sessionId = `memory-recall:${profile.id}`;
  }

  /**
   * Query the LLM for memories relevant to the given user message.
   */
  async recall(params: {
    userMessage: string;
    conversationKey: string;
  }): Promise<LlmRecallMatch[]> {
    return traceSpan(
      "llm_memory_recall.recall",
      async () => {
        const corpus = await this.loadCorpus();
        if (!corpus) {
          return [];
        }

        const systemPrompt = [
          RECALL_SYSTEM_PROMPT,
          "",
          "## Memory Corpus",
          "",
          corpus,
        ].join("\n");

        const resolved = await this.models.resolveMemoryRecallModel();
        const response = await complete(resolved.runtimeModel, {
          systemPrompt,
          messages: [{
            role: "user",
            content: params.userMessage,
            timestamp: Date.now(),
          }],
        }, {
          apiKey: resolved.apiKey,
          sessionId: this.sessionId,
          cacheRetention: "long",
          maxTokens: 1_024,
        });

        const responseText = response.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("")
          .trim();

        const matches = parseRecallResponse(responseText);

        llmRecallTelemetry.event("llm_memory_recall.completed", {
          conversationKey: params.conversationKey,
          userMessageLength: params.userMessage.length,
          corpusChars: corpus.length,
          matchCount: matches.length,
          cacheRead: response.usage?.cacheRead ?? 0,
          cacheWrite: response.usage?.cacheWrite ?? 0,
          inputTokens: response.usage?.input ?? 0,
          outputTokens: response.usage?.output ?? 0,
        });

        return matches;
      },
      {
        attributes: {
          conversationKey: params.conversationKey,
          userMessageLength: params.userMessage.length,
        },
      },
    );
  }

  /**
   * Invalidate the in-memory corpus cache so the next recall re-reads from disk.
   */
  invalidateCorpus() {
    this.corpusCache = null;
  }

  /**
   * Load all memory markdown files into a single text corpus.
   * Cached in memory for 5 minutes to avoid re-reading on every turn.
   */
  private async loadCorpus(): Promise<string | null> {
    const CACHE_TTL_MS = 5 * 60 * 1_000;
    if (this.corpusCache && Date.now() - this.corpusCache.builtAt < CACHE_TTL_MS) {
      return this.corpusCache.text;
    }

    const namespace = this.profiles.getWriteMemoryNamespace(this.profile);
    const memoryDocRoot = path.join(resolveRuntimePath("memory"), "documents", namespace);

    const segments: string[] = [];
    let totalChars = 0;

    // Prioritized paths: structured memory first, then core, then other docs
    const prioritizedDirs = [
      path.join(memoryDocRoot, "structured"),
      path.join(memoryDocRoot, "core"),
      memoryDocRoot,
    ];

    const seenPaths = new Set<string>();

    for (const dir of prioritizedDirs) {
      const dirStat = await stat(dir).catch(() => null);
      if (!dirStat?.isDirectory()) continue;

      await this.collectMarkdownFiles(dir, memoryDocRoot, segments, seenPaths, () => totalChars);
      totalChars = segments.reduce((sum, s) => sum + s.length, 0);
      if (totalChars >= MAX_MEMORY_CORPUS_CHARS) break;
    }

    if (segments.length === 0) {
      return null;
    }

    const corpus = segments.join("\n\n");
    this.corpusCache = { text: corpus, builtAt: Date.now() };

    llmRecallTelemetry.event("llm_memory_recall.corpus_loaded", {
      profileId: this.profile.id,
      documentCount: segments.length,
      corpusChars: corpus.length,
    });

    return corpus;
  }

  private async collectMarkdownFiles(
    dir: string,
    rootDir: string,
    segments: string[],
    seen: Set<string>,
    getCurrentChars: () => number,
  ) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (getCurrentChars() >= MAX_MEMORY_CORPUS_CHARS) break;

      const fullPath = path.join(dir, entry.name);
      if (seen.has(fullPath)) continue;

      if (entry.isDirectory()) {
        // Skip identity and compactions directories
        if (entry.name === "identity" || entry.name === "compactions" || entry.name === "legacy") continue;
        await this.collectMarkdownFiles(fullPath, rootDir, segments, seen, getCurrentChars);
        continue;
      }

      if (!entry.name.endsWith(".md") || entry.name === "INDEX.md") continue;

      seen.add(fullPath);
      try {
        const content = await Bun.file(fullPath).text();
        const relativePath = path.relative(rootDir, fullPath);
        const trimmed = content.trim();
        if (!trimmed) continue;

        // Skip very large files
        if (trimmed.length > 8_000) continue;

        const segment = `### ${relativePath}\n${trimmed}`;
        if (getCurrentChars() + segment.length > MAX_MEMORY_CORPUS_CHARS) break;

        segments.push(segment);
      } catch {
        // Skip unreadable files
      }
    }
  }
}
