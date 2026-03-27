/**
 * E2E test: agent routine tool behavior.
 * Verifies that the function layer produces correct results for routine operations
 * by invoking tools through the real runtime.
 *
 * Gated on OPENELINARO_ENABLE_LIVE_MODEL_E2E !== "0" and auth credentials present.
 * Uses a temp directory for isolation (never touches ~/.openelinaro/).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { getTestFixturesDir } from "../test/fixtures";

const repoRoot = process.cwd();
const machineTestRoot = getTestFixturesDir();

function hasRootProviderAuthInRepo() {
  const authStorePath = path.join(machineTestRoot, "auth-store.json");
  if (!fs.existsSync(authStorePath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(authStorePath, "utf8")) as {
      profiles?: Record<string, {
        providers?: Record<string, {
          credentials?: unknown;
          token?: string;
        }>;
      }>;
    };
    const providers = parsed.profiles?.root?.providers;
    if (!providers) return false;
    const codex = providers["openai-codex"];
    if (codex && typeof codex.credentials === "object" && codex.credentials !== null) return true;
    const claude = providers.claude;
    return Boolean(typeof claude?.token === "string" && claude.token.trim());
  } catch { return false; }
}

const RUN_AGENT_E2E =
  process.env.OPENELINARO_ENABLE_LIVE_MODEL_E2E !== "0" && hasRootProviderAuthInRepo();

describe("agent routine behavior e2e", () => {
  const liveTest = RUN_AGENT_E2E ? test : test.skip;

  liveTest("routine add, list, done, and delete produce correct tool results", () => {
    const runnerPath = path.join(repoRoot, "src/app/agent-routine-behavior.e2e.runner.ts");
    const stdout = execFileSync("bun", ["run", runnerPath], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      timeout: 120_000,
    });

    expect(stdout).toContain("ROUTINE_E2E_ADD_OK");
    expect(stdout).toContain("ROUTINE_E2E_LIST_OK");
    expect(stdout).toContain("ROUTINE_E2E_DONE_OK");
    expect(stdout).toContain("ROUTINE_E2E_DELETE_OK");
  }, 140_000);
});
