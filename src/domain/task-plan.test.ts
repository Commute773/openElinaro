import { test, expect, describe } from "bun:test";
import {
  createTaskPlan,
  getRunnableTasks,
  getExecutionBatch,
  updateTaskStatuses,
  isPlanComplete,
  hasPlanFailures,
  hasPlanBlockers,
  isPlanTerminal,
  type PlannedTask,
  type TaskPlan,
} from "./task-plan";

function makeTask(overrides: Partial<PlannedTask> & { id: string }): PlannedTask {
  return {
    title: overrides.id,
    status: "pending",
    executionMode: "parallel",
    dependsOn: [],
    ...overrides,
  };
}

function makePlan(tasks: PlannedTask[], goal = "test goal"): TaskPlan {
  return { id: "plan-test", goal, tasks };
}

describe("createTaskPlan", () => {
  test("returns a plan with generated id, goal, and tasks", () => {
    const tasks = [makeTask({ id: "t1" })];
    const plan = createTaskPlan("do something", tasks);
    expect(plan.id).toStartWith("plan-");
    expect(plan.goal).toBe("do something");
    expect(plan.tasks).toBe(tasks);
  });
});

describe("getRunnableTasks", () => {
  test("returns pending tasks with no dependencies", () => {
    const plan = makePlan([
      makeTask({ id: "a", status: "pending" }),
      makeTask({ id: "b", status: "pending" }),
    ]);
    expect(getRunnableTasks(plan).map((t) => t.id)).toEqual(["a", "b"]);
  });

  test("returns ready tasks with no dependencies", () => {
    const plan = makePlan([makeTask({ id: "a", status: "ready" })]);
    expect(getRunnableTasks(plan)).toHaveLength(1);
  });

  test("excludes running, completed, failed, blocked tasks", () => {
    const plan = makePlan([
      makeTask({ id: "a", status: "running" }),
      makeTask({ id: "b", status: "completed" }),
      makeTask({ id: "c", status: "failed" }),
      makeTask({ id: "d", status: "blocked" }),
    ]);
    expect(getRunnableTasks(plan)).toEqual([]);
  });

  test("excludes tasks whose dependencies are not completed", () => {
    const plan = makePlan([
      makeTask({ id: "a", status: "running" }),
      makeTask({ id: "b", status: "pending", dependsOn: ["a"] }),
    ]);
    expect(getRunnableTasks(plan)).toEqual([]);
  });

  test("includes tasks whose dependencies are all completed", () => {
    const plan = makePlan([
      makeTask({ id: "a", status: "completed" }),
      makeTask({ id: "b", status: "pending", dependsOn: ["a"] }),
    ]);
    expect(getRunnableTasks(plan).map((t) => t.id)).toEqual(["b"]);
  });

  test("handles diamond dependency pattern", () => {
    const plan = makePlan([
      makeTask({ id: "a", status: "completed" }),
      makeTask({ id: "b", status: "completed", dependsOn: ["a"] }),
      makeTask({ id: "c", status: "completed", dependsOn: ["a"] }),
      makeTask({ id: "d", status: "pending", dependsOn: ["b", "c"] }),
    ]);
    expect(getRunnableTasks(plan).map((t) => t.id)).toEqual(["d"]);
  });

  test("blocks task when only some dependencies are completed", () => {
    const plan = makePlan([
      makeTask({ id: "a", status: "completed" }),
      makeTask({ id: "b", status: "running" }),
      makeTask({ id: "c", status: "pending", dependsOn: ["a", "b"] }),
    ]);
    expect(getRunnableTasks(plan)).toEqual([]);
  });
});

describe("getExecutionBatch", () => {
  test("returns idle when no tasks are runnable", () => {
    const plan = makePlan([makeTask({ id: "a", status: "completed" })]);
    expect(getExecutionBatch(plan)).toEqual({ mode: "idle", tasks: [] });
  });

  test("returns serial batch with single task when a serial task is runnable", () => {
    const plan = makePlan([
      makeTask({ id: "a", status: "pending", executionMode: "serial" }),
      makeTask({ id: "b", status: "pending", executionMode: "parallel" }),
    ]);
    const batch = getExecutionBatch(plan);
    expect(batch.mode).toBe("serial");
    expect(batch.tasks).toHaveLength(1);
    expect(batch.tasks[0]!.id).toBe("a");
  });

  test("returns parallel batch with all parallel tasks when no serial tasks", () => {
    const plan = makePlan([
      makeTask({ id: "a", status: "pending", executionMode: "parallel" }),
      makeTask({ id: "b", status: "pending", executionMode: "parallel" }),
    ]);
    const batch = getExecutionBatch(plan);
    expect(batch.mode).toBe("parallel");
    expect(batch.tasks.map((t) => t.id)).toEqual(["a", "b"]);
  });

  test("serial task takes priority over parallel tasks", () => {
    const plan = makePlan([
      makeTask({ id: "a", status: "pending", executionMode: "parallel" }),
      makeTask({ id: "b", status: "pending", executionMode: "serial" }),
      makeTask({ id: "c", status: "pending", executionMode: "parallel" }),
    ]);
    const batch = getExecutionBatch(plan);
    expect(batch.mode).toBe("serial");
    expect(batch.tasks[0]!.id).toBe("b");
  });
});

