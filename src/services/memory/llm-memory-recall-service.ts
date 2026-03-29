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

const MAX_CORPUS_CHARS = 600_000;
const MAX_RECALL_RESULTS = 5;

export type LlmRecallMatch = {
  path: string;
  heading: string;
  content: string;
  reason: string;
};

const CORPUS_SYSTEM_PREFIX = "You are a memory recall agent. Below is a corpus of memory documents. When the user asks, return relevant memories as JSON.\n\n## Memory Corpus\n\n";

const RECALL_USER_PREFIX = [
  "Which memories from the corpus are relevant to the following message? Return a JSON array (max 5 entries).",
  'Each entry: { "path": "relative/path.md", "heading": "title", "content": "1-3 line excerpt", "reason": "why relevant" }',
  "Return [] if nothing is relevant. JSON only, no markdown fences, no explanation text.",
  "",
  "User message: ",
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
  private corpusCache: { text: string; mtimeMs: number } | null = null;
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

        const systemPrompt = CORPUS_SYSTEM_PREFIX + corpus;

        const resolved = await this.models.resolveMemoryRecallModel();
        const response = await complete(resolved.runtimeModel, {
          systemPrompt,
          messages: [{
            role: "user",
            content: RECALL_USER_PREFIX + params.userMessage,
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
   * Load all memory markdown files into a single text corpus.
   * Uses the memory document root's mtime as a cheap staleness check —
   * if the directory hasn't changed, returns the cached corpus instantly.
   * Full re-read is ~5-7ms so even a miss is cheap.
   */
  private async loadCorpus(): Promise<string | null> {
    const namespace = this.profiles.getWriteMemoryNamespace(this.profile);
    const memoryDocRoot = path.join(resolveRuntimePath("memory"), "documents", namespace);

    // Check root mtime as a cheap staleness signal
    const rootStat = await stat(memoryDocRoot).catch(() => null);
    const currentMtime = rootStat?.mtimeMs ?? 0;
    if (this.corpusCache && this.corpusCache.mtimeMs === currentMtime) {
      return this.corpusCache.text;
    }

    const segments: string[] = [];
    const charCounter = { total: 0 };

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

      await this.collectMarkdownFiles(dir, memoryDocRoot, segments, seenPaths, charCounter);
      if (charCounter.total >= MAX_CORPUS_CHARS) break;
    }

    if (segments.length === 0) {
      return null;
    }

    const corpus = segments.join("\n\n");
    this.corpusCache = { text: corpus, mtimeMs: currentMtime };

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
    charCounter: { total: number },
  ) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (charCounter.total >= MAX_CORPUS_CHARS) break;

      const fullPath = path.join(dir, entry.name);
      if (seen.has(fullPath)) continue;

      if (entry.isDirectory()) {
        if (entry.name === "identity" || entry.name === "compactions" || entry.name === "legacy") continue;
        await this.collectMarkdownFiles(fullPath, rootDir, segments, seen, charCounter);
        continue;
      }

      if (!entry.name.endsWith(".md") || entry.name === "INDEX.md") continue;

      seen.add(fullPath);
      try {
        const content = await Bun.file(fullPath).text();
        const relativePath = path.relative(rootDir, fullPath);
        const trimmed = content.trim();
        if (!trimmed) continue;

        const segment = `### ${relativePath}\n${trimmed}`;
        if (charCounter.total + segment.length > MAX_CORPUS_CHARS) break;

        segments.push(segment);
        charCounter.total += segment.length;
      } catch {
        // Skip unreadable files
      }
    }
  }
}
