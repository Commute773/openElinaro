import { describe, expect, test } from "bun:test";
import {
  tokenize,
  countTerms,
  dotProduct,
  scoreBm25,
  buildDocumentFrequencies,
  rankHybridMatches,
  extractContextSnippet,
} from "./hybrid-search";

describe("tokenize", () => {
  test("lowercases and splits on word boundaries", () => {
    expect(tokenize("Hello World")).toEqual(["hello", "world"]);
  });

  test("keeps hyphenated and underscored tokens intact", () => {
    expect(tokenize("foo-bar baz_qux")).toEqual(["foo-bar", "baz_qux"]);
  });

  test("strips punctuation that is not part of a word", () => {
    expect(tokenize("hello, world! (test)")).toEqual(["hello", "world", "test"]);
  });

  test("returns empty array for empty string", () => {
    expect(tokenize("")).toEqual([]);
  });

  test("returns empty array for only punctuation", () => {
    expect(tokenize("!!! ???")).toEqual([]);
  });

  test("handles unicode letters", () => {
    const tokens = tokenize("café naïve");
    expect(tokens).toEqual(["café", "naïve"]);
  });

  test("handles numbers", () => {
    expect(tokenize("version 3 test2")).toEqual(["version", "3", "test2"]);
  });
});

describe("countTerms", () => {
  test("counts term frequencies", () => {
    expect(countTerms(["a", "b", "a", "c", "a"])).toEqual({ a: 3, b: 1, c: 1 });
  });

  test("returns empty object for empty input", () => {
    expect(countTerms([])).toEqual({});
  });
});

describe("dotProduct", () => {
  test("computes dot product of two equal-length vectors", () => {
    expect(dotProduct([1, 2, 3], [4, 5, 6])).toBe(32);
  });

  test("returns 0 for empty vectors", () => {
    expect(dotProduct([], [])).toBe(0);
  });

  test("uses shorter length when vectors differ", () => {
    expect(dotProduct([1, 2], [3, 4, 5])).toBe(11);
  });

  test("handles negative values", () => {
    expect(dotProduct([1, -1], [-1, 1])).toBe(-2);
  });
});

describe("scoreBm25", () => {
  const baseParams = {
    documentLength: 10,
    averageDocumentLength: 10,
    totalDocuments: 100,
    queryTokens: ["hello"],
    termFrequencies: { hello: 2 } as Record<string, number>,
    documentFrequencies: { hello: 10 } as Record<string, number>,
  };

  test("returns positive score when query token appears in document", () => {
    const score = scoreBm25(baseParams);
    expect(score).toBeGreaterThan(0);
  });

  test("returns 0 for empty query tokens", () => {
    expect(scoreBm25({ ...baseParams, queryTokens: [] })).toBe(0);
  });

  test("returns 0 when average document length is 0", () => {
    expect(scoreBm25({ ...baseParams, averageDocumentLength: 0 })).toBe(0);
  });

  test("returns 0 when query token is absent from document", () => {
    expect(
      scoreBm25({ ...baseParams, queryTokens: ["missing"], termFrequencies: {} }),
    ).toBe(0);
  });

  test("higher term frequency yields higher score", () => {
    const lowTf = scoreBm25({ ...baseParams, termFrequencies: { hello: 1 } });
    const highTf = scoreBm25({ ...baseParams, termFrequencies: { hello: 5 } });
    expect(highTf).toBeGreaterThan(lowTf);
  });

  test("rarer terms (lower document frequency) score higher", () => {
    const common = scoreBm25({ ...baseParams, documentFrequencies: { hello: 80 } });
    const rare = scoreBm25({ ...baseParams, documentFrequencies: { hello: 2 } });
    expect(rare).toBeGreaterThan(common);
  });

  test("shorter documents score higher (length normalization)", () => {
    const shortDoc = scoreBm25({ ...baseParams, documentLength: 5 });
    const longDoc = scoreBm25({ ...baseParams, documentLength: 50 });
    expect(shortDoc).toBeGreaterThan(longDoc);
  });

  test("sums scores for multiple query tokens", () => {
    const single = scoreBm25(baseParams);
    const multi = scoreBm25({
      ...baseParams,
      queryTokens: ["hello", "world"],
      termFrequencies: { hello: 2, world: 1 },
      documentFrequencies: { hello: 10, world: 5 },
    });
    expect(multi).toBeGreaterThan(single);
  });
});

