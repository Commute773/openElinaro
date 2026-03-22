import { z } from "zod";
import type { ProviderConnector } from "../connectors/provider-connector";
import type { PlannedTask } from "../domain/task-plan";
import type { TaskExecutionReport, WorkflowRun } from "../domain/workflow-run";
import type { ShellService } from "../services/shell-service";
import type { WorkflowSessionStore } from "../services/workflow-session-store";
import type { ToolResolutionService } from "../services/tool-resolution-service";
import type { toToolSet } from "../services/ai-sdk-message-service";
import type { WorkflowSessionState } from "../services/workflow-session-store";

export const MAX_PLANNED_TASKS = 8;
export const MAX_VERIFICATION_COMMANDS = 4;
export const TIMEOUT_SUMMARY_RESERVE_MS = 15_000;
export const MIN_TIMEOUT_SUMMARY_BUDGET_MS = 1_000;
export const DEFAULT_RESUME_RETRY_DELAY_MS = 5_000;
export const MAX_RESUME_RETRY_DELAY_MS = 60_000;
export const WORKFLOW_TOOL_PRUNE_MINIMUM_TOKENS = 20_000;
export const WORKFLOW_TOOL_PRUNE_PROTECT_TOKENS = 40_000;
export const WORKFLOW_TOOL_PRUNE_KEEP_RECENT_MESSAGES = 4;
export const PRUNED_WORKFLOW_TOOL_MESSAGE =
  "[Older workflow tool result content cleared to save context. Re-run the tool if you need the raw output again.]";
export const WORKFLOW_TOOL_PRUNE_PROTECTED_TOOL_NAMES = new Set(["tool_result_read"]);

export const plannerTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(3),
  executionMode: z.enum(["serial", "parallel"]).default("serial"),
  dependsOn: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string().min(3)).max(5).default([]),
  verificationCommands: z.array(z.string().min(1)).max(MAX_VERIFICATION_COMMANDS).default([]),
});

export const submittedPlanSchema = z.object({
  summary: z.string().min(1),
  tasks: z.array(plannerTaskSchema).min(1).max(MAX_PLANNED_TASKS),
});

export const submittedTaskSchema = z.object({
  status: z.enum(["completed", "blocked", "failed"]),
  summary: z.string().min(1),
  filesTouched: z.array(z.string().min(1)).max(20).default([]),
  commandsRun: z.array(z.string().min(1)).max(20).default([]),
  verificationCommands: z.array(z.string().min(1)).max(MAX_VERIFICATION_COMMANDS).default([]),
  blockers: z.array(z.string().min(1)).max(5).default([]),
});

export const workflowProgressSchema = z.object({
  summary: z.string().min(1).max(400),
  nextTool: z.string().min(1).max(80).optional(),
});

export type SubmittedPlan = z.infer<typeof submittedPlanSchema>;
export type SubmittedTask = z.infer<typeof submittedTaskSchema>;

export type StructuredToolAgentOutcome<T> =
  | { kind: "submitted"; value: T }
  | { kind: "timed_out"; summary: string };

export type PlanningOutcome =
  | { kind: "planned"; run: WorkflowRun }
  | { kind: "timed_out"; run: WorkflowRun; summary: string };

export type CodingTaskOutcome =
  | {
      kind: "completed";
      task: PlannedTask;
      report: TaskExecutionReport;
      assignedAgent: string;
      notes: string;
      progressLog: string[];
    }
  | {
      kind: "timed_out";
      task: PlannedTask;
      report: TaskExecutionReport;
      assignedAgent: string;
      notes: string;
      progressLog: string[];
      timeoutSummary: string;
    };

export type CodingBatchOutcome =
  | { kind: "completed"; run: WorkflowRun }
  | { kind: "timed_out"; run: WorkflowRun; summary: string };

export type TimeoutContext = {
  startedAtMs: number;
  timeoutMs: number;
  hardTimeoutMs: number;
};

export class WorkflowTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Workflow reached timeout of ${timeoutMs}ms.`);
    this.name = "WorkflowTimeoutError";
  }
}

export class WorkflowHardTimeoutError extends Error {
  constructor(timeoutMs: number, hardTimeoutMs: number) {
    super(
      `Workflow exceeded hard timeout of ${hardTimeoutMs}ms (soft timeout ${timeoutMs}ms plus ${hardTimeoutMs - timeoutMs}ms grace).`,
    );
    this.name = "WorkflowHardTimeoutError";
  }
}

export class WorkflowCancelledError extends Error {
  constructor(message = "Workflow was cancelled.") {
    super(message);
    this.name = "WorkflowCancelledError";
  }
}

export class WorkflowResumableInterruptionError extends Error {
  constructor(
    message: string,
    readonly retryDelayMs: number,
    readonly reason: "interruption" | "rate_limit" = "interruption",
  ) {
    super(message);
    this.name = "WorkflowResumableInterruptionError";
  }
}

export interface WorkflowExecutionDeps {
  connector: ProviderConnector;
  toolResolver: ToolResolutionService;
  shell: Pick<ShellService, "execVerification">;
  workflowSessions: WorkflowSessionStore;
  baseSystemPrompt: string;
  assistantContext?: string;
  onRunUpdate?: (run: WorkflowRun) => Promise<void> | void;
  abortSignal?: AbortSignal;
}

export type StructuredToolAgentParams<T> = {
  connector: ProviderConnector;
  allTools: ReturnType<typeof toToolSet>;
  getActiveTools: () => string[];
  sessionId: string;
  sessionStore: WorkflowSessionStore;
  sessionScope: "planner" | "worker";
  runId: string;
  taskId?: string;
  systemPrompt: string;
  userPrompt: string;
  submissionToolName: string;
  submissionToolDescription: string;
  submissionSchema: z.ZodType<T>;
  retryCount?: number;
  timeout: TimeoutContext;
  abortSignal?: AbortSignal;
  timeoutSummaryPrompt: (session: WorkflowSessionState) => string;
};
