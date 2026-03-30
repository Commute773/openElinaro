import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { generateApiRoute, generateApiRoutes } from "./generate-api-routes";
import { deriveHttpAnnotation, API_PATH_PREFIX } from "./define-function";
import type { FunctionDefinition } from "./define-function";
import type { ToolBuildContext } from "./context";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Tests: deriveHttpAnnotation (auto-derived paths)
// ---------------------------------------------------------------------------

describe("deriveHttpAnnotation", () => {
  test("converts underscores to slashes for the path", () => {
    const def = makeDef({ name: "finance_summary", input: z.object({}) });
    const ann = deriveHttpAnnotation(def);
    expect(ann.path).toBe("/finance/summary");
  });

  test("single-word name produces simple path", () => {
    const def = makeDef({ name: "status", input: z.object({}) });
    const ann = deriveHttpAnnotation(def);
    expect(ann.path).toBe("/status");
  });

  test("uses POST for mutating functions", () => {
    const def = makeDef({ name: "create_item", input: z.object({}), mutatesState: true });
    const ann = deriveHttpAnnotation(def);
    expect(ann.method).toBe("POST");
  });

  test("uses GET for non-mutating functions", () => {
    const def = makeDef({ name: "list_items", input: z.object({}), mutatesState: false });
    const ann = deriveHttpAnnotation(def);
    expect(ann.method).toBe("GET");
  });

  test("defaults to GET when mutatesState is unset", () => {
    const def = makeDef({ name: "query", input: z.object({}) });
    const ann = deriveHttpAnnotation(def);
    expect(ann.method).toBe("GET");
  });
});

// ---------------------------------------------------------------------------
// Tests: generateApiRoute
// ---------------------------------------------------------------------------

describe("generateApiRoute", () => {
  test("returns null for definitions that exclude the api surface", () => {
    const def = makeDef({
      name: "agent_only",
      input: z.object({}),
      surfaces: ["agent"],
    });
    const route = generateApiRoute(def, resolveServices);
    expect(route).toBeNull();
  });

  test("uses explicit http annotation when provided", () => {
    const def = makeDef({
      name: "custom_route",
      input: z.object({}),
      http: { method: "PUT", path: "/custom/endpoint", successStatus: 201 },
    });
    const route = generateApiRoute(def, resolveServices)!;
    expect(route.method).toBe("PUT");
    expect(route.pattern).toBe(`${API_PATH_PREFIX}/custom/endpoint`);
  });

  test("auto-derives route when no http annotation", () => {
    const def = makeDef({
      name: "finance_summary",
      input: z.object({}),
    });
    const route = generateApiRoute(def, resolveServices)!;
    expect(route.method).toBe("GET");
    expect(route.pattern).toBe(`${API_PATH_PREFIX}/finance/summary`);
  });

  test("does not double-prefix /api/ paths", () => {
    const def = makeDef({
      name: "legacy",
      input: z.object({}),
      http: { method: "GET", path: "/api/legacy/route" },
    });
    const route = generateApiRoute(def, resolveServices)!;
    expect(route.pattern).toBe("/api/legacy/route");
  });

  test("handler validates input and returns 400 on invalid input", async () => {
    const def = makeDef({
      name: "validated",
      input: z.object({ name: z.string() }),
    });
    const route = generateApiRoute(def, resolveServices)!;
    // Simulate a POST with invalid JSON body (missing required field)
    const request = new Request("http://localhost/api/validated", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const response = await route.handler(request, {}, {} as any);
    expect(response.status).toBe(400);
  });

  test("handler returns success with explicit successStatus", async () => {
    const def = makeDef({
      name: "create_thing",
      input: z.object({ title: z.string() }),
      http: { method: "POST", path: "/things", successStatus: 201 },
      mutatesState: true,
      handler: async (input: any) => ({ id: "1", title: input.title }),
      format: (r: any) => `Created: ${r.title}`,
    });
    const route = generateApiRoute(def, resolveServices)!;
    const request = new Request("http://localhost/api/things", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "hello" }),
    });
    const response = await route.handler(request, {}, {} as any);
    expect(response.status).toBe(201);
    const body = await response.json() as Record<string, unknown>;
    expect(body.id).toBe("1");
    expect(body.title).toBe("hello");
  });

  test("string handler results are wrapped in { text: ... }", async () => {
    const def = makeDef({
      name: "echo",
      input: z.object({ msg: z.string() }),
      mutatesState: true, // ensures POST method is derived
      handler: async (input: any) => input.msg,
      format: (r: unknown) => String(r),
    });
    const route = generateApiRoute(def, resolveServices)!;
    const request = new Request("http://localhost/api/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msg: "hi" }),
    });
    const response = await route.handler(request, {}, {} as any);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.text).toBe("hi");
  });
});

// ---------------------------------------------------------------------------
// Tests: query param coercion
// ---------------------------------------------------------------------------

describe("query param coercion", () => {
  test("coerces string to boolean and number for GET requests", async () => {
    let capturedInput: any;
    const def = makeDef({
      name: "search",
      input: z.object({
        query: z.string(),
        limit: z.number(),
        verbose: z.boolean().optional(),
      }),
      handler: async (input: any) => {
        capturedInput = input;
        return { results: [] };
      },
      format: () => "ok",
    });
    const route = generateApiRoute(def, resolveServices)!;
    const request = new Request("http://localhost/api/search?query=hello&limit=10&verbose=true");
    await route.handler(request, {}, {} as any);
    expect(capturedInput.query).toBe("hello");
    expect(capturedInput.limit).toBe(10);
    expect(capturedInput.verbose).toBe(true);
  });

  test("coerces '1' to true for boolean params", async () => {
    let capturedInput: any;
    const def = makeDef({
      name: "check",
      input: z.object({
        active: z.boolean(),
      }),
      handler: async (input: any) => {
        capturedInput = input;
        return {};
      },
      format: () => "ok",
    });
    const route = generateApiRoute(def, resolveServices)!;
    const request = new Request("http://localhost/api/check?active=1");
    await route.handler(request, {}, {} as any);
    expect(capturedInput.active).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: generateApiRoutes (bulk)
// ---------------------------------------------------------------------------

describe("generateApiRoutes", () => {
  test("generates routes for all api-surface definitions", () => {
    const defs = [
      makeDef({ name: "route_a", input: z.object({}), surfaces: ["api"] }),
      makeDef({ name: "route_b", input: z.object({}), surfaces: ["agent"] }),
      makeDef({ name: "route_c", input: z.object({}) }), // default = all surfaces
    ];
    const routes = generateApiRoutes(defs, resolveServices);
    expect(routes.length).toBe(2);
  });

  test("respects feature gating", () => {
    const defs = [
      makeDef({ name: "gated_route", input: z.object({}), featureGate: "finance" as any }),
      makeDef({ name: "open_route", input: z.object({}) }),
    ];
    const routes = generateApiRoutes(defs, resolveServices, (id) => id !== "finance");
    expect(routes.length).toBe(1);
  });
});
