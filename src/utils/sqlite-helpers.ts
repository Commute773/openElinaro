import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

/**
 * Open (or create) a SQLite database at `dbPath` with sensible defaults:
 *   - Ensures the parent directory exists
 *   - Sets `busy_timeout`, `journal_mode = WAL`, and `foreign_keys = ON`
 *
 * Override individual pragmas via the `pragmas` option.
 */
export function openDatabase(
  dbPath: string,
  options?: { pragmas?: Record<string, string> },
): Database {
  if (!dbPath.startsWith(":")) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath, { create: true });
  const pragmas: Record<string, string> = {
    busy_timeout: "5000",
    journal_mode: "WAL",
    foreign_keys: "ON",
    ...options?.pragmas,
  };
  for (const [key, value] of Object.entries(pragmas)) {
    db.exec(`PRAGMA ${key} = ${value};`);
  }
  return db;
}

export type SqliteRetryOptions = {
  /** Maximum number of retry attempts (default: 5). */
  maxRetries?: number;
  /** Base delay in milliseconds before the first retry (default: 50). */
  baseDelayMs?: number;
  /** Label included in warning logs to identify the call site (default: "sqlite"). */
  label?: string;
};

function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  return msg.includes("database is locked") || msg.includes("SQLITE_BUSY");
}

/**
 * Retry a synchronous SQLite operation on SQLITE_BUSY / "database is locked"
 * errors using exponential backoff with jitter.
 *
 * Delay formula: `baseDelayMs * 2^attempt + random(0, baseDelayMs)`
 *
 * Uses `Bun.sleepSync()` because bun:sqlite operations are synchronous.
 */
export function withSqliteRetry<T>(
  fn: () => T,
  options?: SqliteRetryOptions,
): T {
  const maxRetries = options?.maxRetries ?? 5;
  const baseDelayMs = options?.baseDelayMs ?? 50;
  const label = options?.label ?? "sqlite";

  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= maxRetries) {
        throw error;
      }
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * baseDelayMs;
      console.warn(
        `[${label}] SQLITE_BUSY — retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms`,
      );
      Bun.sleepSync(delay);
    }
  }
}
