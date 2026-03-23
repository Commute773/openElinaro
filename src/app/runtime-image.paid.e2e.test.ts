import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { getTestFixturesDir } from "../test/fixtures";

const repoRoot = process.cwd();
const machineTestRoot = getTestFixturesDir();

function hasRootProviderAuthInRepo() {
  const authStorePath = path.join(machineTestRoot, "auth-store.json");
  if (!fs.existsSync(authStorePath)) {
    return false;
  }

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
    if (!providers) {
      return false;
    }
    const codex = providers["openai-codex"];
    if (codex && typeof codex.credentials === "object" && codex.credentials !== null) {
      return true;
    }
    const claude = providers.claude;
    return Boolean(typeof claude?.token === "string" && claude.token.trim());
  } catch {
    return false;
  }
}

const RUN_IMAGE_E2E =
  process.env.OPENELINARO_ENABLE_LIVE_MODEL_E2E !== "0" && hasRootProviderAuthInRepo();

describe("runtime image e2e", () => {
  const liveTest = RUN_IMAGE_E2E ? test : test.skip;

  liveTest("sends an image with sourceUrl and receives a valid response", () => {
    const runnerPath = path.join(repoRoot, "src/app/runtime-image.e2e.runner.ts");
    const stdout = execFileSync("bun", ["run", runnerPath], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      timeout: 240_000,
    });

    expect(stdout).toContain("IMAGE_E2E_OK");
  }, 260_000);
});
