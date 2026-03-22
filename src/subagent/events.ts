import type { SubagentProvider } from "../domain/subagent-run";

export type SubagentEventKind =
  | "worker.started"
  | "worker.progress"
  | "worker.completed"
  | "worker.failed";

export interface SubagentEvent {
  kind: SubagentEventKind;
  runId: string;
  provider: SubagentProvider;
  timestamp: string;
  payload: Record<string, unknown>;
}

// --- Claude hook payloads ---

export interface ClaudeHookPayload {
  runId: string;
  hookType: "Stop" | "SessionEnd" | "Notification" | "SubagentStop" | "TaskCompleted";
  sessionId?: string;
  exitCode?: number;
  result?: string;
  error?: string;
}

export function normalizeClaudeHookEvent(raw: ClaudeHookPayload): SubagentEvent {
  const timestamp = new Date().toISOString();
  const base = {
    runId: raw.runId,
    provider: "claude" as const,
    timestamp,
  };

  if (raw.hookType === "Notification") {
    return {
      ...base,
      kind: "worker.progress",
      payload: { message: raw.result ?? "" },
    };
  }

  if (raw.hookType === "SubagentStop" || raw.hookType === "TaskCompleted") {
    return {
      ...base,
      kind: "worker.progress",
      payload: { hookType: raw.hookType, result: raw.result ?? "" },
    };
  }

  // Stop hook: terminal event
  const succeeded = raw.exitCode === 0;
  return {
    ...base,
    kind: succeeded ? "worker.completed" : "worker.failed",
    payload: {
      exitCode: raw.exitCode ?? 1,
      result: raw.result ?? "",
      error: raw.error ?? "",
    },
  };
}

// --- Codex notify payloads ---

export interface CodexNotifyPayload {
  runId: string;
  exitCode: number;
  output?: string;
  error?: string;
}

export function normalizeCodexNotifyEvent(raw: CodexNotifyPayload): SubagentEvent {
  const timestamp = new Date().toISOString();
  const succeeded = raw.exitCode === 0;

  return {
    runId: raw.runId,
    provider: "codex",
    timestamp,
    kind: succeeded ? "worker.completed" : "worker.failed",
    payload: {
      exitCode: raw.exitCode,
      output: raw.output ?? "",
      error: raw.error ?? "",
    },
  };
}
