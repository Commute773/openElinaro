import { test, expect, describe } from "bun:test";
import { isSqliteBusyError, withSqliteRetry } from "./sqlite-helpers";

// ---------------------------------------------------------------------------
// isSqliteBusyError
// ---------------------------------------------------------------------------
describe("isSqliteBusyError", () => {
  test("returns true for 'database is locked' error", () => {
    expect(isSqliteBusyError(new Error("database is locked"))).toBe(true);
  });

  test("returns true for SQLITE_BUSY error", () => {
    expect(isSqliteBusyError(new Error("SQLITE_BUSY: database table is locked"))).toBe(true);
  });

  test("returns false for other errors", () => {
    expect(isSqliteBusyError(new Error("no such table: foo"))).toBe(false);
  });

  test("returns false for non-Error objects", () => {
    expect(isSqliteBusyError("database is locked")).toBe(false);
    expect(isSqliteBusyError(null)).toBe(false);
    expect(isSqliteBusyError(undefined)).toBe(false);
    expect(isSqliteBusyError(42)).toBe(false);
  });

  test("returns false for error without matching message", () => {
    expect(isSqliteBusyError(new Error("connection refused"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withSqliteRetry
// ---------------------------------------------------------------------------
describe("withSqliteRetry", () => {
  test("returns value on first success", () => {
    const result = withSqliteRetry(() => 42);
    expect(result).toBe(42);
  });

  test("retries on SQLITE_BUSY and eventually succeeds", () => {
    let attempts = 0;
    const result = withSqliteRetry(
      () => {
        attempts++;
        if (attempts < 3) throw new Error("database is locked");
        return "ok";
      },
      { maxRetries: 5, baseDelayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  test("throws after max retries exceeded", () => {
    let attempts = 0;
    expect(() =>
      withSqliteRetry(
        () => {
          attempts++;
          throw new Error("database is locked");
        },
        { maxRetries: 2, baseDelayMs: 1 },
      ),
    ).toThrow("database is locked");
    // Initial attempt + 2 retries = 3 total attempts
    expect(attempts).toBe(3);
  });

  test("throws immediately for non-busy errors", () => {
    let attempts = 0;
    expect(() =>
      withSqliteRetry(
        () => {
          attempts++;
          throw new Error("no such table");
        },
        { maxRetries: 5, baseDelayMs: 1 },
      ),
    ).toThrow("no such table");
    expect(attempts).toBe(1);
  });

  test("uses default options when none provided", () => {
    const result = withSqliteRetry(() => "default");
    expect(result).toBe("default");
  });

  test("respects custom label in logs", () => {
    let attempts = 0;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]));
    try {
      withSqliteRetry(
        () => {
          attempts++;
          if (attempts < 2) throw new Error("database is locked");
          return "ok";
        },
        { maxRetries: 3, baseDelayMs: 1, label: "test-db" },
      );
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("[test-db]");
    } finally {
      console.warn = originalWarn;
    }
  });
});
