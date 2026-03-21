import { env, pipeline, type FeatureExtractionPipeline, type Tensor } from "@xenova/transformers";
import type { AgentToolScope, ToolCatalogCard, ToolSearchResult } from "../domain/tool-catalog";
import { resolveRuntimePath } from "./runtime-root";
import { telemetry } from "./telemetry";

const EMBEDDING_CACHE_DIR = resolveRuntimePath("models/transformers");
const EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_BATCH_SIZE = 8;
const BM25_K1 = 1.5;
const BM25_B = 0.75;
const HYBRID_RRF_K = 25;
const toolSearchTelemetry = telemetry.child({ component: "tool_search" });

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

type SearchParams = {
  cards: ToolCatalogCard[];
  query: string;
  limit?: number;
  agentScope?: AgentToolScope;
  excludeAliases?: boolean;
};

function tokenize(text: string) {
  return text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
}

function normalizePhrase(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function exactNameMatchBonus(query: string, card: ToolCatalogCard) {
  const normalizedQuery = normalizePhrase(query);
  if (!normalizedQuery) {
    return 0;
  }

  const queryTokens = new Set(tokenize(query).map((token) => token.replace(/[_-]+/g, "")));
  const candidateNames = [card.canonicalName, card.name];
  let best = 0;

  for (const candidate of candidateNames) {
    const normalizedCandidate = normalizePhrase(candidate);
    if (!normalizedCandidate) {
      continue;
    }

    if (normalizedQuery === normalizedCandidate) {
      best = Math.max(best, 1_000);
      continue;
    }

    if (normalizedQuery.startsWith(`${normalizedCandidate} `)) {
      best = Math.max(best, 400);
      continue;
    }

    if (` ${normalizedQuery} `.includes(` ${normalizedCandidate} `)) {
      best = Math.max(best, 250);
      continue;
    }

    const candidateTokens = tokenize(candidate).map((token) => token.replace(/[_-]+/g, ""));
    if (candidateTokens.length > 0 && candidateTokens.every((token) => queryTokens.has(token))) {
      best = Math.max(best, 100);
    }
  }

  return best;
}

function countTerms(tokens: string[]) {
  const counts: Record<string, number> = {};
  for (const token of tokens) {
    counts[token] = (counts[token] ?? 0) + 1;
  }
  return counts;
}

function dotProduct(left: number[], right: number[]) {
  let total = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    total += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return total;
}

function scoreBm25(params: {
  documentLength: number;
  averageDocumentLength: number;
  totalDocuments: number;
  queryTokens: string[];
  termFrequencies: Record<string, number>;
  documentFrequencies: Record<string, number>;
}) {
  if (params.queryTokens.length === 0 || params.averageDocumentLength === 0) {
    return 0;
  }

  let score = 0;
  for (const token of params.queryTokens) {
    const termFrequency = params.termFrequencies[token] ?? 0;
    if (termFrequency === 0) {
      continue;
    }

    const documentFrequency = params.documentFrequencies[token] ?? 0;
    const idf = Math.log(
      1 + (params.totalDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5),
    );
    const numerator = termFrequency * (BM25_K1 + 1);
    const denominator =
      termFrequency +
      BM25_K1 *
        (1 - BM25_B + BM25_B * (params.documentLength / params.averageDocumentLength));
    score += idf * (numerator / denominator);
  }

  return score;
}

async function getEmbeddingExtractor() {
  env.cacheDir = EMBEDDING_CACHE_DIR;
  env.allowLocalModels = true;
  env.allowRemoteModels = true;

  if (!extractorPromise) {
    extractorPromise = pipeline(
      "feature-extraction",
      EMBEDDING_MODEL_ID,
    ) as Promise<FeatureExtractionPipeline>;
  }

  return extractorPromise;
}

async function embedTexts(texts: string[]) {
  const extractor = await getEmbeddingExtractor();
  const vectors: number[][] = [];

  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBEDDING_BATCH_SIZE);
    if (batch.length === 0) {
      continue;
    }

    const output = await extractor(batch, {
      pooling: "mean",
      normalize: true,
    }) as Tensor;
    const rows = output.dims[0] ?? 0;
    const dimensions = output.dims[1] ?? 0;
    const raw = Array.from(output.data as Float32Array);
    for (let row = 0; row < rows; row += 1) {
      const offset = row * dimensions;
      vectors.push(raw.slice(offset, offset + dimensions));
    }
  }

  return vectors;
}

