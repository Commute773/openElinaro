import fs from "node:fs";
import path from "node:path";
import type { TaskPlan } from "../domain/task-plan";
import type { WorkflowRun } from "../domain/workflow-run";
import { assertTestRuntimeRootIsIsolated, resolveRuntimePath } from "./runtime-root";
import { telemetry as rootTelemetry, type TelemetryService } from "./telemetry";

function getStorePath() {
  return resolveRuntimePath("workflows.json");
}

function timestamp() {
  return new Date().toISOString();
}

function ensureStoreDir() {
  fs.mkdirSync(path.dirname(getStorePath()), { recursive: true });
}

export function nextWorkflowRunId() {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildFailureCompletionMessage(run: WorkflowRun, error: string) {
  if (run.kind !== "coding-agent") {
    return undefined;
  }

  return [
    `Background coding agent run ${run.id} failed.`,
    `Goal: ${run.goal}`,
    `Summary: ${error}`,
    run.workspaceCwd ? `Workspace: ${run.workspaceCwd}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export class WorkflowRegistry {
  private runs = new Map<string, WorkflowRun>();
  private readonly telemetry: TelemetryService;

  constructor(telemetry: TelemetryService = rootTelemetry.child({ component: "workflow_registry" })) {
    this.telemetry = telemetry;
    this.runs = this.load();
  }

  enqueuePlan(
    plan: TaskPlan,
    options?: {
      profileId?: string;
      workspaceCwd?: string;
      originConversationKey?: string;
      requestedBy?: string;
      timeoutMs?: number;
      launchDepth?: number;
    },
  ): WorkflowRun {
    const now = timestamp();
    const run: WorkflowRun = {
      id: nextWorkflowRunId(),
      kind: "task-plan",
      profileId: options?.profileId,
      launchDepth: options?.launchDepth,
      goal: plan.goal,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      plan,
      workspaceCwd: options?.workspaceCwd,
      originConversationKey: options?.originConversationKey,
      requestedBy: options?.requestedBy,
      timeoutMs: options?.timeoutMs,
      taskReports: [],
      executionLog: ["Workflow accepted into the background queue."],
    };

    return this.save(run);
  }

  enqueueCodingAgent(params: {
    id?: string;
    profileId?: string;
    goal: string;
    workspaceCwd?: string;
    originConversationKey?: string;
    requestedBy?: string;
    timeoutMs?: number;
    launchDepth?: number;
  }): WorkflowRun {
    const now = timestamp();
    const run: WorkflowRun = {
      id: params.id ?? nextWorkflowRunId(),
      kind: "coding-agent",
      profileId: params.profileId,
      launchDepth: params.launchDepth,
      goal: params.goal,
      status: "running",
      runningState: "active",
      createdAt: now,
      updatedAt: now,
      executionStartedAt: now,
      workspaceCwd: params.workspaceCwd,
      originConversationKey: params.originConversationKey,
      requestedBy: params.requestedBy,
      timeoutMs: params.timeoutMs,
      taskReports: [],
      retryCount: 0,
      nextAttemptAt: undefined,
      lastProgressAt: now,
      executionLog: [
        "Coding agent launched immediately.",
        params.workspaceCwd ? `Workspace: ${params.workspaceCwd}` : `Workspace: ${process.cwd()}`,
      ],
    };

    return this.save(run);
  }

  get(runId: string): WorkflowRun | undefined {
    return this.runs.get(runId);
  }

  list(): WorkflowRun[] {
    return Array.from(this.runs.values()).sort((left, right) =>
      left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0
    );
  }

  listRecoverableRuns(reference = new Date()) {
    const now = reference.toISOString();
    return this.list().filter((run) =>
      (
        run.status === "queued"
        || run.status === "interrupted"
        || (run.status === "running" && run.runningState === "backoff")
      )
      && (!run.nextAttemptAt || run.nextAttemptAt <= now)
    );
  }

  getNextRecoveryAt(reference = new Date()) {
    const now = reference.toISOString();
    return this.list()
      .filter((run) =>
        run.status === "queued"
        || run.status === "interrupted"
        || (run.status === "running" && run.runningState === "backoff")
      )
      .map((run) => run.nextAttemptAt)
      .filter((value): value is string => typeof value === "string" && value > now)
      .sort((left, right) => left.localeCompare(right))[0];
  }

  createFailedRun(run: WorkflowRun, error: unknown): WorkflowRun {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...run,
      status: "failed",
      runningState: undefined,
      updatedAt: timestamp(),
      resultSummary: message,
      completionMessage: buildFailureCompletionMessage(run, message),
      error: message,
      executionLog: run.executionLog.concat("Workflow execution failed."),
    };
  }

  save(run: WorkflowRun): WorkflowRun {
    this.runs.set(run.id, run);
    this.persist();
    this.telemetry.event("workflow_registry.run_saved", {
      workflowRunId: run.id,
      entityType: "workflow_run",
      entityId: run.id,
      profileId: run.profileId,
      status: run.status,
      runningState: run.runningState,
      kind: run.kind,
    });
    return run;
  }

  private load() {
    ensureStoreDir();
    const storePath = getStorePath();
    if (!fs.existsSync(storePath)) {
      return new Map<string, WorkflowRun>();
    }

    const raw = JSON.parse(fs.readFileSync(storePath, "utf8")) as { runs?: WorkflowRun[] };
    const runs = new Map<string, WorkflowRun>();
    for (const storedRun of raw.runs ?? []) {
      const run = (
        storedRun.kind === "coding-agent"
          && (storedRun.status === "running" || storedRun.status === "interrupted")
      )
        ? {
            ...storedRun,
            status: "interrupted" as const,
            runningState: undefined,
            updatedAt: timestamp(),
            retryCount: storedRun.retryCount ?? 0,
            executionLog: (storedRun.executionLog ?? []).concat(
              "Requeued on startup after harness restart. Persisted workflow state will resume automatically.",
            ),
          }
        : storedRun.status === "running" || storedRun.status === "interrupted"
          ? {
              ...storedRun,
              status: "queued" as const,
              runningState: undefined,
              updatedAt: timestamp(),
              retryCount: storedRun.retryCount ?? 0,
              executionLog: (storedRun.executionLog ?? []).concat(
                "Requeued on startup after harness restart. Persisted workflow state will resume automatically.",
              ),
            }
          : storedRun;
      runs.set(run.id, run);
    }
    return runs;
  }

  private persist() {
    assertTestRuntimeRootIsIsolated("Workflow registry");
    ensureStoreDir();
    fs.writeFileSync(
      getStorePath(),
      `${JSON.stringify({ runs: this.list() }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
}
