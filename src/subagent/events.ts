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
  const exitCode = raw.exitCode ?? 1;
  const succeeded = exitCode === 0;
  const result = raw.result ?? "";

  // Build a meaningful error: prefer the explicit error field, fall back to
  // exit-code + result excerpt so failures are never opaque.
  let error = raw.error ?? "";
  if (!error && !succeeded) {
    const parts = [`Process exited with code ${exitCode}.`];
    if (result) {
      parts.push(`Hook payload (last 2000 chars): ${result.slice(-2000)}`);
    }
    error = parts.join(" ");
  }

  return {
    ...base,
    kind: succeeded ? "worker.completed" : "worker.failed",
    payload: { exitCode, result, error },
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
  const output = raw.output ?? "";

  // Build a meaningful error when the explicit error field is empty.
  let error = raw.error ?? "";
  if (!error && !succeeded) {
    const parts = [`Process exited with code ${raw.exitCode}.`];
    if (output) {
      parts.push(`Output (last 2000 chars): ${output.slice(-2000)}`);
    }
    error = parts.join(" ");
  }

  return {
    runId: raw.runId,
    provider: "codex",
    timestamp,
    kind: succeeded ? "worker.completed" : "worker.failed",
    payload: { exitCode: raw.exitCode, output, error },
  };
}
