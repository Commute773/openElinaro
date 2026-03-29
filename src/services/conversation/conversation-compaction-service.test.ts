import { test, expect, describe } from "bun:test";

describe("ConversationCompactionService constants", () => {
  test("COMPACTION_MAX_TOKENS is at least 16000 to avoid truncated summaries", async () => {
    // Read the source file and check the constant value
    const source = await Bun.file(
      import.meta.dir + "/conversation-compaction-service.ts"
    ).text();
    const match = source.match(/const COMPACTION_MAX_TOKENS\s*=\s*([\d_]+)/);
    expect(match).not.toBeNull();
    const value = parseInt(match![1]!.replace(/_/g, ""), 10);
    expect(value).toBeGreaterThanOrEqual(16_000);
  });

  test("summary_too_short telemetry guard exists in compact method", async () => {
    const source = await Bun.file(
      import.meta.dir + "/conversation-compaction-service.ts"
    ).text();
    expect(source).toContain("conversation.compact.summary_too_short");
    expect(source).toContain("payload.summary.trim().length < 50");
    expect(source).toContain("params.messages.length > 10");
  });
});