function traceSpan<T>(
  operation: string,
  fn: () => Promise<T>,
  options?: { attributes?: Record<string, unknown> },
) {
  return toolSearchTelemetry.span(operation, options?.attributes ?? {}, fn);
}

export class ToolSearchService {
  private readonly embeddingCache = new Map<string, number[]>();

  async search(params: SearchParams): Promise<ToolSearchResult[]> {
    return traceSpan(
      "tool_search.search",
      async () => {
        const filtered = params.cards.filter((card) => {
          if (params.agentScope && !card.agentScopes.includes(params.agentScope)) {
            return false;
          }
          if (params.excludeAliases !== false && card.aliasOf) {
            return false;
          }
          return true;
        });
        const query = params.query.trim();
        if (!query || filtered.length === 0) {
          return [];
        }

        const queryTokens = tokenize(query);
        const cardTokens = filtered.map((card) => tokenize(card.searchText));
        const averageDocumentLength =
          cardTokens.reduce((sum, tokens) => sum + tokens.length, 0) / filtered.length;
        const documentFrequencies: Record<string, number> = {};

        for (const tokens of cardTokens) {
          for (const token of new Set(tokens)) {
            documentFrequencies[token] = (documentFrequencies[token] ?? 0) + 1;
          }
        }

        const lexicalScores = cardTokens.map((tokens) =>
          scoreBm25({
            documentLength: tokens.length,
            averageDocumentLength,
            totalDocuments: filtered.length,
            queryTokens,
            termFrequencies: countTerms(tokens),
            documentFrequencies,
          }));

        const vectorScores = await this.computeVectorScores(filtered, query);
        const vectorRanks = new Map(
          [...vectorScores.entries()]
            .sort((left, right) => right[1] - left[1])
            .map(([index], rank) => [index, rank]),
        );
        const lexicalRanks = new Map(
          [...lexicalScores.entries()]
            .sort((left, right) => right[1] - left[1])
            .map(([index], rank) => [index, rank]),
        );

        return filtered
          .map((card, index) => ({
            card,
            nameMatchBonus: exactNameMatchBonus(query, card),
            score:
              1 / (HYBRID_RRF_K + (vectorRanks.get(index) ?? filtered.length)) +
              1 / (HYBRID_RRF_K + (lexicalRanks.get(index) ?? filtered.length)) +
              exactNameMatchBonus(query, card),
            vectorScore: vectorScores[index] ?? 0,
            lexicalScore: lexicalScores[index] ?? 0,
          }))
          .filter((result) => result.vectorScore > 0 || result.lexicalScore > 0 || result.nameMatchBonus > 0)
          .sort((left, right) => right.score - left.score)
          .slice(0, params.limit ?? 8);
      },
      {
        attributes: {
          cardCount: params.cards.length,
          filteredCount: params.cards.filter((card) =>
            (!params.agentScope || card.agentScopes.includes(params.agentScope)) &&
            (params.excludeAliases === false || !card.aliasOf)
          ).length,
          limit: params.limit ?? 8,
        },
      },
    );
  }

  private async computeVectorScores(cards: ToolCatalogCard[], query: string) {
    try {
      const [queryVector] = await embedTexts([query]);
      const textsToEmbed = cards
        .map((card) => ({ key: this.embeddingKey(card), text: card.searchText }))
        .filter((entry) => !this.embeddingCache.has(entry.key));

      if (textsToEmbed.length > 0) {
        const vectors = await embedTexts(textsToEmbed.map((entry) => entry.text));
        textsToEmbed.forEach((entry, index) => {
          this.embeddingCache.set(entry.key, vectors[index] ?? []);
        });
      }

      return cards.map((card) => {
        const vector = this.embeddingCache.get(this.embeddingKey(card)) ?? [];
        return dotProduct(queryVector ?? [], vector);
      });
    } catch (error) {
      toolSearchTelemetry.event(
        "tool_search.embedding_failed",
        {
          error: error instanceof Error ? error.message : String(error),
          modelId: EMBEDDING_MODEL_ID,
        },
        { level: "warn", outcome: "error" },
      );
      return cards.map(() => 0);
    }
  }

  private embeddingKey(card: ToolCatalogCard) {
    return `${card.name}:${card.searchText}`;
  }
}
