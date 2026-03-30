import { test, expect, describe } from "bun:test";
import {
  toPromptBlocks,
  combineQueuedChatContents,
  isWrappedInjectedMessage,
  buildCombinedTurnContent,
  chatPromptContentToString,
} from "./chat-helpers.ts";
import type { ChatPromptContent, ChatPromptContentBlock } from "../../domain/assistant.ts";

// ---------------------------------------------------------------------------
// toPromptBlocks
// ---------------------------------------------------------------------------

describe("toPromptBlocks", () => {
  test("converts string to single text block", () => {
    const result = toPromptBlocks("hello");
    expect(result).toEqual([{ type: "text", text: "hello" }]);
  });

  test("passes through array content unchanged", () => {
    const blocks: ChatPromptContentBlock[] = [
      { type: "text", text: "a" },
      { type: "image", data: "b64", mimeType: "image/png" },
    ];
    const result = toPromptBlocks(blocks);
    expect(result).toEqual(blocks);
  });

  test("handles empty string", () => {
    const result = toPromptBlocks("");
    expect(result).toEqual([{ type: "text", text: "" }]);
  });

  test("handles empty array", () => {
    const result = toPromptBlocks([]);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// combineQueuedChatContents
// ---------------------------------------------------------------------------

describe("combineQueuedChatContents", () => {
  test("returns empty string for empty array", () => {
    const result = combineQueuedChatContents([]);
    expect(result).toBe("");
  });

  test("passes through single string content", () => {
    const result = combineQueuedChatContents(["hello"]);
    expect(result).toBe("hello");
  });

  test("passes through single array content", () => {
    const blocks: ChatPromptContentBlock[] = [{ type: "text", text: "hello" }];
    const result = combineQueuedChatContents([blocks]);
    expect(result).toEqual(blocks);
  });

  test("combines multiple string contents with headers", () => {
    const result = combineQueuedChatContents(["first", "second"]);
    expect(Array.isArray(result)).toBe(true);
    const arr = result as ChatPromptContentBlock[];
    // Should have: intro header + msg1 header + msg1 content + msg2 header + msg2 content
    expect(arr).toHaveLength(5);
    expect(arr[0]!.type).toBe("text");
    expect((arr[0] as { type: "text"; text: string }).text).toContain("Multiple user messages");
    expect((arr[1] as { type: "text"; text: string }).text).toBe("Queued message 1:");
    expect((arr[2] as { type: "text"; text: string }).text).toBe("first");
    expect((arr[3] as { type: "text"; text: string }).text).toBe("Queued message 2:");
    expect((arr[4] as { type: "text"; text: string }).text).toBe("second");
  });

  test("combines mixed string and array contents", () => {
    const imageBlock: ChatPromptContentBlock = {
      type: "image",
      data: "b64data",
      mimeType: "image/png",
    };
    const result = combineQueuedChatContents(["text msg", [imageBlock]]);
    expect(Array.isArray(result)).toBe(true);
    const arr = result as ChatPromptContentBlock[];
    // intro + header1 + text block + header2 + image block
    expect(arr).toHaveLength(5);
    expect(arr[4]!.type).toBe("image");
  });
});

// ---------------------------------------------------------------------------
// isWrappedInjectedMessage
// ---------------------------------------------------------------------------

describe("isWrappedInjectedMessage", () => {
  test("matches standard injected message tag", () => {
    expect(isWrappedInjectedMessage("<INJECTED_MESSAGE>content</INJECTED_MESSAGE>")).toBe(true);
  });

  test("matches with attributes", () => {
    expect(isWrappedInjectedMessage('<INJECTED_MESSAGE source="system">hi</INJECTED_MESSAGE>')).toBe(true);
  });

  test("matches case-insensitively", () => {
    expect(isWrappedInjectedMessage("<injected_message>content</injected_message>")).toBe(true);
    expect(isWrappedInjectedMessage("<Injected_Message>content</Injected_Message>")).toBe(true);
  });

  test("matches with leading whitespace", () => {
    expect(isWrappedInjectedMessage("  <INJECTED_MESSAGE>content</INJECTED_MESSAGE>")).toBe(true);
  });

  test("rejects non-injected strings", () => {
    expect(isWrappedInjectedMessage("Hello world")).toBe(false);
    expect(isWrappedInjectedMessage("<OTHER_TAG>content</OTHER_TAG>")).toBe(false);
    expect(isWrappedInjectedMessage("")).toBe(false);
  });

  test("rejects string with injected tag mid-text", () => {
    expect(isWrappedInjectedMessage("some prefix <INJECTED_MESSAGE>content</INJECTED_MESSAGE>")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildCombinedTurnContent
// ---------------------------------------------------------------------------

describe("buildCombinedTurnContent", () => {
  test("returns base content when no pending", () => {
    const result = buildCombinedTurnContent("base message", []);
    expect(result).toBe("base message");
  });

  test("combines base with pending messages", () => {
    const result = buildCombinedTurnContent("base", ["pending1", "pending2"]);
    expect(Array.isArray(result)).toBe(true);
    const arr = result as ChatPromptContentBlock[];
    // intro + 3 messages (base + 2 pending), each with header + content = 1 + 3*2 = 7
    expect(arr).toHaveLength(7);
    expect((arr[0] as { type: "text"; text: string }).text).toContain("Multiple user messages");
  });
});

// ---------------------------------------------------------------------------
// chatPromptContentToString
// ---------------------------------------------------------------------------

describe("chatPromptContentToString", () => {
  test("passes through string content", () => {
    expect(chatPromptContentToString("hello world")).toBe("hello world");
  });

  test("extracts text from text blocks", () => {
    const blocks: ChatPromptContentBlock[] = [
      { type: "text", text: "line 1" },
      { type: "text", text: "line 2" },
    ];
    expect(chatPromptContentToString(blocks)).toBe("line 1\nline 2");
  });

  test("skips non-text blocks (image)", () => {
    const blocks: ChatPromptContentBlock[] = [
      { type: "text", text: "before" },
      { type: "image", data: "b64data", mimeType: "image/png" },
      { type: "text", text: "after" },
    ];
    expect(chatPromptContentToString(blocks)).toBe("before\nafter");
  });

  test("returns empty string for empty array", () => {
    expect(chatPromptContentToString([])).toBe("");
  });

  test("returns empty string for array with only image blocks", () => {
    const blocks: ChatPromptContentBlock[] = [
      { type: "image", data: "b64", mimeType: "image/jpeg" },
    ];
    expect(chatPromptContentToString(blocks)).toBe("");
  });
});
