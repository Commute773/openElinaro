/**
 * E2E runner: triggers a heartbeat with no required reminders through the full
 * app → core → real model pipeline and asserts that the agent suppresses the
 * response (normalizeAssistantReply returns undefined / empty).
 *
 * Runs in a subprocess with an isolated OPENELINARO_ROOT_DIR so it never
 * touches production state.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const TEST_ROOT_NAME = ".openelinarotest";
const MACHINE_TEST_ROOT = path.join(os.homedir(), TEST_ROOT_NAME);
const PRODUCTION_ROOT = path.join(os.homedir(), ".openelinaro");

let previousRootDirEnv: string | undefined;
let tempRoot = "";

let runtimeModule: typeof import("./runtime");
let runtimeAutomationModule: typeof import("./runtime-automation");
let authStoreModule: typeof import("../auth/store");
let heartbeatServiceModule: typeof import("../services/heartbeat-service");

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?runner=${Date.now()}-${Math.random()}`) as Promise<T>;
}

function copyDirectory(relativePath: string) {
  const source = path.join(repoRoot, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }
  fs.cpSync(source, path.join(tempRoot, relativePath), { recursive: true });
}

function copyMachineTestDirectory(relativePath: string) {
  const source = path.join(MACHINE_TEST_ROOT, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }
  fs.cpSync(source, path.join(tempRoot, TEST_ROOT_NAME, relativePath), { recursive: true });
}

function findSecretStoreWithAuth() {
  for (const root of [MACHINE_TEST_ROOT, PRODUCTION_ROOT]) {
    const candidate = path.join(root, "secret-store.json");
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
        profiles?: Record<string, { auth?: Record<string, unknown> }>;
      };
      const auth = parsed.profiles?.root?.auth;
      if (auth && Object.keys(auth).length > 0) {
        return candidate;
      }
    } catch {
      // skip unreadable files
    }
  }
  return null;
}

function findFixtureFile(relativePath: string) {
  for (const root of [MACHINE_TEST_ROOT, PRODUCTION_ROOT]) {
    const candidate = path.join(root, relativePath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function copyMachineTestFile(relativePath: string) {
  const source = relativePath === "secret-store.json"
    ? findSecretStoreWithAuth()
    : findFixtureFile(relativePath);
  if (!source) {
    return;
  }
  const destination = path.join(tempRoot, TEST_ROOT_NAME, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function resolveTestPath(...segments: string[]) {
  return path.join(tempRoot, TEST_ROOT_NAME, ...segments);
}

function copyProdProfileAndModelState() {
  for (const file of ["profiles/registry.json", "model-state.json"]) {
    const source = findFixtureFile(file);
    if (!source) {
      continue;
    }
    const destination = path.join(tempRoot, TEST_ROOT_NAME, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

function writeProjectRegistry() {
  fs.mkdirSync(resolveTestPath("projects"), { recursive: true });
  fs.writeFileSync(
    resolveTestPath("projects", "registry.json"),
    `${JSON.stringify({ version: 1, projects: [], jobs: [] }, null, 2)}\n`,
    "utf8",
  );
}

function writeWorkspaceFixture() {
  fs.mkdirSync(resolveTestPath("memory", "documents", "root"), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, "README.md"), "# heartbeat e2e workspace\n", "utf8");
  fs.writeFileSync(
    path.join(tempRoot, "package.json"),
    `${JSON.stringify({ name: "openelinaro-heartbeat-e2e", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
}

function writeEmptyRoutineStore() {
  // Write an empty routine store so the heartbeat has zero required candidates
  fs.mkdirSync(resolveTestPath("routines"), { recursive: true });
  fs.writeFileSync(
    resolveTestPath("routines", "store.json"),
    JSON.stringify({
      version: 1,
      settings: { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      items: [],
      todos: [],
    }, null, 2),
    "utf8",
  );
}

async function main() {
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-heartbeat-e2e-"));
  process.env.OPENELINARO_ROOT_DIR = tempRoot;

  // Copy system prompts and auth fixtures
  copyDirectory("system_prompt");
  copyMachineTestDirectory("system_prompt");
  copyMachineTestDirectory("assistant_context");
  copyMachineTestFile("secret-store.json");
  writeProjectRegistry();
  writeWorkspaceFixture();
  writeEmptyRoutineStore();
  copyProdProfileAndModelState();

  // Verify auth
  authStoreModule = await importFresh("src/auth/store.ts");
  if (
    !authStoreModule.hasProviderAuth("claude", "root") &&
    !authStoreModule.hasProviderAuth("openai-codex", "root")
  ) {
    throw new Error(
      "No root provider auth found. Ensure secret-store.json with valid credentials exists in ~/.openelinarotest/ or ~/.openelinaro/.",
    );
  }

  runtimeModule = await importFresh("src/app/runtime.ts");
  runtimeAutomationModule = await importFresh("src/app/runtime-automation.ts");
  heartbeatServiceModule = await importFresh("src/services/heartbeat-service.ts");

  const app = new runtimeModule.OpenElinaroApp({ profileId: "root" });
  const conversationKey = "e2e-heartbeat-user";

  // Run the heartbeat through the full pipeline
  console.log("[heartbeat-e2e] Running heartbeat with no required reminders...");
  const response = await app.runHourlyHeartbeat(conversationKey, {
    reference: new Date(),
  });

  console.log(`[heartbeat-e2e] response.mode: ${response.mode}`);
  console.log(`[heartbeat-e2e] response.completed: ${response.completed}`);
  console.log(`[heartbeat-e2e] response.message (raw): "${response.message}"`);
  console.log(`[heartbeat-e2e] response.message length: ${response.message.length}`);

  // Also test normalizeAssistantReply directly on the raw response
  const heartbeatService = new heartbeatServiceModule.HeartbeatService();

  // The message has already been normalized by the pipeline, but let's also
  // check what the raw model output was before normalization
  const wasMessageSuppressed = response.message === "";

  console.log(`[heartbeat-e2e] message suppressed: ${wasMessageSuppressed}`);

  // Assertions
  assert(
    response.completed,
    `Expected heartbeat to complete, but completed=${response.completed}`,
  );

  assert(
    wasMessageSuppressed,
    `Expected heartbeat to be suppressed (empty message) when nothing needs attention, ` +
    `but got: "${response.message}"`,
  );

  console.log("HEARTBEAT_E2E_OK");
}

main()
  .then(() => {
    if (previousRootDirEnv === undefined) {
      delete process.env.OPENELINARO_ROOT_DIR;
    } else {
      process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
    }
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
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
