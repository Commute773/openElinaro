import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

let tempRoot = "";
let previousRootDirEnv: string | undefined;

describe("ToolResultStore", () => {
  beforeEach(() => {
    previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-tool-result-store-"));
    process.env.OPENELINARO_ROOT_DIR = tempRoot;
  });

  afterEach(() => {
    if (previousRootDirEnv === undefined) {
      delete process.env.OPENELINARO_ROOT_DIR;
    } else {
      process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("persists and reloads stored tool results", async () => {
    const { ToolResultStore } = await import("./tool-result-store");
    const store = new ToolResultStore();

    const saved = await store.save({
      namespace: "conversation:test",
      toolCallId: "call-1",
      toolName: "read_file",
      status: "success",
      content: "line 1\nline 2\nline 3",
    });

    expect(saved.ref).toContain("toolres_");
    expect(saved.lineCount).toBe(3);
    expect(saved.charLength).toBe("line 1\nline 2\nline 3".length);

    const loaded = await store.get(saved.ref);
    expect(loaded).toBeTruthy();
    expect(loaded?.namespace).toBe("conversation:test");
    expect(loaded?.toolName).toBe("read_file");
    expect(loaded?.content).toBe("line 1\nline 2\nline 3");
  });
});
