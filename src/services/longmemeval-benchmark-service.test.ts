import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createIsolatedRuntimeRoot } from "../test/isolated-runtime-root";

const repoRoot = process.cwd();
const testRoot = createIsolatedRuntimeRoot("longmemeval-benchmark-service-");

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?test=${Date.now()}-${Math.random()}`) as Promise<T>;
}

beforeEach(() => {
  testRoot.setup();
  fs.mkdirSync(path.join(testRoot.path, ".openelinarotest", "profiles"), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, "profiles/registry.json"),
    path.join(testRoot.path, ".openelinarotest", "profiles/registry.json"),
  );
  fs.mkdirSync(path.join(testRoot.path, ".openelinarotest", "benchmarks/longmemeval/data"), { recursive: true });
});
afterEach(() => testRoot.teardown());

describe("LongMemEvalBenchmarkService", () => {
  test("runs a low-cost retrieval-only benchmark on a synthetic dataset", async () => {
    const dataset = [
      {
        question_id: "synthetic-q1",
        question_type: "single-session-user",
        question: "What gemstone phrase did I mention about zebrakite harmonic lens?",
        answer: "violet orchard",
        question_date: "2026-01-01",
        haystack_session_ids: ["sess-answer", "sess-distractor"],
        haystack_dates: ["2025-12-01", "2025-12-02"],
        haystack_sessions: [
          [
            {
              role: "user",
              content: "Remember this exact phrase: zebrakite harmonic lens violet orchard.",
              has_answer: true,
            },
            {
              role: "assistant",
              content: "Stored.",
            },
          ],
          [
            {
              role: "user",
              content: "We also talked about ordinary groceries and weather.",
            },
          ],
        ],
        answer_session_ids: ["sess-answer"],
      },
      {
        question_id: "synthetic-q2_abs",
        question_type: "abstention",
        question: "What nonexistent item did I never mention?",
        answer: "unknown",
        question_date: "2026-01-01",
        haystack_session_ids: ["sess-none"],
        haystack_dates: ["2025-12-03"],
        haystack_sessions: [
          [
            {
              role: "user",
              content: "This is filler only.",
            },
          ],
        ],
        answer_session_ids: [],
      },
    ];

    fs.writeFileSync(
      path.join(testRoot.path, ".openelinarotest", "benchmarks/longmemeval/data/longmemeval_s_cleaned.json"),
      `${JSON.stringify(dataset, null, 2)}\n`,
      "utf8",
    );

    const { LongMemEvalBenchmarkService } = await importFresh<typeof import("./longmemeval-benchmark-service")>(
      "src/services/longmemeval-benchmark-service.ts",
    );
    const service = new LongMemEvalBenchmarkService(path.join(testRoot.path, ".openelinarotest"), testRoot.path);
    const result = await service.run({
      dataset: "longmemeval_s_cleaned",
      limit: 1,
      topK: 10,
      profileId: "root",
      sampleStrategy: "first_n",
    });

    expect(result.evaluatedQuestions).toBe(1);
    expect(result.skippedAbstentionQuestions).toBe(1);
    expect(result.aggregate.recallAnyAt5).toBe(1);
    expect(result.aggregate.recallAllAt5).toBe(1);
    expect(result.questions[0]?.topResults[0]?.corpusId).toBe("sess-answer");
    expect(fs.existsSync(result.outputPath)).toBe(true);
  });
});
