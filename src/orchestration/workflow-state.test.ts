import { ToolMessage } from "@langchain/core/messages";
import { describe, expect, test } from "bun:test";
import type { TaskPlan } from "../domain/task-plan";
import type { TaskExecutionReport, WorkflowRun } from "../domain/workflow-run";
import type { CodingTaskOutcome } from "./workflow-types";
import {
  WorkflowHardTimeoutError,
  WorkflowResumableInterruptionError,
  PRUNED_WORKFLOW_TOOL_MESSAGE,
} from "./workflow-types";
import {
  uniqueStrings,
  sanitizeTaskId,
  sanitizeFilesystemSegment,
  buildTaskPlan,
  summarizeBatch,
  summarizeVerification,
  isTaskIssueStatus,
  isTaskErrorStatus,
  getRunIssueCounts,
  getWorkspaceCwd,
  appendUniqueLogEntries,
  mergeTaskReport,
  collectFilesTouched,
  buildCompletionMessage,
  buildFinishedRun,
  buildTimedOutRun,
  buildHardTimedOutRun,
  buildCancelledRun,
  buildResumableInterruptionRun,
  applyTaskIssueCounters,
  executeTaskPlanBatch,
  buildCompletedTaskReportsSummary,
  buildPlannerResumeContext,
  shouldRetryVerificationWithSharedTmp,
  pruneWorkflowToolMessages,
  getResponseToolNames,
  formatWorkflowTurnProgress,
  buildExceededTaskErrorThresholdRun,
  persistRun,
} from "./workflow-state";

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

