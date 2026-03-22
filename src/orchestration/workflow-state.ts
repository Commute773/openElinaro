import fs from "node:fs";
import path from "node:path";
import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { PlannedTask, TaskPlan } from "../domain/task-plan";
import {
  getExecutionBatch,
  hasPlanBlockers,
  hasPlanFailures,
  isPlanComplete,
  updateTaskStatuses,
} from "../domain/task-plan";
import type {
  TaskExecutionReport,
  VerificationCommandResult,
  WorkflowRun,
} from "../domain/workflow-run";
import { approximateTextTokens } from "../utils/text-utils";
import { getRuntimeConfig } from "../config/runtime-config";
import {
  WORKFLOW_DEFAULT_MAX_CONSECUTIVE_TASK_ERRORS as DEFAULT_MAX_CONSECUTIVE_TASK_ERRORS,
} from "../config/service-constants";
import { toV3Usage } from "../services/ai-sdk-message-service";
import type { WorkflowSessionTurnRecord } from "../services/workflow-session-store";
import { timestamp } from "../utils/timestamp";
import {
  type CodingTaskOutcome,
  type SubmittedPlan,
  type WorkflowExecutionDeps,
  WorkflowHardTimeoutError,
  WorkflowResumableInterruptionError,
  WORKFLOW_TOOL_PRUNE_MINIMUM_TOKENS,
  WORKFLOW_TOOL_PRUNE_PROTECT_TOKENS,
  WORKFLOW_TOOL_PRUNE_KEEP_RECENT_MESSAGES,
  PRUNED_WORKFLOW_TOOL_MESSAGE,
  WORKFLOW_TOOL_PRUNE_PROTECTED_TOOL_NAMES,
} from "./workflow-types";

const SHARED_VERIFICATION_TMP_ROOT = path.join("/tmp", "openelinaro-workflow-verification");

function isPrunedWorkflowToolMessage(message: ToolMessage) {
  return typeof message.content === "string" && message.content === PRUNED_WORKFLOW_TOOL_MESSAGE;
}

export function pruneWorkflowToolMessages(messages: BaseMessage[]) {
  if (messages.length <= WORKFLOW_TOOL_PRUNE_KEEP_RECENT_MESSAGES) {
    return messages;
  }

  let retainedTokens = 0;
  let prunableTokens = 0;
  let changed = false;
  const nextMessages = [...messages];
  const toPrune: number[] = [];

  for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
    const message = nextMessages[index];
    if (!(message instanceof ToolMessage)) {
      continue;
    }
    if (isPrunedWorkflowToolMessage(message)) {
      continue;
    }
    const estimatedTokens = approximateTextTokens(
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
    if (message.name && WORKFLOW_TOOL_PRUNE_PROTECTED_TOOL_NAMES.has(message.name)) {
      retainedTokens += estimatedTokens;
      continue;
    }
    if (index >= nextMessages.length - WORKFLOW_TOOL_PRUNE_KEEP_RECENT_MESSAGES) {
      retainedTokens += estimatedTokens;
      continue;
    }
    retainedTokens += estimatedTokens;
    if (retainedTokens <= WORKFLOW_TOOL_PRUNE_PROTECT_TOKENS) {
      continue;
    }
    prunableTokens += estimatedTokens;
    toPrune.push(index);
  }

  if (prunableTokens < WORKFLOW_TOOL_PRUNE_MINIMUM_TOKENS) {
    return messages;
  }

  for (const index of toPrune) {
    const message = nextMessages[index];
    if (!(message instanceof ToolMessage) || isPrunedWorkflowToolMessage(message)) {
      continue;
    }
    nextMessages[index] = new ToolMessage({
      tool_call_id: message.tool_call_id,
      name: message.name,
      status: message.status,
      content: PRUNED_WORKFLOW_TOOL_MESSAGE,
    });
    changed = true;
  }

  return changed ? nextMessages : messages;
}

export function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

export function summarizeWorkflowUsage(usage: ReturnType<typeof toV3Usage>) {
  if (!usage) {
    return "tokens=n/a";
  }

  return [
    `in=${usage.inputTokens.total ?? 0}`,
    `out=${usage.outputTokens.total ?? 0}`,
    `total=${(usage.inputTokens.total ?? 0) + (usage.outputTokens.total ?? 0)}`,
  ].join(" ");
}