describe("buildDocumentFrequencies", () => {
  test("counts how many documents contain each term", () => {
    const result = buildDocumentFrequencies([
      { hello: 3, world: 1 },
      { hello: 1, foo: 2 },
      { foo: 1, world: 1 },
    ]);
    expect(result).toEqual({ hello: 2, world: 2, foo: 2 });
  });

  test("returns empty object for empty input", () => {
    expect(buildDocumentFrequencies([])).toEqual({});
  });

  test("counts each document only once per term regardless of frequency", () => {
    const result = buildDocumentFrequencies([{ a: 100 }, { a: 1 }]);
    expect(result).toEqual({ a: 2 });
  });
});

describe("rankHybridMatches", () => {
  test("returns scored items using reciprocal rank fusion", () => {
    const items = ["docA", "docB", "docC"];
    const results = rankHybridMatches({
      items,
      vectorScores: [0.9, 0.1, 0.5],
      bm25Scores: [0.2, 0.8, 0.5],
    });

    expect(results.length).toBe(3);
    const docA = results.find((r) => r.item === "docA")!;
    expect(docA.vectorScore).toBe(0.9);
    expect(docA.bm25Score).toBe(0.2);
    expect(docA.score).toBeGreaterThan(0);
  });

  test("filters out items with zero scores on both dimensions", () => {
    const results = rankHybridMatches({
      items: ["a", "b"],
      vectorScores: [0.5, 0],
      bm25Scores: [0, 0],
    });
    expect(results.length).toBe(1);
    expect(results[0]!.item).toBe("a");
  });

  test("keeps items that have score on only one dimension", () => {
    const results = rankHybridMatches({
      items: ["a", "b"],
      vectorScores: [0, 0.5],
      bm25Scores: [0.3, 0],
    });
    expect(results.length).toBe(2);
  });

  test("returns empty array for empty input", () => {
    const results = rankHybridMatches({
      items: [],
      vectorScores: [],
      bm25Scores: [],
    });
    expect(results).toEqual([]);
  });

  test("RRF scoring ranks item highest when it ranks well on both dimensions", () => {
    const results = rankHybridMatches({
      items: ["both-good", "vector-only", "bm25-only"],
      vectorScores: [0.9, 0.8, 0.1],
      bm25Scores: [0.9, 0.1, 0.8],
    });
    const sorted = results.sort((a, b) => b.score - a.score);
    expect(sorted[0]!.item).toBe("both-good");
  });
});

describe("extractContextSnippet", () => {
  test("returns full text when short enough", () => {
    const snippet = extractContextSnippet("Hello world", "hello");
    expect(snippet).toBe("Hello world");
  });

  test("returns empty string for empty text", () => {
    expect(extractContextSnippet("", "query")).toBe("");
  });

  test("returns empty string for whitespace-only text", () => {
    expect(extractContextSnippet("   \n  ", "query")).toBe("");
  });

  test("collapses whitespace", () => {
    const snippet = extractContextSnippet("hello   world\n\nfoo", "hello");
    expect(snippet).toBe("hello world foo");
  });

  test("shows context around query match in long text", () => {
    const longText = "x ".repeat(200) + "TARGET_WORD " + "y ".repeat(200);
    const snippet = extractContextSnippet(longText, "target_word");
    expect(snippet).toContain("TARGET_WORD");
    expect(snippet.startsWith("...")).toBe(true);
    expect(snippet.endsWith("...")).toBe(true);
  });

  test("truncates from start when query not found in long text", () => {
    const longText = "word ".repeat(200);
    const snippet = extractContextSnippet(longText, "zzz_missing");
    expect(snippet.endsWith("...")).toBe(true);
    expect(snippet.length).toBeLessThan(longText.length);
  });

  test("truncates from start when query is empty in long text", () => {
    const longText = "word ".repeat(200);
    const snippet = extractContextSnippet(longText, "");
    expect(snippet.endsWith("...")).toBe(true);
  });

  test("respects contextChars parameter", () => {
    const longText = "a ".repeat(500) + "NEEDLE " + "b ".repeat(500);
    const small = extractContextSnippet(longText, "needle", 30);
    const large = extractContextSnippet(longText, "needle", 300);
    expect(large.length).toBeGreaterThan(small.length);
  });

  test("escapes regex special characters in query", () => {
    const text = "a ".repeat(200) + "foo.bar+baz " + "c ".repeat(200);
    const snippet = extractContextSnippet(text, "foo.bar+baz");
    expect(snippet).toContain("foo.bar+baz");
  });
});
