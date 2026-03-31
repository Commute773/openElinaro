import fs from "node:fs/promises";
import path from "node:path";
import { assertTestRuntimeRootIsIsolated, resolveRuntimePath } from "./runtime-root";
import { attemptOrAsync, attemptAsync } from "../utils/result";

export type SweBenchDifficultySplit = "verified";

export type SweBenchDifficultyAnalysisConfig = {
  split: SweBenchDifficultySplit;
  minSubmissionCoverage: number;
  minTaskAttempts: number;
  laplaceAlpha: number;
  laplaceBeta: number;
  irtRegularization: number;
  irtMaxIterations: number;
  irtTolerance: number;
};

type SubmissionOutcomeRecord = {
  submissionId: string;
  displayName: string;
  attempted: Set<string>;
  resolved: Set<string>;
};

export type SweBenchTaskDifficulty = {
  instanceId: string;
  attempts: number;
  solves: number;
  rawSolveRate: number;
  smoothedSolveRate: number;
  difficulty: number;
  difficultyPercentile: number;
  latentDifficulty: number;
  latentDifficultyStdError: number;
  latentDifficultyPercentile: number;
};

export type SweBenchSubmissionDifficultyScore = {
  submissionId: string;
  displayName: string;
  attemptedCount: number;
  scoredTaskCount: number;
  solvedCount: number;
  failedCount: number;
  isRightCensored: boolean;
  solveRate: number;
  latentAbility: number;
  latentAbilityStdError: number;
  latentAbilityLowerBound95: number;
  latentAbilityPercentile: number;
  failureFrontierDifficulty: number;
  failureFrontierPercentile: number;
  failureFrontierSolveRateEquivalent: number;
  thresholdBalancedAccuracy: number;
  averageSolvedDifficulty: number | null;
  averageFailedDifficulty: number | null;
  hardestSolvedDifficulty: number | null;
  easiestFailedDifficulty: number | null;
};

export type SweBenchDifficultyAnalysisResult = {
  benchmark: "SWE-bench Verified Difficulty Analysis";
  generatedAt: string;
  experimentsRoot: string;
  outputPath: string;
  config: SweBenchDifficultyAnalysisConfig;
  submissionsSeen: number;
  submissionsIncluded: number;
  tasksConsidered: number;
  submissions: SweBenchSubmissionDifficultyScore[];
  tasks: SweBenchTaskDifficulty[];
};

const DEFAULT_CONFIG: SweBenchDifficultyAnalysisConfig = {
  split: "verified",
  minSubmissionCoverage: 450,
  minTaskAttempts: 5,
  laplaceAlpha: 1,
  laplaceBeta: 1,
  irtRegularization: 1,
  irtMaxIterations: 75,
  irtTolerance: 1e-4,
};

function round(value: number) {
  return Number(value.toFixed(4));
}

