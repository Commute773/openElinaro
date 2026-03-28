import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { getTestFixturesDir } from "../test/fixtures";

const repoRoot = process.cwd();
const machineTestRoot = getTestFixturesDir();

function hasRootOpenAICodexAuthInRepo() {
  const authStorePath = path.join(machineTestRoot, "auth-store.json");
  if (!fs.existsSync(authStorePath)) {
    return false;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(authStorePath, "utf8")) as {
      profiles?: Record<string, {
        providers?: Record<string, {
          credentials?: unknown;
        }>;
      }>;
    };
    const codex = parsed.profiles?.root?.providers?.["openai-codex"];
    return Boolean(codex && typeof codex.credentials === "object" && codex.credentials !== null);
  } catch {
    return false;
  }
}

const RUN_SWEBENCH_SPHINX_SMOKE =
  process.env.OPENELINARO_ENABLE_LIVE_MODEL_E2E !== "0" && hasRootOpenAICodexAuthInRepo();

describe("swebench sphinx 9229 smoke e2e", () => {
  // Skip when OpenAI Codex credentials are not present in the machine test fixtures directory.
  // Disable explicitly with OPENELINARO_ENABLE_LIVE_MODEL_E2E=0.
  const liveTest = RUN_SWEBENCH_SPHINX_SMOKE ? test : test.skip;

  liveTest("runs the isolated live-model smoke harness for Sphinx 9229", () => {
    const runnerPath = path.join(repoRoot, "src/app/swebench-sphinx-9229-smoke.e2e.runner.ts");
    const stdout = execFileSync("bun", ["run", runnerPath], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      timeout: 240_000,
    });

    expect(stdout).toContain("SWEBENCH_SPHINX_9229_SMOKE_OK");
    expect(stdout).toContain("SWEBENCH_SPHINX_9229_SMOKE_ARTIFACT=");
  }, 260_000);
});
