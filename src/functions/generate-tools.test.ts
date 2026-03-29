import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { generateAgentTool, generateAgentTools } from "./generate-tools";
import type { FunctionDefinition } from "./define-function";
import { formatResult } from "./formatters";
import type { ToolBuildContext } from "../tools/groups/tool-group-types";
import type { ToolContext } from "../tools/tool-registry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal stub satisfying ToolBuildContext for tests. */
function stubServices(): ToolBuildContext {
  return {} as ToolBuildContext;
}

/** Build a minimal FunctionDefinition with required fields. */
function makeDef(
  overrides: Partial<FunctionDefinition> & { name: string } = { name: "test_fn" },
): FunctionDefinition {
  const { name, ...rest } = overrides;
  return {
    name,
    description: "A test function",
    input: z.object({ value: z.string() }),
    handler: async (input: any) => `echo:${input.value}`,
    format: formatResult,
    auth: { access: "anyone", behavior: "uniform" },
    domains: ["test"],
    agentScopes: ["chat"],
    ...rest,
  };
}

// ---------------------------------------------------------------------------
// generateAgentTool
// ---------------------------------------------------------------------------

describe("generateAgentTool", () => {
  test("produces a tool with correct name and description", () => {
    const def = makeDef({ name: "greet", description: "Say hello" });
    const entry = generateAgentTool(def, stubServices);
    expect(entry).not.toBeNull();
    expect(entry!.tool.name).toBe("greet");
    expect(entry!.tool.description).toBe("Say hello");
  });

  test("handler invokes the function handler with parsed input", async () => {
    const calls: unknown[] = [];
    const def = makeDef({
      name: "record",
      input: z.object({ msg: z.string() }),
      handler: async (input: any) => {
        calls.push(input);
        return "ok";
      },
    });
    const entry = generateAgentTool(def, stubServices)!;
    const result = await entry.handler({ msg: "hello" });
    expect(calls).toHaveLength(1);
    expect((calls[0] as any).msg).toBe("hello");
    expect(result).toBe("ok");
  });

  test("handler passes FunctionContext with services and toolContext", async () => {
    let capturedCtx: any = null;
    const services = stubServices();
    const toolCtx: ToolContext = { conversationKey: "conv-123" };
    const def = makeDef({
      name: "ctx_check",
      handler: async (_input: any, ctx: any) => {
        capturedCtx = ctx;
        return "done";
      },
    });
    const entry = generateAgentTool(
      def,
      () => services,
      () => toolCtx,
    )!;
    await entry.handler({ value: "x" });
    expect(capturedCtx).not.toBeNull();
    expect(capturedCtx.services).toBe(services);
    expect(capturedCtx.toolContext).toBe(toolCtx);
    expect(capturedCtx.conversationKey).toBe("conv-123");
  });

  test("returns null when surfaces exclude 'agent'", () => {
    const def = makeDef({ name: "api_only", surfaces: ["api"] });
    const entry = generateAgentTool(def, stubServices);
    expect(entry).toBeNull();
  });

  test("defaults to all surfaces when surfaces is undefined", () => {
    const def = makeDef({ name: "default_surfaces" });
    const entry = generateAgentTool(def, stubServices);
    expect(entry).not.toBeNull();
  });

  test("extends ZodObject input with silent field", () => {
    const def = makeDef({
      name: "ext",
      input: z.object({ x: z.number() }),
    });
    const entry = generateAgentTool(def, stubServices)!;
    const params = entry.tool.parameters as Record<string, unknown>;
    // The extended schema should accept the silent field
    expect(params).toBeDefined();
    expect(typeof params).toBe("object");
  });

  test("non-ZodObject input schema is passed through unchanged", async () => {
    const enumSchema = z.enum(["a", "b", "c"]);
    const def = makeDef({
      name: "enum_fn",
      input: enumSchema as any,
      handler: async (input: any) => input,
    });
    const entry = generateAgentTool(def, stubServices)!;
    expect(entry).not.toBeNull();
    expect(entry.tool.name).toBe("enum_fn");
  });

  test("auth metadata is preserved on the original definition", () => {
    const def = makeDef({
      name: "auth_check",
      auth: { access: "root", behavior: "role-sensitive", note: "admin only" },
    });
    const entry = generateAgentTool(def, stubServices);
    expect(entry).not.toBeNull();
    expect(def.auth.access).toBe("root");
    expect(def.auth.behavior).toBe("role-sensitive");
    expect(def.auth.note).toBe("admin only");
  });

  test("resolveToolContext returning undefined still works", async () => {
    let capturedCtx: any = null;
    const def = makeDef({
      name: "undef_ctx",
      handler: async (_input: any, ctx: any) => {
        capturedCtx = ctx;
        return "ok";
      },
    });
    const entry = generateAgentTool(
      def,
      stubServices,
      () => undefined,
    )!;
    await entry.handler({ value: "x" });
    expect(capturedCtx.toolContext).toBeUndefined();
    expect(capturedCtx.conversationKey).toBeUndefined();
  });

  test("no resolveToolContext argument still works", async () => {
    let capturedCtx: any = null;
    const def = makeDef({
      name: "no_ctx",
      handler: async (_input: any, ctx: any) => {
        capturedCtx = ctx;
        return "ok";
      },
    });
    const entry = generateAgentTool(def, stubServices)!;
    await entry.handler({ value: "x" });
    expect(capturedCtx.toolContext).toBeUndefined();
    expect(capturedCtx.conversationKey).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// generateAgentTools
// ---------------------------------------------------------------------------

describe("generateAgentTools", () => {
  test("converts multiple definitions into tools", () => {
    const defs = [
      makeDef({ name: "fn_a" }),
      makeDef({ name: "fn_b" }),
      makeDef({ name: "fn_c" }),
    ];
    const tools = generateAgentTools(defs, stubServices);
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.tool.name)).toEqual(["fn_a", "fn_b", "fn_c"]);
  });

  test("filters out non-agent surface definitions", () => {
    const defs = [
      makeDef({ name: "agent_fn", surfaces: ["agent"] }),
      makeDef({ name: "api_fn", surfaces: ["api"] }),
      makeDef({ name: "discord_fn", surfaces: ["discord"] }),
    ];
    const tools = generateAgentTools(defs, stubServices);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.tool.name).toBe("agent_fn");
  });

  test("excludes feature-gated definitions when gate is inactive", () => {
    const defs = [
      makeDef({ name: "gated", featureGate: "calendar" }),
      makeDef({ name: "ungated" }),
    ];
    const tools = generateAgentTools(defs, stubServices, undefined, (_id) => false);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.tool.name).toBe("ungated");
  });

  test("includes feature-gated definitions when gate is active", () => {
    const defs = [
      makeDef({ name: "gated", featureGate: "calendar" }),
      makeDef({ name: "ungated" }),
    ];
    const tools = generateAgentTools(defs, stubServices, undefined, (_id) => true);
    expect(tools).toHaveLength(2);
  });

  test("includes feature-gated definitions when no featureChecker provided", () => {
    const defs = [
      makeDef({ name: "gated", featureGate: "calendar" }),
      makeDef({ name: "ungated" }),
    ];
    const tools = generateAgentTools(defs, stubServices);
    expect(tools).toHaveLength(2);
  });

  test("returns empty array for empty input", () => {
    const tools = generateAgentTools([], stubServices);
    expect(tools).toEqual([]);
  });

  test("returns empty array when all definitions are filtered out", () => {
    const defs = [
      makeDef({ name: "api_only", surfaces: ["api"] }),
    ];
    const tools = generateAgentTools(defs, stubServices);
    expect(tools).toEqual([]);
  });

  test("featureChecker receives the correct feature id", () => {
    const checkedIds: string[] = [];
    const defs = [
      makeDef({ name: "a", featureGate: "email" }),
      makeDef({ name: "b", featureGate: "finance" }),
    ];
    generateAgentTools(defs, stubServices, undefined, (id) => {
      checkedIds.push(id);
      return true;
    });
    expect(checkedIds).toEqual(["email", "finance"]);
  });

  test("definitions without featureGate skip the featureChecker", () => {
    const checkedIds: string[] = [];
    const defs = [
      makeDef({ name: "plain" }),
      makeDef({ name: "gated", featureGate: "media" }),
    ];
    generateAgentTools(defs, stubServices, undefined, (id) => {
      checkedIds.push(id);
      return true;
    });
    expect(checkedIds).toEqual(["media"]);
  });
});
