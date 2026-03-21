import { ToolMessage } from "@langchain/core/messages";
import { describe, expect, test } from "bun:test";
import { pruneWorkflowToolMessages } from "./workflow-graph";

function buildToolMessage(index: number, size = 4_000, name = "read_file") {
  return new ToolMessage({
    tool_call_id: `tool-${index}`,
    name,
    status: "success",
    content: `${`x`.repeat(Math.max(0, size - 16))}-${index.toString().padStart(4, "0")}`,
  });
}

describe("pruneWorkflowToolMessages", () => {
  test("does not prune when stale tool output stays below the minimum prune threshold", () => {
    const messages = Array.from({ length: 50 }, (_, index) => buildToolMessage(index + 1));

    const pruned = pruneWorkflowToolMessages(messages);

    expect(pruned).toHaveLength(messages.length);
    expect(pruned.every((message) => String(message.content) !== "[Older workflow tool result content cleared to save context. Re-run the tool if you need the raw output again.]")).toBe(true);
  });

  test("prunes only older tool messages once stale output exceeds the protected budget and minimum prune threshold", () => {
    const messages = Array.from({ length: 64 }, (_, index) => buildToolMessage(index + 1));

    const pruned = pruneWorkflowToolMessages(messages);
    const placeholder = "[Older workflow tool result content cleared to save context. Re-run the tool if you need the raw output again.]";

    expect(pruned).toHaveLength(messages.length);
    expect(pruned.slice(-4).every((message) => String(message.content) !== placeholder)).toBe(true);
    expect(pruned.slice(0, -4).some((message) => String(message.content) === placeholder)).toBe(true);
  });

  test("keeps explicit tool_result_read payloads even when older tool output is pruned", () => {
    const messages = [
      ...Array.from({ length: 56 }, (_, index) => buildToolMessage(index + 1)),
      ...Array.from({ length: 8 }, (_, index) => buildToolMessage(100 + index, 4_000, "tool_result_read")),
    ];

    const pruned = pruneWorkflowToolMessages(messages);
    const placeholder = "[Older workflow tool result content cleared to save context. Re-run the tool if you need the raw output again.]";

    expect(pruned.some((message) => message.name === "tool_result_read" && String(message.content) === placeholder)).toBe(false);
    expect(pruned.some((message) => message.name === "read_file" && String(message.content) === placeholder)).toBe(true);
  });
});