function average(values: number[]) {
  if (values.length === 0) {
    return null;
  }
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function extractStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function logistic(value: number) {
  if (value >= 0) {
    const exp = Math.exp(-value);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function logit(probability: number) {
  const clamped = Math.min(1 - 1e-6, Math.max(1e-6, probability));
  return Math.log(clamped / (1 - clamped));
}

function parseDisplayName(metadataText: string | null, readmeText: string | null, submissionId: string) {
  const metadataName = metadataText?.match(/^\s*name:\s*(.+)$/m)?.[1]?.trim();
  if (metadataName) {
    return metadataName.replace(/^['"]|['"]$/g, "");
  }

  const readmeHeading = readmeText?.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (readmeHeading) {
    return readmeHeading;
  }

  return submissionId.replace(/^\d{8}_/, "");
}

function collectOutcomeSets(results: Record<string, unknown>) {
  const attempted = new Set<string>();
  const resolved = new Set<string>(extractStringArray(results.resolved));

  for (const value of Object.values(results)) {
    for (const instanceId of extractStringArray(value)) {
      attempted.add(instanceId);
    }
  }

  return { attempted, resolved };
}

function buildThresholdCandidates(difficulties: number[]) {
  const unique = [...new Set(difficulties.map((value) => round(value)))].sort((left, right) => left - right);
  const candidates = new Set<number>([0, 1]);

  for (let index = 0; index < unique.length; index += 1) {
    const current = unique[index]!;
    candidates.add(current);
    const next = unique[index + 1];
    if (next !== undefined) {
      candidates.add(round((current + next) / 2));
    }
  }

  return [...candidates].sort((left, right) => left - right);
}

function computeBalancedAccuracy(points: Array<{ difficulty: number; solved: boolean }>, threshold: number) {
  let truePositives = 0;
  let trueNegatives = 0;
  let positives = 0;
  let negatives = 0;

  for (const point of points) {
    const predictedSolved = point.difficulty <= threshold;
    if (point.solved) {
      positives += 1;
      if (predictedSolved) {
        truePositives += 1;
      }
    } else {
      negatives += 1;
      if (!predictedSolved) {
        trueNegatives += 1;
      }
    }
  }

  if (positives === 0 || negatives === 0) {
    return 1;
  }

  return ((truePositives / positives) + (trueNegatives / negatives)) / 2;
}

function estimateFailureFrontier(points: Array<{ difficulty: number; solved: boolean }>) {
  const solvedCount = points.filter((point) => point.solved).length;
  const failedCount = points.length - solvedCount;
  if (solvedCount === 0) {
    return { threshold: 0, balancedAccuracy: 1 };
  }
  if (failedCount === 0) {
    return { threshold: 1, balancedAccuracy: 1 };
  }

  const candidates = buildThresholdCandidates(points.map((point) => point.difficulty));
  let bestScore = -1;
  let bestThresholds: number[] = [];

  for (const threshold of candidates) {
    const score = computeBalancedAccuracy(points, threshold);
    if (score > bestScore + Number.EPSILON) {
      bestScore = score;
      bestThresholds = [threshold];
    } else if (Math.abs(score - bestScore) <= Number.EPSILON) {
      bestThresholds.push(threshold);
    }
  }

  return {
    threshold: round(bestThresholds.reduce((sum, value) => sum + value, 0) / bestThresholds.length),
    balancedAccuracy: round(bestScore),
  };
}

async function readOptionalText(filePath: string) {
  return attemptOrAsync(() => fs.readFile(filePath, "utf8"), null);
}

async function loadSubmissionRecords(splitRoot: string, minSubmissionCoverage: number) {
  const entries = await fs.readdir(splitRoot, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const records: SubmissionOutcomeRecord[] = [];
  let submissionsSeen = 0;

  for (const submissionId of directories) {
    const submissionRoot = path.join(splitRoot, submissionId);
    const resultsPath = path.join(submissionRoot, "results/results.json");

    const parseResult = await attemptAsync(async () =>
      JSON.parse(await fs.readFile(resultsPath, "utf8")) as Record<string, unknown>,
    );
    if (!parseResult.ok) continue;
    const results = parseResult.value;

    submissionsSeen += 1;
    const { attempted, resolved } = collectOutcomeSets(results);
    if (attempted.size < minSubmissionCoverage) {
      continue;
    }

    const [metadataText, readmeText] = await Promise.all([
      readOptionalText(path.join(submissionRoot, "metadata.yaml")),
      readOptionalText(path.join(submissionRoot, "README.md")),
    ]);

    records.push({
      submissionId,
      displayName: parseDisplayName(metadataText, readmeText, submissionId),
      attempted,
      resolved,
    });
  }

  return { submissionsSeen, records };
}

function computeTaskDifficulties(
  records: SubmissionOutcomeRecord[],
  config: SweBenchDifficultyAnalysisConfig,
) {
  const taskStats = new Map<string, { attempts: number; solves: number }>();

  for (const record of records) {
    for (const instanceId of record.attempted) {
      const existing = taskStats.get(instanceId) ?? { attempts: 0, solves: 0 };
      existing.attempts += 1;
      if (record.resolved.has(instanceId)) {
        existing.solves += 1;
      }
      taskStats.set(instanceId, existing);
    }
  }

  const tasks = [...taskStats.entries()]
    .filter(([, stats]) => stats.attempts >= config.minTaskAttempts)
    .map(([instanceId, stats]) => {
      const rawSolveRate = stats.solves / stats.attempts;
      const smoothedSolveRate = (stats.solves + config.laplaceAlpha)
        / (stats.attempts + config.laplaceAlpha + config.laplaceBeta);
      return {
        instanceId,
        attempts: stats.attempts,
        solves: stats.solves,
        rawSolveRate: round(rawSolveRate),
        smoothedSolveRate: round(smoothedSolveRate),
        difficulty: round(1 - smoothedSolveRate),
        difficultyPercentile: 0,
        latentDifficulty: 0,
        latentDifficultyStdError: 0,
        latentDifficultyPercentile: 0,
      } satisfies SweBenchTaskDifficulty;
    })
    .sort((left, right) =>
      right.difficulty - left.difficulty
      || right.attempts - left.attempts
      || left.instanceId.localeCompare(right.instanceId)
    );

  const total = tasks.length;
  if (total <= 1) {
    return tasks.map((task) => ({ ...task, difficultyPercentile: total === 1 ? 1 : 0 }));
  }

  return tasks.map((task, index) => ({
    ...task,
    difficultyPercentile: round((total - index - 1) / (total - 1)),
  }));
}

function fitRaschModel(
  records: SubmissionOutcomeRecord[],
  tasks: SweBenchTaskDifficulty[],
  config: SweBenchDifficultyAnalysisConfig,
) {
  const taskIndexById = new Map(tasks.map((task, index) => [task.instanceId, index]));
  const submissionObservations = records.map((record) => {
    const observations: Array<{ taskIndex: number; solved: boolean }> = [];
    for (const instanceId of record.attempted) {
      const taskIndex = taskIndexById.get(instanceId);
      if (taskIndex === undefined) {
        continue;
      }
      observations.push({ taskIndex, solved: record.resolved.has(instanceId) });
    }
    return observations;
  });
  const taskObservations = tasks.map((): Array<{ submissionIndex: number; solved: boolean }> => []);
  for (let submissionIndex = 0; submissionIndex < submissionObservations.length; submissionIndex += 1) {
    for (const observation of submissionObservations[submissionIndex] ?? []) {
      taskObservations[observation.taskIndex]!.push({
        submissionIndex,
        solved: observation.solved,
      });
    }
  }

  const abilities = records.map((record) => {
    const attemptedCount = [...record.attempted].filter((instanceId) => taskIndexById.has(instanceId)).length;
    const solvedCount = [...record.resolved].filter((instanceId) => taskIndexById.has(instanceId)).length;
    const smoothedSolveRate = (solvedCount + config.laplaceAlpha)
      / (attemptedCount + config.laplaceAlpha + config.laplaceBeta);
    return logit(smoothedSolveRate);
  });
  const difficulties = tasks.map((task) => -logit(task.smoothedSolveRate));

  for (let iteration = 0; iteration < config.irtMaxIterations; iteration += 1) {
    let maxDelta = 0;

    for (let submissionIndex = 0; submissionIndex < submissionObservations.length; submissionIndex += 1) {
      const observations = submissionObservations[submissionIndex] ?? [];
      if (observations.length === 0) {
        continue;
      }

      let gradient = -config.irtRegularization * abilities[submissionIndex]!;
      let hessian = -config.irtRegularization;
      for (const observation of observations) {
        const probability = logistic(abilities[submissionIndex]! - difficulties[observation.taskIndex]!);
        gradient += (observation.solved ? 1 : 0) - probability;
        hessian -= probability * (1 - probability);
      }

      const updated = abilities[submissionIndex]! - (gradient / hessian);
      maxDelta = Math.max(maxDelta, Math.abs(updated - abilities[submissionIndex]!));
      abilities[submissionIndex] = updated;
    }

    for (let taskIndex = 0; taskIndex < taskObservations.length; taskIndex += 1) {
      const observations = taskObservations[taskIndex] ?? [];
      if (observations.length === 0) {
        continue;
      }

      let gradient = -config.irtRegularization * difficulties[taskIndex]!;
      let hessian = -config.irtRegularization;
      for (const observation of observations) {
        const probability = logistic(abilities[observation.submissionIndex]! - difficulties[taskIndex]!);
        gradient += probability - (observation.solved ? 1 : 0);
        hessian -= probability * (1 - probability);
      }

      const updated = difficulties[taskIndex]! - (gradient / hessian);
      maxDelta = Math.max(maxDelta, Math.abs(updated - difficulties[taskIndex]!));
      difficulties[taskIndex] = updated;
    }

    const meanDifficulty = difficulties.reduce((sum, value) => sum + value, 0) / Math.max(1, difficulties.length);
    for (let index = 0; index < difficulties.length; index += 1) {
      difficulties[index] = difficulties[index]! - meanDifficulty;
    }
    for (let index = 0; index < abilities.length; index += 1) {
      abilities[index] = abilities[index]! - meanDifficulty;
    }

    if (maxDelta <= config.irtTolerance) {
      break;
    }
  }

  const abilityStdErrors = abilities.map((ability, submissionIndex) => {
    let information = config.irtRegularization;
    for (const observation of submissionObservations[submissionIndex] ?? []) {
      const probability = logistic(ability - difficulties[observation.taskIndex]!);
      information += probability * (1 - probability);
    }
    return Math.sqrt(1 / information);
  });

  const difficultyStdErrors = difficulties.map((difficulty, taskIndex) => {
    let information = config.irtRegularization;
    for (const observation of taskObservations[taskIndex] ?? []) {
      const probability = logistic(abilities[observation.submissionIndex]! - difficulty);
      information += probability * (1 - probability);
    }
    return Math.sqrt(1 / information);
  });

  return {
    abilities,
    abilityStdErrors,
    difficulties,
    difficultyStdErrors,
  };
}

function applyLatentDifficultyScores(
  tasks: SweBenchTaskDifficulty[],
  raschFit: ReturnType<typeof fitRaschModel>,
) {
  const ranked = tasks
    .map((task, index) => ({
      ...task,
      latentDifficulty: round(raschFit.difficulties[index] ?? 0),
      latentDifficultyStdError: round(raschFit.difficultyStdErrors[index] ?? 0),
      latentDifficultyPercentile: 0,
    }))
    .sort((left, right) =>
      right.latentDifficulty - left.latentDifficulty
      || right.attempts - left.attempts
      || left.instanceId.localeCompare(right.instanceId)
    );

  const total = ranked.length;
  if (total <= 1) {
    return ranked.map((task) => ({ ...task, latentDifficultyPercentile: total === 1 ? 1 : 0 }));
  }

  return ranked.map((task, index) => ({
    ...task,
    latentDifficultyPercentile: round((total - index - 1) / (total - 1)),
  }));
}

function computeThresholdPercentile(threshold: number, tasks: SweBenchTaskDifficulty[]) {
  if (tasks.length === 0) {
    return 0;
  }
  const count = tasks.filter((task) => task.difficulty <= threshold).length;
  return round(count / tasks.length);
}

function computeLatentAbilityPercentile(value: number, submissions: Array<{ latentAbilityLowerBound95: number }>) {
  if (submissions.length === 0) {
    return 0;
  }
  const count = submissions.filter((submission) => submission.latentAbilityLowerBound95 <= value).length;
  return round(count / submissions.length);
}

function computeSubmissionScores(
  records: SubmissionOutcomeRecord[],
  tasks: SweBenchTaskDifficulty[],
  raschFit: ReturnType<typeof fitRaschModel>,
) {
  const taskById = new Map(tasks.map((task) => [task.instanceId, task]));
  const unsorted = records
    .map((record) => {
      const submissionIndex = records.findIndex((candidate) => candidate.submissionId === record.submissionId);
      const points = [...record.attempted]
        .map((instanceId) => {
          const task = taskById.get(instanceId);
          if (!task) {
            return null;
          }
          return {
            difficulty: task.difficulty,
            solved: record.resolved.has(instanceId),
          };
        })
        .filter((point): point is { difficulty: number; solved: boolean } => point !== null);

      const solvedDifficulties = points.filter((point) => point.solved).map((point) => point.difficulty);
      const failedDifficulties = points.filter((point) => !point.solved).map((point) => point.difficulty);
      const frontier = estimateFailureFrontier(points);
      const latentAbility = round(raschFit.abilities[submissionIndex] ?? 0);
      const latentAbilityStdError = round(raschFit.abilityStdErrors[submissionIndex] ?? 0);
      const latentAbilityLowerBound95 = round(latentAbility - (1.96 * latentAbilityStdError));

      return {
        submissionId: record.submissionId,
        displayName: record.displayName,
        attemptedCount: record.attempted.size,
        scoredTaskCount: points.length,
        solvedCount: solvedDifficulties.length,
        failedCount: failedDifficulties.length,
        isRightCensored: failedDifficulties.length === 0 && points.length < tasks.length,
        solveRate: points.length > 0 ? round(solvedDifficulties.length / points.length) : 0,
        latentAbility,
        latentAbilityStdError,
        latentAbilityLowerBound95,
        latentAbilityPercentile: 0,
        failureFrontierDifficulty: frontier.threshold,
        failureFrontierPercentile: computeThresholdPercentile(frontier.threshold, tasks),
        failureFrontierSolveRateEquivalent: round(1 - frontier.threshold),
        thresholdBalancedAccuracy: frontier.balancedAccuracy,
        averageSolvedDifficulty: average(solvedDifficulties),
        averageFailedDifficulty: average(failedDifficulties),
        hardestSolvedDifficulty: solvedDifficulties.length > 0 ? round(Math.max(...solvedDifficulties)) : null,
        easiestFailedDifficulty: failedDifficulties.length > 0 ? round(Math.min(...failedDifficulties)) : null,
      } satisfies SweBenchSubmissionDifficultyScore;
    });

  const sorted = unsorted.sort((left, right) =>
      right.latentAbilityLowerBound95 - left.latentAbilityLowerBound95
      || right.latentAbility - left.latentAbility
      || Number(left.isRightCensored) - Number(right.isRightCensored)
      || right.failureFrontierDifficulty - left.failureFrontierDifficulty
      || right.solveRate - left.solveRate
      || right.scoredTaskCount - left.scoredTaskCount
      || left.submissionId.localeCompare(right.submissionId)
    );

  return sorted.map((submission) => ({
    ...submission,
    latentAbilityPercentile: computeLatentAbilityPercentile(submission.latentAbilityLowerBound95, sorted),
  }));
}

function timestampForFilename(date: Date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export class SweBenchDifficultyAnalysisService {
  constructor(private readonly repoRoot: string) {}

  async run(config?: Partial<SweBenchDifficultyAnalysisConfig>): Promise<SweBenchDifficultyAnalysisResult> {
    const resolvedConfig: SweBenchDifficultyAnalysisConfig = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    const experimentsRoot = path.join(this.repoRoot, "references/swe-bench-experiments");
    const splitRoot = path.join(experimentsRoot, "evaluation", resolvedConfig.split);
    const { submissionsSeen, records } = await loadSubmissionRecords(splitRoot, resolvedConfig.minSubmissionCoverage);
    const empiricalTasks = computeTaskDifficulties(records, resolvedConfig);
    const raschFit = fitRaschModel(records, empiricalTasks, resolvedConfig);
    const tasks = applyLatentDifficultyScores(empiricalTasks, raschFit);
    const submissions = computeSubmissionScores(records, tasks, raschFit);

    assertTestRuntimeRootIsIsolated("SWE-bench difficulty analysis");
    const now = new Date();
    const outputDirectory = resolveRuntimePath("benchmarks/swebench/verified-difficulty");
    await fs.mkdir(outputDirectory, { recursive: true });
    const outputPath = path.join(outputDirectory, `${timestampForFilename(now)}.json`);

    const result: SweBenchDifficultyAnalysisResult = {
      benchmark: "SWE-bench Verified Difficulty Analysis",
      generatedAt: now.toISOString(),
      experimentsRoot,
      outputPath,
      config: resolvedConfig,
      submissionsSeen,
      submissionsIncluded: submissions.length,
      tasksConsidered: tasks.length,
      submissions,
      tasks,
    };

    await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  }
}
