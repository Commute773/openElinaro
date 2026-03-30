import { test, expect, describe } from "bun:test";
import { splitToolsForCore, coreOwnsFeature, featureIsShared } from "./tool-split.ts";
import type { CoreManifest, CoreToolDefinition } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(overrides?: Partial<CoreManifest>): CoreManifest {
  return {
    id: "test-core",
    nativeTools: [],
    nativeFeatures: [],
    requires: {
      systemPrompt: true,
      messageHistory: true,
      toolExecution: true,
      toolDefinitions: true,
    },
    ...overrides,
  };
}

function makeTool(name: string): CoreToolDefinition {
  return { name, description: `${name} description`, parameters: {} };
}

// ---------------------------------------------------------------------------
// splitToolsForCore
// ---------------------------------------------------------------------------

describe("splitToolsForCore", () => {
  test("returns all harness tools when manifest has no native tools", () => {
    const tools = [makeTool("read_file"), makeTool("write_file")];
    const manifest = makeManifest({ nativeTools: [] });

    const result = splitToolsForCore(tools, manifest);
    expect(result).toEqual(tools);
  });

  test("filters out tools matching native tool mappings", () => {
    const tools = [makeTool("read_file"), makeTool("write_file"), makeTool("search")];
    const manifest = makeManifest({
      nativeTools: [
        {
          harnessToolName: "read_file",
          coreToolName: "Read",
          reportResultsToHarness: false,
        },
        {
          harnessToolName: "write_file",
          coreToolName: "Write",
          reportResultsToHarness: false,
        },
      ],
    });

    const result = splitToolsForCore(tools, manifest);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("search");
  });

  test("returns all tools when none match native mappings", () => {
    const tools = [makeTool("search"), makeTool("list_files")];
    const manifest = makeManifest({
      nativeTools: [
        {
          harnessToolName: "read_file",
          coreToolName: "Read",
          reportResultsToHarness: false,
        },
      ],
    });

    const result = splitToolsForCore(tools, manifest);
    expect(result).toHaveLength(2);
  });

  test("handles empty harness tools list", () => {
    const manifest = makeManifest({
      nativeTools: [
        {
          harnessToolName: "read_file",
          coreToolName: "Read",
          reportResultsToHarness: false,
        },
      ],
    });

    const result = splitToolsForCore([], manifest);
    expect(result).toEqual([]);
  });

  test("does not mutate the original harness tools array", () => {
    const tools = [makeTool("read_file"), makeTool("search")];
    const original = [...tools];
    const manifest = makeManifest({
      nativeTools: [
        {
          harnessToolName: "read_file",
          coreToolName: "Read",
          reportResultsToHarness: false,
        },
      ],
    });

    splitToolsForCore(tools, manifest);
    expect(tools).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// coreOwnsFeature
// ---------------------------------------------------------------------------

describe("coreOwnsFeature", () => {
  test("returns true when feature mode is core_owns", () => {
    const manifest = makeManifest({
      nativeFeatures: [{ feature: "compaction", mode: "core_owns" }],
    });
    expect(coreOwnsFeature(manifest, "compaction")).toBe(true);
  });

  test("returns false when feature mode is harness_owns", () => {
    const manifest = makeManifest({
      nativeFeatures: [{ feature: "compaction", mode: "harness_owns" }],
    });
    expect(coreOwnsFeature(manifest, "compaction")).toBe(false);
  });

  test("returns false when feature mode is shared", () => {
    const manifest = makeManifest({
      nativeFeatures: [{ feature: "compaction", mode: "shared" }],
    });
    expect(coreOwnsFeature(manifest, "compaction")).toBe(false);
  });

  test("returns false when feature not in manifest", () => {
    const manifest = makeManifest({ nativeFeatures: [] });
    expect(coreOwnsFeature(manifest, "compaction")).toBe(false);
  });

  test("matches by feature name, not position", () => {
    const manifest = makeManifest({
      nativeFeatures: [
        { feature: "streaming", mode: "harness_owns" },
        { feature: "compaction", mode: "core_owns" },
        { feature: "thinking", mode: "shared" },
      ],
    });
    expect(coreOwnsFeature(manifest, "compaction")).toBe(true);
    expect(coreOwnsFeature(manifest, "streaming")).toBe(false);
    expect(coreOwnsFeature(manifest, "thinking")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// featureIsShared
// ---------------------------------------------------------------------------

describe("featureIsShared", () => {
  test("returns true when feature mode is shared", () => {
    const manifest = makeManifest({
      nativeFeatures: [{ feature: "context_management", mode: "shared" }],
    });
    expect(featureIsShared(manifest, "context_management")).toBe(true);
  });

  test("returns false when feature mode is core_owns", () => {
    const manifest = makeManifest({
      nativeFeatures: [{ feature: "context_management", mode: "core_owns" }],
    });
    expect(featureIsShared(manifest, "context_management")).toBe(false);
  });

  test("returns false when feature mode is harness_owns", () => {
    const manifest = makeManifest({
      nativeFeatures: [{ feature: "context_management", mode: "harness_owns" }],
    });
    expect(featureIsShared(manifest, "context_management")).toBe(false);
  });

  test("returns false when feature not in manifest", () => {
    const manifest = makeManifest({ nativeFeatures: [] });
    expect(featureIsShared(manifest, "context_management")).toBe(false);
  });
});
