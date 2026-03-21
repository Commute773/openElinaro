import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";

let tempRoot = "";
let previousRootDirEnv: string | undefined;

describe("WorkflowSessionStore", () => {
  beforeEach(() => {
    previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-workflow-session-store-"));
    process.env.OPENELINARO_ROOT_DIR = tempRoot;
  });

  afterEach(() => {
    if (previousRootDirEnv === undefined) {
      delete process.env.OPENELINARO_ROOT_DIR;
    } else {
      process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
    }
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("archives cleared run sessions with turns and progress logs", async () => {
    const { WorkflowSessionStore } = await import("./workflow-session-store");
    const store = new WorkflowSessionStore();

    store.save({
      key: "run-1:plan",
      runId: "run-1",
      scope: "planner",
      messages: [new HumanMessage("hello")],
      activeToolNames: ["read_file"],
      progressLog: ["[plan] tool: `read_file`"],
      turns: [
        {
          index: 1,
          startedAt: "2026-03-18T00:00:00.000Z",
          completedAt: "2026-03-18T00:00:01.000Z",
          modelId: "gpt-5.4",
          provider: "openai-codex",
          finishReason: "tool-calls",
          rawFinishReason: "toolUse",
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          responseToolNames: ["read_file"],
          activeToolNames: ["read_file"],
        },
      ],
      createdAt: "2026-03-18T00:00:00.000Z",
      updatedAt: "2026-03-18T00:00:01.000Z",
    });

    store.clearRun("run-1");

    expect(store.get("run-1:plan")).toBeUndefined();

    const archivePath = path.join(tempRoot, ".openelinarotest", "workflow-session-history.json");
    expect(fs.existsSync(archivePath)).toBe(true);
    const archive = JSON.parse(fs.readFileSync(archivePath, "utf8")) as {
      entries: Array<{
        runId: string;
        sessions: Array<{ key: string; progressLog: string[]; turns: Array<{ modelId?: string }> }>;
      }>;
    };
    expect(archive.entries).toHaveLength(1);
    expect(archive.entries[0]?.runId).toBe("run-1");
    expect(archive.entries[0]?.sessions[0]?.key).toBe("run-1:plan");
    expect(archive.entries[0]?.sessions[0]?.progressLog).toEqual(["[plan] tool: `read_file`"]);
    expect(archive.entries[0]?.sessions[0]?.turns[0]?.modelId).toBe("gpt-5.4");
  });
});
