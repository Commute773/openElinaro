import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { FunctionRegistry } from "./function-registry";
import type { FunctionDefinition, FunctionDomainBuilder } from "./define-function";
import type { ToolBuildContext } from "./context";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockCtx = {} as ToolBuildContext;

function makeDef(overrides: Partial<FunctionDefinition> & { name: string; input: z.ZodType }): FunctionDefinition {
  return {
    description: `Description for ${overrides.name}`,
    handler: async () => "ok",
    format: (r: unknown) => String(r),
    auth: { access: "anyone", behavior: "uniform" },
    domains: ["general"],
    agentScopes: ["chat"],
    ...overrides,
  } as FunctionDefinition;
}

function makeBuilder(defs: FunctionDefinition[]): FunctionDomainBuilder {
  return (_ctx: ToolBuildContext) => defs;
}

// ---------------------------------------------------------------------------
// Tests: build and get
// ---------------------------------------------------------------------------

describe("FunctionRegistry build and get", () => {
  test("builds definitions from domain builders", () => {
    const registry = new FunctionRegistry([
      makeBuilder([
        makeDef({ name: "fn_a", input: z.object({}) }),
        makeDef({ name: "fn_b", input: z.object({}) }),
      ]),
    ]);
    registry.build(mockCtx);
    expect(registry.isBuilt).toBe(true);
    expect(registry.getNames().sort()).toEqual(["fn_a", "fn_b"]);
  });

  test("get returns the definition by name", () => {
    const registry = new FunctionRegistry([
      makeBuilder([makeDef({ name: "my_fn", input: z.object({ x: z.string() }) })]),
    ]);
    registry.build(mockCtx);
    const def = registry.get("my_fn");
    expect(def).toBeDefined();
    expect(def!.name).toBe("my_fn");
  });

  test("get returns undefined for unknown name", () => {
    const registry = new FunctionRegistry([makeBuilder([])]);
    registry.build(mockCtx);
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  test("isBuilt is false before build and true after", () => {
    const registry = new FunctionRegistry([
      makeBuilder([makeDef({ name: "fn", input: z.object({}) })]),
    ]);
    expect(registry.isBuilt).toBe(false);
    registry.build(mockCtx);
    expect(registry.isBuilt).toBe(true);
  });

  test("build clears previous definitions", () => {
    let callCount = 0;
    const builder: FunctionDomainBuilder = (_ctx) => {
      callCount++;
      return [makeDef({ name: `fn_v${callCount}`, input: z.object({}) })];
    };
    const registry = new FunctionRegistry([builder]);
    registry.build(mockCtx);
    expect(registry.getNames()).toEqual(["fn_v1"]);
    registry.build(mockCtx);
    expect(registry.getNames()).toEqual(["fn_v2"]);
    expect(registry.get("fn_v1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: duplicate name detection
// ---------------------------------------------------------------------------

describe("duplicate name detection", () => {
  test("throws on duplicate function names within same builder", () => {
    const registry = new FunctionRegistry([
      makeBuilder([
        makeDef({ name: "dupe", input: z.object({}) }),
        makeDef({ name: "dupe", input: z.object({}) }),
      ]),
    ]);
    expect(() => registry.build(mockCtx)).toThrow("Duplicate function definition: dupe");
  });

  test("throws on duplicate function names across builders", () => {
    const registry = new FunctionRegistry([
      makeBuilder([makeDef({ name: "shared_name", input: z.object({}) })]),
      makeBuilder([makeDef({ name: "shared_name", input: z.object({}) })]),
    ]);
    expect(() => registry.build(mockCtx)).toThrow("Duplicate function definition: shared_name");
  });
});

// ---------------------------------------------------------------------------
// Tests: filter by surface
// ---------------------------------------------------------------------------

describe("getDefinitions with surface filter", () => {
  test("filters by api surface", () => {
    const registry = new FunctionRegistry([
      makeBuilder([
        makeDef({ name: "api_fn", input: z.object({}), surfaces: ["api"] }),
        makeDef({ name: "agent_fn", input: z.object({}), surfaces: ["agent"] }),
        makeDef({ name: "all_fn", input: z.object({}) }), // default = all
      ]),
    ]);
    registry.build(mockCtx);
    const apiDefs = registry.getDefinitions({ surface: "api" });
    expect(apiDefs.map((d) => d.name).sort()).toEqual(["all_fn", "api_fn"]);
  });

  test("filters by discord surface", () => {
    const registry = new FunctionRegistry([
      makeBuilder([
        makeDef({ name: "discord_fn", input: z.object({}), surfaces: ["discord"] }),
        makeDef({ name: "agent_fn", input: z.object({}), surfaces: ["agent"] }),
      ]),
    ]);
    registry.build(mockCtx);
    const discordDefs = registry.getDefinitions({ surface: "discord" });
    expect(discordDefs.length).toBe(1);
    expect(discordDefs[0]!.name).toBe("discord_fn");
  });

  test("filters by agent surface", () => {
    const registry = new FunctionRegistry([
      makeBuilder([
        makeDef({ name: "agent_fn", input: z.object({}), surfaces: ["agent"] }),
        makeDef({ name: "api_fn", input: z.object({}), surfaces: ["api"] }),
      ]),
    ]);
    registry.build(mockCtx);
    const agentDefs = registry.getDefinitions({ surface: "agent" });
    expect(agentDefs.length).toBe(1);
    expect(agentDefs[0]!.name).toBe("agent_fn");
  });

  test("returns all definitions when no filter is applied", () => {
    const registry = new FunctionRegistry([
      makeBuilder([
        makeDef({ name: "fn_a", input: z.object({}) }),
        makeDef({ name: "fn_b", input: z.object({}) }),
      ]),
    ]);
    registry.build(mockCtx);
    expect(registry.getDefinitions().length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: filter by feature
// ---------------------------------------------------------------------------

describe("getDefinitions with featureChecker", () => {
  test("excludes gated definitions when feature is inactive", () => {
    const registry = new FunctionRegistry([
      makeBuilder([
        makeDef({ name: "gated", input: z.object({}), featureGate: "finance" as any }),
        makeDef({ name: "open", input: z.object({}) }),
      ]),
    ]);
    registry.build(mockCtx);
    const defs = registry.getDefinitions({ featureChecker: (id) => id !== "finance" });
    expect(defs.length).toBe(1);
    expect(defs[0]!.name).toBe("open");
  });

  test("includes gated definitions when feature is active", () => {
    const registry = new FunctionRegistry([
      makeBuilder([
        makeDef({ name: "gated", input: z.object({}), featureGate: "finance" as any }),
      ]),
    ]);
    registry.build(mockCtx);
    const defs = registry.getDefinitions({ featureChecker: () => true });
    expect(defs.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: filter by domain (via getDefinitions + manual filter)
// ---------------------------------------------------------------------------

describe("domain-based filtering", () => {
  test("definitions carry domain metadata for downstream filtering", () => {
    const registry = new FunctionRegistry([
      makeBuilder([
        makeDef({ name: "finance_fn", input: z.object({}), domains: ["finance"] }),
        makeDef({ name: "health_fn", input: z.object({}), domains: ["health"] }),
        makeDef({ name: "multi_fn", input: z.object({}), domains: ["finance", "health"] }),
      ]),
    ]);
    registry.build(mockCtx);
    const allDefs = registry.getDefinitions();
    const financeDefs = allDefs.filter((d) => d.domains.includes("finance"));
    expect(financeDefs.map((d) => d.name).sort()).toEqual(["finance_fn", "multi_fn"]);
    const healthDefs = allDefs.filter((d) => d.domains.includes("health"));
    expect(healthDefs.map((d) => d.name).sort()).toEqual(["health_fn", "multi_fn"]);
  });
});

// ---------------------------------------------------------------------------
// Tests: surface generators delegation
// ---------------------------------------------------------------------------

describe("surface generator delegation", () => {
  test("generateAgentTools produces tool entries for agent-surface definitions", () => {
    const registry = new FunctionRegistry([
      makeBuilder([
        makeDef({ name: "tool_a", input: z.object({ x: z.string() }), surfaces: ["agent"] }),
        makeDef({ name: "tool_b", input: z.object({}), surfaces: ["api"] }),
      ]),
    ]);
    registry.build(mockCtx);
    const tools = registry.generateAgentTools(() => mockCtx);
    expect(tools.length).toBe(1);
    expect(tools[0]!.tool.name).toBe("tool_a");
  });

  test("generateApiRoutes produces routes for api-surface definitions", () => {
    const registry = new FunctionRegistry([
      makeBuilder([
        makeDef({ name: "route_fn", input: z.object({}), surfaces: ["api"] }),
        makeDef({ name: "agent_fn", input: z.object({}), surfaces: ["agent"] }),
      ]),
    ]);
    registry.build(mockCtx);
    const routes = registry.generateApiRoutes(() => mockCtx);
    expect(routes.length).toBe(1);
    expect(routes[0]!.pattern).toContain("route_fn".replaceAll("_", "/"));
  });

  test("generateDiscordCommands produces commands for discord-surface definitions", () => {
    const registry = new FunctionRegistry([
      makeBuilder([
        makeDef({ name: "disc_cmd", input: z.object({}), surfaces: ["discord"] }),
        makeDef({ name: "agent_fn", input: z.object({}), surfaces: ["agent"] }),
      ]),
    ]);
    registry.build(mockCtx);
    const cmds = registry.generateDiscordCommands();
    expect(cmds.length).toBe(1);
    expect(cmds[0]!.name).toBe("disc_cmd");
  });
});

// ---------------------------------------------------------------------------
// Tests: multiple builders compose
// ---------------------------------------------------------------------------

describe("multiple builders", () => {
  test("definitions from multiple builders are merged", () => {
    const registry = new FunctionRegistry([
      makeBuilder([makeDef({ name: "from_builder_1", input: z.object({}) })]),
      makeBuilder([makeDef({ name: "from_builder_2", input: z.object({}) })]),
    ]);
    registry.build(mockCtx);
    expect(registry.getNames().sort()).toEqual(["from_builder_1", "from_builder_2"]);
  });
});
