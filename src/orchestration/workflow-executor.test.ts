import { describe, expect, test, mock } from "bun:test";
import type { PlannedTask } from "../domain/task-plan";
import type { WorkflowRun } from "../domain/workflow-run";
import type { WorkflowExecutionDeps } from "./workflow-types";
import {
  WorkflowResumableInterruptionError,
  WorkflowHardTimeoutError,
} from "./workflow-types";
import { executeCodingTaskSafely, executeCodingBatch } from "./workflow-executor";

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-1",
    kind: "coding-agent",
    goal: "Test goal",
    status: "running",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    executionLog: [],
    ...overrides,
  };
}

function makeTask(id: string, overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    id,
    title: `Task ${id}`,
    status: "ready",
    executionMode: "serial",
    dependsOn: [],
    acceptanceCriteria: ["it works"],
    verificationCommands: ["bun test"],
    ...overrides,
  };
}

function makePlan(tasks: PlannedTask[]) {
  return { id: "plan-1", goal: "Test", tasks };
}

const defaultTimeout = {
  startedAtMs: Date.now(),
  timeoutMs: 600_000,
  hardTimeoutMs: 900_000,
};

function makeDeps(toolResolverOverride: Record<string, unknown> = {}): WorkflowExecutionDeps {
  return {
    connector: {} as any,
    toolResolver: {
      resolveAllForCodingWorker: () => { throw new Error("not configured"); },
      ...toolResolverOverride,
    } as any,
    shell: { execVerification: mock(() => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })) },
    workflowSessions: {
      ensure: mock(() => {}),
      get: mock(() => ({ progressLog: [], activeToolNames: [] })),
      appendProgress: mock(() => {}),
      addActiveTools: mock(() => {}),
    } as any,
    baseSystemPrompt: "test",
  } as unknown as WorkflowExecutionDeps;
}

describe("executeCodingTaskSafely", () => {
  test("catches generic errors and returns a failed CodingTaskOutcome", async () => {
    const deps = makeDeps({
      resolveAllForCodingWorker: () => { throw new Error("Simulated tool resolution failure"); },
    });

    const result = await executeCodingTaskSafely({
      run: makeRun(),
      task: makeTask("t1"),
      deps,
      agentLabel: "test-agent",
      timeout: defaultTimeout,
    });

    expect(result.kind).toBe("completed");
    expect(result.report.status).toBe("failed");
    expect(result.report.summary).toContain("Simulated tool resolution failure");
    expect(result.report.taskId).toBe("t1");
  });

  test("re-throws WorkflowResumableInterruptionError", async () => {
    const deps = makeDeps({
      resolveAllForCodingWorker: () => {
        throw new WorkflowResumableInterruptionError("rate limited", 5000, "rate_limit");
      },
    });

    await expect(
      executeCodingTaskSafely({
        run: makeRun(),
        task: makeTask("t1"),
        deps,
        agentLabel: "test-agent",
        timeout: defaultTimeout,
      }),
    ).rejects.toThrow(WorkflowResumableInterruptionError);
  });

  test("re-throws WorkflowHardTimeoutError", async () => {
    const deps = makeDeps({
      resolveAllForCodingWorker: () => {
        throw new WorkflowHardTimeoutError(60000, 90000);
      },
    });

    await expect(
      executeCodingTaskSafely({
        run: makeRun(),
        task: makeTask("t1"),
        deps,
        agentLabel: "test-agent",
        timeout: defaultTimeout,
      }),
    ).rejects.toThrow(WorkflowHardTimeoutError);
  });
});

describe("executeCodingBatch", () => {
  test("returns completed immediately when run has no plan", async () => {
    const run = makeRun();
    const deps = {} as unknown as WorkflowExecutionDeps;
    const result = await executeCodingBatch(run, deps, defaultTimeout);
    expect(result.kind).toBe("completed");
    expect(result.run).toBe(run);
  });

  test("returns completed when plan has no runnable tasks", async () => {
    const plan = makePlan([
      { id: "t1", title: "Done", status: "completed", executionMode: "serial", dependsOn: [] },
    ]);
    const run = makeRun({ plan });
    const deps = {} as unknown as WorkflowExecutionDeps;
    const result = await executeCodingBatch(run, deps, defaultTimeout);
    expect(result.kind).toBe("completed");
  });

  test("executes a batch of serial tasks and merges reports", async () => {
    const plan = makePlan([
      makeTask("t1", { status: "ready", executionMode: "serial" }),
    ]);
    const run = makeRun({ plan });
    const deps = makeDeps({
      resolveAllForCodingWorker: () => { throw new Error("Controlled failure for batch test"); },
    });

    const result = await executeCodingBatch(run, deps, defaultTimeout);

    expect(result.kind).toBe("completed");
    expect(result.run.taskReports).toHaveLength(1);
    expect(result.run.taskReports![0].taskId).toBe("t1");
    expect(result.run.taskReports![0].status).toBe("failed");
    expect(result.run.executionLog.length).toBeGreaterThan(0);
    expect(result.run.executionLog.some((e) => e.includes("t1"))).toBe(true);
  });

  test("labels parallel workers with index-based agent names", async () => {
    const plan = makePlan([
      makeTask("t1", { status: "ready", executionMode: "parallel" }),
      makeTask("t2", { status: "ready", executionMode: "parallel" }),
    ]);
    const run = makeRun({ plan });
    const deps = makeDeps({
      resolveAllForCodingWorker: () => { throw new Error("Controlled failure"); },
    });

    const result = await executeCodingBatch(run, deps, defaultTimeout);

    expect(result.kind).toBe("completed");
    expect(result.run.taskReports).toHaveLength(2);
    const taskIds = result.run.taskReports!.map((r) => r.taskId).sort();
    expect(taskIds).toEqual(["t1", "t2"]);
  });
});
