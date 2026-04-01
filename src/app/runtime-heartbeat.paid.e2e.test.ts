import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

const repoRoot = process.cwd();

function hasRootProviderAuth() {
  for (const root of [
    path.join(os.homedir(), ".openelinarotest"),
    path.join(os.homedir(), ".openelinaro"),
  ]) {
    const secretStorePath = path.join(root, "secret-store.json");
    if (!fs.existsSync(secretStorePath)) {
      continue;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(secretStorePath, "utf8")) as {
        version?: number;
        profiles?: Record<string, {
          auth?: Record<string, {
            credentials?: unknown;
            token?: string;
          }>;
        }>;
      };
      const auth = parsed.profiles?.root?.auth;
      if (!auth) {
        continue;
      }
      const codex = auth["openai-codex"];
      if (codex && typeof codex.credentials === "object" && codex.credentials !== null) {
        return true;
      }
      const claude = auth.claude;
      if (typeof claude?.token === "string" && claude.token.trim()) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

const RUN_LIVE_E2E =
  process.env.OPENELINARO_ENABLE_LIVE_MODEL_E2E !== "0" && hasRootProviderAuth();

describe("heartbeat e2e", () => {
  const liveTest = RUN_LIVE_E2E ? test : test.skip;

  liveTest("suppresses heartbeat response when nothing needs attention", () => {
    const runnerPath = path.join(repoRoot, "src/app/runtime-heartbeat.e2e.runner.ts");
    const stdout = execFileSync("bun", ["run", runnerPath], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      timeout: 240_000,
    });

    expect(stdout).toContain("HEARTBEAT_E2E_OK");
  }, 260_000);
});
