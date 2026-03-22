import fs from "node:fs";
import path from "node:path";
import type { SubagentEventRecord, SubagentRun, SubagentRunStatus } from "../domain/subagent-run";
import { assertTestRuntimeRootIsIsolated, resolveRuntimePath } from "../services/runtime-root";
import { telemetry as rootTelemetry, type TelemetryService } from "../services/telemetry";
import { timestamp } from "../utils/timestamp";

function getStorePath() {
  return resolveRuntimePath("subagent-runs.json");
}

function ensureStoreDir() {
  fs.mkdirSync(path.dirname(getStorePath()), { recursive: true });
}

export function nextSubagentRunId() {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SubagentRegistry {
  private runs = new Map<string, SubagentRun>();
  private readonly telemetry: TelemetryService;

  constructor(telemetry: TelemetryService = rootTelemetry.child({ component: "subagent_registry" })) {
    this.telemetry = telemetry;
    this.runs = this.load();
  }

  create(params: {
    id?: string;
    profileId: string;
    provider: SubagentRun["provider"];
    goal: string;
    tmuxSession: string;
    tmuxWindow: string;
    workspaceCwd: string;
    worktreeRoot?: string;
    worktreeBranch?: string;
    sourceWorkspaceCwd?: string;
    originConversationKey?: string;
    requestedBy?: string;
    launchDepth: number;
    timeoutMs: number;
  }): SubagentRun {
    const now = timestamp();
    const run: SubagentRun = {
      id: params.id ?? nextSubagentRunId(),
      profileId: params.profileId,
      provider: params.provider,
      goal: params.goal,
      status: "starting",
      tmuxSession: params.tmuxSession,
      tmuxWindow: params.tmuxWindow,
      workspaceCwd: params.workspaceCwd,
      worktreeRoot: params.worktreeRoot,
      worktreeBranch: params.worktreeBranch,
      sourceWorkspaceCwd: params.sourceWorkspaceCwd,
      originConversationKey: params.originConversationKey,
      requestedBy: params.requestedBy,
      launchDepth: params.launchDepth,
      timeoutMs: params.timeoutMs,
      createdAt: now,
      eventLog: [],
    };
    return this.save(run);
  }

  get(runId: string): SubagentRun | undefined {
    return this.runs.get(runId);
  }

  list(): SubagentRun[] {
    return Array.from(this.runs.values()).sort((left, right) =>
      left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0
    );
  }

  save(run: SubagentRun): SubagentRun {
    this.runs.set(run.id, run);
    this.persist();
    this.telemetry.event("subagent_registry.run_saved", {
      entityType: "subagent_run",
      entityId: run.id,
      profileId: run.profileId,
      provider: run.provider,
      status: run.status,
    });
    return run;
  }

  markStarted(runId: string): SubagentRun | undefined {
    return this.transition(runId, "running", (run) => ({
      ...run,
      startedAt: timestamp(),
    }));
  }

  markCompleted(runId: string, summary?: string): SubagentRun | undefined {
    return this.transition(runId, "completed", (run) => ({
      ...run,
      completedAt: timestamp(),
      resultSummary: summary ?? run.resultSummary,
      completionMessage: buildCompletionMessage(run, "completed", summary),
    }));
  }

  markFailed(runId: string, error: string): SubagentRun | undefined {
    return this.transition(runId, "failed", (run) => ({
      ...run,
      completedAt: timestamp(),
      error,
      completionMessage: buildCompletionMessage(run, "failed", undefined, error),
    }));
  }

  markCancelled(runId: string): SubagentRun | undefined {
    return this.transition(runId, "cancelled", (run) => ({
      ...run,
      completedAt: timestamp(),
      error: "Cancelled by parent agent.",
      completionMessage: buildCompletionMessage(run, "cancelled"),
    }));
  }

  appendEvent(runId: string, event: SubagentEventRecord): SubagentRun | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const updated: SubagentRun = {
      ...run,
      eventLog: [...run.eventLog, event],
    };
    return this.save(updated);
  }

  private transition(
    runId: string,
    newStatus: SubagentRunStatus,
    updater: (run: SubagentRun) => SubagentRun,
  ): SubagentRun | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const updated = updater({
      ...run,
      status: newStatus,
    });
    return this.save(updated);
  }

  private load(): Map<string, SubagentRun> {
    ensureStoreDir();
    const storePath = getStorePath();
    if (!fs.existsSync(storePath)) {
      return new Map<string, SubagentRun>();
    }

    const raw = JSON.parse(fs.readFileSync(storePath, "utf8")) as { runs?: SubagentRun[] };
    const runs = new Map<string, SubagentRun>();
    for (const run of raw.runs ?? []) {
      runs.set(run.id, run);
    }
    return runs;
  }

  private persist(): void {
    assertTestRuntimeRootIsIsolated("Subagent registry");
    ensureStoreDir();
    fs.writeFileSync(
      getStorePath(),
      `${JSON.stringify({ runs: this.list() }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
}

function buildCompletionMessage(
  run: SubagentRun,
  status: SubagentRunStatus,
  summary?: string,
  error?: string,
): string {
  return [
    `Background ${run.provider} agent run ${run.id} ${status}.`,
    `Goal: ${run.goal}`,
    summary ? `Summary: ${summary}` : "",
    error ? `Error: ${error}` : "",
    run.workspaceCwd ? `Workspace: ${run.workspaceCwd}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
