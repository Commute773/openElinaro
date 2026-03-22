export type SubagentRunStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type SubagentProvider = "claude" | "codex";

export interface SubagentEventRecord {
  kind: string;
  timestamp: string;
  summary?: string;
}

export interface SubagentRun {
  id: string;
  profileId: string;
  provider: SubagentProvider;
  goal: string;
  status: SubagentRunStatus;

  /** tmux session name (e.g. "openelinaro") */
  tmuxSession: string;
  /** tmux window name (same as run id) */
  tmuxWindow: string;

  /** Effective working directory inside the worktree */
  workspaceCwd: string;
  /** Root of the linked worktree (if created) */
  worktreeRoot?: string;
  /** Branch name of the linked worktree */
  worktreeBranch?: string;
  /** Original source workspace before worktree fork */
  sourceWorkspaceCwd?: string;

  createdAt: string;
  startedAt?: string;
  completedAt?: string;

  /** Conversation key of the parent that launched this run */
  originConversationKey?: string;
  /** User/profile that requested the launch */
  requestedBy?: string;
  /** Subagent nesting depth (1 = first-level child) */
  launchDepth: number;

  /** Wall-clock timeout in ms */
  timeoutMs: number;

  /** Agent-produced result summary */
  resultSummary?: string;
  /** Pre-formatted completion message for parent injection */
  completionMessage?: string;
  /** Error message if failed */
  error?: string;

  /** Chronological event log from the sidecar */
  eventLog: SubagentEventRecord[];
}
