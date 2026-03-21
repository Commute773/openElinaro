import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { ProfileRecord } from "../domain/profiles";
import { MemoryService } from "./memory-service";
import { ProfileService } from "./profile-service";
import { getServiceRootDir, getUserDataRootDir, resolveRuntimePath } from "./runtime-root";

const LONGMEMEVAL_DATASET_URLS = {
  longmemeval_s_cleaned: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json",
  longmemeval_oracle: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json",
} as const;

export type LongMemEvalDatasetName = keyof typeof LONGMEMEVAL_DATASET_URLS;

type LongMemEvalTurn = {
  role: string;
  content: string;
  has_answer?: boolean;
};

type LongMemEvalEntry = {
  question_id: string;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: LongMemEvalTurn[][];
  answer_session_ids: string[];
};

export type LongMemEvalBenchmarkConfig = {
  dataset: LongMemEvalDatasetName;
  limit: number;
  topK: 5 | 10;
  profileId: string;
  sampleStrategy: "round_robin_question_type" | "first_n";
};

type CorpusDocument = {
  corpusId: string;
  relativePath: string;
  content: string;
};

type QuestionBenchmarkResult = {
  questionId: string;
  questionType: string;
  questionLength: number;
  corpusSize: number;
  correctSessionCount: number;
  metrics: {
    recallAnyAt5: number;
    recallAllAt5: number;
    ndcgAnyAt5: number;
    recallAnyAt10: number;
    recallAllAt10: number;
    ndcgAnyAt10: number;
  };
  latency: {
    reindexMs: number;
    searchMs: number;
  };
  topResults: Array<{
    corpusId: string;
    score: number;
  }>;
};

export type LongMemEvalBenchmarkSummary = {
  benchmark: "LongMemEval";
  mode: "retrieval_only";
  config: LongMemEvalBenchmarkConfig;
  datasetPath: string;
  datasetSize: number;
  evaluatedQuestions: number;
  skippedAbstentionQuestions: number;
  aggregate: {
    recallAnyAt5: number;
    recallAllAt5: number;
    ndcgAnyAt5: number;
    recallAnyAt10: number;
    recallAllAt10: number;
    ndcgAnyAt10: number;
    avgReindexMs: number;
    avgSearchMs: number;
    p95SearchMs: number;
  };
  questions: QuestionBenchmarkResult[];
  outputPath: string;
};

function percentile(sortedValues: number[], ratio: number) {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * ratio) - 1),
  );
  return sortedValues[index] ?? 0;
}

function average(values: number[]) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function dcg(relevances: number[], k: number) {
  const sliced = relevances.slice(0, k);
  if (sliced.length === 0) {
    return 0;
  }
  return sliced[0]! + sliced
    .slice(1)
    .reduce((sum, relevance, index) => sum + (relevance / Math.log2(index + 2)), 0);
}

function ndcg(rankings: number[], correctDocs: string[], corpusIds: string[], k: number) {
  const relevances = corpusIds.map((docId) => correctDocs.includes(docId) ? 1 : 0);
  const sortedRelevances = rankings.slice(0, k).map((index) => relevances[index] ?? 0);
  const idealRelevance = [...relevances].sort((left, right) => right - left);
  const idealDcg = dcg(idealRelevance, k);
  if (idealDcg === 0) {
    return 0;
  }
  return dcg(sortedRelevances, k) / idealDcg;
}

function evaluateRetrieval(rankings: number[], correctDocs: string[], corpusIds: string[], k: number) {
  const recalledDocs = new Set(rankings.slice(0, k).map((index) => corpusIds[index]).filter(Boolean));
  return {
    recallAny: Number(correctDocs.some((doc) => recalledDocs.has(doc))),
    recallAll: Number(correctDocs.every((doc) => recalledDocs.has(doc))),
    ndcgAny: ndcg(rankings, correctDocs, corpusIds, k),
  };
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "item";
}

function round(value: number) {
  return Number(value.toFixed(4));
}

function formatSessionMarkdown(params: {
  sessionId: string;
  sessionDate: string;
  turns: LongMemEvalTurn[];
}) {
  return [
    `# Session ${params.sessionId}`,
    "",
    `- session_id: ${params.sessionId}`,
    `- date: ${params.sessionDate}`,
    "",
    ...params.turns.flatMap((turn, index) => [
      `## Turn ${index + 1} (${turn.role})`,
      "",
      turn.content.trim(),
      "",
    ]),
  ].join("\n").trimEnd();
}

function buildSessionCorpus(entry: LongMemEvalEntry): CorpusDocument[] {
  return entry.haystack_session_ids.map((sessionId, index) => ({
    corpusId: sessionId,
    relativePath: path.posix.join(
      "benchmark",
      slugify(entry.question_id),
      `${index + 1}-${slugify(sessionId)}.md`,
    ),
    content: formatSessionMarkdown({
      sessionId,
      sessionDate: entry.haystack_dates[index] ?? "",
      turns: entry.haystack_sessions[index] ?? [],
    }),
  }));
}

