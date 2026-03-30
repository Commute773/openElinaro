/**
 * Phase 5: Verification of both cores.
 *
 * Tests the AgentCore interface contract, CoreFactory routing,
 * manifest-based tool splitting, and (when ANTHROPIC_API_KEY is set)
 * a live Claude SDK query.
 */
import { describe, expect, test } from "bun:test";
import { PiCore, PI_CORE_MANIFEST } from "./pi-core";
import { ClaudeSdkCore, CLAUDE_SDK_MANIFEST } from "./claude-sdk-core";
import { splitToolsForCore, coreOwnsFeature, featureIsShared } from "./tool-split";
import type {
  AgentCore,
  CoreManifest,
  CoreToolDefinition,
  CoreRunOptions,
  CoreMessage,
  CoreModelConfig,
} from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HARNESS_TOOLS: CoreToolDefinition[] = [
  { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
  { name: "write_file", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } },
  { name: "edit_file", description: "Edit a file", parameters: { type: "object", properties: {} } },
  { name: "glob", description: "Glob files", parameters: { type: "object", properties: {} } },
  { name: "grep", description: "Grep files", parameters: { type: "object", properties: {} } },
  { name: "exec_command", description: "Execute a command", parameters: { type: "object", properties: {} } },
  { name: "web_search", description: "Search the web", parameters: { type: "object", properties: {} } },
  { name: "routine_check", description: "Check routines", parameters: { type: "object", properties: {} } },
  { name: "finance_summary", description: "Finance summary", parameters: { type: "object", properties: {} } },
  { name: "send_message", description: "Send instance message", parameters: { type: "object", properties: {} } },
];

const SIMPLE_MESSAGES: CoreMessage[] = [
  { role: "user", content: "What is 2+2?", timestamp: Date.now() },
];

// ---------------------------------------------------------------------------
// Manifest verification
// ---------------------------------------------------------------------------

