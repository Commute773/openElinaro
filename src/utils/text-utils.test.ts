import { test, expect, describe } from "bun:test";
import {
  approximateTextTokens,
  countLines,
  normalizeString,
} from "./text-utils";

// ---------------------------------------------------------------------------
// approximateTextTokens
// ---------------------------------------------------------------------------
describe("approximateTextTokens", () => {
  test("returns 0 for empty string", () => {
    expect(approximateTextTokens("")).toBe(0);
  });

  test("returns 1 for short text under 4 chars", () => {
    expect(approximateTextTokens("hi")).toBe(1);
  });

  test("returns ceil(length / 4) for exact multiples", () => {
    expect(approximateTextTokens("abcd")).toBe(1);
    expect(approximateTextTokens("abcdefgh")).toBe(2);
  });

  test("rounds up for non-multiples", () => {
    expect(approximateTextTokens("abcde")).toBe(2); // ceil(5/4) = 2
  });

  test("handles long text", () => {
    const text = "a".repeat(1000);
    expect(approximateTextTokens(text)).toBe(250);
  });

  test("handles text with spaces and punctuation", () => {
    const text = "Hello, world! This is a test.";
    expect(approximateTextTokens(text)).toBe(Math.ceil(text.length / 4));
  });
});

// ---------------------------------------------------------------------------
// countLines
// ---------------------------------------------------------------------------
describe("countLines", () => {
  test("returns 0 for empty string", () => {
    expect(countLines("")).toBe(0);
  });

  test("returns 1 for string with no newlines", () => {
    expect(countLines("hello")).toBe(1);
  });

  test("counts newlines correctly", () => {
    expect(countLines("a\nb\nc")).toBe(3);
  });

  test("trailing newline adds an extra empty line", () => {
    expect(countLines("a\nb\n")).toBe(3);
  });

  test("handles Windows-style line endings", () => {
    expect(countLines("a\r\nb\r\nc")).toBe(3);
  });

  test("handles mixed line endings", () => {
    expect(countLines("a\nb\r\nc")).toBe(3);
  });

  test("single newline only", () => {
    expect(countLines("\n")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// normalizeString
// ---------------------------------------------------------------------------
describe("normalizeString", () => {
  test("returns trimmed string", () => {
    expect(normalizeString("  hello  ")).toBe("hello");
  });

  test("returns null for empty string", () => {
    expect(normalizeString("")).toBeNull();
  });

  test("returns null for whitespace-only string", () => {
    expect(normalizeString("   ")).toBeNull();
  });

  test("returns null for non-string values", () => {
    expect(normalizeString(null)).toBeNull();
    expect(normalizeString(undefined)).toBeNull();
    expect(normalizeString(42)).toBeNull();
    expect(normalizeString({})).toBeNull();
  });

  test("preserves internal whitespace", () => {
    expect(normalizeString("  hello  world  ")).toBe("hello  world");
  });

  test("handles string with tabs and newlines", () => {
    expect(normalizeString("\t\nhello\n\t")).toBe("hello");
  });
});