function makeTask(id: string, status: "completed" | "blocked" | "failed" = "completed"): TaskExecutionReport {
  return {
    taskId: id,
    title: `Task ${id}`,
    status,
    summary: `Summary for ${id}`,
    filesTouched: [`file-${id}.ts`],
    commandsRun: [`cmd-${id}`],
    verification: [],
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function makePlan(tasks: TaskPlan["tasks"]): TaskPlan {
  return { id: "plan-1", goal: "Test", tasks };
}

describe("uniqueStrings", () => {
  test("deduplicates and trims strings", () => {
    expect(uniqueStrings(["a", "  b  ", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  test("filters empty strings", () => {
    expect(uniqueStrings(["a", "", "  ", "b"])).toEqual(["a", "b"]);
  });

  test("returns empty for all-empty input", () => {
    expect(uniqueStrings(["", "  "])).toEqual([]);
  });
});


describe("sanitizeTaskId", () => {
  test("normalizes a valid id", () => {
    expect(sanitizeTaskId("My-Task-1", 0)).toBe("my-task-1");
  });

  test("replaces special characters with hyphens", () => {
    expect(sanitizeTaskId("task@#name!", 0)).toBe("task-name");
  });

  test("falls back to index-based id for empty input", () => {
    expect(sanitizeTaskId("", 2)).toBe("task-3");
  });

  test("trims leading and trailing hyphens", () => {
    expect(sanitizeTaskId("--hello--", 0)).toBe("hello");
  });
});


describe("sanitizeFilesystemSegment", () => {
  test("normalizes a profile id", () => {
    expect(sanitizeFilesystemSegment("My Profile")).toBe("my-profile");
  });

  test("preserves dots and underscores", () => {
    expect(sanitizeFilesystemSegment("file.name_v2")).toBe("file.name_v2");
  });

  test("falls back to default for empty", () => {
    expect(sanitizeFilesystemSegment("")).toBe("default");
  });
});


describe("buildTaskPlan", () => {
  test("builds a plan from submitted tasks", () => {
    const plan = buildTaskPlan("Do stuff", {
      summary: "A plan",
      tasks: [
        {
          id: "task-1",
          title: "First task",
          executionMode: "serial",
          dependsOn: [],
          acceptanceCriteria: ["it works"],
          verificationCommands: ["bun test"],
        },
        {
          id: "task-2",
          title: "Second task",
          executionMode: "parallel",
          dependsOn: ["task-1"],
          acceptanceCriteria: [],
          verificationCommands: [],
        },
      ],
    });

    expect(plan.goal).toBe("Do stuff");
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0]!.status).toBe("ready");
    expect(plan.tasks[1]!.status).toBe("pending");
    expect(plan.tasks[1]!.dependsOn).toEqual(["task-1"]);
  });

  test("deduplicates task ids by appending suffix", () => {
    const plan = buildTaskPlan("goal", {
      summary: "dup",
      tasks: [
        { id: "same", title: "A", executionMode: "serial", dependsOn: [], acceptanceCriteria: [], verificationCommands: [] },
        { id: "same", title: "B", executionMode: "serial", dependsOn: [], acceptanceCriteria: [], verificationCommands: [] },
      ],
    });

    const ids = plan.tasks.map((t) => t.id);
    expect(ids[0]).toBe("same");
    expect(ids[1]).toBe("same-2");
  });

  test("filters out self-referencing dependencies", () => {
    const plan = buildTaskPlan("goal", {
      summary: "self-dep",
      tasks: [
        { id: "alpha", title: "A", executionMode: "serial", dependsOn: ["alpha"], acceptanceCriteria: [], verificationCommands: [] },
      ],
    });

    expect(plan.tasks[0]!.dependsOn).toEqual([]);
  });

  test("filters out dependencies referencing non-existent tasks", () => {
    const plan = buildTaskPlan("goal", {
      summary: "missing dep",
      tasks: [
        { id: "alpha", title: "A", executionMode: "serial", dependsOn: ["nonexistent"], acceptanceCriteria: [], verificationCommands: [] },
      ],
    });

    expect(plan.tasks[0]!.dependsOn).toEqual([]);
  });
});


describe("summarizeBatch", () => {
  test("returns idle message when no tasks are runnable", () => {
    const plan = makePlan([
      { id: "t1", title: "Done", status: "completed", executionMode: "serial", dependsOn: [] },
    ]);
    expect(summarizeBatch(plan)).toBe("No runnable tasks remain.");
  });

  test("returns serial batch description", () => {
    const plan = makePlan([
      { id: "t1", title: "Build widget", status: "ready", executionMode: "serial", dependsOn: [] },
    ]);
    expect(summarizeBatch(plan)).toContain("serial batch");
    expect(summarizeBatch(plan)).toContain("Build widget");
  });
});


describe("summarizeVerification", () => {
  test("includes command, exit code, stdout, stderr", () => {
    const result = summarizeVerification({
      command: "bun test",
      exitCode: 1,
      stdout: "FAIL",
      stderr: "error occurred",
    });
    expect(result).toContain("bun test");
    expect(result).toContain("exit 1");
    expect(result).toContain("stdout: FAIL");
    expect(result).toContain("stderr: error occurred");
  });

  test("omits empty stdout/stderr", () => {
    const result = summarizeVerification({
      command: "echo ok",
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(result).toBe("echo ok (exit 0)");
  });
});


describe("isTaskIssueStatus", () => {
  test("returns true for failed and blocked", () => {
    expect(isTaskIssueStatus("failed")).toBe(true);
    expect(isTaskIssueStatus("blocked")).toBe(true);
  });

  test("returns false for completed", () => {
    expect(isTaskIssueStatus("completed")).toBe(false);
  });
});

describe("isTaskErrorStatus", () => {
  test("returns true only for failed", () => {
    expect(isTaskErrorStatus("failed")).toBe(true);
    expect(isTaskErrorStatus("blocked")).toBe(false);
    expect(isTaskErrorStatus("completed")).toBe(false);
  });
});


describe("getRunIssueCounts", () => {
  test("computes counts from task reports when counters are absent", () => {
    const run = makeRun({
      taskReports: [makeTask("t1", "completed"), makeTask("t2", "failed"), makeTask("t3", "blocked")],
    });
    const counts = getRunIssueCounts(run);
    expect(counts.issueCount).toBe(2);
    expect(counts.errorCount).toBe(1);
    expect(counts.consecutiveErrorCount).toBe(0);
  });

  test("uses stored counters when present", () => {
    const run = makeRun({
      taskIssueCount: 5,
      taskErrorCount: 3,
      consecutiveTaskErrorCount: 2,
    });
    const counts = getRunIssueCounts(run);
    expect(counts.issueCount).toBe(5);
    expect(counts.errorCount).toBe(3);
    expect(counts.consecutiveErrorCount).toBe(2);
  });
});


describe("getWorkspaceCwd", () => {
  test("returns workspaceCwd when set", () => {
    const run = makeRun({ workspaceCwd: "/some/path" });
    expect(getWorkspaceCwd(run)).toBe("/some/path");
  });

  test("falls back to process.cwd()", () => {
    const run = makeRun();
    expect(getWorkspaceCwd(run)).toBe(process.cwd());
  });
});


describe("appendUniqueLogEntries", () => {
  test("appends only new non-empty entries", () => {
    const result = appendUniqueLogEntries(["a", "b"], ["b", "c", "", "  "]);
    expect(result).toEqual(["a", "b", "c"]);
  });
});


describe("mergeTaskReport", () => {
  test("adds a new report", () => {
    const run = makeRun();
    const result = mergeTaskReport(run, makeTask("t1"));
    expect(result.taskReports).toHaveLength(1);
    expect(result.taskReports![0]!.taskId).toBe("t1");
  });

  test("replaces an existing report for the same task id", () => {
    const run = makeRun({ taskReports: [makeTask("t1", "failed")] });
    const result = mergeTaskReport(run, makeTask("t1", "completed"));
    expect(result.taskReports).toHaveLength(1);
    expect(result.taskReports![0]!.status).toBe("completed");
  });
});


describe("collectFilesTouched", () => {
  test("deduplicates and sorts files across reports", () => {
    const run = makeRun({
      taskReports: [
        { ...makeTask("t1"), filesTouched: ["b.ts", "a.ts"] },
        { ...makeTask("t2"), filesTouched: ["a.ts", "c.ts"] },
      ],
    });
    expect(collectFilesTouched(run)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("returns empty array when no reports exist", () => {
    expect(collectFilesTouched(makeRun())).toEqual([]);
  });
});


describe("applyTaskIssueCounters", () => {
  test("increments issue and error counts for failed tasks", () => {
    const run = makeRun();
    const taskRuns: CodingTaskOutcome[] = [
      { kind: "completed", task: { id: "t1", title: "T1", status: "ready", executionMode: "serial", dependsOn: [] }, report: makeTask("t1", "failed"), assignedAgent: "a", notes: "", progressLog: [] },
    ];
    const result = applyTaskIssueCounters(run, taskRuns);
    expect(result.taskIssueCount).toBe(1);
    expect(result.taskErrorCount).toBe(1);
    expect(result.consecutiveTaskErrorCount).toBe(1);
  });

  test("resets consecutive error count on success", () => {
    const run = makeRun({ consecutiveTaskErrorCount: 3 });
    const taskRuns: CodingTaskOutcome[] = [
      { kind: "completed", task: { id: "t1", title: "T1", status: "ready", executionMode: "serial", dependsOn: [] }, report: makeTask("t1", "completed"), assignedAgent: "a", notes: "", progressLog: [] },
    ];
    const result = applyTaskIssueCounters(run, taskRuns);
    expect(result.consecutiveTaskErrorCount).toBe(0);
  });

  test("increments issue count for blocked tasks without incrementing error count", () => {
    const run = makeRun();
    const taskRuns: CodingTaskOutcome[] = [
      { kind: "completed", task: { id: "t1", title: "T1", status: "ready", executionMode: "serial", dependsOn: [] }, report: makeTask("t1", "blocked"), assignedAgent: "a", notes: "", progressLog: [] },
    ];
    const result = applyTaskIssueCounters(run, taskRuns);
    expect(result.taskIssueCount).toBe(1);
    expect(result.taskErrorCount).toBe(0);
    // blocked is not an error, so consecutive resets
    expect(result.consecutiveTaskErrorCount).toBe(0);
  });
});


describe("buildCompletionMessage", () => {
  test("returns undefined for non-coding-agent runs", () => {
    const run = makeRun({ kind: "task-plan" });
    expect(buildCompletionMessage(run)).toBeUndefined();
  });

  test("includes goal and status for coding-agent runs", () => {
    const run = makeRun({ status: "completed", resultSummary: "All done" });
    const message = buildCompletionMessage(run)!;
    expect(message).toContain("run-1");
    expect(message).toContain("Test goal");
    expect(message).toContain("All done");
  });
});


describe("buildFinishedRun", () => {
  test("marks run completed when all plan tasks are completed", () => {
    const plan = makePlan([
      { id: "t1", title: "A", status: "completed", executionMode: "serial", dependsOn: [] },
    ]);
    const run = makeRun({ plan });
    const finished = buildFinishedRun(run);
    expect(finished.status).toBe("completed");
    expect(finished.runningState).toBeUndefined();
  });

  test("marks run failed when plan has failures", () => {
    const plan = makePlan([
      { id: "t1", title: "A", status: "failed", executionMode: "serial", dependsOn: [] },
    ]);
    const run = makeRun({ plan });
    const finished = buildFinishedRun(run);
    expect(finished.status).toBe("failed");
  });

  test("marks run failed when plan has blockers", () => {
    const plan = makePlan([
      { id: "t1", title: "A", status: "blocked", executionMode: "serial", dependsOn: [] },
    ]);
    const run = makeRun({ plan });
    const finished = buildFinishedRun(run);
    expect(finished.status).toBe("failed");
  });

  test("marks run failed when coding-agent has no plan", () => {
    const run = makeRun({ kind: "coding-agent" });
    const finished = buildFinishedRun(run);
    expect(finished.status).toBe("failed");
    expect(finished.resultSummary).toContain("before producing a task plan");
  });

  test("marks coding-agent failed when there are task issue counts", () => {
    const plan = makePlan([
      { id: "t1", title: "A", status: "failed", executionMode: "serial", dependsOn: [] },
      { id: "t2", title: "B", status: "ready", executionMode: "serial", dependsOn: ["t1"] },
    ]);
    const run = makeRun({ plan, taskIssueCount: 1, taskErrorCount: 1, consecutiveTaskErrorCount: 1 });
    const finished = buildFinishedRun(run);
    expect(finished.status).toBe("failed");
  });
});


describe("buildTimedOutRun", () => {
  test("sets failed status with timeout message", () => {
    const run = makeRun({ timeoutMs: 60000 });
    const result = buildTimedOutRun(run, "Some work was done.");
    expect(result.status).toBe("failed");
    expect(result.resultSummary).toContain("timeout");
    expect(result.resultSummary).toContain("Some work was done.");
  });

  test("handles empty summary", () => {
    const run = makeRun({ timeoutMs: 60000 });
    const result = buildTimedOutRun(run, "  ");
    expect(result.resultSummary).toContain("60000ms");
    expect(result.resultSummary).not.toContain("  ");
  });
});


describe("buildHardTimedOutRun", () => {
  test("records hard timeout error", () => {
    const run = makeRun();
    const error = new WorkflowHardTimeoutError(60000, 90000);
    const result = buildHardTimedOutRun(run, error);
    expect(result.status).toBe("failed");
    expect(result.resultSummary).toContain("hard-timeout");
  });
});


describe("buildCancelledRun", () => {
  test("sets cancelled status", () => {
    const run = makeRun();
    const result = buildCancelledRun(run);
    expect(result.status).toBe("cancelled");
    expect(result.resultSummary).toContain("cancelled");
  });
});


describe("buildResumableInterruptionRun", () => {
  test("increments retry count and keeps running status", () => {
    const run = makeRun({ retryCount: 1 });
    const error = new WorkflowResumableInterruptionError("rate limited", 5000, "rate_limit");
    const result = buildResumableInterruptionRun(run, error);
    expect(result.status).toBe("running");
    expect(result.runningState).toBe("backoff");
    expect(result.retryCount).toBe(2);
    expect(result.nextAttemptAt).toBeDefined();
    expect(result.resultSummary).toContain("rate limit");
  });

  test("handles interruption reason", () => {
    const run = makeRun();
    const error = new WorkflowResumableInterruptionError("harness issue", 5000, "interruption");
    const result = buildResumableInterruptionRun(run, error);
    expect(result.resultSummary).toContain("transient harness interruption");
  });
});


describe("buildExceededTaskErrorThresholdRun", () => {
  test("marks run failed with error threshold message", () => {
    const run = makeRun({ consecutiveTaskErrorCount: 5 });
    const result = buildExceededTaskErrorThresholdRun(run);
    expect(result.status).toBe("failed");
    expect(result.resultSummary).toContain("consecutive task errors");
  });
});


describe("executeTaskPlanBatch", () => {
  test("returns same run when no plan exists", () => {
    const run = makeRun();
    expect(executeTaskPlanBatch(run)).toBe(run);
  });

  test("returns same run when no runnable tasks exist", () => {
    const plan = makePlan([
      { id: "t1", title: "Done", status: "completed", executionMode: "serial", dependsOn: [] },
    ]);
    const run = makeRun({ plan });
    expect(executeTaskPlanBatch(run)).toBe(run);
  });

  test("completes runnable serial task", () => {
    const plan = makePlan([
      { id: "t1", title: "First", status: "ready", executionMode: "serial", dependsOn: [] },
    ]);
    const run = makeRun({ plan });
    const result = executeTaskPlanBatch(run);
    expect(result.plan!.tasks[0]!.status).toBe("completed");
  });
});


describe("buildCompletedTaskReportsSummary", () => {
  test("returns none message when no completed reports exist", () => {
    const run = makeRun();
    expect(buildCompletedTaskReportsSummary(run)).toContain("none");
  });

  test("lists completed task reports", () => {
    const run = makeRun({ taskReports: [makeTask("t1", "completed"), makeTask("t2", "failed")] });
    const result = buildCompletedTaskReportsSummary(run);
    expect(result).toContain("t1");
    expect(result).not.toContain("t2");
  });
});


describe("buildPlannerResumeContext", () => {
  test("returns empty string for a fresh run", () => {
    const run = makeRun();
    expect(buildPlannerResumeContext(run)).toBe("");
  });

  test("includes result summary when present", () => {
    const run = makeRun({ resultSummary: "Previous attempt failed." });
    expect(buildPlannerResumeContext(run)).toContain("Previous attempt failed.");
  });

  test("includes prior task state", () => {
    const plan = makePlan([
      { id: "t1", title: "A", status: "completed", executionMode: "serial", dependsOn: [] },
    ]);
    const run = makeRun({ plan });
    const context = buildPlannerResumeContext(run);
    expect(context).toContain("Prior task state");
    expect(context).toContain("t1");
  });

  test("includes parent instructions", () => {
    const run = makeRun({ pendingParentInstructions: ["Fix the tests"] });
    const context = buildPlannerResumeContext(run);
    expect(context).toContain("Fix the tests");
  });
});


describe("shouldRetryVerificationWithSharedTmp", () => {
  test("returns true for cargo test with permission denied on temp dir", () => {
    expect(
      shouldRetryVerificationWithSharedTmp("cargo test", {
        exitCode: 1,
        stderr: "failed to create temporary directory: Permission denied (doc-tests)",
      }),
    ).toBe(true);
  });

  test("returns false for exit code 0", () => {
    expect(
      shouldRetryVerificationWithSharedTmp("cargo test", {
        exitCode: 0,
        stderr: "failed to create temporary directory: Permission denied (doc-tests)",
      }),
    ).toBe(false);
  });

  test("returns false for non-cargo commands", () => {
    expect(
      shouldRetryVerificationWithSharedTmp("bun test", {
        exitCode: 1,
        stderr: "failed to create temporary directory: Permission denied (doc-tests)",
      }),
    ).toBe(false);
  });

  test("returns false when stderr does not match pattern", () => {
    expect(
      shouldRetryVerificationWithSharedTmp("cargo test", {
        exitCode: 1,
        stderr: "compilation error: some other issue",
      }),
    ).toBe(false);
  });
});


describe("getResponseToolNames", () => {
  test("extracts tool names from assistant messages", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolName: "read_file" },
          { type: "tool-call", toolName: "exec_command" },
          { type: "tool-call", toolName: "read_file" },
        ],
      },
    ];
    expect(getResponseToolNames(messages)).toEqual(["read_file", "exec_command"]);
  });

  test("ignores non-assistant messages", () => {
    const messages = [
      { role: "user", content: [{ type: "tool-call", toolName: "should_ignore" }] },
    ];
    expect(getResponseToolNames(messages)).toEqual([]);
  });

  test("returns empty for messages without tool calls", () => {
    const messages = [{ role: "assistant", content: "just text" }];
    expect(getResponseToolNames(messages)).toEqual([]);
  });
});


describe("formatWorkflowTurnProgress", () => {
  test("formats a turn record", () => {
    const turn = {
      index: 3,
      startedAt: "2024-01-01T00:00:00.000Z",
      completedAt: "2024-01-01T00:00:01.000Z",
      modelId: "claude-test",
      finishReason: "stop" as const,
      responseToolNames: ["read_file"],
      activeToolNames: [],
      inputTokens: 100,
      outputTokens: 50,
    };
    const result = formatWorkflowTurnProgress("worker", turn);
    expect(result).toContain("[worker]");
    expect(result).toContain("model turn 3");
    expect(result).toContain("model=claude-test");
    expect(result).toContain("tools=read_file");
    expect(result).toContain("in=100");
    expect(result).toContain("out=50");
  });

  test("shows (none) when no tools used", () => {
    const turn = {
      index: 1,
      startedAt: "2024-01-01T00:00:00.000Z",
      completedAt: "2024-01-01T00:00:01.000Z",
      modelId: undefined,
      finishReason: "stop" as const,
      responseToolNames: [],
      activeToolNames: [],
      inputTokens: 0,
      outputTokens: 0,
    };
    const result = formatWorkflowTurnProgress("planner", turn);
    expect(result).toContain("tools=(none)");
  });
});


describe("persistRun", () => {
  test("calls onRunUpdate and returns the run", async () => {
    const run = makeRun();
    let captured: WorkflowRun | undefined;
    const result = await persistRun(run, async (r) => { captured = r; });
    expect(result).toBe(run);
    expect(captured).toBe(run);
  });

  test("works without onRunUpdate callback", async () => {
    const run = makeRun();
    const result = await persistRun(run);
    expect(result).toBe(run);
  });
});


describe("pruneWorkflowToolMessages", () => {
  function buildToolMsg(index: number, size = 4_000, name = "read_file") {
    return new ToolMessage({
      tool_call_id: `tool-${index}`,
      name,
      status: "success",
      content: `${"x".repeat(Math.max(0, size - 16))}-${index.toString().padStart(4, "0")}`,
    });
  }

  test("returns original messages when below the keep-recent threshold", () => {
    const messages = [buildToolMsg(1), buildToolMsg(2)];
    const pruned = pruneWorkflowToolMessages(messages);
    expect(pruned).toBe(messages);
  });

  test("does not prune when stale content is below minimum prune threshold", () => {
    const messages = Array.from({ length: 50 }, (_, i) => buildToolMsg(i + 1));
    const pruned = pruneWorkflowToolMessages(messages);
    expect(pruned.every((m) => String(m.content) !== PRUNED_WORKFLOW_TOOL_MESSAGE)).toBe(true);
  });
});
