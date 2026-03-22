import { describe, expect, test } from "bun:test";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import {
  normalizeChatPromptContent,
  buildChatPromptContent,
  prependTextToChatPromptContent,
  extractTextFromContent,
  extractTextFromMessage,
  approximateContentTokens,
  toPiUserContent,
} from "./message-content-service";

describe("normalizeChatPromptContent", () => {
  test("converts a plain string to a single text block", () => {
    const result = normalizeChatPromptContent("hello world");
    expect(result).toEqual([{ type: "text", text: "hello world" }]);
  });

  test("returns empty array for empty string", () => {
    expect(normalizeChatPromptContent("")).toEqual([]);
  });

  test("returns empty array for non-array, non-string input", () => {
    expect(normalizeChatPromptContent(42)).toEqual([]);
    expect(normalizeChatPromptContent(null)).toEqual([]);
    expect(normalizeChatPromptContent(undefined)).toEqual([]);
    expect(normalizeChatPromptContent({ type: "text", text: "x" })).toEqual([]);
  });

  test("preserves text blocks from array input", () => {
    const input = [{ type: "text", text: "hi" }];
    expect(normalizeChatPromptContent(input)).toEqual([{ type: "text", text: "hi" }]);
  });

  test("preserves image blocks from array input", () => {
    const input = [{ type: "image", data: "base64data", mimeType: "image/png" }];
    expect(normalizeChatPromptContent(input)).toEqual([
      { type: "image", data: "base64data", mimeType: "image/png" },
    ]);
  });

  test("filters out unrecognized blocks", () => {
    const input = [
      { type: "text", text: "ok" },
      { type: "audio", data: "something" },
      { type: "image", data: "img", mimeType: "image/jpeg" },
    ];
    const result = normalizeChatPromptContent(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "text", text: "ok" });
    expect(result[1]).toEqual({ type: "image", data: "img", mimeType: "image/jpeg" });
  });

  test("filters out invalid text blocks (missing text field)", () => {
    const input = [{ type: "text" }, { type: "text", text: 123 }];
    expect(normalizeChatPromptContent(input)).toEqual([]);
  });

  test("filters out invalid image blocks (missing fields)", () => {
    const input = [
      { type: "image", data: "x" },
      { type: "image", mimeType: "image/png" },
    ];
    expect(normalizeChatPromptContent(input)).toEqual([]);
  });
});

describe("buildChatPromptContent", () => {
  test("returns trimmed text when no blocks", () => {
    expect(buildChatPromptContent({ text: "  hello  " })).toBe("hello");
  });

  test("returns empty string when no text and no blocks", () => {
    expect(buildChatPromptContent({})).toBe("");
  });

  test("returns blocks only when no text", () => {
    const blocks = [{ type: "image" as const, data: "x", mimeType: "image/png" }];
    const result = buildChatPromptContent({ blocks });
    expect(result).toEqual(blocks);
  });

  test("prepends text block when both text and blocks", () => {
    const blocks = [{ type: "image" as const, data: "x", mimeType: "image/png" }];
    const result = buildChatPromptContent({ text: "caption", blocks });
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ type: "text", text: "caption" });
      expect(result[1]).toEqual(blocks[0]);
    }
  });

  test("omits text block when text is whitespace-only", () => {
    const blocks = [{ type: "image" as const, data: "x", mimeType: "image/png" }];
    const result = buildChatPromptContent({ text: "   ", blocks });
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(1);
    }
  });
});

