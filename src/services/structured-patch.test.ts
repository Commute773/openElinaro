import { test, expect, describe } from "bun:test";
import {
  parseStructuredPatch,
  applyStructuredUpdate,
  buildAddedFileContent,
  type StructuredPatchChunk,
} from "./structured-patch";

// ---------------------------------------------------------------------------
// parseStructuredPatch
// ---------------------------------------------------------------------------

describe("parseStructuredPatch", () => {
  test("throws if patch does not start with *** Begin Patch", () => {
    expect(() => parseStructuredPatch("hello\n*** End Patch\n")).toThrow(
      "Patch must start with *** Begin Patch",
    );
  });

  test("throws if patch does not end with *** End Patch", () => {
    expect(() => parseStructuredPatch("*** Begin Patch\nhello\n")).toThrow(
      "Patch must end with *** End Patch",
    );
  });

  test("throws when patch body is empty (no hunks)", () => {
    expect(() =>
      parseStructuredPatch("*** Begin Patch\n*** End Patch\n"),
    ).toThrow("Patch rejected: no hunks found");
  });

  test("parses an Add File operation", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+line one",
      "+line two",
      "*** End Patch",
    ].join("\n");

    const ops = parseStructuredPatch(patch);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({
      type: "add",
      path: "src/new.ts",
      lines: ["line one", "line two"],
    });
  });

  test("parses a Delete File operation", () => {
    const patch = [
      "*** Begin Patch",
      "*** Delete File: old.ts",
      "*** End Patch",
    ].join("\n");

    const ops = parseStructuredPatch(patch);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ type: "delete", path: "old.ts" });
  });

  test("parses an Update File operation with chunks", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/app.ts",
      "@@ context",
      " keep",
      "-old line",
      "+new line",
      "*** End Patch",
    ].join("\n");

    const ops = parseStructuredPatch(patch);
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("update");
    if (ops[0].type === "update") {
      expect(ops[0].path).toBe("src/app.ts");
      expect(ops[0].moveTo).toBeUndefined();
      expect(ops[0].chunks).toHaveLength(1);
      expect(ops[0].chunks[0].oldLines).toEqual(["keep", "old line"]);
      expect(ops[0].chunks[0].newLines).toEqual(["keep", "new line"]);
    }
  });

  test("parses Update File with moveTo", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "*** Move to: b.ts",
      "*** End Patch",
    ].join("\n");

    const ops = parseStructuredPatch(patch);
    expect(ops).toHaveLength(1);
    if (ops[0].type === "update") {
      expect(ops[0].moveTo).toBe("b.ts");
      expect(ops[0].chunks).toHaveLength(0);
    }
  });

  test("throws on Update File with no hunks and no moveTo", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "*** End Patch",
    ].join("\n");

    expect(() => parseStructuredPatch(patch)).toThrow(
      "does not include any hunks",
    );
  });

  test("parses multiple operations", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: new.ts",
      "+hello",
      "*** Delete File: old.ts",
      "*** End Patch",
    ].join("\n");

    const ops = parseStructuredPatch(patch);
    expect(ops).toHaveLength(2);
    expect(ops[0].type).toBe("add");
    expect(ops[1].type).toBe("delete");
  });

  test("throws on unexpected patch header line", () => {
    const patch = [
      "*** Begin Patch",
      "BOGUS LINE",
      "*** End Patch",
    ].join("\n");

    expect(() => parseStructuredPatch(patch)).toThrow("Unexpected patch header");
  });

  test("throws when Add File line does not start with +", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: f.ts",
      "no plus sign",
      "*** End Patch",
    ].join("\n");

    expect(() => parseStructuredPatch(patch)).toThrow(
      "Add file lines must start with +",
    );
  });

  test("handles \\r\\n line endings", () => {
    const patch =
      "*** Begin Patch\r\n*** Delete File: a.ts\r\n*** End Patch\r\n";
    const ops = parseStructuredPatch(patch);
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("delete");
  });

  test("handles multiple @@ chunks in an update", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: f.ts",
      "@@ chunk1",
      "-old1",
      "+new1",
      "@@ chunk2",
      "-old2",
      "+new2",
      "*** End Patch",
    ].join("\n");

    const ops = parseStructuredPatch(patch);
    if (ops[0].type === "update") {
      expect(ops[0].chunks).toHaveLength(2);
    }
  });

  test("parses Update File with moveTo and chunks", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: old.ts",
      "*** Move to: new.ts",
      "@@ chunk",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");

    const ops = parseStructuredPatch(patch);
    expect(ops).toHaveLength(1);
    if (ops[0].type === "update") {
      expect(ops[0].path).toBe("old.ts");
      expect(ops[0].moveTo).toBe("new.ts");
      expect(ops[0].chunks).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// applyStructuredUpdate
// ---------------------------------------------------------------------------

describe("applyStructuredUpdate", () => {
  test("replaces a single line", () => {
    const original = "line1\nline2\nline3\n";
    const chunks: StructuredPatchChunk[] = [
      { oldLines: ["line2"], newLines: ["LINE2"] },
    ];
    expect(applyStructuredUpdate(original, chunks)).toBe(
      "line1\nLINE2\nline3\n",
    );
  });

  test("inserts lines (empty oldLines)", () => {
    const original = "a\nb\n";
    const chunks: StructuredPatchChunk[] = [
      { oldLines: [], newLines: ["inserted"] },
    ];
    // empty oldLines matches at cursor=0, so insertion goes before 'a'
    expect(applyStructuredUpdate(original, chunks)).toBe("inserted\na\nb\n");
  });

  test("deletes lines (empty newLines)", () => {
    const original = "a\nb\nc\n";
    const chunks: StructuredPatchChunk[] = [
      { oldLines: ["b"], newLines: [] },
    ];
    expect(applyStructuredUpdate(original, chunks)).toBe("a\nc\n");
  });

  test("applies multiple sequential chunks", () => {
    const original = "a\nb\nc\nd\n";
    const chunks: StructuredPatchChunk[] = [
      { oldLines: ["a"], newLines: ["A"] },
      { oldLines: ["c"], newLines: ["C"] },
    ];
    expect(applyStructuredUpdate(original, chunks)).toBe("A\nb\nC\nd\n");
  });

  test("preserves trailing newline when original has one", () => {
    const original = "hello\n";
    const chunks: StructuredPatchChunk[] = [
      { oldLines: ["hello"], newLines: ["world"] },
    ];
    expect(applyStructuredUpdate(original, chunks)).toBe("world\n");
  });

  test("no trailing newline when original lacks one", () => {
    const original = "hello";
    const chunks: StructuredPatchChunk[] = [
      { oldLines: ["hello"], newLines: ["world"] },
    ];
    expect(applyStructuredUpdate(original, chunks)).toBe("world");
  });

  test("throws when hunk does not match", () => {
    const original = "a\nb\n";
    const chunks: StructuredPatchChunk[] = [
      { oldLines: ["nonexistent"], newLines: ["x"] },
    ];
    expect(() => applyStructuredUpdate(original, chunks)).toThrow(
      "Patch hunk did not match",
    );
  });

  test("handles \\r\\n in original content", () => {
    const original = "line1\r\nline2\r\n";
    const chunks: StructuredPatchChunk[] = [
      { oldLines: ["line1"], newLines: ["LINE1"] },
    ];
    expect(applyStructuredUpdate(original, chunks)).toBe("LINE1\nline2\n");
  });
});

// ---------------------------------------------------------------------------
// buildAddedFileContent
// ---------------------------------------------------------------------------

describe("buildAddedFileContent", () => {
  test("returns empty string for empty array", () => {
    expect(buildAddedFileContent([])).toBe("");
  });

  test("joins lines with newline and appends trailing newline", () => {
    expect(buildAddedFileContent(["a", "b"])).toBe("a\nb\n");
  });

  test("handles single line", () => {
    expect(buildAddedFileContent(["only"])).toBe("only\n");
  });
});
