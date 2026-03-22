import { z } from "zod";
import type { TaskPlan } from "./task-plan";

export const RequestKindSchema = z.enum(["chat", "todo", "medication", "workflow"]);

export type RequestKind = z.infer<typeof RequestKindSchema>;

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

export interface AppProgressUpdate {
  message: string;
  attachments?: AppResponseAttachment[];
}

export type AppProgressEvent = string | AppProgressUpdate;

export interface AppRequest {
  id: string;
  text: string;
  kind: RequestKind;
  conversationKey?: string;
  chatContent?: ChatPromptContent;
  todoTitle?: string;
  medicationName?: string;
  medicationDueAt?: string;
  workflowPlan?: TaskPlan;
}

export interface AppResponse {
  requestId: string;
  mode: "immediate" | "accepted";
  message: string;
  warnings?: string[];
  attachments?: AppResponseAttachment[];
  workflowRunId?: string;
}
