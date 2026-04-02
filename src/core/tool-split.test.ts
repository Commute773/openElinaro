import { test, expect, describe } from "bun:test";
import { filterNativeTools } from "./tool-split.ts";
import type { CoreToolDefinition } from "./types.ts";

function makeTool(name: string): CoreToolDefinition {
  return { name, description: `${name} description`, parameters: {} };
}

describe("filterNativeTools", () => {
  test("returns all harness tools when no native tools", () => {
    const tools = [makeTool("read_file"), makeTool("write_file")];
    const result = filterNativeTools(tools, new Set());
    expect(result).toEqual(tools);
  });

  test("filters out native tools", () => {
    const tools = [makeTool("read_file"), makeTool("write_file"), makeTool("search")];
    const native = new Set(["read_file", "write_file"]);
    const result = filterNativeTools(tools, native);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("search");
  });

  test("filters out suppressed tools", () => {
    const tools = [makeTool("compact"), makeTool("search")];
    const native = new Set<string>();
    const suppressed = new Set(["compact"]);
    const result = filterNativeTools(tools, native, suppressed);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("search");
  });

  test("handles empty tools list", () => {
    const result = filterNativeTools([], new Set(["read_file"]));
    expect(result).toEqual([]);
  });

  test("does not mutate original array", () => {
    const tools = [makeTool("read_file"), makeTool("search")];
    const original = [...tools];
    filterNativeTools(tools, new Set(["read_file"]));
    expect(tools).toEqual(original);
  });
});
