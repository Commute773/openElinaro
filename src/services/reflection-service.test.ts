import { test, expect, describe } from "bun:test";
import { parseReflectionText } from "./reflection-service";

describe("parseReflectionText", () => {
  test("parses valid JSON response", () => {
    const json = JSON.stringify({
      body: "Today was productive.",
      mood: "content",
      bring_up_next_time: "Follow up on the deployment",
    });
    const result = parseReflectionText(json);
    expect(result).not.toBeNull();
    expect(result!.body).toBe("Today was productive.");
    expect(result!.mood).toBe("content");
    expect(result!.bring_up_next_time).toBe("Follow up on the deployment");
  });

  test("parses JSON wrapped in code fence", () => {
    const text = '```json\n{"body": "A reflection.", "mood": "calm"}\n```';
    const result = parseReflectionText(text);
    expect(result).not.toBeNull();
    expect(result!.body).toBe("A reflection.");
    expect(result!.mood).toBe("calm");
  });

  test("falls back to heuristic on markdown input", () => {
    const markdown = "# Reflection\n\nClaude has been thoughtful about the recent changes.";
    const result = parseReflectionText(markdown);
    expect(result).not.toBeNull();
    expect(result!.body).toBe(markdown.trim());
    expect(result!.mood).toBe("thoughtful");
  });

  test("falls back to heuristic on prose with no mood word", () => {
    const prose = "The day went by without much happening. Nothing notable occurred.";
    const result = parseReflectionText(prose);
    expect(result).not.toBeNull();
    expect(result!.body).toBe(prose.trim());
    expect(result!.mood).toBe("uncertain");
  });

  test("detects mood from prose text", () => {
    const prose = "I feel quite happy about the progress we made today on the project.";
    const result = parseReflectionText(prose);
    expect(result).not.toBeNull();
    expect(result!.mood).toBe("happy");
  });

  test("returns null for empty string", () => {
    expect(parseReflectionText("")).toBeNull();
  });

  test("returns null for whitespace-only string", () => {
    expect(parseReflectionText("   \n\t  ")).toBeNull();
  });

  test("does not crash on 'Unrecognized token #' input", () => {
    const text = "# My Reflection\n\nThis is what I think about recent events.";
    const result = parseReflectionText(text);
    expect(result).not.toBeNull();
    expect(result!.body).toContain("My Reflection");
  });

  test("does not crash on 'Unexpected identifier Claude' input", () => {
    const text = "Claude has been reflecting on recent conversations and feels optimistic about the future.";
    const result = parseReflectionText(text);
    expect(result).not.toBeNull();
    expect(result!.mood).toBe("optimistic");
  });
});
