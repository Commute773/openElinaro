import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildServiceTransitionCompletionMessage,
  sendDiscordDirectMessage,
} from "../services/service-transition-notifier";
import { getUserDataRootDir } from "../services/runtime-root";

const execFileAsync = promisify(execFile);

function usage() {
  return "usage: bun src/cli/service-transition-helper.ts <update|rollback> <status-path> [target-release]";
}

function parsePositiveInt(raw: string | undefined, fallback: number) {
  if (!raw?.trim()) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function writeStatus(
  statusPath: string,
  lines: Record<string, string | number>,
) {
  await fs.mkdir(path.dirname(statusPath), { recursive: true });
  const body = Object.entries(lines).map(([key, value]) => `${key}=${value}`).join("\n");
  await fs.writeFile(statusPath, `${body}\n`, "utf8");
}

async function readCurrentVersion(rootDir: string) {
  try {
    const userDataDir = getUserDataRootDir();
    const deploymentsDir = path.join(userDataDir, "deployments");
    const pointerPath = path.join(deploymentsDir, "current-release.txt");
    const currentReleaseDir = (await fs.readFile(pointerPath, "utf8")).trim();
    if (!currentReleaseDir) {
      return "";
    }
    const versionPath = path.join(currentReleaseDir, "VERSION.json");
    const raw = await fs.readFile(versionPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "";
  } catch {
    return "";
  }
}

async function notifyTransitionStatus(rootDir: string, action: "update" | "rollback", status: "completed" | "failed") {
  const userId = process.env.OPENELINARO_NOTIFY_DISCORD_USER_ID?.trim();
  if (action !== "update" || !userId) {
    return;
  }

  const version = status === "completed" ? await readCurrentVersion(rootDir) : "";
  const message = buildServiceTransitionCompletionMessage({ action, status, version });
  if (!message) {
    return;
  }

  try {
    await sendDiscordDirectMessage({ userId, message });
  } catch (error) {
    console.error(`Unable to send ${action} ${status} Discord notification.`);
    console.error(error instanceof Error ? error.message : String(error));
  }
}

const action = process.argv[2];
const statusPath = process.argv[3];
const targetReleaseDir = process.argv[4] ?? "";

if ((action !== "update" && action !== "rollback") || !statusPath?.trim()) {
  console.error(usage());
  process.exit(1);
}

if (process.env.OPENELINARO_AGENT_SERVICE_CONTROL !== "1") {
  console.error("Managed-service update and rollback scripts are internal. Use the root-only agent update flow instead.");
  process.exit(1);
}

const rootDir = process.env.OPENELINARO_ROOT_DIR?.trim() || process.cwd();
const delayMs = parsePositiveInt(process.env.OPENELINARO_DETACHED_HELPER_DELAY_MS, 5_000);
const scriptPath = path.join(rootDir, "scripts", `service-${action}.sh`);

await writeStatus(statusPath, {
  status: "running",
  action,
  startedAt: new Date().toISOString(),
});

if (delayMs > 0) {
  await Bun.sleep(delayMs);
}

try {
  const args = targetReleaseDir && action === "rollback" ? [targetReleaseDir] : [];
  const result = await execFileAsync(scriptPath, args, {
    cwd: rootDir,
    env: {
      ...process.env,
      OPENELINARO_AGENT_SERVICE_CONTROL: "1",
    },
    maxBuffer: 1024 * 1024 * 4,
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  await writeStatus(statusPath, {
    status: "completed",
    action,
    completedAt: new Date().toISOString(),
  });
  await notifyTransitionStatus(rootDir, action, "completed");
} catch (error) {
  const execError = error as NodeJS.ErrnoException & {
    code?: number | string;
    stdout?: string;
    stderr?: string;
  };
  if (execError.stdout) {
    process.stdout.write(execError.stdout);
  }
  if (execError.stderr) {
    process.stderr.write(execError.stderr);
  } else if (execError.message) {
    console.error(execError.message);
  }

  const exitCode = typeof execError.code === "number" ? execError.code : 1;
  await writeStatus(statusPath, {
    status: "failed",
    action,
    completedAt: new Date().toISOString(),
    exitCode,
  });
  await notifyTransitionStatus(rootDir, action, "failed");
  process.exit(exitCode);
}
