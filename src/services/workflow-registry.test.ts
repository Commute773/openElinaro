import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTaskPlan } from "../domain/task-plan";
import type { TelemetryService } from "./telemetry";
import { WorkflowRegistry } from "./workflow-registry";

let tempRoot = "";
let previousRootDirEnv: string | undefined;
const telemetryStub = {
  event() {},
} as unknown as TelemetryService;

describe("WorkflowRegistry", () => {
  beforeEach(() => {
    previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-workflow-registry-"));
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

  test("launches coding-agent runs directly into running state", () => {
    const registry = new WorkflowRegistry(telemetryStub);

    const run = registry.enqueueCodingAgent({
      goal: "Test immediate launch.",
      workspaceCwd: tempRoot,
      timeoutMs: 30_000,
    });

    expect(run.status).toBe("running");
    expect(run.runningState).toBe("active");
    expect(run.executionStartedAt).toBeTruthy();
    expect(run.retryCount).toBe(0);
    expect(run.executionLog[0]).toContain("launched immediately");
  });

  test("requeues persisted coding-agent runs as interrupted and task plans as queued", () => {
    fs.mkdirSync(path.join(tempRoot, ".openelinarotest"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, ".openelinarotest", "workflows.json"),
      `${JSON.stringify({
        runs: [
          {
            id: "run-coding",
            kind: "coding-agent",
            goal: "Resume me",
            status: "running",
            createdAt: "2026-03-19T00:00:00.000Z",
            updatedAt: "2026-03-19T00:00:00.000Z",
            executionStartedAt: "2026-03-19T00:00:00.000Z",
            executionLog: ["started"],
            taskReports: [],
          },
          {
            id: "run-plan",
            kind: "task-plan",
            goal: "Resume task plan",
            status: "running",
            createdAt: "2026-03-19T00:00:00.000Z",
            updatedAt: "2026-03-19T00:00:00.000Z",
            plan: createTaskPlan("Resume task plan", []),
            executionLog: ["started"],
            taskReports: [],
          },
        ],
      }, null, 2)}\n`,
    );

    const registry = new WorkflowRegistry(telemetryStub);

    expect(registry.get("run-coding")?.status).toBe("interrupted");
    expect(registry.get("run-plan")?.status).toBe("queued");
    expect(registry.get("run-coding")?.executionLog.at(-1)).toContain("Persisted workflow state will resume automatically");
  });

  test("treats running backoff runs as recoverable and schedules the next retry", () => {
    const registry = new WorkflowRegistry(telemetryStub);
    const now = new Date("2026-03-19T12:00:00.000Z");

    registry.save({
      id: "run-backoff-now",
      kind: "coding-agent",
      goal: "Retry now",
      status: "running",
      runningState: "backoff",
      createdAt: "2026-03-19T11:00:00.000Z",
      updatedAt: "2026-03-19T11:59:00.000Z",
      executionStartedAt: "2026-03-19T11:00:00.000Z",
      nextAttemptAt: "2026-03-19T11:59:30.000Z",
      executionLog: [],
      taskReports: [],
    });
    registry.save({
      id: "run-backoff-later",
      kind: "coding-agent",
      goal: "Retry later",
      status: "running",
      runningState: "backoff",
      createdAt: "2026-03-19T11:00:00.000Z",
      updatedAt: "2026-03-19T11:59:00.000Z",
      executionStartedAt: "2026-03-19T11:00:00.000Z",
      nextAttemptAt: "2026-03-19T12:05:00.000Z",
      executionLog: [],
      taskReports: [],
    });

    expect(registry.listRecoverableRuns(now).map((run) => run.id)).toEqual(["run-backoff-now"]);
    expect(registry.getNextRecoveryAt(now)).toBe("2026-03-19T12:05:00.000Z");
  });
});
