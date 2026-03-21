import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const repoRoot = process.cwd();
const tempRoots: string[] = [];

describe("auth store root override", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const tempRoot = tempRoots.pop();
      if (tempRoot) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    }
  });

  test("writes under OPENELINARO_ROOT_DIR instead of the current cwd", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-auth-store-test-"));
    tempRoots.push(tempRoot);

    const repoStorePath = path.join(repoRoot, ".openelinarotest", "secret-store.json");
    const repoStoreBefore = fs.existsSync(repoStorePath) ? fs.readFileSync(repoStorePath, "utf8") : null;
    const bunBin = process.execPath;

    execFileSync(
      bunBin,
      [
        "-e",
        "import { saveClaudeSetupToken } from './src/auth/store'; saveClaudeSetupToken('temp-token', 'restricted');",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          OPENELINARO_ROOT_DIR: tempRoot,
        },
        stdio: "pipe",
      },
    );

    const expectedStorePath = path.join(tempRoot, ".openelinarotest", "secret-store.json");
    const repoStoreAfter = fs.existsSync(repoStorePath) ? fs.readFileSync(repoStorePath, "utf8") : null;

    expect(fs.existsSync(expectedStorePath)).toBe(true);
    expect(repoStoreAfter).toBe(repoStoreBefore);
    expect(fs.readFileSync(expectedStorePath, "utf8")).toContain("temp-token");
  });

  test("resolves OPENELINARO_ROOT_DIR at call time instead of import time", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-auth-store-late-env-test-"));
    tempRoots.push(tempRoot);

    const repoStorePath = path.join(repoRoot, ".openelinarotest", "secret-store.json");
    const repoStoreBefore = fs.existsSync(repoStorePath) ? fs.readFileSync(repoStorePath, "utf8") : null;
    const bunBin = process.execPath;

    execFileSync(
      bunBin,
      [
        "-e",
        [
          "import { saveClaudeSetupToken } from './src/auth/store';",
          `process.env.OPENELINARO_ROOT_DIR = ${JSON.stringify(tempRoot)};`,
          "saveClaudeSetupToken('late-env-token', 'restricted');",
        ].join(" "),
      ],
      {
        cwd: repoRoot,
        env: process.env,
        stdio: "pipe",
      },
    );

    const expectedStorePath = path.join(tempRoot, ".openelinarotest", "secret-store.json");
    const repoStoreAfter = fs.existsSync(repoStorePath) ? fs.readFileSync(repoStorePath, "utf8") : null;

    expect(fs.existsSync(expectedStorePath)).toBe(true);
    expect(repoStoreAfter).toBe(repoStoreBefore);
    expect(fs.readFileSync(expectedStorePath, "utf8")).toContain("late-env-token");
  });

  test("blocks auth store writes during tests when no isolated root is configured", () => {
    const repoStorePath = path.join(repoRoot, ".openelinarotest", "secret-store.json");
    const repoStoreBefore = fs.existsSync(repoStorePath) ? fs.readFileSync(repoStorePath, "utf8") : null;
    const bunBin = process.execPath;

    expect(() =>
      execFileSync(
        bunBin,
        [
          "-e",
          "import { saveClaudeSetupToken } from './src/auth/store'; saveClaudeSetupToken('should-fail', 'restricted');",
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            NODE_ENV: "test",
            OPENELINARO_ROOT_DIR: "",
          },
          stdio: "pipe",
        },
      )).toThrow("OPENELINARO_ROOT_DIR");

    const repoStoreAfter = fs.existsSync(repoStorePath) ? fs.readFileSync(repoStorePath, "utf8") : null;
    expect(repoStoreAfter).toBe(repoStoreBefore);
  });
});
