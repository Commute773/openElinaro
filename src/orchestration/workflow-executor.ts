import { HumanMessage } from "@langchain/core/messages";
import type { PlannedTask } from "../domain/task-plan";
import {
  getExecutionBatch,
  isPlanComplete,
  updateTaskStatuses,
} from "../domain/task-plan";
import type {
  TaskExecutionReport,
  VerificationCommandResult,
  WorkflowRun,
} from "../domain/workflow-run";
import { toToolSet } from "../services/ai-sdk-message-service";
import { timestamp } from "../utils/timestamp";
import type {
  TimeoutContext,
  CodingTaskOutcome,
  CodingBatchOutcome,
  SubmittedTask,
  WorkflowExecutionDeps,
} from "./workflow-types";
import {
  submittedTaskSchema,
  MAX_VERIFICATION_COMMANDS,
  WorkflowCancelledError,
  WorkflowHardTimeoutError,
  WorkflowResumableInterruptionError,
} from "./workflow-types";
import { buildWorkflowTimeAwarenessBlock } from "./workflow-timeout";
import {
  getWorkspaceCwd,
  summarizeBatch,
  summarizeVerification,
  mergeTaskReport,
  applyTaskIssueCounters,
  ensureSharedVerificationTempDir,
  shouldRetryVerificationWithSharedTmp,
  buildCompletedTaskReportsSummary,
  pruneWorkflowToolMessages,
} from "./workflow-state";
import {
  runStructuredToolAgent,
  ensureWorkflowSession,
  buildWorkflowAgentSystemPrompt,
  isWorkflowReasonToolEnabled,
} from "./workflow-agent-runner";
import type { AppProgressEvent } from "../domain/assistant";

