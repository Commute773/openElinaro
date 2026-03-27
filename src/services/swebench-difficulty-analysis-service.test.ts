import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const repoRoot = process.cwd();

let tempRoot = "";
let previousRootDir = "";

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?test=${Date.now()}-${Math.random()}`) as Promise<T>;
}

function writeSubmission(root: string, submissionId: string, resolved: string[], failed: string[]) {
  const submissionRoot = path.join(root, "references/swe-bench-experiments/evaluation/verified", submissionId);
  fs.mkdirSync(path.join(submissionRoot, "results"), { recursive: true });
  fs.writeFileSync(
    path.join(submissionRoot, "results/results.json"),
    `${JSON.stringify({
      resolved,
      no_generation: [],
      no_logs: failed,
    }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(submissionRoot, "README.md"), `# ${submissionId}\n`, "utf8");
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "swebench-difficulty-analysis-"));
  previousRootDir = process.env.OPENELINARO_ROOT_DIR ?? "";
  process.env.OPENELINARO_ROOT_DIR = tempRoot;
});

afterEach(() => {
  if (previousRootDir) {
    process.env.OPENELINARO_ROOT_DIR = previousRootDir;
  } else {
    delete process.env.OPENELINARO_ROOT_DIR;
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("SweBenchDifficultyAnalysisService", () => {
  test("computes task difficulty and failure frontiers from published submission outcomes", async () => {
    writeSubmission(tempRoot, "20260101_combo_alpha", ["task-a", "task-b"], ["task-c", "task-d"]);
    writeSubmission(tempRoot, "20260101_combo_beta", ["task-a", "task-b", "task-c"], ["task-d"]);
    writeSubmission(tempRoot, "20260101_combo_gamma", ["task-a"], ["task-b", "task-c", "task-d"]);

    const { SweBenchDifficultyAnalysisService } = await importFresh<typeof import("./swebench-difficulty-analysis-service")>(
      "src/services/swebench-difficulty-analysis-service.ts",
    );
    const service = new SweBenchDifficultyAnalysisService(tempRoot);
    const result = await service.run({
      split: "verified",
      minSubmissionCoverage: 0,
      minTaskAttempts: 1,
      laplaceAlpha: 1,
      laplaceBeta: 1,
    });

    expect(result.submissionsIncluded).toBe(3);
    expect(result.tasksConsidered).toBe(4);
    expect(result.tasks.map((task) => [task.instanceId, task.difficulty])).toEqual([
      ["task-d", 0.8],
      ["task-c", 0.6],
      ["task-b", 0.4],
      ["task-a", 0.2],
    ]);

    expect(result.submissions.map((submission) => [submission.submissionId, submission.failureFrontierDifficulty])).toEqual([
      ["20260101_combo_beta", 0.65],
      ["20260101_combo_alpha", 0.45],
      ["20260101_combo_gamma", 0.25],
    ]);
    expect(fs.existsSync(result.outputPath)).toBe(true);
  });
});
