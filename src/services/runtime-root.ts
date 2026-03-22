import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USER_DATA_ROOT_DIRNAME = ".openelinaro";
const TEST_USER_DATA_ROOT_DIRNAME = ".openelinarotest";
const DEFAULT_SERVICE_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const USER_DATA_TOP_LEVEL = new Set([
  "config.yaml",
  "profiles",
  "projects",
  "media",
  "agent-healthchecks",
  "alarms.sqlite",
  "auth-store.json",
  "benchmarks",
  "calendar-sync-state.json",
  "communications",
  "conversation-history",
  "conversations.json",
  "deployments",
  "docs-index-state.json",
  "docs-index.json",
  "external-sessions.json",
  "finance",
  "finance.sqlite",
  "health",
  "heartbeat-state.json",
  "logs",
  "memory",
  "migrations",
  "model-state.json",
  "model-usage.jsonl",
  "models",
  "openbrowser",
  "project-workspaces.json",
  "python",
  "reflection-state.json",
  "routines.json",
  "runtime-ssh-keys",
  "secret-store.json",
  "session-todos.json",
  "shell-tasks",
  "telemetry.sqlite",
  "tmp",
  "tool-program-artifacts",
  "tool-results",
  "web-fetch",
  "workflow-session-history.json",
  "workflow-sessions.json",
  "workflows.json",
]);

export function getRuntimeRootDir() {
  const configuredRoot = process.env.OPENELINARO_ROOT_DIR?.trim();
  return configuredRoot ? path.resolve(configuredRoot) : process.cwd();
}

export function getServiceRootDir() {
  const configuredRoot = process.env.OPENELINARO_SERVICE_ROOT_DIR?.trim();
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }
  return DEFAULT_SERVICE_ROOT_DIR;
}

export function getUserDataRootDir() {
  const configuredRoot = process.env.OPENELINARO_USER_DATA_DIR?.trim();
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }
  if (process.env.NODE_ENV === "test") {
    const configuredRuntimeRoot = process.env.OPENELINARO_ROOT_DIR?.trim();
    if (configuredRuntimeRoot) {
      return path.join(path.resolve(configuredRuntimeRoot), TEST_USER_DATA_ROOT_DIRNAME);
    }
    // Fall back to a temp-dir-based path rather than touching the user's home
    // directory.  The test preload (src/test/preload.ts) should have set
    // OPENELINARO_ROOT_DIR already; this branch is a last-resort safety net.
    return path.join(os.tmpdir(), TEST_USER_DATA_ROOT_DIRNAME);
  }
  return path.join(os.homedir(), USER_DATA_ROOT_DIRNAME);
}

function getTopLevelSegment(segment: string | undefined) {
  if (!segment) {
    return "";
  }
  return segment.split(/[\\/]/, 1)[0] ?? segment;
}

function shouldResolveToUserData(segments: string[]) {
  return USER_DATA_TOP_LEVEL.has(getTopLevelSegment(segments[0]));
}

export function resolveRuntimePath(...segments: string[]) {
  const root = shouldResolveToUserData(segments) ? getUserDataRootDir() : getRuntimeRootDir();
  return path.join(root, ...segments);
}

export function resolveServicePath(...segments: string[]) {
  return path.join(getServiceRootDir(), ...segments);
}

export function resolveUserDataPath(...segments: string[]) {
  return path.join(getUserDataRootDir(), ...segments);
}

export function assertTestRuntimeRootIsIsolated(feature: string) {
  if (process.env.NODE_ENV !== "test") {
    return;
  }

  const runtimeRoot = getRuntimeRootDir();
  if (fs.existsSync(path.join(runtimeRoot, ".git"))) {
    throw new Error(
      `${feature} writes are blocked during tests unless OPENELINARO_ROOT_DIR or cwd points to an isolated test root, or OPENELINARO_USER_DATA_DIR points to an isolated directory. The Bun test preload (src/test/preload.ts) should set OPENELINARO_ROOT_DIR automatically.`,
    );
  }
}
