/**
 * Pure utility functions for the media subsystem.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { telemetry } from "../infrastructure/telemetry";
import type { CommandResult, SpeakerTransport } from "./types";

export function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value && value.trim()))));
}

export function normalizeToken(value: string) {
  return value.toLowerCase().trim();
}

export function slugify(value: string) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "media";
}

export function titleCaseFromSlug(value: string) {
  return value
    .replace(/\.[^.]+$/, "")
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

export function sleep(delayMs: number) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function defaultProcessIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function defaultSignalProcess(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal);
  } catch {
    // Best effort only.
  }
}

export function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    telemetry.event("media.invalid_json", {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    }, {
      level: "warn",
      outcome: "error",
    });
    return null;
  }
}

export function resolveSpeakerConfigPath(
  defaultPath: string,
  legacyPath: string,
): string {
  if (existsSync(defaultPath)) {
    return defaultPath;
  }
  if (existsSync(legacyPath)) {
    telemetry.event("media.legacy_speaker_config", {
      legacyPath,
      expectedPath: defaultPath,
    }, {
      level: "warn",
      outcome: "ok",
    });
    return legacyPath;
  }
  return defaultPath;
}

export async function defaultRunCommand(params: {
  file: string;
  args?: string[];
  input?: string;
  timeoutMs?: number;
  allowFailure?: boolean;
}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(params.file, params.args ?? [], {
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = params.timeoutMs ?? 15_000;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${params.file}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const result = {
        stdout,
        stderr,
        exitCode: exitCode ?? 0,
      };
      if (result.exitCode !== 0 && !params.allowFailure) {
        reject(new Error(`Command failed (${result.exitCode}): ${params.file} ${(params.args ?? []).join(" ")}\n${stderr.trim()}`));
        return;
      }
      resolve(result);
    });

    if (params.input) {
      child.stdin.write(params.input);
    }
    child.stdin.end();
  });
}

export async function defaultSpawnDetached(params: {
  file: string;
  args?: string[];
  stdoutPath: string;
  stderrPath: string;
}): Promise<{ pid: number }> {
  mkdirSync(path.dirname(params.stdoutPath), { recursive: true });
  mkdirSync(path.dirname(params.stderrPath), { recursive: true });
  const stdoutFd = openSync(params.stdoutPath, "a");
  const stderrFd = openSync(params.stderrPath, "a");
  const child = spawn(params.file, params.args ?? [], {
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
  });
  child.unref();
  closeSync(stdoutFd);
  closeSync(stderrFd);
  return { pid: child.pid ?? 0 };
}

export function normalizeTransport(value?: string): SpeakerTransport {
  switch (normalizeToken(value ?? "")) {
    case "aux":
      return "aux";
    case "bluetooth":
      return "bluetooth";
    case "built-in":
    case "builtin":
    case "internal":
      return "built-in";
    default:
      return value ? "unknown" : "system";
  }
}
