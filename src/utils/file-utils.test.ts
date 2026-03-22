import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureDir, readJsonFile, writeJsonFileSecurely } from "./file-utils";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-utils-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ensureDir
// ---------------------------------------------------------------------------

describe("ensureDir", () => {
  test("creates a single directory", () => {
    const dir = path.join(tmpDir, "a");
    ensureDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  test("creates nested directories", () => {
    const dir = path.join(tmpDir, "a", "b", "c");
    ensureDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
  });

  test("is idempotent on existing directory", () => {
    const dir = path.join(tmpDir, "exists");
    fs.mkdirSync(dir);
    expect(() => ensureDir(dir)).not.toThrow();
    expect(fs.existsSync(dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readJsonFile
// ---------------------------------------------------------------------------

describe("readJsonFile", () => {
  test("reads and parses a valid JSON file", () => {
    const filePath = path.join(tmpDir, "data.json");
    fs.writeFileSync(filePath, JSON.stringify({ key: "value" }));
    const result = readJsonFile<{ key: string }>(filePath);
    expect(result).toEqual({ key: "value" });
  });

  test("returns null for non-existent file", () => {
    expect(readJsonFile(path.join(tmpDir, "missing.json"))).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    const filePath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(filePath, "not json {{{");
    expect(readJsonFile(filePath)).toBeNull();
  });

  test("handles arrays", () => {
    const filePath = path.join(tmpDir, "arr.json");
    fs.writeFileSync(filePath, "[1,2,3]");
    expect(readJsonFile<number[]>(filePath)).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// writeJsonFileSecurely
// ---------------------------------------------------------------------------

describe("writeJsonFileSecurely", () => {
  test("writes JSON with pretty formatting and trailing newline", () => {
    const filePath = path.join(tmpDir, "out.json");
    writeJsonFileSecurely(filePath, { hello: "world" });
    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toBe('{\n  "hello": "world"\n}\n');
  });

  test("creates parent directories automatically", () => {
    const filePath = path.join(tmpDir, "deep", "nested", "file.json");
    writeJsonFileSecurely(filePath, { ok: true });
    expect(fs.existsSync(filePath)).toBe(true);
    expect(readJsonFile<{ ok: boolean }>(filePath)).toEqual({ ok: true });
  });

  test("uses default mode 0o600", () => {
    const filePath = path.join(tmpDir, "secure.json");
    writeJsonFileSecurely(filePath, {});
    const stat = fs.statSync(filePath);
    // mode includes file-type bits; mask to permission bits
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("accepts custom mode via options", () => {
    const filePath = path.join(tmpDir, "custom.json");
    writeJsonFileSecurely(filePath, {}, { mode: 0o644 });
    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o644);
  });

  test("overwrites existing file", () => {
    const filePath = path.join(tmpDir, "overwrite.json");
    writeJsonFileSecurely(filePath, { v: 1 });
    writeJsonFileSecurely(filePath, { v: 2 });
    expect(readJsonFile<{ v: number }>(filePath)).toEqual({ v: 2 });
  });
});
