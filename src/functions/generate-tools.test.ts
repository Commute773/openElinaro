import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { generateAgentTool, generateAgentTools, type ToolEntry } from "./generate-tools";
import type { FunctionDefinition } from "./define-function";
import type { ToolBuildContext } from "./context";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock ToolBuildContext — only the type matters here, handlers are not called. */
const mockServices = {} as ToolBuildContext;
const resolveServices = () => mockServices;

function makeDef(overrides: Partial<FunctionDefinition> & { name: string; input: z.ZodType }): FunctionDefinition {
  return {
    description: `Description for ${overrides.name}`,
    handler: async () => "ok",
    format: (r: unknown) => String(r),
    auth: { access: "anyone", behavior: "uniform" },
    domains: ["test"],
    agentScopes: ["chat"],
    ...overrides,
  } as FunctionDefinition;
}

// ---------------------------------------------------------------------------
// Tests: zodToToolParameters via generateAgentTool
// ---------------------------------------------------------------------------

describe("generateAgentTool", () => {
  test("produces correct JSON Schema from Zod with string, number, boolean, optional, enum fields", () => {
    const def = makeDef({
      name: "test_tool",
      input: z.object({
        title: z.string().describe("The title"),
        count: z.number().describe("How many"),
        enabled: z.boolean(),
        note: z.string().optional(),
        status: z.enum(["active", "inactive"]),
      }),
    });

    const entry = generateAgentTool(def, resolveServices);
    expect(entry).not.toBeNull();

    const params = entry!.tool.parameters as Record<string, unknown>;
    expect(params.type).toBe("object");

    const props = params.properties as Record<string, Record<string, unknown>>;
    // String field
    expect(props.title.type).toBe("string");
    expect(props.title.description).toBe("The title");
    // Number field
    expect(props.count.type).toBe("number");
    expect(props.count.description).toBe("How many");
    // Boolean field
    expect(props.enabled.type).toBe("boolean");
    // Optional field — not in required
    const required = params.required as string[];
    expect(required).toContain("title");
    expect(required).toContain("count");
    expect(required).toContain("enabled");
    expect(required).toContain("status");
    expect(required).not.toContain("note");
    // Enum field
    expect(props.status.type).toBe("string");
    expect(props.status.enum).toEqual(["active", "inactive"]);
  });

  test("strips $schema from JSON Schema output", () => {
    const def = makeDef({
      name: "no_schema_key",
      input: z.object({ x: z.string() }),
    });
    const entry = generateAgentTool(def, resolveServices)!;
    const params = entry.tool.parameters as Record<string, unknown>;
    expect(params.$schema).toBeUndefined();
  });

  test("includes the silent control field from TOOL_CALL_BEHAVIOR_SCHEMA", () => {
    const def = makeDef({
      name: "with_silent",
      input: z.object({ query: z.string() }),
    });
    const entry = generateAgentTool(def, resolveServices)!;
    const props = (entry.tool.parameters as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props.silent).toBeDefined();
  });

  test("preserves name and description on the tool", () => {
    const def = makeDef({
      name: "my_tool",
      description: "Does something useful",
      input: z.object({}),
    });
    const entry = generateAgentTool(def, resolveServices)!;
    expect(entry.tool.name).toBe("my_tool");
    expect(entry.tool.description).toBe("Does something useful");
  });

  test("returns null for definitions that exclude the agent surface", () => {
    const def = makeDef({
      name: "api_only",
      input: z.object({}),
      surfaces: ["api"],
    });
    const entry = generateAgentTool(def, resolveServices);
    expect(entry).toBeNull();
  });

  test("handles nested object schemas", () => {
    const def = makeDef({
      name: "nested_tool",
      input: z.object({
        config: z.object({
          host: z.string(),
          port: z.number(),
        }),
      }),
    });
    const entry = generateAgentTool(def, resolveServices)!;
    const props = (entry.tool.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
    expect(props.config.type).toBe("object");
    const nested = props.config.properties as Record<string, Record<string, unknown>>;
    expect(nested.host.type).toBe("string");
    expect(nested.port.type).toBe("number");
  });

  test("includes zodSchema on the tool entry", () => {
    const def = makeDef({
      name: "zod_passthrough",
      input: z.object({ a: z.string() }),
    });
    const entry = generateAgentTool(def, resolveServices)!;
    expect(entry.tool.zodSchema).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: generateAgentTools (bulk)
// ---------------------------------------------------------------------------

describe("generateAgentTools", () => {
  test("converts multiple definitions and skips non-agent surfaces", () => {
    const defs = [
      makeDef({ name: "tool_a", input: z.object({ x: z.string() }), surfaces: ["agent"] }),
      makeDef({ name: "tool_b", input: z.object({ y: z.number() }), surfaces: ["api"] }),
      makeDef({ name: "tool_c", input: z.object({ z: z.boolean() }) }), // default = all surfaces
    ];
    const entries = generateAgentTools(defs, resolveServices);
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.tool.name)).toEqual(["tool_a", "tool_c"]);
  });

  test("respects feature gating", () => {
    const defs = [
      makeDef({ name: "gated", input: z.object({}), featureGate: "finance" as any }),
      makeDef({ name: "ungated", input: z.object({}) }),
    ];
    // Feature checker says "finance" is off
    const entries = generateAgentTools(defs, resolveServices, undefined, (id) => id !== "finance");
    expect(entries.length).toBe(1);
    expect(entries[0]!.tool.name).toBe("ungated");
  });

  test("includes gated function when feature is active", () => {
    const defs = [
      makeDef({ name: "gated", input: z.object({}), featureGate: "finance" as any }),
    ];
    const entries = generateAgentTools(defs, resolveServices, undefined, () => true);
    expect(entries.length).toBe(1);
  });
});
