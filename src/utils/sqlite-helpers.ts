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
