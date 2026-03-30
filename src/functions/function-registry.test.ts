import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { FunctionRegistry } from "./function-registry";
import type { FunctionDefinition, FunctionDomainBuilder } from "./define-function";
import { formatResult } from "./formatters";
import type { ToolBuildContext } from "./context";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal stub that satisfies the ToolBuildContext shape for build(). */
const stubCtx = {} as ToolBuildContext;

/** Create a minimal valid FunctionDefinition with overrides. */
function makeDef(overrides: Partial<FunctionDefinition> & { name: string }): FunctionDefinition {
  return {
    description: `${overrides.name} description`,
    input: z.object({}),
    handler: async () => "ok",
    format: formatResult,
    auth: { access: "anyone", behavior: "uniform" },
    domains: ["test"],
    agentScopes: ["chat"],
    ...overrides,
  };
}

/** Create a domain builder that returns the given definitions. */
function makeBuilder(defs: FunctionDefinition[]): FunctionDomainBuilder {
  return (_ctx: ToolBuildContext) => defs;
}

// ---------------------------------------------------------------------------
// build()
// ---------------------------------------------------------------------------

describe("FunctionRegistry.build()", () => {
  test("aggregates definitions from multiple domain builders", () => {
    const builderA = makeBuilder([makeDef({ name: "alpha" })]);
    const builderB = makeBuilder([makeDef({ name: "beta" }), makeDef({ name: "gamma" })]);

    const registry = new FunctionRegistry([builderA, builderB]);
    registry.build(stubCtx);

    expect(registry.getNames().sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  test("passes the build context to each builder", () => {
    const received: ToolBuildContext[] = [];
    const spy: FunctionDomainBuilder = (ctx) => {
      received.push(ctx);
      return [makeDef({ name: "x" })];
    };

    const registry = new FunctionRegistry([spy]);
    registry.build(stubCtx);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(stubCtx);
  });

  test("clears previous definitions on rebuild", () => {
    let callCount = 0;
    const builder: FunctionDomainBuilder = (_ctx) => {
      callCount++;
      return callCount === 1
        ? [makeDef({ name: "first" })]
        : [makeDef({ name: "second" })];
    };

    const registry = new FunctionRegistry([builder]);
    registry.build(stubCtx);
    expect(registry.getNames()).toEqual(["first"]);

    registry.build(stubCtx);
    expect(registry.getNames()).toEqual(["second"]);
  });
});

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

describe("duplicate detection", () => {
  test("throws when two definitions share the same name", () => {
    const builderA = makeBuilder([makeDef({ name: "dup" })]);
    const builderB = makeBuilder([makeDef({ name: "dup" })]);

    const registry = new FunctionRegistry([builderA, builderB]);
    expect(() => registry.build(stubCtx)).toThrow("Duplicate function definition: dup");
  });

  test("throws when same builder returns duplicate names", () => {
    const builder = makeBuilder([makeDef({ name: "same" }), makeDef({ name: "same" })]);
    const registry = new FunctionRegistry([builder]);
    expect(() => registry.build(stubCtx)).toThrow("Duplicate function definition: same");
  });
});

// ---------------------------------------------------------------------------
// isBuilt / get()
// ---------------------------------------------------------------------------

describe("isBuilt", () => {
  test("returns false before build", () => {
    const registry = new FunctionRegistry([makeBuilder([makeDef({ name: "a" })])]);
    expect(registry.isBuilt).toBe(false);
  });

  test("returns true after build with definitions", () => {
    const registry = new FunctionRegistry([makeBuilder([makeDef({ name: "a" })])]);
    registry.build(stubCtx);
    expect(registry.isBuilt).toBe(true);
  });
});

describe("get()", () => {
  test("returns the definition by name", () => {
    const def = makeDef({ name: "findme" });
    const registry = new FunctionRegistry([makeBuilder([def])]);
    registry.build(stubCtx);

    expect(registry.get("findme")).toBe(def);
  });

  test("returns undefined for unknown names", () => {
    const registry = new FunctionRegistry([makeBuilder([makeDef({ name: "a" })])]);
    registry.build(stubCtx);

    expect(registry.get("nonexistent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Surface filtering via getDefinitions()
// ---------------------------------------------------------------------------

describe("surface filtering", () => {
  test("returns only definitions matching the requested surface", () => {
    const agentOnly = makeDef({ name: "agent-only", surfaces: ["agent"] });
    const apiOnly = makeDef({ name: "api-only", surfaces: ["api"] });
    const discordOnly = makeDef({ name: "discord-only", surfaces: ["discord"] });
    const allSurfaces = makeDef({ name: "everywhere", surfaces: ["api", "discord", "agent"] });

    const registry = new FunctionRegistry([makeBuilder([agentOnly, apiOnly, discordOnly, allSurfaces])]);
    registry.build(stubCtx);

    const agentDefs = registry.getDefinitions({ surface: "agent" });
    expect(agentDefs.map((d) => d.name).sort()).toEqual(["agent-only", "everywhere"]);

    const apiDefs = registry.getDefinitions({ surface: "api" });
    expect(apiDefs.map((d) => d.name).sort()).toEqual(["api-only", "everywhere"]);

    const discordDefs = registry.getDefinitions({ surface: "discord" });
    expect(discordDefs.map((d) => d.name).sort()).toEqual(["discord-only", "everywhere"]);
  });

  test("definitions without explicit surfaces default to all three", () => {
    const noSurfaces = makeDef({ name: "default" });

    const registry = new FunctionRegistry([makeBuilder([noSurfaces])]);
    registry.build(stubCtx);

    for (const surface of ["api", "discord", "agent"] as const) {
      const defs = registry.getDefinitions({ surface });
      expect(defs.map((d) => d.name)).toEqual(["default"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Feature gating
// ---------------------------------------------------------------------------

describe("feature gating", () => {
  test("excludes gated definitions when feature is inactive", () => {
    const gated = makeDef({ name: "gated", featureGate: "calendar" });
    const ungated = makeDef({ name: "ungated" });

    const registry = new FunctionRegistry([makeBuilder([gated, ungated])]);
    registry.build(stubCtx);

    const featureChecker = (id: string) => id !== "calendar";
    const defs = registry.getDefinitions({ featureChecker });
    expect(defs.map((d) => d.name)).toEqual(["ungated"]);
  });

  test("includes gated definitions when feature is active", () => {
    const gated = makeDef({ name: "gated", featureGate: "calendar" });
    const ungated = makeDef({ name: "ungated" });

    const registry = new FunctionRegistry([makeBuilder([gated, ungated])]);
    registry.build(stubCtx);

    const featureChecker = (_id: string) => true;
    const defs = registry.getDefinitions({ featureChecker });
    expect(defs.map((d) => d.name).sort()).toEqual(["gated", "ungated"]);
  });

  test("includes ungated definitions regardless of featureChecker", () => {
    const ungated = makeDef({ name: "ungated" });
    const registry = new FunctionRegistry([makeBuilder([ungated])]);
    registry.build(stubCtx);

    const featureChecker = (_id: string) => false;
    const defs = registry.getDefinitions({ featureChecker });
    expect(defs.map((d) => d.name)).toEqual(["ungated"]);
  });

  test("combined surface and feature filtering", () => {
    const gatedAgent = makeDef({ name: "gated-agent", surfaces: ["agent"], featureGate: "email" });
    const gatedApi = makeDef({ name: "gated-api", surfaces: ["api"], featureGate: "email" });
    const ungatedAgent = makeDef({ name: "ungated-agent", surfaces: ["agent"] });

    const registry = new FunctionRegistry([makeBuilder([gatedAgent, gatedApi, ungatedAgent])]);
    registry.build(stubCtx);

    // Feature inactive, agent surface only
    const defs = registry.getDefinitions({
      surface: "agent",
      featureChecker: (id) => id !== "email",
    });
    expect(defs.map((d) => d.name)).toEqual(["ungated-agent"]);
  });
});

// ---------------------------------------------------------------------------
// generateAgentTools() surface filtering
// ---------------------------------------------------------------------------

describe("generateAgentTools() surface filtering", () => {
  test("only includes agent-surface functions", () => {
    const agentFn = makeDef({ name: "agent-fn", surfaces: ["agent"] });
    const apiOnlyFn = makeDef({ name: "api-fn", surfaces: ["api"] });

    const registry = new FunctionRegistry([makeBuilder([agentFn, apiOnlyFn])]);
    registry.build(stubCtx);

    const tools = registry.generateAgentTools(() => stubCtx);
    const toolNames = tools.map((t) => t.tool.name);
    expect(toolNames).toEqual(["agent-fn"]);
  });

  test("excludes feature-gated functions when gated off", () => {
    const gatedFn = makeDef({ name: "gated", surfaces: ["agent"], featureGate: "finance" });
    const normalFn = makeDef({ name: "normal", surfaces: ["agent"] });

    const registry = new FunctionRegistry([makeBuilder([gatedFn, normalFn])]);
    registry.build(stubCtx);

    const tools = registry.generateAgentTools(
      () => stubCtx,
      undefined,
      (id) => id !== "finance",
    );
    const toolNames = tools.map((t) => t.tool.name);
    expect(toolNames).toEqual(["normal"]);
  });
});

// ---------------------------------------------------------------------------
// generateCatalog()
// ---------------------------------------------------------------------------

describe("generateCatalog()", () => {
  test("produces ToolCatalogCard with correct metadata", () => {
    const def = makeDef({
      name: "my-tool",
      description: "Does something useful",
      domains: ["core"],
      agentScopes: ["chat", "coding-worker"],
      tags: ["read"],
      examples: ["example usage"],
      surfaces: ["agent"],
      defaultVisibleScopes: ["chat"],
      supportsBackground: true,
      mutatesState: false,
      readsWorkspace: true,
    });

    const registry = new FunctionRegistry([makeBuilder([def])]);
    registry.build(stubCtx);

    const cards = registry.generateCatalog();
    expect(cards).toHaveLength(1);

    const card = cards[0]!;
    expect(card.name).toBe("my-tool");
    expect(card.description).toBe("Does something useful");
    expect(card.canonicalName).toBe("my-tool");
    expect(card.domains).toEqual(["core"]);
    expect(card.agentScopes).toEqual(["chat", "coding-worker"]);
    expect(card.tags).toEqual(["read"]);
    expect(card.examples).toEqual(["example usage"]);
    expect(card.defaultVisibleScopes).toEqual(["chat"]);
    expect(card.defaultVisibleToMainAgent).toBe(true);
    expect(card.defaultVisibleToSubagent).toBe(false);
    expect(card.supportsBackground).toBe(true);
    expect(card.mutatesState).toBe(false);
    expect(card.readsWorkspace).toBe(true);
    expect(card.authorization).toEqual({ access: "anyone", behavior: "uniform" });
  });

  test("skips non-agent-surface definitions", () => {
    const apiOnly = makeDef({ name: "api-only", surfaces: ["api"] });
    const agent = makeDef({ name: "agent", surfaces: ["agent"] });

    const registry = new FunctionRegistry([makeBuilder([apiOnly, agent])]);
    registry.build(stubCtx);

    const cards = registry.generateCatalog();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.name).toBe("agent");
  });

  test("defaultVisibleToSubagent is true when coding-worker is in defaultVisibleScopes", () => {
    const def = makeDef({
      name: "subagent-tool",
      surfaces: ["agent"],
      defaultVisibleScopes: ["coding-worker"],
    });

    const registry = new FunctionRegistry([makeBuilder([def])]);
    registry.build(stubCtx);

    const cards = registry.generateCatalog();
    expect(cards[0]!.defaultVisibleToMainAgent).toBe(false);
    expect(cards[0]!.defaultVisibleToSubagent).toBe(true);
  });

  test("infers tags when none are provided", () => {
    const listDef = makeDef({ name: "list-items", description: "List all items" });
    const createDef = makeDef({ name: "create-item", description: "Create a new item" });

    const registry = new FunctionRegistry([makeBuilder([listDef, createDef])]);
    registry.build(stubCtx);

    const cards = registry.generateCatalog();
    const listCard = cards.find((c) => c.name === "list-items")!;
    expect(listCard.tags).toContain("read");

    const createCard = cards.find((c) => c.name === "create-item")!;
    expect(createCard.tags).toContain("write");
  });

  test("defaults boolean flags to false when not set", () => {
    const def = makeDef({ name: "minimal" });

    const registry = new FunctionRegistry([makeBuilder([def])]);
    registry.build(stubCtx);

    const cards = registry.generateCatalog();
    expect(cards[0]!.supportsBackground).toBe(false);
    expect(cards[0]!.mutatesState).toBe(false);
    expect(cards[0]!.readsWorkspace).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generateAuthDeclarations()
// ---------------------------------------------------------------------------

describe("generateAuthDeclarations()", () => {
  test("produces auth declarations keyed by function name", () => {
    const def = makeDef({
      name: "restricted",
      auth: { access: "root", behavior: "role-sensitive", note: "admin only" },
    });

    const registry = new FunctionRegistry([makeBuilder([def])]);
    registry.build(stubCtx);

    const decls = registry.generateAuthDeclarations();
    expect(decls["restricted"]).toEqual({
      access: "root",
      behavior: "role-sensitive",
      note: "admin only",
    });
  });
});

// ---------------------------------------------------------------------------
// generateUntrustedOutputMap()
// ---------------------------------------------------------------------------

describe("generateUntrustedOutputMap()", () => {
  test("returns entries only for definitions with untrustedOutput", () => {
    const untrusted = makeDef({
      name: "web-fetch",
      untrustedOutput: { sourceType: "web", sourceName: "fetch", notes: "external" },
    });
    const trusted = makeDef({ name: "local-op" });

    const registry = new FunctionRegistry([makeBuilder([untrusted, trusted])]);
    registry.build(stubCtx);

    const map = registry.generateUntrustedOutputMap();
    expect(Object.keys(map)).toEqual(["web-fetch"]);
    expect(map["web-fetch"]).toEqual({ sourceType: "web", sourceName: "fetch", notes: "external" });
  });
});

// ---------------------------------------------------------------------------
// Empty registry
// ---------------------------------------------------------------------------

describe("empty registry", () => {
  test("produces empty results before build", () => {
    const registry = new FunctionRegistry([]);
    expect(registry.isBuilt).toBe(false);
    expect(registry.getNames()).toEqual([]);
    expect(registry.getDefinitions()).toEqual([]);
    expect(registry.generateCatalog()).toEqual([]);
    expect(registry.generateAuthDeclarations()).toEqual({});
    expect(registry.generateUntrustedOutputMap()).toEqual({});
  });

  test("produces empty results when builders return no definitions", () => {
    const emptyBuilder = makeBuilder([]);
    const registry = new FunctionRegistry([emptyBuilder]);
    registry.build(stubCtx);

    expect(registry.isBuilt).toBe(false);
    expect(registry.getNames()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scale
// ---------------------------------------------------------------------------

describe("registry can hold many functions", () => {
  test("handles 500 definitions without issues", () => {
    const defs: FunctionDefinition[] = [];
    for (let i = 0; i < 500; i++) {
      defs.push(makeDef({ name: `fn-${i}` }));
    }

    const registry = new FunctionRegistry([makeBuilder(defs)]);
    registry.build(stubCtx);

    expect(registry.getNames()).toHaveLength(500);
    expect(registry.get("fn-0")).toBeDefined();
    expect(registry.get("fn-499")).toBeDefined();
    expect(registry.generateCatalog()).toHaveLength(500);
  });
});
