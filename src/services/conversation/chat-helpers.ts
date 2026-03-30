import type { ChatPromptContent, ChatPromptContentBlock } from "../../domain/assistant";

export function toPromptBlocks(content: ChatPromptContent) {
  if (typeof content === "string") {
    return [{ type: "text" as const, text: content }];
  }
  return content;
}

export function combineQueuedChatContents(contents: ChatPromptContent[]) {
  if (contents.length <= 1) {
    return contents[0] ?? "";
  }

  const combined: ChatPromptContentBlock[] = [{
    type: "text" as const,
    text: "Multiple user messages arrived while you were busy. Treat them as one combined update from the same user, in chronological order.",
  }];
  for (const [index, content] of contents.entries()) {
    combined.push({
      type: "text" as const,
      text: `Queued message ${index + 1}:`,
    });
    combined.push(...toPromptBlocks(content));
  }
  return combined;
}

export function isWrappedInjectedMessage(text: string) {
  return /^<INJECTED_MESSAGE\b/i.test(text.trim());
}

export function buildCombinedTurnContent(
  baseContent: ChatPromptContent,
  pendingContent: ChatPromptContent[],
) {
  return combineQueuedChatContents([baseContent, ...pendingContent]);
}

export function chatPromptContentToString(content: ChatPromptContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