function buildRankings(corpusIds: string[], rankedCorpusIds: string[]) {
  const seen = new Set<string>();
  const ordered = rankedCorpusIds.filter((corpusId) => {
    if (seen.has(corpusId) || !corpusIds.includes(corpusId)) {
      return false;
    }
    seen.add(corpusId);
    return true;
  });
  const trailing = corpusIds.filter((corpusId) => !seen.has(corpusId));
  const fullOrder = ordered.concat(trailing);
  return fullOrder
    .map((corpusId) => corpusIds.indexOf(corpusId))
    .filter((index) => index >= 0);
}

function uniqueTopResults(entries: Array<{ corpusId: string; score: number }>) {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.corpusId)) {
      return false;
    }
    seen.add(entry.corpusId);
    return true;
  });
}

async function copyProfileRegistry(sourceUserDataRoot: string, serviceRoot: string, destinationUserDataRoot: string) {
  const liveSource = path.join(sourceUserDataRoot, "profiles", "registry.json");
  const starterSource = path.join(serviceRoot, "profiles/registry.json");
  let source = starterSource;
  try {
    await fs.access(liveSource);
    source = liveSource;
  } catch {
    // Fall back to the bundled starter registry when no live profile registry exists yet.
  }
  const destination = path.join(destinationUserDataRoot, "profiles", "registry.json");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function ensureDatasetFile(userDataRoot: string, dataset: LongMemEvalDatasetName) {
  const datasetDirectory = path.join(userDataRoot, "benchmarks", "longmemeval", "data");
  const datasetPath = path.join(datasetDirectory, `${dataset}.json`);
  try {
    await fs.access(datasetPath);
    return datasetPath;
  } catch {
    // continue
  }

  await fs.mkdir(datasetDirectory, { recursive: true });
  const response = await fetch(LONGMEMEVAL_DATASET_URLS[dataset]);
  if (!response.ok) {
    throw new Error(`Failed to download ${dataset}: HTTP ${response.status}`);
  }
  await fs.writeFile(datasetPath, await response.text(), "utf8");
  return datasetPath;
}

function selectEntries(entries: LongMemEvalEntry[], config: LongMemEvalBenchmarkConfig) {
  const eligible = entries
    .filter((entry) => !entry.question_id.endsWith("_abs"))
    .sort((left, right) => left.question_id.localeCompare(right.question_id));
  if (config.sampleStrategy === "first_n") {
    return eligible.slice(0, config.limit);
  }

  const groups = new Map<string, LongMemEvalEntry[]>();
  for (const entry of eligible) {
    const list = groups.get(entry.question_type) ?? [];
    list.push(entry);
    groups.set(entry.question_type, list);
  }

  const selected: LongMemEvalEntry[] = [];
  const questionTypes = [...groups.keys()].sort();
  let added = true;
  while (selected.length < config.limit && added) {
    added = false;
    for (const questionType of questionTypes) {
      const group = groups.get(questionType) ?? [];
      const next = group.shift();
      if (!next) {
        continue;
      }
      selected.push(next);
      added = true;
      if (selected.length >= config.limit) {
        break;
      }
    }
  }
  return selected;
}

export class LongMemEvalBenchmarkService {
  constructor(
    private readonly userDataRoot = getUserDataRootDir(),
    private readonly serviceRoot = getServiceRootDir(),
  ) {}

  async run(config: LongMemEvalBenchmarkConfig): Promise<LongMemEvalBenchmarkSummary> {
    const datasetPath = await ensureDatasetFile(this.userDataRoot, config.dataset);
    const raw = await fs.readFile(datasetPath, "utf8");
    const allEntries = JSON.parse(raw) as LongMemEvalEntry[];
    const selectedEntries = selectEntries(allEntries, config);
    const skippedAbstentionQuestions = allEntries.filter((entry) => entry.question_id.endsWith("_abs")).length;

    const previousRootDir = process.env.OPENELINARO_ROOT_DIR;
    const previousUserDataRootDir = process.env.OPENELINARO_USER_DATA_DIR;
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openelinaro-longmemeval-"));
    const runtimeUserDataRoot = path.join(runtimeRoot, ".openelinaro");
    await copyProfileRegistry(this.userDataRoot, this.serviceRoot, runtimeUserDataRoot);

    const questions: QuestionBenchmarkResult[] = [];

    try {
      process.env.OPENELINARO_ROOT_DIR = runtimeRoot;
      process.env.OPENELINARO_USER_DATA_DIR = runtimeUserDataRoot;
      const profiles = new ProfileService(config.profileId);
      const profile = profiles.getProfile(config.profileId);

      for (const [index, entry] of selectedEntries.entries()) {
        const result = await this.runQuestion({
          entry,
          profile,
          profiles,
          topK: config.topK,
        });
        questions.push(result);
        if ((index + 1) % 5 === 0 || index === selectedEntries.length - 1) {
          console.error(
            `[LongMemEval] ${index + 1}/${selectedEntries.length} questions processed`,
          );
        }
      }
    } finally {
      if (previousRootDir) {
        process.env.OPENELINARO_ROOT_DIR = previousRootDir;
      } else {
        delete process.env.OPENELINARO_ROOT_DIR;
      }
      if (previousUserDataRootDir) {
        process.env.OPENELINARO_USER_DATA_DIR = previousUserDataRootDir;
      } else {
        delete process.env.OPENELINARO_USER_DATA_DIR;
      }
      await fs.rm(runtimeRoot, { recursive: true, force: true });
    }

    const searchLatencies = questions.map((question) => question.latency.searchMs).sort((left, right) => left - right);
    const summary: LongMemEvalBenchmarkSummary = {
      benchmark: "LongMemEval",
      mode: "retrieval_only",
      config,
      datasetPath,
      datasetSize: allEntries.length,
      evaluatedQuestions: questions.length,
      skippedAbstentionQuestions,
      aggregate: {
        recallAnyAt5: round(average(questions.map((question) => question.metrics.recallAnyAt5))),
        recallAllAt5: round(average(questions.map((question) => question.metrics.recallAllAt5))),
        ndcgAnyAt5: round(average(questions.map((question) => question.metrics.ndcgAnyAt5))),
        recallAnyAt10: round(average(questions.map((question) => question.metrics.recallAnyAt10))),
        recallAllAt10: round(average(questions.map((question) => question.metrics.recallAllAt10))),
        ndcgAnyAt10: round(average(questions.map((question) => question.metrics.ndcgAnyAt10))),
        avgReindexMs: round(average(questions.map((question) => question.latency.reindexMs))),
        avgSearchMs: round(average(questions.map((question) => question.latency.searchMs))),
        p95SearchMs: round(percentile(searchLatencies, 0.95)),
      },
      questions,
      outputPath: "",
    };

    const resultsDirectory = path.join(this.userDataRoot, "benchmarks", "longmemeval", "results");
    await fs.mkdir(resultsDirectory, { recursive: true });
    const outputPath = path.join(
      resultsDirectory,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${config.dataset}-${config.limit}.json`,
    );
    summary.outputPath = outputPath;
    await fs.writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    return summary;
  }

  private async runQuestion(params: {
    entry: LongMemEvalEntry;
    profile: ProfileRecord;
    profiles: ProfileService;
    topK: number;
  }): Promise<QuestionBenchmarkResult> {
    const corpus = buildSessionCorpus(params.entry);
    const memoryRoot = resolveRuntimePath("memory");
    await fs.rm(memoryRoot, { recursive: true, force: true });

    const documentsRoot = path.join(
      memoryRoot,
      "documents",
      params.profiles.getWriteMemoryNamespace(params.profile),
    );
    await fs.mkdir(documentsRoot, { recursive: true });
    for (const document of corpus) {
      const destination = path.join(documentsRoot, document.relativePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, `${document.content}\n`, "utf8");
    }

    const memory = new MemoryService(params.profile, params.profiles);
    const reindexStartedAt = performance.now();
    await memory.reindex();
    const reindexMs = performance.now() - reindexStartedAt;

    const searchStartedAt = performance.now();
    const matches = await memory.searchStructured({
      query: params.entry.question,
      limit: Math.max(5, Math.min(params.topK, 10)),
    });
    const searchMs = performance.now() - searchStartedAt;

    const relativePathToCorpusId = new Map(corpus.map((document) => [
      path.posix.join(params.profiles.getWriteMemoryNamespace(params.profile), document.relativePath),
      document.corpusId,
    ]));
    const rankedCorpusIds = matches
      .map((match) => relativePathToCorpusId.get(match.relativePath))
      .filter((corpusId): corpusId is string => Boolean(corpusId));
    const rankings = buildRankings(
      corpus.map((document) => document.corpusId),
      rankedCorpusIds,
    );

    const correctDocs = params.entry.answer_session_ids;
    const metricsAt5 = evaluateRetrieval(rankings, correctDocs, corpus.map((document) => document.corpusId), 5);
    const metricsAt10 = evaluateRetrieval(rankings, correctDocs, corpus.map((document) => document.corpusId), 10);

    return {
      questionId: params.entry.question_id,
      questionType: params.entry.question_type,
      questionLength: params.entry.question.length,
      corpusSize: corpus.length,
      correctSessionCount: correctDocs.length,
      metrics: {
        recallAnyAt5: round(metricsAt5.recallAny),
        recallAllAt5: round(metricsAt5.recallAll),
        ndcgAnyAt5: round(metricsAt5.ndcgAny),
        recallAnyAt10: round(metricsAt10.recallAny),
        recallAllAt10: round(metricsAt10.recallAll),
        ndcgAnyAt10: round(metricsAt10.ndcgAny),
      },
      latency: {
        reindexMs: round(reindexMs),
        searchMs: round(searchMs),
      },
      topResults: uniqueTopResults(matches.map((match) => ({
        corpusId: relativePathToCorpusId.get(match.relativePath) ?? match.relativePath,
        score: round(match.score),
      }))),
    };
  }
}