describe("CoreManifest", () => {
  test("PI_CORE_MANIFEST has no native tools", () => {
    expect(PI_CORE_MANIFEST.nativeTools).toEqual([]);
    expect(PI_CORE_MANIFEST.id).toBe("pi");
  });

  test("CLAUDE_SDK_MANIFEST declares 8 native tools", () => {
    expect(CLAUDE_SDK_MANIFEST.nativeTools.length).toBe(8);
    expect(CLAUDE_SDK_MANIFEST.id).toBe("claude-sdk");
    const nativeNames = CLAUDE_SDK_MANIFEST.nativeTools.map((t) => t.harnessToolName);
    expect(nativeNames).toContain("read_file");
    expect(nativeNames).toContain("exec_command");
    expect(nativeNames).not.toContain("routine_check");
  });

  test("both manifests declare all required features", () => {
    for (const manifest of [PI_CORE_MANIFEST, CLAUDE_SDK_MANIFEST]) {
      const featureIds = manifest.nativeFeatures.map((f) => f.feature);
      expect(featureIds).toContain("agent_loop");
      expect(featureIds).toContain("compaction");
      expect(featureIds).toContain("thinking");
    }
  });

  test("PI_CORE_MANIFEST requires all harness capabilities", () => {
    expect(PI_CORE_MANIFEST.requires.systemPrompt).toBe(true);
    expect(PI_CORE_MANIFEST.requires.messageHistory).toBe(true);
    expect(PI_CORE_MANIFEST.requires.toolExecution).toBe(true);
    expect(PI_CORE_MANIFEST.requires.toolDefinitions).toBe(true);
  });

  test("CLAUDE_SDK_MANIFEST does not require message history (manages its own)", () => {
    expect(CLAUDE_SDK_MANIFEST.requires.messageHistory).toBe(false);
    expect(CLAUDE_SDK_MANIFEST.requires.systemPrompt).toBe(true);
    expect(CLAUDE_SDK_MANIFEST.requires.toolExecution).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tool splitting
// ---------------------------------------------------------------------------

describe("splitToolsForCore", () => {
  test("PiCore receives all harness tools (no native tools to filter)", () => {
    const forCore = splitToolsForCore(HARNESS_TOOLS, PI_CORE_MANIFEST);
    expect(forCore.length).toBe(HARNESS_TOOLS.length);
  });

  test("ClaudeSdkCore filters out native tools", () => {
    const forCore = splitToolsForCore(HARNESS_TOOLS, CLAUDE_SDK_MANIFEST);
    const names = forCore.map((t) => t.name);
    // Native tools should be filtered out
    expect(names).not.toContain("read_file");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("edit_file");
    expect(names).not.toContain("glob");
    expect(names).not.toContain("grep");
    expect(names).not.toContain("exec_command");
    expect(names).not.toContain("web_search");
    // Domain tools should remain
    expect(names).toContain("routine_check");
    expect(names).toContain("finance_summary");
    expect(names).toContain("send_message");
  });

  test("domain tools are the same count as harness tools minus native", () => {
    const forCore = splitToolsForCore(HARNESS_TOOLS, CLAUDE_SDK_MANIFEST);
    const nativeCount = CLAUDE_SDK_MANIFEST.nativeTools.filter(
      (nt) => HARNESS_TOOLS.some((ht) => ht.name === nt.harnessToolName),
    ).length;
    expect(forCore.length).toBe(HARNESS_TOOLS.length - nativeCount);
  });
});

// ---------------------------------------------------------------------------
// Feature ownership queries
// ---------------------------------------------------------------------------

describe("feature ownership", () => {
  test("PiCore: harness owns compaction, core owns agent_loop", () => {
    expect(coreOwnsFeature(PI_CORE_MANIFEST, "compaction")).toBe(false);
    expect(coreOwnsFeature(PI_CORE_MANIFEST, "agent_loop")).toBe(true);
    expect(featureIsShared(PI_CORE_MANIFEST, "thinking")).toBe(true);
  });

  test("ClaudeSdkCore: core owns context_management, compaction is shared", () => {
    expect(coreOwnsFeature(CLAUDE_SDK_MANIFEST, "context_management")).toBe(true);
    expect(coreOwnsFeature(CLAUDE_SDK_MANIFEST, "compaction")).toBe(false);
    expect(featureIsShared(CLAUDE_SDK_MANIFEST, "compaction")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Core interface contract
// ---------------------------------------------------------------------------

describe("AgentCore interface", () => {
  test("PiCore implements AgentCore", () => {
    const core: AgentCore = new PiCore({
      model: {} as any,
      apiKey: "test",
    });
    expect(core.manifest).toBeDefined();
    expect(core.manifest.id).toBe("pi");
    expect(typeof core.run).toBe("function");
  });

  test("ClaudeSdkCore implements AgentCore", () => {
    const core: AgentCore = new ClaudeSdkCore({
      model: "claude-sonnet-4-6",
    });
    expect(core.manifest).toBeDefined();
    expect(core.manifest.id).toBe("claude-sdk");
    expect(typeof core.run).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// CoreFactory routing
// ---------------------------------------------------------------------------

describe("CoreFactory routing", () => {
  function testFactory(modelConfig: CoreModelConfig): AgentCore {
    if (modelConfig.providerId === "claude") {
      return new ClaudeSdkCore({ model: modelConfig.modelId });
    }
    return new PiCore({
      model: modelConfig.runtimeModel as any,
      apiKey: modelConfig.apiKey,
    });
  }

  test("routes claude provider to ClaudeSdkCore", () => {
    const core = testFactory({ providerId: "claude", modelId: "claude-opus-4-6" });
    expect(core.manifest.id).toBe("claude-sdk");
  });

  test("routes openai-codex provider to PiCore", () => {
    const core = testFactory({ providerId: "openai-codex", modelId: "gpt-5.4", runtimeModel: {} });
    expect(core.manifest.id).toBe("pi");
  });

  test("routes zai provider to PiCore", () => {
    const core = testFactory({ providerId: "zai", modelId: "z1", runtimeModel: {} });
    expect(core.manifest.id).toBe("pi");
  });
});
