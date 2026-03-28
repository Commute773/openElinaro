import { describe, expect, test } from "bun:test";
import type { Message } from "../messages/types";
import { userMessage, assistantTextMessage } from "../messages/types";
import { InferencePromptDriftMonitor } from "./inference-prompt-drift-monitor";

describe("InferencePromptDriftMonitor", () => {
  test("does not warn on the first prompt for a session", () => {
    const monitor = new InferencePromptDriftMonitor();

    const warning = monitor.inspect({
      sessionId: "session-1",
      prompt: [userMessage("hello")],
    });

    expect(warning).toBeNull();
  });

  test("does not warn when the prompt is append-only", () => {
    const monitor = new InferencePromptDriftMonitor();
    monitor.inspect({
      sessionId: "session-1",
      prompt: [userMessage("hello")],
    });

    const warning = monitor.inspect({
      sessionId: "session-1",
      prompt: [
        userMessage("hello"),
        assistantTextMessage("world"),
      ],
    });

    expect(warning).toBeNull();
  });

  test("warns when earlier prompt content is rewritten", () => {
    const monitor = new InferencePromptDriftMonitor();
    monitor.inspect({
      sessionId: "session-1",
      prompt: [
        userMessage("alpha"),
        assistantTextMessage("beta"),
      ],
    });

    const warning = monitor.inspect({
      sessionId: "session-1",
      prompt: [
        userMessage("alpha changed"),
        assistantTextMessage("beta"),
      ],
    });

    expect(warning).not.toBeNull();
    expect(warning?.removedLength).toBeGreaterThan(0);
    expect(warning?.addedLength).toBeGreaterThan(0);
    expect(warning?.firstChangedMessageIndex).toBe(0);
    expect(warning?.previousChangedMessageRole).toBe("user");
    expect(warning?.currentChangedMessageRole).toBe("user");
    expect(warning?.previousChangedMessagePreview).toContain("alpha");
    expect(warning?.currentChangedMessagePreview).toContain("alpha changed");
    expect(warning?.removedPreview).toContain("<assistant>");
    expect(warning?.addedPreview).toContain("changed");
    expect(warning?.message).toContain("non-append prompt mutation detected");
  });

  test("does not warn on rollback-only changes at a message boundary", () => {
    const monitor = new InferencePromptDriftMonitor();
    monitor.inspect({
      sessionId: "session-1",
      systemPrompt: "base prompt",
      prompt: [
        userMessage("hello"),
        assistantTextMessage("world"),
      ],
    });

    const warning = monitor.inspect({
      sessionId: "session-1",
      systemPrompt: "base prompt",
      prompt: [
        userMessage("hello"),
      ],
    });

    expect(warning).toBeNull();
  });

  test("warns on rollback plus rewrite when shared prefix is below threshold", () => {
    const monitor = new InferencePromptDriftMonitor();
    monitor.inspect({
      sessionId: "session-1",
      systemPrompt: "base prompt",
      prompt: [
        userMessage("hello"),
        assistantTextMessage("world"),
      ],
    });

    const warning = monitor.inspect({
      sessionId: "session-1",
      systemPrompt: "base prompt",
      prompt: [
        userMessage("replacement"),
      ],
    });

    expect(warning).not.toBeNull();
    expect(warning?.sharedPrefixPercentOfPrevious).toBeLessThan(0.8);
    expect(warning?.addedLength).toBeGreaterThan(0);
  });

  test("does not warn on rollback plus append when shared prefix is above threshold", () => {
    const monitor = new InferencePromptDriftMonitor();
    // Use a long system prompt so the shared prefix dominates
    const longSystemContent = "base prompt ".repeat(100).trim();
    monitor.inspect({
      sessionId: "session-1",
      systemPrompt: longSystemContent,
      prompt: [
        userMessage("hello"),
        assistantTextMessage("world"),
      ],
    });

    const warning = monitor.inspect({
      sessionId: "session-1",
      systemPrompt: longSystemContent,
      prompt: [
        userMessage("replacement"),
      ],
    });

    expect(warning).toBeNull();
  });

  test("warns when the system prompt changes", () => {
    const monitor = new InferencePromptDriftMonitor();
    monitor.inspect({
      sessionId: "session-1",
      systemPrompt: "base prompt",
      prompt: [
        userMessage("hello"),
      ],
    });

    const warning = monitor.inspect({
      sessionId: "session-1",
      systemPrompt: "changed prompt",
      prompt: [
        userMessage("hello"),
      ],
    });

    expect(warning).not.toBeNull();
    expect(warning?.previousChangedMessageRole).toBe("system");
    expect(warning?.currentChangedMessageRole).toBe("system");
  });
});
