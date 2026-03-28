/**
 * Bun test wrapper for the e2e CLI test suite.
 *
 * Each test case runs as an independent subprocess (via run-case.ts) so
 * they get fully isolated runtime environments. This file lets you run
 * the suite with `bun test src/e2e/e2e-cli.paid.e2e.test.ts`.
 *
 * Skipped when auth credentials are not present or when
 * OPENELINARO_ENABLE_LIVE_MODEL_E2E=0.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { getTestFixturesDir } from "../test/fixtures";
import { TEST_CASES } from "./test-cases";

const repoRoot = process.cwd();
const machineTestRoot = getTestFixturesDir();

function hasRootProviderAuth(): boolean {
  // Check legacy auth-store.json (fixture or live)
  for (const dir of [machineTestRoot, path.join(os.homedir(), ".openelinarotest")]) {
    const authStorePath = path.join(dir, "auth-store.json");
    if (!fs.existsSync(authStorePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(authStorePath, "utf8")) as {
        profiles?: Record<
          string,
          { providers?: Record<string, { credentials?: unknown; token?: string }> }
        >;
      };
      const providers = parsed.profiles?.root?.providers;
      if (!providers) continue;
      const codex = providers["openai-codex"];
      if (codex && typeof codex.credentials === "object" && codex.credentials !== null)
        return true;
      const claude = providers.claude;
      if (typeof claude?.token === "string" && claude.token.trim()) return true;
    } catch {
      continue;
    }
  }

  // Check secret-store.json (newer auth format)
  for (const dir of [machineTestRoot, path.join(os.homedir(), ".openelinarotest")]) {
    const secretStorePath = path.join(dir, "secret-store.json");
    if (fs.existsSync(secretStorePath)) return true;
  }

  return false;
}

const RUN_E2E =
  process.env.OPENELINARO_ENABLE_LIVE_MODEL_E2E !== "0" && hasRootProviderAuth();

describe("e2e cli test suite", () => {
  const liveTest = RUN_E2E ? test : test.skip;

  for (const tc of TEST_CASES) {
    liveTest(
      tc.name,
      () => {
        const runnerPath = path.join(repoRoot, "src/e2e/run-case.ts");
        const stdout = execFileSync("bun", ["run", runnerPath, tc.name], {
          cwd: repoRoot,
          env: process.env,
          encoding: "utf8",
          timeout: (tc.timeoutMs ?? 120_000) + 30_000, // extra buffer
        });

        const result = JSON.parse(stdout.trim()) as { passed: boolean; error?: string };
        expect(result.passed).toBe(true);
      },
      (tc.timeoutMs ?? 120_000) + 60_000, // bun test timeout
    );
  }
});
