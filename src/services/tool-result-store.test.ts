import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createIsolatedRuntimeRoot } from "../test/isolated-runtime-root";

const testRoot = createIsolatedRuntimeRoot("openelinaro-tool-result-store-");

describe("ToolResultStore", () => {
  beforeEach(() => testRoot.setup());
  afterEach(() => testRoot.teardown());

  test("persists and reloads stored tool results", async () => {
    const { ToolResultStore } = await import("./tool-result-store");
    const store = new ToolResultStore();

    const saved = store.save({
      namespace: "conversation:test",
      toolCallId: "call-1",
      toolName: "read_file",
      status: "success",
      content: "line 1\nline 2\nline 3",
    });

    expect(saved.ref).toContain("toolres_");
    expect(saved.lineCount).toBe(3);
    expect(saved.charLength).toBe("line 1\nline 2\nline 3".length);

    const loaded = store.get(saved.ref);
    expect(loaded).toBeTruthy();
    expect(loaded?.namespace).toBe("conversation:test");
    expect(loaded?.toolName).toBe("read_file");
    expect(loaded?.content).toBe("line 1\nline 2\nline 3");
  });
});