describe("prependTextToChatPromptContent", () => {
  test("returns content unchanged when prepended text is empty", () => {
    expect(prependTextToChatPromptContent("existing", "")).toBe("existing");
    expect(prependTextToChatPromptContent("existing", "   ")).toBe("existing");
  });

  test("returns just the text when content normalizes to empty", () => {
    expect(prependTextToChatPromptContent("", "prefix")).toBe("prefix");
  });

  test("merges text into existing first text block", () => {
    const content = [{ type: "text" as const, text: "body" }];
    const result = prependTextToChatPromptContent(content, "prefix");
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result[0]).toEqual({ type: "text", text: "prefix\n\nbody" });
    }
  });

  test("inserts text block before non-text first block", () => {
    const content = [{ type: "image" as const, data: "x", mimeType: "image/png" }];
    const result = prependTextToChatPromptContent(content, "prefix");
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ type: "text", text: "prefix" });
    }
  });

  test("prepends text to a plain string", () => {
    const result = prependTextToChatPromptContent("world", "hello");
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result[0]).toEqual({ type: "text", text: "hello\n\nworld" });
    }
  });
});

describe("extractTextFromContent", () => {
  test("returns string content directly", () => {
    expect(extractTextFromContent("hello")).toBe("hello");
  });

  test("joins text blocks with double newline", () => {
    const content = [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ];
    expect(extractTextFromContent(content)).toBe("first\n\nsecond");
  });

  test("ignores image blocks", () => {
    const content = [
      { type: "text", text: "caption" },
      { type: "image", data: "x", mimeType: "image/png" },
    ];
    expect(extractTextFromContent(content)).toBe("caption");
  });

  test("returns empty string for non-string non-array input", () => {
    expect(extractTextFromContent(null)).toBe("");
    expect(extractTextFromContent(42)).toBe("");
  });
});

describe("extractTextFromMessage", () => {
  test("extracts text from HumanMessage", () => {
    const msg = new HumanMessage("hello user");
    expect(extractTextFromMessage(msg)).toBe("hello user");
  });

  test("extracts text from AIMessage", () => {
    const msg = new AIMessage("assistant reply");
    expect(extractTextFromMessage(msg)).toBe("assistant reply");
  });

  test("extracts text from message with content blocks", () => {
    const msg = new HumanMessage({
      content: [
        { type: "text", text: "part one" },
        { type: "text", text: "part two" },
      ],
    });
    expect(extractTextFromMessage(msg)).toBe("part one\n\npart two");
  });
});

describe("approximateContentTokens", () => {
  test("returns 0 for empty content", () => {
    expect(approximateContentTokens("")).toBe(0);
    expect(approximateContentTokens([])).toBe(0);
  });

  test("approximates text tokens as ceil(length / 4)", () => {
    expect(approximateContentTokens("abcd")).toBe(1);
    expect(approximateContentTokens("abcde")).toBe(2);
  });

  test("adds 1024 per image block", () => {
    const content = [
      { type: "text", text: "abcd" },
      { type: "image", data: "x", mimeType: "image/png" },
    ];
    expect(approximateContentTokens(content)).toBe(1 + 1024);
  });

  test("handles multiple image blocks", () => {
    const content = [
      { type: "image", data: "a", mimeType: "image/png" },
      { type: "image", data: "b", mimeType: "image/jpeg" },
    ];
    expect(approximateContentTokens(content)).toBe(2048);
  });
});

describe("toPiUserContent", () => {
  test("returns plain string for single text block", () => {
    expect(toPiUserContent("hello")).toBe("hello");
  });

  test("returns empty string for empty string input", () => {
    expect(toPiUserContent("")).toBe("");
  });

  test("returns string for single text block in array", () => {
    const content = [{ type: "text", text: "only one" }];
    expect(toPiUserContent(content)).toBe("only one");
  });

  test("returns array for multiple blocks", () => {
    const content = [
      { type: "text", text: "caption" },
      { type: "image", data: "imgdata", mimeType: "image/png" },
    ];
    const result = toPiUserContent(content);
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ type: "text", text: "caption" });
      expect(result[1]).toEqual({ type: "image", data: "imgdata", mimeType: "image/png" });
    }
  });

  test("returns empty string for non-string, non-array input", () => {
    expect(toPiUserContent(42)).toBe("");
  });
});
