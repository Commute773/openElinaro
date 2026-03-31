import fs from "node:fs";
import path from "node:path";
import { attemptOr } from "./result";

/** Ensure a directory (and all parents) exists. */
export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/** Read and parse a JSON file. Returns `null` if the file doesn't exist or is unparseable. */
export function readJsonFile<T>(filePath: string): T | null {
  return attemptOr(() => JSON.parse(fs.readFileSync(filePath, "utf8")) as T, null);
}

/** Atomically write a JSON file with secure permissions (0o600). Creates parent dirs. */
export function writeJsonFileSecurely(filePath: string, data: unknown, options?: { mode?: number }): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: options?.mode ?? 0o600 });
}