export function getResponseToolNames(messages: Array<{ role: string; content: unknown }>) {
  const names: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    for (const part of message.content) {
      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        (part as { type?: unknown }).type === "tool-call" &&
        "toolName" in part &&
        typeof (part as { toolName?: unknown }).toolName === "string"
      ) {
        names.push((part as { toolName: string }).toolName);
      }
    }
  }
  return uniqueStrings(names);
}

export function formatWorkflowTurnProgress(scopeLabel: string, turn: WorkflowSessionTurnRecord) {
  return [
    `[${scopeLabel}] model turn ${turn.index}`,
    turn.modelId ? `model=${turn.modelId}` : "",
    `finish=${turn.finishReason}`,
    turn.responseToolNames.length > 0 ? `tools=${turn.responseToolNames.join(",")}` : "tools=(none)",
    summarizeWorkflowUsage({
      inputTokens: {
        total: turn.inputTokens,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: turn.outputTokens,
        text: undefined,
        reasoning: undefined,
      },
      raw: undefined,
    }),
  ]
    .filter(Boolean)
    .join(" ");
}

export function sanitizeTaskId(value: string, fallbackIndex: number) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `task-${fallbackIndex + 1}`;
}

export function sanitizeFilesystemSegment(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "default";
}

export function buildTaskPlan(goal: string, submittedPlan: SubmittedPlan): TaskPlan {
  const seen = new Set<string>();
  const ids = submittedPlan.tasks.map((task, index) => {
    let candidate = sanitizeTaskId(task.id, index);
    let suffix = 2;
    while (seen.has(candidate)) {
      candidate = `${sanitizeTaskId(task.id, index)}-${suffix}`;
      suffix += 1;
    }
    seen.add(candidate);
    return candidate;
  });
  const validIds = new Set(ids);

  return {
    id: `plan-${Date.now()}`,
    goal,
    tasks: submittedPlan.tasks.map((task, index) => ({
      id: ids[index] ?? `task-${index + 1}`,
      title: task.title,
      status: task.dependsOn.length === 0 ? "ready" : "pending",
      executionMode: task.executionMode,
      dependsOn: task.dependsOn
        .map((dependencyId) => sanitizeTaskId(dependencyId, index))
        .filter((dependencyId) => validIds.has(dependencyId) && dependencyId !== (ids[index] ?? "")),
      acceptanceCriteria: task.acceptanceCriteria,
      verificationCommands: task.verificationCommands,
      notes:
        task.acceptanceCriteria.length > 0
          ? `Acceptance: ${task.acceptanceCriteria.join(" | ")}`
          : undefined,
    })),
  };
}

export function summarizeBatch(plan: TaskPlan) {
  const batch = getExecutionBatch(plan);
  if (batch.mode === "idle") {
    return "No runnable tasks remain.";
  }

  const taskList = batch.tasks.map((task) => task.title).join(", ");
  return `${batch.mode} batch: ${taskList}`;
}

