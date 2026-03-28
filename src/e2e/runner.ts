/**
 * E2E test runner.
 *
 * Each invocation sets up an isolated runtime environment, runs one or more
 * test cases through a Connector, and prints structured results to stdout.
 *
 * Usage:
 *   bun run src/e2e/runner.ts                          # run all cases
 *   bun run src/e2e/runner.ts --case basic-chat-greeting
 *   bun run src/e2e/runner.ts --tag todo
 *   bun run src/e2e/runner.ts --case todo-add --case exec-command-echo
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getTestFixturesDir } from "../test/fixtures";
import { DirectConnector } from "./connector";
import { runAssertions, type AssertionResult } from "./test-case";
import { TEST_CASES } from "./test-cases";
import type { E2eTestCase } from "./test-case";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const repoRoot = process.cwd();
const TEST_ROOT_NAME = ".openelinarotest";
const MACHINE_TEST_ROOT = getTestFixturesDir();
const MACHINE_LIVE_ROOT = path.join(os.homedir(), ".openelinarotest");
const DEFAULT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Module-level state (set during setup, cleared during teardown)
// ---------------------------------------------------------------------------

let previousRootDirEnv: string | undefined;
let tempRoot = "";

// ---------------------------------------------------------------------------
// Fresh-import helper (cache-bust so module-level singletons reset)
// ---------------------------------------------------------------------------

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?runner=${Date.now()}-${Math.random()}`) as Promise<T>;
}

// ---------------------------------------------------------------------------
// File-system helpers
// ---------------------------------------------------------------------------

function copyDirectory(relativePath: string) {
  const source = path.join(repoRoot, relativePath);
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, path.join(tempRoot, relativePath), { recursive: true });
}

function copyMachineTestDirectory(relativePath: string) {
  const source = path.join(MACHINE_TEST_ROOT, relativePath);
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, path.join(tempRoot, TEST_ROOT_NAME, relativePath), { recursive: true });
}

function copyFile(relativePath: string) {
  const source = path.join(MACHINE_TEST_ROOT, relativePath);
  if (!fs.existsSync(source)) return;
  const destination = path.join(tempRoot, TEST_ROOT_NAME, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyLiveCredentials() {
  const dest = path.join(tempRoot, TEST_ROOT_NAME);
  fs.mkdirSync(dest, { recursive: true });
  const prodRoot = path.join(os.homedir(), ".openelinaro");

  for (const name of ["auth-store.json", "secret-store.json"]) {
    const candidates = [
      path.join(MACHINE_TEST_ROOT, name),
      path.join(prodRoot, name),
      path.join(MACHINE_LIVE_ROOT, name),
    ];
    const src = candidates.find((p) => fs.existsSync(p));
    if (src) {
      fs.copyFileSync(src, path.join(dest, name));
    }
  }
}

function resolveTestPath(...segments: string[]) {
  return path.join(tempRoot, TEST_ROOT_NAME, ...segments);
}

// ---------------------------------------------------------------------------
// Fixture writers
// ---------------------------------------------------------------------------

function writeProfileRegistry(providerId: "openai-codex" | "claude") {
  const defaultModelId =
    providerId === "openai-codex" ? "gpt-5.4" : "claude-opus-4-6-20260301";
  const toolSummarizerModelId =
    providerId === "openai-codex" ? "gpt-5.4" : "claude-haiku-4-5";
  fs.mkdirSync(resolveTestPath("profiles"), { recursive: true });
  fs.writeFileSync(
    resolveTestPath("profiles", "registry.json"),
    `${JSON.stringify(
      {
        version: 1,
        profiles: [
          {
            id: "root",
            name: "Root",
            roles: ["root"],
            memoryNamespace: "root",
            preferredProvider: providerId,
            defaultModelId,
            toolSummarizerProvider: providerId,
            toolSummarizerModelId,
            subagentPreferredProvider: providerId,
            subagentDefaultModelId: defaultModelId,
            maxSubagentDepth: 1,
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function writeProjectRegistry() {
  fs.mkdirSync(resolveTestPath("projects"), { recursive: true });
  fs.writeFileSync(
    resolveTestPath("projects", "registry.json"),
    `${JSON.stringify({ version: 1, projects: [] }, null, 2)}\n`,
    "utf8",
  );
}

function writeWorkspaceFixture() {
  fs.mkdirSync(resolveTestPath("memory", "documents", "root"), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, "README.md"), "# e2e cli workspace\n", "utf8");
  fs.writeFileSync(
    path.join(tempRoot, "package.json"),
    `${JSON.stringify(
      { name: "openelinaro-e2e-cli", private: true, type: "module" },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  passed: boolean;
  durationMs: number;
  responsePreview: string;
  toolUseEvents: string[];
  assertionResults: AssertionResult[];
  error?: string;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { cases: string[]; tags: string[] } {
  const cases: string[] = [];
  const tags: string[] = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--case" && next) {
      cases.push(next);
      i++;
    } else if (arg === "--tag" && next) {
      tags.push(next);
      i++;
    }
  }
  return { cases, tags };
}

function selectCases(
  allCases: E2eTestCase[],
  filter: { cases: string[]; tags: string[] },
): E2eTestCase[] {
  if (filter.cases.length === 0 && filter.tags.length === 0) {
    return allCases;
  }
  return allCases.filter((tc) => {
    if (filter.cases.length > 0 && filter.cases.includes(tc.name)) return true;
    if (
      filter.tags.length > 0 &&
      tc.tags?.some((t) => filter.tags.includes(t))
    )
      return true;
    return false;
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const filter = parseArgs();
  const selectedCases = selectCases(TEST_CASES, filter);

  if (selectedCases.length === 0) {
    console.error("No test cases matched the filter.");
    process.exit(1);
  }

  // ---- Setup isolated environment ----
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-e2e-cli-"));
  process.env.OPENELINARO_ROOT_DIR = tempRoot;

  console.error(`[setup] Temp root: ${tempRoot}`);
  console.error(`[setup] Running ${selectedCases.length} test case(s)`);

  copyDirectory("system_prompt");
  copyMachineTestDirectory("system_prompt");
  copyMachineTestDirectory("assistant_context");
  copyLiveCredentials();
  writeProjectRegistry();
  writeWorkspaceFixture();

  // ---- Detect provider ----
  const authStoreModule = await importFresh<typeof import("../auth/store")>(
    "src/auth/store.ts",
  );
  const providerId = authStoreModule.hasProviderAuth("openai-codex", "root")
    ? "openai-codex"
    : authStoreModule.hasProviderAuth("claude", "root")
      ? "claude"
      : null;
  if (!providerId) {
    console.error(
      `No root provider auth in ${path.join(MACHINE_TEST_ROOT, "auth-store.json")}. Configure root auth first.`,
    );
    process.exit(1);
  }

  writeProfileRegistry(providerId);
  console.error(`[setup] Provider: ${providerId}`);

  // ---- Import runtime fresh ----
  const runtimeModule = await importFresh<typeof import("../app/runtime")>(
    "src/app/runtime.ts",
  );
  const app = new runtimeModule.OpenElinaroApp({ profileId: "root" });

  // ---- Create connector ----
  const connector = new DirectConnector({
    handleRequest: (req, opts) => app.handleRequest(req, opts),
  });

  // ---- Run test cases sequentially (each gets its own conversation) ----
  const results: TestResult[] = [];

  for (const tc of selectedCases) {
    const start = Date.now();
    console.error(`\n[run] ${tc.name}: "${tc.prompt.slice(0, 60)}..."`);

    try {
      const timeoutMs = tc.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const result = await Promise.race([
        connector.send(tc.prompt),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);

      const assertionResults = runAssertions(
        result.response.message,
        result.toolUseEvents,
        tc.assertions,
      );
      const allPassed = assertionResults.every((a) => a.passed);
      const durationMs = Date.now() - start;

      results.push({
        name: tc.name,
        passed: allPassed,
        durationMs,
        responsePreview: result.response.message.slice(0, 300),
        toolUseEvents: result.toolUseEvents,
        assertionResults,
      });

      const icon = allPassed ? "PASS" : "FAIL";
      console.error(`[${icon}] ${tc.name} (${durationMs}ms)`);
      for (const ar of assertionResults) {
        if (!ar.passed) {
          console.error(`       - ${ar.detail}`);
        }
      }
    } catch (error) {
      const durationMs = Date.now() - start;
      const errorMsg =
        error instanceof Error
          ? error.stack ?? error.message
          : String(error);

      results.push({
        name: tc.name,
        passed: false,
        durationMs,
        responsePreview: "",
        toolUseEvents: [],
        assertionResults: [],
        error: errorMsg,
      });

      console.error(`[ERROR] ${tc.name} (${durationMs}ms): ${errorMsg.split("\n")[0]}`);
    }
  }

  // ---- Summary ----
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  console.error(`\n${"=".repeat(60)}`);
  console.error(`Results: ${passed}/${total} passed, ${failed} failed`);
  console.error(`${"=".repeat(60)}`);

  // ---- Structured output to stdout (machine-readable) ----
  const output = {
    timestamp: new Date().toISOString(),
    provider: providerId,
    tempRoot,
    summary: { total, passed, failed },
    results,
  };
  console.log(JSON.stringify(output, null, 2));

  // ---- Exit code ----
  return failed === 0 ? 0 : 1;
}

main()
  .then((exitCode) => {
    // Cleanup
    if (previousRootDirEnv === undefined) {
      delete process.env.OPENELINARO_ROOT_DIR;
    } else {
      process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
    }
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    process.exit(exitCode);
  })
  .catch((error) => {
    console.error(
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    if (previousRootDirEnv === undefined) {
      delete process.env.OPENELINARO_ROOT_DIR;
    } else {
      process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
    }
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    process.exit(1);
  });