export async function executeCodingTask(params: {
  run: WorkflowRun;
  task: PlannedTask;
  deps: WorkflowExecutionDeps;
  agentLabel: string;
  timeout: TimeoutContext;
}) {
  const { run, task, deps, agentLabel, timeout } = params;
  const workspaceCwd = getWorkspaceCwd(run);
  const workerSessionKey = `${run.id}:${task.id}`;
  const userPrompt = [
    `Overall goal: ${run.goal}`,
    `Workspace cwd: ${workspaceCwd}`,
    buildWorkflowTimeAwarenessBlock(timeout),
    `Assigned task id: ${task.id}`,
    `Assigned task title: ${task.title}`,
    task.acceptanceCriteria?.length
      ? `Acceptance criteria:\n- ${task.acceptanceCriteria.join("\n- ")}`
      : "Acceptance criteria: satisfy the task title and keep the repository coherent.",
    task.verificationCommands?.length
      ? `Suggested verification commands:\n- ${task.verificationCommands.join("\n- ")}`
      : "Suggested verification commands: determine and run the smallest relevant checks yourself.",
    "Inspect, implement, verify, then submit the structured result.",
  ].join("\n\n");
  deps.workflowSessions.ensure({
    key: workerSessionKey,
    runId: run.id,
    scope: "worker",
    taskId: task.id,
    messages: [new HumanMessage(userPrompt)],
  });
  const recordProgress = async (event: AppProgressEvent) => {
    const message = typeof event === "string" ? event : event.message;
    deps.workflowSessions.appendProgress(workerSessionKey, `[${task.id}] ${message}`);
  };
  const activatedToolNames = new Set(
    deps.workflowSessions.get(workerSessionKey)?.activeToolNames ?? [],
  );
  const context = {
    conversationKey: workerSessionKey,
    onToolUse: recordProgress,
    invocationSource: "direct" as const,
    getActiveToolNames: () => [...activatedToolNames],
    activateToolNames: (toolNames: string[]) => {
      for (const name of toolNames) {
        activatedToolNames.add(name);
      }
      deps.workflowSessions.addActiveTools(workerSessionKey, toolNames);
    },
  };
  const allTools = toToolSet(
    deps.toolResolver.resolveAllForCodingWorker({
      context,
      defaultCwd: workspaceCwd,
    }).entries,
  );

  const submittedTask = await runStructuredToolAgent<SubmittedTask>(
    {
      connector: deps.connector,
      allTools,
      getActiveTools: () =>
        deps.toolResolver.resolveForCodingWorker({
          activatedToolNames: [...activatedToolNames],
          context,
          defaultCwd: workspaceCwd,
        }).tools,
      sessionId: workerSessionKey,
      sessionStore: deps.workflowSessions,
      sessionScope: "worker",
      runId: run.id,
      taskId: task.id,
      retryCount: run.retryCount,
      timeout,
      abortSignal: deps.abortSignal,
      systemPrompt: buildWorkflowAgentSystemPrompt({
        baseSystemPrompt: deps.baseSystemPrompt,
        assistantContext: deps.assistantContext,
        run,
        timeout,
        role: "worker",
        task,
        roleInstructions: [
          "You are a background coding worker.",
          "Work only inside the provided workspace.",
          "Start by inspecting the relevant files before editing them.",
          "Use the currently visible tools first. Call load_tool_library only when the needed tool family is not already visible.",
          "If exec_command is visible, use it directly for targeted verification instead of searching for a command runner.",
          ...(isWorkflowReasonToolEnabled()
            ? ["In this test-mode run, include report_progress immediately before non-submission tool calls when practical, ideally in the same response. Do not spend extra turns only to satisfy observability."]
            : []),
          "If the task requires repeated searches, reads, filtering, or aggregation, use run_tool_program instead of bouncing every intermediate result through the model.",
          "Treat the timeout as real wall-clock budget, not turn count. Re-check the remaining time from the prompt before starting another implementation loop or full verification sweep.",
          "Make the smallest coherent set of changes that fully satisfies the assigned task.",
          "Run the relevant validation commands before declaring success whenever the task changes code or behavior.",
          "If you are missing required context or the task is unsafe to continue, report blocked instead of guessing.",
          "End by calling complete_coding_task. Do not stop with plain text.",
        ],
      }),
      userPrompt,
      submissionToolName: "complete_coding_task",
      submissionToolDescription:
        "Submit the final status for this coding task after implementation and verification.",
      submissionSchema: submittedTaskSchema,
      timeoutSummaryPrompt: (session) => [
        `Overall goal: ${run.goal}`,
        `Workspace cwd: ${workspaceCwd}`,
        `Assigned task id: ${task.id}`,
        `Assigned task title: ${task.title}`,
        task.acceptanceCriteria?.length
          ? `Acceptance criteria:\n- ${task.acceptanceCriteria.join("\n- ")}`
          : "Acceptance criteria: satisfy the task title and keep the repository coherent.",
        task.verificationCommands?.length
          ? `Suggested verification commands:\n- ${task.verificationCommands.join("\n- ")}`
          : "Suggested verification commands: determine the smallest relevant checks yourself.",
        buildCompletedTaskReportsSummary(run),
        session.progressLog.length > 0
          ? `Tool activity before timeout:\n- ${session.progressLog.join("\n- ")}`
          : "Tool activity before timeout: none recorded.",
        "You have reached the workflow timeout.",
        "Do not continue working. Summarize what has already been done, what remains unfinished, and the best next step for the parent agent.",
      ].join("\n\n"),
    },
    pruneWorkflowToolMessages,
  );

  const workerSession = deps.workflowSessions.get(workerSessionKey);

  if (submittedTask.kind === "timed_out") {
    const report: TaskExecutionReport = {
      taskId: task.id,
      title: task.title,
      status: "failed",
      summary: submittedTask.summary,
      filesTouched: [],
      commandsRun: [],
      verification: [],
      updatedAt: timestamp(),
    };

    return {
      kind: "timed_out",
      task,
      report,
      assignedAgent: agentLabel,
      notes: submittedTask.summary,
      progressLog: workerSession?.progressLog ?? [],
      timeoutSummary: submittedTask.summary,
    } satisfies CodingTaskOutcome;
  }

  const verificationCommands = Array.from(
    new Set(
      submittedTask.value.status === "completed"
        ? [...(task.verificationCommands ?? []), ...submittedTask.value.verificationCommands]
        : [],
    ),
  ).slice(0, MAX_VERIFICATION_COMMANDS);

  const verification = await Promise.all(
    verificationCommands.map(async (command) => {
      if (deps.abortSignal?.aborted) {
        throw new WorkflowCancelledError();
      }
      const initialResult = await deps.shell.execVerification({
        command,
        cwd: workspaceCwd,
        timeoutMs: 180_000,
      });
      if (!shouldRetryVerificationWithSharedTmp(command, initialResult)) {
        return {
          command,
          exitCode: initialResult.exitCode,
          stdout: initialResult.stdout,
          stderr: initialResult.stderr,
        } satisfies VerificationCommandResult;
      }

      const sharedTmpDir = ensureSharedVerificationTempDir(run.profileId);
      const retriedCommand = `TMPDIR=${sharedTmpDir} TMP=${sharedTmpDir} TEMP=${sharedTmpDir} ${command}`;
      if (deps.abortSignal?.aborted) {
        throw new WorkflowCancelledError();
      }
      const retriedResult = await deps.shell.execVerification({
        command: retriedCommand,
        cwd: workspaceCwd,
        timeoutMs: 180_000,
      });

      return {
        command,
        exitCode: retriedResult.exitCode,
        stdout: retriedResult.stdout,
        stderr: [
          retriedResult.stderr.trim(),
          retriedResult.exitCode === 0
            ? `[openelinaro] Retried with shared TMPDIR=${sharedTmpDir} after an initial temp-directory permission error.`
            : `[openelinaro] Retried with shared TMPDIR=${sharedTmpDir} after an initial temp-directory permission error, but the retry also failed.`,
          initialResult.stderr.trim(),
        ]
          .filter(Boolean)
          .join("\n\n"),
      } satisfies VerificationCommandResult;
    }),
  );

  const verificationFailed = verification.some((result) => result.exitCode !== 0);
  const effectiveStatus =
    submittedTask.value.status === "completed" && verificationFailed ? "failed" : submittedTask.value.status;
  const summary =
    effectiveStatus === submittedTask.value.status
      ? submittedTask.value.summary
      : `${submittedTask.value.summary} Verification failed: ${verification
          .filter((result) => result.exitCode !== 0)
          .map((result) => result.command)
          .join(", ")}.`;

  const report: TaskExecutionReport = {
    taskId: task.id,
    title: task.title,
    status: effectiveStatus,
    summary,
    filesTouched: submittedTask.value.filesTouched,
    commandsRun: Array.from(new Set(submittedTask.value.commandsRun)),
    verification,
    updatedAt: timestamp(),
  };

  const notes = [
    summary,
    report.filesTouched.length > 0 ? `Files: ${report.filesTouched.join(", ")}` : "",
    report.verification.length > 0
      ? `Verification: ${report.verification.map(summarizeVerification).join(" || ")}`
      : "",
    submittedTask.value.blockers.length > 0 ? `Blockers: ${submittedTask.value.blockers.join(" | ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    kind: "completed",
    task,
    report,
    assignedAgent: agentLabel,
    notes,
    progressLog: workerSession?.progressLog ?? [],
  } satisfies CodingTaskOutcome;
}

export async function executeCodingTaskSafely(params: {
  run: WorkflowRun;
  task: PlannedTask;
  deps: WorkflowExecutionDeps;
  agentLabel: string;
  timeout: TimeoutContext;
}): Promise<CodingTaskOutcome> {
  try {
    return await executeCodingTask(params);
  } catch (error) {
    if (error instanceof WorkflowResumableInterruptionError) {
      throw error;
    }
    if (error instanceof WorkflowHardTimeoutError) {
      throw error;
    }

    const summary = error instanceof Error
      ? `Task execution error: ${error.message}`
      : `Task execution error: ${String(error)}`;
    const progressLog = [`[${params.task.id}] ${summary}`];
    const report: TaskExecutionReport = {
      taskId: params.task.id,
      title: params.task.title,
      status: "failed",
      summary,
      filesTouched: [],
      commandsRun: [],
      verification: [],
      updatedAt: timestamp(),
    };

    return {
      kind: "completed",
      task: params.task,
      report,
      assignedAgent: params.agentLabel,
      notes: summary,
      progressLog,
    } satisfies CodingTaskOutcome;
  }
}

export async function executeCodingBatch(
  run: WorkflowRun,
  deps: WorkflowExecutionDeps,
  timeout: TimeoutContext,
): Promise<CodingBatchOutcome> {
  if (!run.plan) {
    return {
      kind: "completed",
      run,
    };
  }

  const batch = getExecutionBatch(run.plan);
  if (batch.mode === "idle" || batch.tasks.length === 0) {
    return {
      kind: "completed",
      run,
    };
  }

  const taskRuns = await Promise.all(
    batch.tasks.map((task, index) =>
      executeCodingTaskSafely({
        run,
        task,
        deps,
        timeout,
        agentLabel: batch.mode === "serial" ? "coding-agent-primary" : `coding-agent-worker-${index + 1}`,
      }),
    ),
  );

  let nextRun = run;
  for (const taskRun of taskRuns) {
    nextRun = mergeTaskReport(nextRun, taskRun.report);
  }
  nextRun = applyTaskIssueCounters(nextRun, taskRuns);

  const updatedPlan = updateTaskStatuses(
    run.plan,
    taskRuns.map((taskRun) => ({
      id: taskRun.task.id,
      status: taskRun.report.status,
      assignedAgent: taskRun.assignedAgent,
      notes: taskRun.notes,
    })),
  );

  return {
    kind: taskRuns.some((taskRun) => taskRun.kind === "timed_out") ? "timed_out" : "completed",
    run: {
      ...nextRun,
      plan: updatedPlan,
      updatedAt: timestamp(),
      executionLog: nextRun.executionLog.concat([
        `Selected ${summarizeBatch(run.plan)}`,
        ...taskRuns.flatMap((taskRun) => [
          `Task ${taskRun.task.id} ${taskRun.report.status}: ${taskRun.report.summary}`,
          ...taskRun.progressLog,
        ]),
      ]),
    },
    summary: taskRuns
      .filter((taskRun): taskRun is Extract<CodingTaskOutcome, { kind: "timed_out" }> => taskRun.kind === "timed_out")
      .map((taskRun) => `Task ${taskRun.task.id} timed out. ${taskRun.timeoutSummary}`)
      .join("\n"),
  } satisfies CodingBatchOutcome;
}