export function summarizeVerification(result: VerificationCommandResult) {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  return [
    `${result.command} (exit ${result.exitCode})`,
    stdout ? `stdout: ${stdout.slice(0, 160)}` : "",
    stderr ? `stderr: ${stderr.slice(0, 160)}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

export function isTaskIssueStatus(status: TaskExecutionReport["status"]) {
  return status === "failed" || status === "blocked";
}

export function isTaskErrorStatus(status: TaskExecutionReport["status"]) {
  return status === "failed";
}

export function getMaxConsecutiveTaskErrors() {
  const override = getRuntimeConfig().core.app.workflow.maxConsecutiveTaskErrors;
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_MAX_CONSECUTIVE_TASK_ERRORS;
}

export function getRunIssueCounts(run: WorkflowRun) {
  const reports = run.taskReports ?? [];
  return {
    issueCount:
      run.taskIssueCount ?? reports.filter((report) => isTaskIssueStatus(report.status)).length,
    errorCount:
      run.taskErrorCount ?? reports.filter((report) => isTaskErrorStatus(report.status)).length,
    consecutiveErrorCount: run.consecutiveTaskErrorCount ?? 0,
  };
}

export function ensureSharedVerificationTempDir(profileId?: string) {
  const root = SHARED_VERIFICATION_TMP_ROOT;
  const profileDir = path.join(root, sanitizeFilesystemSegment(profileId ?? "default"));
  fs.mkdirSync(root, { recursive: true, mode: 0o1777 });
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o1777 });
  fs.chmodSync(root, 0o1777);
  fs.chmodSync(profileDir, 0o1777);
  return profileDir;
}

export function shouldRetryVerificationWithSharedTmp(
  command: string,
  result: Pick<VerificationCommandResult, "stderr" | "exitCode">,
) {
  return (
    result.exitCode !== 0 &&
    /\bcargo\s+test\b/.test(command) &&
    /failed to create temporary directory/i.test(result.stderr) &&
    /permission denied/i.test(result.stderr) &&
    /(doc-tests|rustdoctest)/i.test(result.stderr)
  );
}

export function getWorkspaceCwd(run: WorkflowRun) {
  return run.workspaceCwd ?? process.cwd();
}

export function appendUniqueLogEntries(existing: string[], entries: string[]) {
  return existing.concat(entries.filter((entry) => entry.trim() && !existing.includes(entry)));
}

export function mergeTaskReport(run: WorkflowRun, report: TaskExecutionReport): WorkflowRun {
  const existingReports = run.taskReports ?? [];
  const nextReports = existingReports.filter((entry) => entry.taskId !== report.taskId).concat(report);
  return {
    ...run,
    taskReports: nextReports,
  };
}

export function collectFilesTouched(run: WorkflowRun) {
  return Array.from(new Set((run.taskReports ?? []).flatMap((report) => report.filesTouched))).sort();
}

export function buildCompletionMessage(run: WorkflowRun) {
  if (run.kind !== "coding-agent") {
    return undefined;
  }

  const issueCounts = getRunIssueCounts(run);
  const filesTouched = collectFilesTouched(run);
  const recentTaskReports = (run.taskReports ?? []).slice(-3);
  return [
    `Background coding agent run ${run.id} ${run.status}.`,
    `Goal: ${run.goal}`,
    run.resultSummary ? `Summary: ${run.resultSummary}` : "",
    recentTaskReports.length > 0
      ? [
          "Recent task reports:",
          ...recentTaskReports.map((report) => `- ${report.taskId}: ${report.summary}`),
        ].join("\n")
      : "",
    run.error ? `Error: ${run.error}` : "",
    issueCounts.issueCount > 0
      ? `Task issues: ${issueCounts.issueCount} (${issueCounts.errorCount} errors, consecutive error streak ${issueCounts.consecutiveErrorCount}/${getMaxConsecutiveTaskErrors()})`
      : "",
    filesTouched.length > 0 ? `Files touched: ${filesTouched.join(", ")}` : "",
    run.workspaceCwd ? `Workspace: ${run.workspaceCwd}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildFinishedRun(run: WorkflowRun) {
  const plan = run.plan;
  let status: WorkflowRun["status"] = "completed";
  let resultSummary = run.resultSummary ?? "Workflow finished successfully.";

  if (plan) {
    const maxConsecutiveTaskErrors = getMaxConsecutiveTaskErrors();
    const issueCounts = getRunIssueCounts(run);
    const failedTaskCount = plan.tasks.filter((task) => task.status === "failed").length;
    const blockedTaskCount = plan.tasks.filter((task) => task.status === "blocked").length;
    if (isPlanComplete(plan)) {
      status = "completed";
      resultSummary =
        run.resultSummary ??
        (run.kind === "coding-agent"
          ? "Coding agent finished all planned tasks successfully."
          : "Workflow finished successfully.");
    } else if (run.kind === "coding-agent" && issueCounts.issueCount > 0) {
      if (issueCounts.consecutiveErrorCount >= maxConsecutiveTaskErrors) {
        status = "failed";
        resultSummary = `Coding agent stopped after ${issueCounts.consecutiveErrorCount} consecutive task errors (threshold ${maxConsecutiveTaskErrors}).`;
      } else {
        status = "failed";
        resultSummary = [
          "Coding agent finished with task issues.",
          `${failedTaskCount} failed, ${blockedTaskCount} blocked.`,
          `The consecutive task error threshold (${maxConsecutiveTaskErrors}) was not reached, but the overall run is still marked failed.`,
        ].join(" ");
      }
    } else if (hasPlanFailures(plan)) {
      status = "failed";
      resultSummary = "Workflow failed because at least one task failed verification or execution.";
    } else if (hasPlanBlockers(plan)) {
      status = "failed";
      resultSummary = "Workflow stopped because at least one task reported a blocker.";
    } else {
      status = "failed";
      resultSummary = "Workflow ended with unfinished tasks and no runnable work remaining.";
    }
  } else if (run.kind === "coding-agent") {
    status = "failed";
    resultSummary = "Coding agent stopped before producing a task plan.";
  }

  const filesTouched = collectFilesTouched(run);
  return {
    ...run,
    status,
    runningState: undefined,
    updatedAt: timestamp(),
    resultSummary,
    completionMessage: buildCompletionMessage({
      ...run,
      status,
      resultSummary,
    }),
    executionLog: run.executionLog.concat(
      [
        `Workflow finalized with status ${status}.`,
        filesTouched.length > 0 ? `Files touched across run: ${filesTouched.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    ),
  } satisfies WorkflowRun;
}

export function buildExceededTaskErrorThresholdRun(run: WorkflowRun) {
  const maxConsecutiveTaskErrors = getMaxConsecutiveTaskErrors();
  const issueCounts = getRunIssueCounts(run);
  const errorMessage =
    run.error ??
    `Coding agent stopped after ${issueCounts.consecutiveErrorCount} consecutive task errors (threshold ${maxConsecutiveTaskErrors}).`;

  return {
    ...run,
    status: "failed",
    runningState: undefined,
    updatedAt: timestamp(),
    resultSummary: errorMessage,
    error: errorMessage,
    completionMessage: buildCompletionMessage({
      ...run,
      status: "failed",
      resultSummary: errorMessage,
      error: errorMessage,
    }),
    executionLog: run.executionLog.concat(errorMessage),
  } satisfies WorkflowRun;
}

export function buildTimedOutRun(run: WorkflowRun, summary: string) {
  const timeoutMessage = `Workflow reached timeout of ${run.timeoutMs ?? 3_600_000}ms.`;
  const resultSummary = summary.trim()
    ? `${timeoutMessage} ${summary.trim()}`
    : timeoutMessage;

  return {
    ...run,
    status: "failed",
    runningState: undefined,
    updatedAt: timestamp(),
    resultSummary,
    error: timeoutMessage,
    completionMessage: buildCompletionMessage({
      ...run,
      status: "failed",
      resultSummary,
      error: timeoutMessage,
    }),
    executionLog: run.executionLog.concat([
      timeoutMessage,
      summary.trim() ? `Timeout handoff summary: ${summary.trim()}` : "",
    ].filter(Boolean)),
  } satisfies WorkflowRun;
}

export function buildHardTimedOutRun(run: WorkflowRun, error: WorkflowHardTimeoutError) {
  const resultSummary = [
    error.message,
    "The subagent did not finish within the extra hard-timeout grace window and was terminated.",
  ].join(" ");

  return {
    ...run,
    status: "failed",
    runningState: undefined,
    updatedAt: timestamp(),
    resultSummary,
    error: error.message,
    completionMessage: buildCompletionMessage({
      ...run,
      status: "failed",
      resultSummary,
      error: error.message,
    }),
    executionLog: run.executionLog.concat([
      error.message,
      "Subagent hard-timed out before it could finish its timeout handoff.",
    ]),
  } satisfies WorkflowRun;
}

export function buildCancelledRun(run: WorkflowRun) {
  const resultSummary = "Coding agent run was cancelled by the parent agent.";
  return {
    ...run,
    status: "cancelled",
    runningState: undefined,
    updatedAt: timestamp(),
    resultSummary,
    error: resultSummary,
    completionMessage: buildCompletionMessage({
      ...run,
      status: "cancelled",
      resultSummary,
      error: resultSummary,
    }),
    executionLog: run.executionLog.concat(resultSummary),
  } satisfies WorkflowRun;
}

export function buildResumableInterruptionRun(run: WorkflowRun, error: WorkflowResumableInterruptionError) {
  const retryCount = (run.retryCount ?? 0) + 1;
  const nextAttemptAt = new Date(Date.now() + error.retryDelayMs).toISOString();
  return {
    ...run,
    status: "running",
    runningState: "backoff",
    updatedAt: timestamp(),
    retryCount,
    nextAttemptAt,
    resultSummary:
      error.reason === "rate_limit"
        ? "Background execution hit a transient rate limit. Retrying automatically."
        : "Background execution paused after a transient harness interruption. Retrying automatically.",
    executionLog: run.executionLog.concat(
      error.reason === "rate_limit"
        ? `Background execution rate-limited: ${error.message}. Retrying at ${nextAttemptAt}.`
        : `Background execution interrupted: ${error.message}. Retrying at ${nextAttemptAt}.`,
    ),
  } satisfies WorkflowRun;
}

export function applyTaskIssueCounters(run: WorkflowRun, taskRuns: CodingTaskOutcome[]): WorkflowRun {
  let issueCount = run.taskIssueCount ?? 0;
  let errorCount = run.taskErrorCount ?? 0;
  let consecutiveErrorCount = run.consecutiveTaskErrorCount ?? 0;

  for (const taskRun of taskRuns) {
    if (isTaskIssueStatus(taskRun.report.status)) {
      issueCount += 1;
    }
    if (isTaskErrorStatus(taskRun.report.status)) {
      errorCount += 1;
      consecutiveErrorCount += 1;
      continue;
    }
    consecutiveErrorCount = 0;
  }

  return {
    ...run,
    taskIssueCount: issueCount,
    taskErrorCount: errorCount,
    consecutiveTaskErrorCount: consecutiveErrorCount,
  };
}

export function executeTaskPlanBatch(run: WorkflowRun): WorkflowRun {
  if (!run.plan) {
    return run;
  }

  const batch = getExecutionBatch(run.plan);
  if (batch.mode === "idle" || batch.tasks.length === 0) {
    return run;
  }

  const updatedPlan = updateTaskStatuses(
    run.plan,
    batch.tasks.map((task, index) => ({
      id: task.id,
      status: "completed" as const,
      assignedAgent: batch.mode === "serial" ? "foreground-agent" : `parallel-agent-${index + 1}`,
      notes:
        batch.mode === "serial"
          ? "Completed in the primary execution lane."
          : "Completed in the background parallel lane.",
    })),
  );

  return {
    ...run,
    plan: updatedPlan,
    updatedAt: timestamp(),
    resultSummary: isPlanComplete(updatedPlan)
      ? "Workflow finished successfully."
      : run.resultSummary,
    executionLog: run.executionLog.concat(`Executed ${summarizeBatch(updatedPlan)}`),
  };
}

export function buildCompletedTaskReportsSummary(run: WorkflowRun) {
  const reports = (run.taskReports ?? []).filter((report) => report.status === "completed");
  if (reports.length === 0) {
    return "Completed task reports earlier in this run: none.";
  }

  return [
    "Completed task reports earlier in this run:",
    ...reports.map((report) => `- ${report.taskId}: ${report.summary}`),
  ].join("\n");
}

export function buildPlannerResumeContext(run: WorkflowRun) {
  const sections: string[] = [];
  const priorPlanTasks = run.plan?.tasks ?? [];
  const completedReports = (run.taskReports ?? []).filter((report) => report.status === "completed");
  const issueReports = (run.taskReports ?? []).filter((report) => report.status !== "completed");
  const parentInstructions = run.pendingParentInstructions ?? [];

  if (run.resultSummary?.trim()) {
    sections.push(`Most recent run summary: ${run.resultSummary.trim()}`);
  }

  if (priorPlanTasks.length > 0) {
    sections.push([
      "Prior task state:",
      ...priorPlanTasks.map((task) => `- ${task.id}: ${task.status} - ${task.title}`),
    ].join("\n"));
  }

  if (completedReports.length > 0) {
    sections.push([
      "Previously completed task reports:",
      ...completedReports.map((report) => `- ${report.taskId}: ${report.summary}`),
    ].join("\n"));
  }

  if (issueReports.length > 0) {
    sections.push([
      "Previous task issues:",
      ...issueReports.map((report) => `- ${report.taskId}: ${report.status} - ${report.summary}`),
    ].join("\n"));
  }

  if (parentInstructions.length > 0) {
    sections.push([
      "New parent instructions:",
      ...parentInstructions.map((instruction) => `- ${instruction}`),
    ].join("\n"));
  }

  return sections.join("\n\n");
}

export async function persistRun(run: WorkflowRun, onRunUpdate?: WorkflowExecutionDeps["onRunUpdate"]) {
  await onRunUpdate?.(run);
  return run;
}
