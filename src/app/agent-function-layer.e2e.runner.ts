/**
 * E2E runner: function layer surface generation.
 *
 * Tests that FunctionRegistry correctly builds definitions and generates
 * all surfaces (agent tools, API routes, OpenAPI, auth declarations, catalog).
 *
 * No LLM calls — tests metadata generation only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Set up isolated runtime root BEFORE importing runtime modules
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-fnlayer-e2e-"));
process.env.OPENELINARO_ROOT_DIR = testRoot;

// Copy minimal fixtures
const fixturesDir = path.join(import.meta.dir, "../test/fixtures");
if (fs.existsSync(path.join(fixturesDir, "profiles"))) {
  fs.cpSync(path.join(fixturesDir, "profiles"), path.join(testRoot, "profiles"), { recursive: true });
}
if (fs.existsSync(path.join(fixturesDir, "auth-store.json"))) {
  fs.copyFileSync(path.join(fixturesDir, "auth-store.json"), path.join(testRoot, "auth-store.json"));
}

try {
  // Import after env setup
  const { FunctionRegistry } = await import("../functions/function-registry");
  const { ALL_FUNCTION_BUILDERS } = await import("../functions/domains");

  // 1. Build registry
  const registry = new FunctionRegistry(ALL_FUNCTION_BUILDERS);

  // Create a minimal mock ToolBuildContext
  const noopService = new Proxy({}, {
    get: () => () => { throw new Error("Mock service called"); },
  });
  const mockCtx = new Proxy({}, {
    get: (_target, prop) => {
      if (prop === "featureConfig") {
        return { isActive: () => true };
      }
      return noopService;
    },
  }) as any;

  registry.build(mockCtx);

  const defCount = registry.getNames().length;
  if (defCount > 70) {
    console.log(`FNLAYER_REGISTRY_BUILD_OK (${defCount} definitions)`);
  } else {
    console.log(`FNLAYER_REGISTRY_BUILD_FAIL: only ${defCount} definitions`);
  }

  // 2. Generate agent tools
  const tools = registry.generateAgentTools(
    () => mockCtx,
    undefined,
    () => true,
  );
  if (tools.length > 50) {
    console.log(`FNLAYER_AGENT_TOOLS_OK (${tools.length} tools)`);
  } else {
    console.log(`FNLAYER_AGENT_TOOLS_FAIL: only ${tools.length} tools`);
  }

  // Verify each tool has name and description
  const missingMeta = tools.filter((t) => !t.tool.name || !t.tool.description);
  if (missingMeta.length > 0) {
    console.log(`FNLAYER_AGENT_TOOLS_WARN: ${missingMeta.length} tools missing name/description`);
  }

  // 3. Generate API routes
  const routes = registry.generateApiRoutes(
    () => mockCtx,
    () => true,
  );
  if (routes.length > 10) {
    console.log(`FNLAYER_API_ROUTES_OK (${routes.length} routes)`);
  } else {
    console.log(`FNLAYER_API_ROUTES_FAIL: only ${routes.length} routes`);
  }

  // Verify each route has method, pattern, handler
  const invalidRoutes = routes.filter((r) => !r.method || !r.pattern || !r.handler);
  if (invalidRoutes.length > 0) {
    console.log(`FNLAYER_API_ROUTES_WARN: ${invalidRoutes.length} invalid routes`);
  }

  // 4. Generate OpenAPI spec
  const spec = registry.generateOpenApiSpec(() => true);
  const pathCount = Object.keys(spec.paths as object ?? {}).length;
  if (pathCount > 5 && (spec as any).openapi === "3.1.0") {
    console.log(`FNLAYER_OPENAPI_OK (${pathCount} paths, OpenAPI 3.1.0)`);
  } else {
    console.log(`FNLAYER_OPENAPI_FAIL: ${pathCount} paths, version=${(spec as any).openapi}`);
  }

  // 5. Generate auth declarations
  const authDecls = registry.generateAuthDeclarations();
  const authCount = Object.keys(authDecls).length;
  if (authCount > 70) {
    console.log(`FNLAYER_AUTH_DECLS_OK (${authCount} declarations)`);
  } else {
    console.log(`FNLAYER_AUTH_DECLS_FAIL: only ${authCount} declarations`);
  }

  // Verify each declaration has access and behavior
  const invalidDecls = Object.entries(authDecls).filter(
    ([, d]) => !d.access || !d.behavior,
  );
  if (invalidDecls.length > 0) {
    console.log(`FNLAYER_AUTH_DECLS_WARN: ${invalidDecls.length} invalid declarations`);
  }

  // 6. Generate catalog
  const catalog = registry.generateCatalog();
  if (catalog.length > 50) {
    console.log(`FNLAYER_CATALOG_OK (${catalog.length} cards)`);
  } else {
    console.log(`FNLAYER_CATALOG_FAIL: only ${catalog.length} cards`);
  }

  // Verify each card has required fields
  const invalidCards = catalog.filter(
    (c) => !c.name || !c.description || !c.domains.length || !c.agentScopes.length,
  );
  if (invalidCards.length > 0) {
    console.log(`FNLAYER_CATALOG_WARN: ${invalidCards.length} incomplete cards`);
  }
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
