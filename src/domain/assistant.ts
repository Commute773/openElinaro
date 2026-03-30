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
