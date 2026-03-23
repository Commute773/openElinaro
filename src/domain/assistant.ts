import { z } from "zod";

export const RequestKindSchema = z.enum(["chat", "todo", "medication"]);

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
}

export interface AppResponse {
  requestId: string;
  mode: "immediate" | "accepted";
  message: string;
  warnings?: string[];
  attachmentErrors?: string[];
  attachments?: AppResponseAttachment[];
}
