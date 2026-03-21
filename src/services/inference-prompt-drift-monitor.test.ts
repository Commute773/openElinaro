import { describe, expect, test } from "bun:test";
import { InferencePromptDriftMonitor } from "./inference-prompt-drift-monitor";

describe("InferencePromptDriftMonitor", () => {
  test("does not warn on the first prompt for a session", () => {
    const monitor = new InferencePromptDriftMonitor();

    const warning = monitor.inspect({
      sessionId: "session-1",
      prompt: [{ role: "user", content: "hello" }],
    });

    expect(warning).toBeNull();
  });

  test("does not warn when the prompt is append-only", () => {
    const monitor = new InferencePromptDriftMonitor();
    monitor.inspect({
      sessionId: "session-1",
      prompt: [{ role: "user", content: "hello" }],
    });

    const warning = monitor.inspect({
      sessionId: "session-1",
      prompt: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ],
    });

    expect(warning).toBeNull();
  });

  test("warns when earlier prompt content is rewritten", () => {
    const monitor = new InferencePromptDriftMonitor();
    monitor.inspect({
      sessionId: "session-1",
      prompt: [
        { role: "user", content: "alpha" },
        { role: "assistant", content: "beta" },
      ],
    });

    const warning = monitor.inspect({
      sessionId: "session-1",
      prompt: [
        { role: "user", content: "alpha changed" },
        { role: "assistant", content: "beta" },
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
      prompt: [
        { role: "system", content: "base prompt" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ],
    });

    const warning = monitor.inspect({
      sessionId: "session-1",
      prompt: [
        { role: "system", content: "base prompt" },
        { role: "user", content: "hello" },
      ],
    });

    expect(warning).toBeNull();
  });

  test("does not warn on rollback plus append when the system prompt is unchanged", () => {
    const monitor = new InferencePromptDriftMonitor();
    monitor.inspect({
      sessionId: "session-1",
      prompt: [
        { role: "system", content: "base prompt" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ],
    });

    const warning = monitor.inspect({
      sessionId: "session-1",
      prompt: [
        { role: "system", content: "base prompt" },
        { role: "user", content: "replacement" },
      ],
    });

    expect(warning).toBeNull();
  });

  test("warns when the system prompt changes", () => {
    const monitor = new InferencePromptDriftMonitor();
    monitor.inspect({
      sessionId: "session-1",
      prompt: [
        { role: "system", content: "base prompt" },
        { role: "user", content: "hello" },
      ],
    });

    const warning = monitor.inspect({
      sessionId: "session-1",
      prompt: [
        { role: "system", content: "changed prompt" },
        { role: "user", content: "hello" },
      ],
    });

    expect(warning).not.toBeNull();
    expect(warning?.previousChangedMessageRole).toBe("system");
    expect(warning?.currentChangedMessageRole).toBe("system");
  });
});
