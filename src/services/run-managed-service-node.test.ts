import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const wrapperPath = path.join(process.cwd(), "scripts/run-managed-service-node.mjs");

const tempRoots: string[] = [];

describe("run-managed-service-node.mjs", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("forwards extra arguments to the bun entrypoint", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-managed-node-"));
    tempRoots.push(tempRoot);

    const fakeBunPath = path.join(tempRoot, "fake-bun.sh");
    fs.writeFileSync(
      fakeBunPath,
      [
        "#!/usr/bin/env bash",
        "printf '%s\\n' \"$@\"",
      ].join("\n"),
      { mode: 0o755 },
    );

    const fakeAppPath = path.join(tempRoot, "fake-app.ts");
    fs.writeFileSync(fakeAppPath, "console.log('unused');\n", "utf8");

    const output = execFileSync(
      process.execPath,
      [
        wrapperPath,
        fakeBunPath,
        fakeAppPath,
        tempRoot,
        tempRoot,
        "update",
        path.join(tempRoot, "status.txt"),
        "/tmp/release",
      ],
      {
        cwd: tempRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          OPENELINARO_ROOT_DIR: tempRoot,
          OPENELINARO_SERVICE_ROOT_DIR: tempRoot,
        },
      },
    );

    expect(output.trim().split("\n")).toEqual([
      fakeAppPath,
      "update",
      path.join(tempRoot, "status.txt"),
      "/tmp/release",
    ]);
  });
});
