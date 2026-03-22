import { describe, expect, test } from "bun:test";
import {
  TOOL_AUTH_DECLARATIONS,
  getToolAuthorizationDeclaration,
  assertToolAuthorizationCoverage,
} from "./tool-authorization-service";

describe("getToolAuthorizationDeclaration", () => {
  test("returns declaration for a known tool", () => {
    const decl = getToolAuthorizationDeclaration("web_search");
    expect(decl.access).toBe("anyone");
    expect(decl.behavior).toBe("uniform");
  });

  test("returns declaration with note when present", () => {
    const decl = getToolAuthorizationDeclaration("email");
    expect(decl.access).toBe("root");
    expect(decl.behavior).toBe("uniform");
    expect(decl.note).toBeDefined();
    expect(decl.note).toContain("mail");
  });

  test("throws for unknown tool name", () => {
    expect(() => getToolAuthorizationDeclaration("nonexistent_tool_xyz")).toThrow(
      "Missing tool authorization declaration for nonexistent_tool_xyz",
    );
  });
});

describe("assertToolAuthorizationCoverage", () => {
  test("does not throw when all tools have declarations", () => {
    const knownTools = Object.keys(TOOL_AUTH_DECLARATIONS).slice(0, 3);
    expect(() => assertToolAuthorizationCoverage(knownTools)).not.toThrow();
  });

  test("throws when a tool is missing a declaration", () => {
    expect(() => assertToolAuthorizationCoverage(["web_search", "fake_missing_tool"])).toThrow(
      "Missing tool authorization declarations for: fake_missing_tool",
    );
  });

  test("throws with sorted missing tool names", () => {
    expect(() => assertToolAuthorizationCoverage(["zzz_tool", "aaa_tool"])).toThrow(
      "Missing tool authorization declarations for: aaa_tool, zzz_tool",
    );
  });

  test("accepts empty array", () => {
    expect(() => assertToolAuthorizationCoverage([])).not.toThrow();
  });
});

describe("TOOL_AUTH_DECLARATIONS", () => {
  test("all entries have required fields", () => {
    for (const [, decl] of Object.entries(TOOL_AUTH_DECLARATIONS)) {
      expect(decl.access).toBeDefined();
      expect(["anyone", "root"]).toContain(decl.access);
      expect(decl.behavior).toBeDefined();
      expect(["uniform", "role-sensitive"]).toContain(decl.behavior);
    }
  });

  test("root-access tools include expected entries", () => {
    const rootTools = Object.entries(TOOL_AUTH_DECLARATIONS)
      .filter(([, decl]) => decl.access === "root")
      .map(([name]) => name);
    expect(rootTools).toContain("email");
    expect(rootTools).toContain("update");
    expect(rootTools).toContain("openbrowser");
  });

  test("anyone-access tools include expected entries", () => {
    const anyoneTools = Object.entries(TOOL_AUTH_DECLARATIONS)
      .filter(([, decl]) => decl.access === "anyone")
      .map(([name]) => name);
    expect(anyoneTools).toContain("web_search");
    expect(anyoneTools).toContain("routine_list");
    expect(anyoneTools).toContain("todo_read");
  });
});
