import type { TaskPlan } from "./task-plan";

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "cancelled"
  | "completed"
  | "failed"
  | "interrupted";

export type WorkflowRunKind = "task-plan" | "coding-agent";

export type WorkflowRunRunningState = "active" | "backoff" | "stuck";

export interface VerificationCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TaskExecutionReport {
  taskId: string;
  title: string;
  status: "completed" | "blocked" | "failed";
  summary: string;
  filesTouched: string[];
  commandsRun: string[];
  verification: VerificationCommandResult[];
  updatedAt: string;
}

export interface WorkflowRun {
  id: string;
  kind: WorkflowRunKind;
  profileId?: string;
  launchDepth?: number;
  goal: string;
  status: WorkflowRunStatus;
  createdAt: string;
  updatedAt: string;
  executionStartedAt?: string;
  currentSessionId?: string;
  currentTaskId?: string;
  executionLog: string[];
  plan?: TaskPlan;
  workspaceCwd?: string;
  originConversationKey?: string;
  requestedBy?: string;
  timeoutMs?: number;
  retryCount?: number;
  nextAttemptAt?: string;
  runningState?: WorkflowRunRunningState;
  lastProgressAt?: string;
  stuckSinceAt?: string;
  stuckReason?: string;
  pendingParentInstructions?: string[];
  taskReports?: TaskExecutionReport[];
  taskIssueCount?: number;
  taskErrorCount?: number;
  consecutiveTaskErrorCount?: number;
  resultSummary?: string;
  completionMessage?: string;
  error?: string;
}
