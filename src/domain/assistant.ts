export interface ChatTextContentBlock {
  type: "text";
  text: string;
  [key: string]: unknown;
}

export interface ChatImageContentBlock {
  type: "image";
  data: string;
  mimeType: string;
  sourceUrl?: string;
  [key: string]: unknown;
}

export type ChatPromptContentBlock = ChatTextContentBlock | ChatImageContentBlock;
export type ChatPromptContent = string | ChatPromptContentBlock[];

export interface AppResponseAttachment {
  path: string;
  name?: string;
}

// ---------------------------------------------------------------------------
// Structured agent stream events — emitted by cores, formatted by clients
// ---------------------------------------------------------------------------

export type AgentStreamEvent =
  | { type: "thinking"; text: string }
  | { type: "tool_start"; name: string; args?: Record<string, unknown>; taskId?: string }
  | { type: "tool_progress"; name: string; elapsed?: number; message?: string; taskId?: string }
  | { type: "tool_end"; name: string; isError: boolean; summary?: string; error?: string }
  | { type: "tool_summary"; summary: string }
  | { type: "task_started"; taskId: string; description?: string; taskType?: string }
  | { type: "task_progress"; taskId: string; tokens?: number; toolUses?: number; durationMs?: number }
  | { type: "task_completed"; taskId: string; status?: string; summary?: string }
  | { type: "text"; text: string }
  | { type: "agent_init"; model?: string; toolCount?: number; mcpServerCount?: number }
  | { type: "compaction"; trigger?: string; preTokens?: number }
  | { type: "result"; turns: number; durationMs: number; costUsd: number }
  | { type: "error"; message: string }
  | { type: "status"; message: string }
  | { type: "progress"; message: string; attachments?: AppResponseAttachment[] };

export type AppProgressEvent = AgentStreamEvent;

export interface AppRequest {
  id: string;
  text: string;
  conversationKey?: string;
  chatContent?: ChatPromptContent;
}

export interface AppResponse {
  requestId: string;
  mode: "immediate" | "accepted";
  message: string;
  warnings?: string[];
  attachmentErrors?: string[];
  attachments?: AppResponseAttachment[];
}
