import { describe, expect, test } from "bun:test";
import { ToolResolutionService } from "./tool-resolution-service";
import type { ToolCatalogCard } from "../domain/tool-catalog";
import type { ToolRegistry } from "../tools/tool-registry";

function makeFakeTool(name: string) {
  return { name } as any;
}

function makeCatalogCard(
  canonicalName: string,
  agentScopes: string[],
  aliasOf?: string,
): ToolCatalogCard {
  return {
    name: canonicalName,
    description: "",
    examples: [],
    canonicalName,
    aliasOf,
    domains: [],
    tags: [],
    agentScopes: agentScopes as any,
    defaultVisibleScopes: [],
    defaultVisibleToMainAgent: false,
    defaultVisibleToSubagent: false,
    supportsBackground: false,
    mutatesState: false,
    readsWorkspace: false,
    authorization: { access: "anyone", behavior: "uniform" },
  };
}

function createMockRegistry(opts: {
  defaultToolNames?: string[];
  catalog?: ToolCatalogCard[];
}): ToolRegistry {
  const defaultNames = opts.defaultToolNames ?? [];
  const catalog = opts.catalog ?? [];

  return {
    getAgentDefaultVisibleToolNames: (_scope: any) => defaultNames,
    getToolsByNames: (names: string[], _context?: any, _opts?: any) =>
      names.map((n) => makeFakeTool(n)),
    getToolCatalog: (_context?: any) => catalog,
  } as unknown as ToolRegistry;
}

describe("ToolResolutionService", () => {
  describe("resolve", () => {
    test("returns default tools for scope", () => {
      const registry = createMockRegistry({
        defaultToolNames: ["tool_a", "tool_b"],
      });
      const service = new ToolResolutionService(registry);

      const result = service.resolve({ agentScope: "chat" });
      expect(result.tools).toContain("tool_a");
      expect(result.tools).toContain("tool_b");
      expect(result.activatedTools).toEqual([]);
    });

    test("merges activatedToolNames with defaults", () => {
      const registry = createMockRegistry({
        defaultToolNames: ["tool_a"],
      });
      const service = new ToolResolutionService(registry);

      const result = service.resolve({
        agentScope: "chat",
        activatedToolNames: ["extra_tool"],
      });
      expect(result.tools).toContain("tool_a");
      expect(result.tools).toContain("extra_tool");
      expect(result.activatedTools).toEqual(["extra_tool"]);
    });

    test("deduplicates activated tools already in defaults", () => {
      const registry = createMockRegistry({
        defaultToolNames: ["tool_a"],
      });
      const service = new ToolResolutionService(registry);

      const result = service.resolve({
        agentScope: "chat",
        activatedToolNames: ["tool_a"],
      });
      // Set deduplication means tool_a appears once
      expect(result.tools.filter((n: string) => n === "tool_a")).toHaveLength(1);
    });

    test("returns entries as StructuredToolInterface-like objects", () => {
      const registry = createMockRegistry({ defaultToolNames: ["t1"] });
      const service = new ToolResolutionService(registry);

      const result = service.resolve({ agentScope: "chat" });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.name).toBe("t1");
    });
  });

  describe("getScopeCatalog", () => {
    test("filters by scope and excludes aliases", () => {
      const catalog = [
        makeCatalogCard("tool_a", ["chat"]),
        makeCatalogCard("tool_b", ["coding-worker"]),
        makeCatalogCard("tool_a_alias", ["chat"], "tool_a"),
      ];
      const registry = createMockRegistry({ catalog });
      const service = new ToolResolutionService(registry);

      const result = service.getScopeCatalog("chat");
      expect(result).toHaveLength(1);
      expect(result[0]!.canonicalName).toBe("tool_a");
    });

    test("returns empty when no tools match scope", () => {
      const catalog = [makeCatalogCard("tool_a", ["coding-worker"])];
      const registry = createMockRegistry({ catalog });
      const service = new ToolResolutionService(registry);

      const result = service.getScopeCatalog("chat");
      expect(result).toHaveLength(0);
    });
  });

  describe("resolveAllForScope", () => {
    test("resolves all non-alias tools for scope", () => {
      const catalog = [
        makeCatalogCard("tool_a", ["chat"]),
        makeCatalogCard("tool_b", ["chat"]),
        makeCatalogCard("tool_c", ["coding-worker"]),
        makeCatalogCard("alias_a", ["chat"], "tool_a"),
      ];
      const registry = createMockRegistry({ catalog });
      const service = new ToolResolutionService(registry);

      const result = service.resolveAllForScope("chat");
      expect(result.tools).toEqual(["tool_a", "tool_b"]);
      expect(result.activatedTools).toEqual([]);
    });
  });

  describe("forScope", () => {
    test("returns resolve and resolveAll helpers bound to scope", () => {
      const catalog = [makeCatalogCard("tool_x", ["coding-planner"])];
      const registry = createMockRegistry({
        defaultToolNames: ["default_tool"],
        catalog,
      });
      const service = new ToolResolutionService(registry);

      const scoped = service.forScope("coding-planner");
      expect(typeof scoped.resolve).toBe("function");
      expect(typeof scoped.resolveAll).toBe("function");

      const resolved = scoped.resolve({});
      expect(resolved.tools).toContain("default_tool");

      const resolvedAll = scoped.resolveAll();
      expect(resolvedAll.tools).toContain("tool_x");
    });
  });

  describe("convenience aliases", () => {
    test("resolveForChat delegates to chat scope", () => {
      const registry = createMockRegistry({ defaultToolNames: ["chat_tool"] });
      const service = new ToolResolutionService(registry);

      const result = service.resolveForChat({});
      expect(result.tools).toContain("chat_tool");
    });

    test("resolveAllForChat delegates to chat scope", () => {
      const catalog = [makeCatalogCard("c1", ["chat"])];
      const registry = createMockRegistry({ catalog });
      const service = new ToolResolutionService(registry);

      const result = service.resolveAllForChat();
      expect(result.tools).toContain("c1");
    });

    test("resolveForCodingPlanner delegates to coding-planner scope", () => {
      const registry = createMockRegistry({ defaultToolNames: ["plan_tool"] });
      const service = new ToolResolutionService(registry);

      const result = service.resolveForCodingPlanner({});
      expect(result.tools).toContain("plan_tool");
    });

    test("resolveAllForCodingPlanner delegates to coding-planner scope", () => {
      const catalog = [makeCatalogCard("p1", ["coding-planner"])];
      const registry = createMockRegistry({ catalog });
      const service = new ToolResolutionService(registry);

      const result = service.resolveAllForCodingPlanner();
      expect(result.tools).toContain("p1");
    });

    test("resolveForCodingWorker delegates to coding-worker scope", () => {
      const registry = createMockRegistry({ defaultToolNames: ["worker_tool"] });
      const service = new ToolResolutionService(registry);

      const result = service.resolveForCodingWorker({});
      expect(result.tools).toContain("worker_tool");
    });

    test("resolveAllForCodingWorker delegates to coding-worker scope", () => {
      const catalog = [makeCatalogCard("w1", ["coding-worker"])];
      const registry = createMockRegistry({ catalog });
      const service = new ToolResolutionService(registry);

      const result = service.resolveAllForCodingWorker();
      expect(result.tools).toContain("w1");
    });
  });
});
