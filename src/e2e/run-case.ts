/**
 * Single test-case runner — designed to be spawned as a subprocess.
 *
 * Usage:
 *   bun run src/e2e/run-case.ts <case-name>
 *
 * Prints a single JSON TestResult to stdout and exits 0 (pass) or 1 (fail).
 * Diagnostic messages go to stderr.
 *
 * This file is the unit of parallelism: the bash orchestrator spawns one
 * process per test case so they run concurrently in fully isolated environments.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getTestFixturesDir } from "../test/fixtures";
import { DirectConnector } from "./connector";
import { runAssertions, type AssertionResult } from "./test-case";
import { TEST_CASES } from "./test-cases";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const repoRoot = process.cwd();
const TEST_ROOT_NAME = ".openelinarotest";
const MACHINE_TEST_ROOT = getTestFixturesDir();
const MACHINE_LIVE_ROOT = path.join(os.homedir(), ".openelinarotest");
const DEFAULT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Fresh-import helper
// ---------------------------------------------------------------------------

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?case=${Date.now()}-${Math.random()}`) as Promise<T>;
}

// ---------------------------------------------------------------------------
// File-system helpers
// ---------------------------------------------------------------------------

function copyDirectory(relativePath: string, tempRoot: string) {
  const source = path.join(repoRoot, relativePath);
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, path.join(tempRoot, relativePath), { recursive: true });
}

function copyMachineTestDirectory(relativePath: string, tempRoot: string) {
  const source = path.join(MACHINE_TEST_ROOT, relativePath);
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, path.join(tempRoot, TEST_ROOT_NAME, relativePath), { recursive: true });
}

function copyFile(relativePath: string, tempRoot: string) {
  const source = path.join(MACHINE_TEST_ROOT, relativePath);
  if (!fs.existsSync(source)) return;
  const destination = path.join(tempRoot, TEST_ROOT_NAME, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyLiveCredentials(tempRoot: string) {
  const dest = path.join(tempRoot, TEST_ROOT_NAME);
  fs.mkdirSync(dest, { recursive: true });
  const prodRoot = path.join(os.homedir(), ".openelinaro");

  for (const name of ["auth-store.json", "secret-store.json"]) {
    // Priority: src/test/fixtures → ~/.openelinaro (prod) → ~/.openelinarotest
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

function resolveTestPath(tempRoot: string, ...segments: string[]) {
  return path.join(tempRoot, TEST_ROOT_NAME, ...segments);
}

// ---------------------------------------------------------------------------
// Fixture writers
// ---------------------------------------------------------------------------

function writeProfileRegistry(tempRoot: string, providerId: "openai-codex" | "claude") {
  const defaultModelId =
    providerId === "openai-codex" ? "gpt-5.4" : "claude-opus-4-6-20260301";
  const toolSummarizerModelId =
    providerId === "openai-codex" ? "gpt-5.4" : "claude-haiku-4-5";
  fs.mkdirSync(resolveTestPath(tempRoot, "profiles"), { recursive: true });
  fs.writeFileSync(
    resolveTestPath(tempRoot, "profiles", "registry.json"),
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

function writeProjectRegistry(tempRoot: string) {
  fs.mkdirSync(resolveTestPath(tempRoot, "projects"), { recursive: true });
  fs.writeFileSync(
    resolveTestPath(tempRoot, "projects", "registry.json"),
    `${JSON.stringify({ version: 1, projects: [] }, null, 2)}\n`,
    "utf8",
  );
}

function writeWorkspaceFixture(tempRoot: string) {
  fs.mkdirSync(resolveTestPath(tempRoot, "memory", "documents", "root"), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, "README.md"), "# e2e case workspace\n", "utf8");
  fs.writeFileSync(
    path.join(tempRoot, "package.json"),
    `${JSON.stringify(
      { name: "openelinaro-e2e-case", private: true, type: "module" },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// Result type (matches runner.ts)
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  const caseName = process.argv[2];
  if (!caseName) {
    console.error("Usage: bun run src/e2e/run-case.ts <case-name>");
    process.exit(1);
  }

  const tc = TEST_CASES.find((c) => c.name === caseName);
  if (!tc) {
    console.error(`Unknown test case: ${caseName}`);
    console.error(`Available: ${TEST_CASES.map((c) => c.name).join(", ")}`);
    process.exit(1);
  }

  // ---- Setup isolated environment ----
  const previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `openelinaro-e2e-${caseName}-`),
  );
  process.env.OPENELINARO_ROOT_DIR = tempRoot;

  const cleanup = () => {
    if (previousRootDirEnv === undefined) {
      delete process.env.OPENELINARO_ROOT_DIR;
    } else {
      process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
    }
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  };

  try {
    console.error(`[${caseName}] Temp root: ${tempRoot}`);

    copyDirectory("system_prompt", tempRoot);
    copyMachineTestDirectory("system_prompt", tempRoot);
    copyMachineTestDirectory("assistant_context", tempRoot);
    copyLiveCredentials(tempRoot);
    writeProjectRegistry(tempRoot);
    writeWorkspaceFixture(tempRoot);

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
      throw new Error(
        `No root provider auth in ${path.join(MACHINE_TEST_ROOT, "auth-store.json")}`,
      );
    }

    writeProfileRegistry(tempRoot, providerId);
    console.error(`[${caseName}] Provider: ${providerId}`);

    // ---- Import runtime fresh ----
    const runtimeModule = await importFresh<typeof import("../app/runtime")>(
      "src/app/runtime.ts",
    );
    const app = new runtimeModule.OpenElinaroApp({ profileId: "root" });

    // ---- Create connector and run ----
    const connector = new DirectConnector({
      handleRequest: (req, opts) => app.handleRequest(req, opts),
    });

    const start = Date.now();
    console.error(`[${caseName}] Sending: "${tc.prompt.slice(0, 80)}"`);

    const timeoutMs = tc.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const connResult = await Promise.race([
      connector.send(tc.prompt),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);

    const assertionResults = runAssertions(
      connResult.response.message,
      connResult.toolUseEvents,
      tc.assertions,
    );
    const allPassed = assertionResults.every((a) => a.passed);
    const durationMs = Date.now() - start;

    const result: TestResult = {
      name: tc.name,
      passed: allPassed,
      durationMs,
      responsePreview: connResult.response.message.slice(0, 300),
      toolUseEvents: connResult.toolUseEvents,
      assertionResults,
    };

    const icon = allPassed ? "PASS" : "FAIL";
    console.error(`[${icon}] ${tc.name} (${durationMs}ms)`);
    for (const ar of assertionResults) {
      if (!ar.passed) {
        console.error(`       - ${ar.detail}`);
      }
    }

    console.log(JSON.stringify(result));
    cleanup();
    process.exit(allPassed ? 0 : 1);
  } catch (error) {
    const errorMsg =
      error instanceof Error ? error.stack ?? error.message : String(error);
    const result: TestResult = {
      name: tc.name,
      passed: false,
      durationMs: 0,
      responsePreview: "",
      toolUseEvents: [],
      assertionResults: [],
      error: errorMsg,
    };
    console.error(`[ERROR] ${tc.name}: ${errorMsg.split("\n")[0]}`);
    console.log(JSON.stringify(result));
    cleanup();
    process.exit(1);
  }
}

main();
