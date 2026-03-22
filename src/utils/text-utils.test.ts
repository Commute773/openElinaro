import { test, expect, describe } from "bun:test";
import { approximateTextTokens, countLines, normalizeString } from "./text-utils";

describe("approximateTextTokens", () => {
  test("returns ceiling of length / 4", () => {
    expect(approximateTextTokens("abcd")).toBe(1);
    expect(approximateTextTokens("abcde")).toBe(2);
    expect(approximateTextTokens("ab")).toBe(1);
  });

  test("returns 0 for empty string", () => {
    expect(approximateTextTokens("")).toBe(0);
  });

  test("handles longer text", () => {
    const text = "a".repeat(100);
    expect(approximateTextTokens(text)).toBe(25);
  });

  test("rounds up partial tokens", () => {
    expect(approximateTextTokens("abc")).toBe(1); // 3/4 = 0.75 -> 1
    expect(approximateTextTokens("abcdefg")).toBe(2); // 7/4 = 1.75 -> 2
  });
});

describe("countLines", () => {
  test("returns 0 for empty string", () => {
    expect(countLines("")).toBe(0);
  });

  test("returns 1 for single line without newline", () => {
    expect(countLines("hello")).toBe(1);
  });

  test("counts lines with unix newlines", () => {
    expect(countLines("a\nb\nc")).toBe(3);
  });

  test("counts lines with windows newlines", () => {
    expect(countLines("a\r\nb\r\nc")).toBe(3);
  });

  test("trailing newline adds an extra line", () => {
    expect(countLines("a\nb\n")).toBe(3);
  });
});

describe("normalizeString", () => {
  test("trims whitespace from strings", () => {
    expect(normalizeString("  hello  ")).toBe("hello");
  });

  test("returns null for empty string", () => {
    expect(normalizeString("")).toBeNull();
  });

  test("returns null for whitespace-only string", () => {
    expect(normalizeString("   ")).toBeNull();
  });

  test("returns null for non-string values", () => {
    expect(normalizeString(undefined)).toBeNull();
    expect(normalizeString(null)).toBeNull();
    expect(normalizeString(42)).toBeNull();
    expect(normalizeString({})).toBeNull();
  });

  test("returns trimmed string for valid input", () => {
    expect(normalizeString("test")).toBe("test");
    expect(normalizeString("\ttab\t")).toBe("tab");
  });
});
