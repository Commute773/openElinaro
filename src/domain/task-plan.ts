export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "blocked"
  | "completed"
  | "failed";

export type TaskExecutionMode = "serial" | "parallel";

export type AgentCapability =
  | "planning"
  | "search"
  | "tools"
  | "coding"
  | "review"
  | "memory";

export interface PlannedTask {
  id: string;
  title: string;
  status: TaskStatus;
  executionMode: TaskExecutionMode;
  dependsOn: string[];
  assignedAgent?: string;
  notes?: string;
  acceptanceCriteria?: string[];
  verificationCommands?: string[];
}

export interface TaskPlan {
  id: string;
  goal: string;
  tasks: PlannedTask[];
}

export interface ExecutionBatch {
  mode: "serial" | "parallel" | "idle";
  tasks: PlannedTask[];
}

export function createTaskPlan(goal: string, tasks: PlannedTask[]): TaskPlan {
  return {
    id: `plan-${Date.now()}`,
    goal,
    tasks,
  };
}

export function getRunnableTasks(plan: TaskPlan): PlannedTask[] {
  const completed = new Set(
    plan.tasks.filter((task) => task.status === "completed").map((task) => task.id),
  );

  return plan.tasks.filter((task) => {
    if (task.status !== "ready" && task.status !== "pending") {
      return false;
    }

    return task.dependsOn.every((dependencyId) => completed.has(dependencyId));
  });
}

export function getExecutionBatch(plan: TaskPlan): ExecutionBatch {
  const runnable = getRunnableTasks(plan);
  if (runnable.length === 0) {
    return { mode: "idle", tasks: [] };
  }

  const serialTask = runnable.find((task) => task.executionMode === "serial");
  if (serialTask) {
    return { mode: "serial", tasks: [serialTask] };
  }

  return {
    mode: "parallel",
    tasks: runnable.filter((task) => task.executionMode === "parallel"),
  };
}

export function updateTaskStatuses(
  plan: TaskPlan,
  updates: Array<{
    id: string;
    status: TaskStatus;
    notes?: string;
    assignedAgent?: string;
  }>,
): TaskPlan {
  const updateById = new Map(updates.map((update) => [update.id, update]));

  return {
    ...plan,
    tasks: plan.tasks.map((task) => {
      const update = updateById.get(task.id);
      if (!update) {
        return task;
      }

      return {
        ...task,
        status: update.status,
        notes: update.notes ?? task.notes,
        assignedAgent: update.assignedAgent ?? task.assignedAgent,
      };
    }),
  };
}

export function isPlanComplete(plan: TaskPlan): boolean {
  return plan.tasks.every((task) => task.status === "completed");
}

export function hasPlanFailures(plan: TaskPlan): boolean {
  return plan.tasks.some((task) => task.status === "failed");
}

export function hasPlanBlockers(plan: TaskPlan): boolean {
  return plan.tasks.some((task) => task.status === "blocked");
}

export function isPlanTerminal(plan: TaskPlan): boolean {
  return isPlanComplete(plan) || getRunnableTasks(plan).length === 0;
}
