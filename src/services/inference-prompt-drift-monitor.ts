import type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
} from "../messages/types";

export interface InferencePromptDriftWarning {
  sessionId: string;
  previousPromptLength: number;
  currentPromptLength: number;
  sharedPrefixLength: number;
  removedLength: number;
  addedLength: number;
  sharedPrefixPercentOfPrevious: number;
  firstChangedMessageIndex: number;
  previousChangedMessageRole?: string;
  currentChangedMessageRole?: string;
  previousChangedMessagePreview?: string;
  currentChangedMessagePreview?: string;
  removedPreview?: string;
  addedPreview?: string;
  message: string;
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function serializePiMessage(message: Message): string {
  switch (message.role) {
    case "user": {
      const user = message as UserMessage;
      if (typeof user.content === "string") {
        return `<user>\n${user.content}`;
      }
      return [
        "<user>",
        ...user.content.map((part) => {
          if (part.type === "text") {
            return (part as TextContent).text;
          }
          if (part.type === "image") {
            return `[image]`;
          }
          return JSON.stringify(part);
        }),
      ].join("\n");
    }
    case "assistant": {
      const assistant = message as AssistantMessage;
      return [
        "<assistant>",
        ...assistant.content.map((part) => {
          if (part.type === "text") {
            return (part as TextContent).text;
          }
          if (part.type === "toolCall") {
            return `[tool-call:${(part as any).name}] ${JSON.stringify((part as any).input ?? {})}`;
          }
          if (part.type === "thinking") {
            return `[thinking]`;
          }
          return JSON.stringify(part);
        }),
      ].join("\n");
    }
    case "toolResult": {
      const toolResult = message as ToolResultMessage;
      const textParts = toolResult.content
        .filter((part): part is TextContent => part.type === "text")
        .map((part) => part.text);
      return `<tool>\n[tool-result:${toolResult.toolName}] ${textParts.join("\n")}`;
    }
    default:
      return JSON.stringify(message);
  }
}

function truncatePreview(value: string, limit = 160) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function getSharedPrefixLength(left: string, right: string) {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function getSharedMessagePrefixLength(left: string[], right: string[]) {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function findChangedMessageContext(serializedMessages: string[], sharedPrefixLength: number) {
  let offset = 0;

  for (let index = 0; index < serializedMessages.length; index += 1) {
    const message = serializedMessages[index] ?? "";
    const messageEnd = offset + message.length;
    if (sharedPrefixLength <= messageEnd) {
      return {
        index,
        preview: truncatePreview(message),
      };
    }
    offset = messageEnd + 2;
  }

  return {
    index: Math.max(0, serializedMessages.length - 1),
    preview: truncatePreview(serializedMessages.at(-1) ?? ""),
  };
}

function extractChangedRole(preview: string | undefined) {
  const match = preview?.match(/^<([^>]+)>/);
  return match?.[1];
}

function buildDiffPreview(text: string, start: number, length: number, limit = 160) {
  if (length <= 0 || start >= text.length) {
    return undefined;
  }
  const excerpt = text.slice(start, Math.min(text.length, start + Math.max(length, limit)));
  return truncatePreview(excerpt, limit);
}

export class InferencePromptDriftMonitor {
  private readonly promptBySession = new Map<string, string>();
  private readonly promptMessagesBySession = new Map<string, string[]>();
  private static readonly MAX_TRACKED_SESSIONS = 200;

  inspect(params: {
    sessionId: string;
    prompt: Message[];
    systemPrompt?: string;
  }): InferencePromptDriftWarning | null {
    const serialized = params.prompt.map((message) => serializePiMessage(message));
    const currentMessages = params.systemPrompt
      ? [`<system>\n${params.systemPrompt}`, ...serialized]
      : serialized;
    const currentPrompt = currentMessages.join("\n\n");
    const previousPrompt = this.promptBySession.get(params.sessionId);
    const previousMessages = this.promptMessagesBySession.get(params.sessionId);
    this.promptBySession.set(params.sessionId, currentPrompt);
    this.promptMessagesBySession.set(params.sessionId, currentMessages);
    this.evictStaleEntries();

    if (!previousPrompt || !previousMessages || currentPrompt === previousPrompt || currentPrompt.startsWith(previousPrompt)) {
      return null;
    }

    const sharedPrefixLength = getSharedPrefixLength(previousPrompt, currentPrompt);
    const removedLength = previousPrompt.length - sharedPrefixLength;
    const addedLength = currentPrompt.length - sharedPrefixLength;
    const sharedPrefixPercentOfPrevious = previousPrompt.length > 0
      ? sharedPrefixLength / previousPrompt.length
      : 0;

    // Allow clean message-boundary rollbacks (trailing messages removed, no
    // content rewritten) regardless of percentage — this is normal compaction.
    // For mutations that also rewrite earlier content, require at least 80% of
    // the previous prompt to be preserved as a shared prefix.  Without the
    // percentage gate the monitor silently ignored mutations that happened to
    // keep the first serialized message identical even when large portions of
    // the prompt were rewritten.
    const sharedMessagePrefixLength = getSharedMessagePrefixLength(previousMessages, currentMessages);
    const isCleanRollback = sharedMessagePrefixLength >= 1
      && currentMessages.length <= previousMessages.length
      && addedLength === 0;
    if (isCleanRollback) {
      return null;
    }
    if (sharedMessagePrefixLength >= 1 && sharedPrefixPercentOfPrevious >= 0.8) {
      return null;
    }
    const previousChanged = findChangedMessageContext(previousMessages ?? [], sharedPrefixLength);
    const currentChanged = findChangedMessageContext(currentMessages, sharedPrefixLength);
    const previousChangedMessageRole = extractChangedRole(previousChanged.preview);
    const currentChangedMessageRole = extractChangedRole(currentChanged.preview);
    const removedPreview = buildDiffPreview(previousPrompt, sharedPrefixLength, removedLength);
    const addedPreview = buildDiffPreview(currentPrompt, sharedPrefixLength, addedLength);

    return {
      sessionId: params.sessionId,
      previousPromptLength: previousPrompt.length,
      currentPromptLength: currentPrompt.length,
      sharedPrefixLength,
      removedLength,
      addedLength,
      sharedPrefixPercentOfPrevious,
      firstChangedMessageIndex: Math.min(previousChanged.index, currentChanged.index),
      previousChangedMessageRole,
      currentChangedMessageRole,
      previousChangedMessagePreview: previousChanged.preview,
      currentChangedMessagePreview: currentChanged.preview,
      removedPreview,
      addedPreview,
      message: [
        "Warning: non-append prompt mutation detected.",
        `session=${params.sessionId}`,
        `shared_prefix=${sharedPrefixLength}/${previousPrompt.length} (${formatPercent(sharedPrefixPercentOfPrevious)})`,
        `removed=${removedLength}`,
        `added=${addedLength}`,
        `first_changed_message=${Math.min(previousChanged.index, currentChanged.index)}`,
        previousChangedMessageRole ? `previous_role=${previousChangedMessageRole}` : "",
        currentChangedMessageRole ? `current_role=${currentChangedMessageRole}` : "",
        previousChanged.preview ? `previous_preview=${JSON.stringify(previousChanged.preview)}` : "",
        currentChanged.preview ? `current_preview=${JSON.stringify(currentChanged.preview)}` : "",
        removedPreview ? `removed_preview=${JSON.stringify(removedPreview)}` : "",
        addedPreview ? `added_preview=${JSON.stringify(addedPreview)}` : "",
      ].join(" "),
    };
  }

  private evictStaleEntries() {
    if (this.promptBySession.size <= InferencePromptDriftMonitor.MAX_TRACKED_SESSIONS) {
      return;
    }
    const excess = this.promptBySession.size - InferencePromptDriftMonitor.MAX_TRACKED_SESSIONS;
    const keys = this.promptBySession.keys();
    for (let i = 0; i < excess; i++) {
      const { value: key } = keys.next();
      if (key) {
        this.promptBySession.delete(key);
        this.promptMessagesBySession.delete(key);
      }
    }
  }
}