describe("updateTaskStatuses", () => {
  test("updates status of matching tasks", () => {
    const plan = makePlan([
      makeTask({ id: "a", status: "pending" }),
      makeTask({ id: "b", status: "pending" }),
    ]);
    const updated = updateTaskStatuses(plan, [{ id: "a", status: "running" }]);
    expect(updated.tasks[0]!.status).toBe("running");
    expect(updated.tasks[1]!.status).toBe("pending");
  });

  test("preserves existing notes when update has no notes", () => {
    const plan = makePlan([makeTask({ id: "a", notes: "original" })]);
    const updated = updateTaskStatuses(plan, [{ id: "a", status: "completed" }]);
    expect(updated.tasks[0]!.notes).toBe("original");
  });

  test("overwrites notes when update provides notes", () => {
    const plan = makePlan([makeTask({ id: "a", notes: "original" })]);
    const updated = updateTaskStatuses(plan, [{ id: "a", status: "completed", notes: "done" }]);
    expect(updated.tasks[0]!.notes).toBe("done");
  });

  test("sets assignedAgent when provided", () => {
    const plan = makePlan([makeTask({ id: "a" })]);
    const updated = updateTaskStatuses(plan, [
      { id: "a", status: "running", assignedAgent: "agent-1" },
    ]);
    expect(updated.tasks[0]!.assignedAgent).toBe("agent-1");
  });

  test("does not mutate the original plan", () => {
    const plan = makePlan([makeTask({ id: "a", status: "pending" })]);
    const updated = updateTaskStatuses(plan, [{ id: "a", status: "completed" }]);
    expect(plan.tasks[0]!.status).toBe("pending");
    expect(updated.tasks[0]!.status).toBe("completed");
  });

  test("handles multiple updates at once", () => {
    const plan = makePlan([
      makeTask({ id: "a", status: "running" }),
      makeTask({ id: "b", status: "running" }),
    ]);
    const updated = updateTaskStatuses(plan, [
      { id: "a", status: "completed" },
      { id: "b", status: "failed", notes: "timeout" },
    ]);
    expect(updated.tasks[0]!.status).toBe("completed");
    expect(updated.tasks[1]!.status).toBe("failed");
    expect(updated.tasks[1]!.notes).toBe("timeout");
  });
});

describe("isPlanComplete", () => {
  test("true when all tasks are completed", () => {
    const plan = makePlan([
      makeTask({ id: "a", status: "completed" }),
      makeTask({ id: "b", status: "completed" }),
    ]);
    expect(isPlanComplete(plan)).toBe(true);
  });

  test("false when any task is not completed", () => {
    const plan = makePlan([
      makeTask({ id: "a", status: "completed" }),
      makeTask({ id: "b", status: "pending" }),
    ]);
    expect(isPlanComplete(plan)).toBe(false);
  });

  test("true for empty plan", () => {
    expect(isPlanComplete(makePlan([]))).toBe(true);
  });
});

describe("hasPlanFailures", () => {
  test("true when a task has failed", () => {
    const plan = makePlan([
      makeTask({ id: "a", status: "completed" }),
      makeTask({ id: "b", status: "failed" }),
    ]);
    expect(hasPlanFailures(plan)).toBe(true);
  });

  test("false when no tasks have failed", () => {
    const plan = makePlan([makeTask({ id: "a", status: "pending" })]);
    expect(hasPlanFailures(plan)).toBe(false);
  });
});

describe("hasPlanBlockers", () => {
  test("true when a task is blocked", () => {
    const plan = makePlan([makeTask({ id: "a", status: "blocked" })]);
    expect(hasPlanBlockers(plan)).toBe(true);
  });

  test("false when no tasks are blocked", () => {
    const plan = makePlan([makeTask({ id: "a", status: "running" })]);
    expect(hasPlanBlockers(plan)).toBe(false);
  });
});

describe("isPlanTerminal", () => {
  test("true when all tasks are completed", () => {
    const plan = makePlan([makeTask({ id: "a", status: "completed" })]);
    expect(isPlanTerminal(plan)).toBe(true);
  });

  test("true when no runnable tasks remain (deadlocked)", () => {
    const plan = makePlan([
      makeTask({ id: "a", status: "failed" }),
      makeTask({ id: "b", status: "pending", dependsOn: ["a"] }),
    ]);
    expect(isPlanTerminal(plan)).toBe(true);
  });

  test("false when runnable tasks exist", () => {
    const plan = makePlan([
      makeTask({ id: "a", status: "completed" }),
      makeTask({ id: "b", status: "pending", dependsOn: ["a"] }),
    ]);
    expect(isPlanTerminal(plan)).toBe(false);
  });
});
