const BM25_K1 = 1.5;
const BM25_B = 0.75;
const HYBRID_RRF_K = 25;

export function tokenize(text: string) {
  return text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
}

export function countTerms(tokens: string[]) {
  const counts: Record<string, number> = {};
  for (const token of tokens) {
    counts[token] = (counts[token] ?? 0) + 1;
  }
  return counts;
}

export function dotProduct(left: number[], right: number[]) {
  let total = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    total += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return total;
}

export function scoreBm25(params: {
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

export function buildDocumentFrequencies(termFrequencies: Array<Record<string, number>>) {
  const documentFrequencies: Record<string, number> = {};
  for (const entry of termFrequencies) {
    for (const token of new Set(Object.keys(entry))) {
      documentFrequencies[token] = (documentFrequencies[token] ?? 0) + 1;
    }
  }
  return documentFrequencies;
}

export function rankHybridMatches<T>(params: {
  items: T[];
  vectorScores: number[];
  bm25Scores: number[];
}) {
  const vectorRanks = new Map(
    [...params.vectorScores.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([index], rank) => [index, rank + 1]),
  );
  const bm25Ranks = new Map(
    [...params.bm25Scores.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([index], rank) => [index, rank + 1]),
  );

  return params.items
    .map((item, index) => ({
      item,
      score:
        1 / (HYBRID_RRF_K + (vectorRanks.get(index) ?? params.items.length)) +
        1 / (HYBRID_RRF_K + (bm25Ranks.get(index) ?? params.items.length)),
      vectorScore: params.vectorScores[index] ?? 0,
      bm25Score: params.bm25Scores[index] ?? 0,
    }))
    .filter((result) => result.vectorScore > 0 || result.bm25Score > 0);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractContextSnippet(text: string, query: string, contextChars = 140) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "";
  }

  const boundedContext = Math.min(Math.max(contextChars, 20), 2_000);
  if (compact.length <= boundedContext * 2 + 40) {
    return compact;
  }

  const firstQueryToken = tokenize(query)[0];
  if (!firstQueryToken) {
    return `${compact.slice(0, boundedContext * 2).trim()}...`;
  }

  const match = compact.toLowerCase().search(new RegExp(escapeRegExp(firstQueryToken), "i"));
  if (match === -1) {
    return `${compact.slice(0, boundedContext * 2).trim()}...`;
  }

  const start = Math.max(0, match - boundedContext);
  const end = Math.min(compact.length, match + firstQueryToken.length + boundedContext);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < compact.length ? "..." : "";
  return `${prefix}${compact.slice(start, end).trim()}${suffix}`;
}
