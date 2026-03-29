import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { FunctionDefinition } from "./define-function";
import type { ToolBuildContext } from "../tools/groups/tool-group-types";
import { generateApiRoute, generateApiRoutes } from "./generate-api-routes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stubServices = () => ({}) as unknown as ToolBuildContext;

function makeDef(overrides: Partial<FunctionDefinition> = {}): FunctionDefinition {
  return {
    name: "test_fn",
    description: "A test function",
    input: z.object({ greeting: z.string() }),
    handler: async (input) => ({ echo: (input as Record<string, string>).greeting }),
    auth: { access: "public", behavior: "allow" },
    domains: ["test"],
    agentScopes: ["foreground"],
    http: { method: "POST", path: "/api/g2/test" },
    ...overrides,
  } as FunctionDefinition;
}

function makeRequest(
  url: string,
  opts?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Request {
  const headers: Record<string, string> = { ...opts?.headers };
  const init: RequestInit = { method: opts?.method ?? "GET", headers };
  if (opts?.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return new Request(url, init);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateApiRoute", () => {
  test("generates a route from a function with HTTP annotation", () => {
    const def = makeDef();
    const route = generateApiRoute(def, stubServices);

    expect(route).not.toBeNull();
    expect(route!.method).toBe("POST");
    expect(route!.pattern).toBe("/api/g2/test");
    expect(typeof route!.handler).toBe("function");
  });

  test("auto-derives route for functions without http annotation", () => {
    const def = makeDef({ name: "finance_summary", http: undefined });
    const route = generateApiRoute(def, stubServices);

    expect(route).not.toBeNull();
    expect(route!.method).toBe("GET"); // not mutatesState, so GET
    expect(route!.pattern).toBe("/api/g2/finance/summary");
  });

  test("auto-derives POST method when mutatesState is true", () => {
    const def = makeDef({ name: "health_log_checkin", http: undefined, mutatesState: true });
    const route = generateApiRoute(def, stubServices);

    expect(route).not.toBeNull();
    expect(route!.method).toBe("POST");
    expect(route!.pattern).toBe("/api/g2/health/log/checkin");
  });

  test("returns null for functions whose surfaces exclude api", () => {
    const def = makeDef({ surfaces: ["discord", "agent"] });
    const route = generateApiRoute(def, stubServices);

    expect(route).toBeNull();
  });

  test("generates a route when surfaces explicitly includes api", () => {
    const def = makeDef({ surfaces: ["api"] });
    const route = generateApiRoute(def, stubServices);

    expect(route).not.toBeNull();
  });

  test("generates a route when surfaces is undefined (defaults to all)", () => {
    const def = makeDef({ surfaces: undefined });
    const route = generateApiRoute(def, stubServices);

    expect(route).not.toBeNull();
  });
});

describe("route handler: input parsing", () => {
  test("parses JSON body for POST requests", async () => {
    const def = makeDef();
    const route = generateApiRoute(def, stubServices)!;

    const request = makeRequest("http://localhost/api/g2/test", {
      method: "POST",
      body: { greeting: "hello" },
    });
    const response = await route.handler(request, {}, null!);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ echo: "hello" });
  });

  test("parses query params for GET requests", async () => {
    const def = makeDef({
      input: z.object({ q: z.string().optional() }),
      handler: async (input) => ({ query: (input as Record<string, string>).q ?? "none" }),
      http: { method: "GET", path: "/api/g2/search" },
    });
    const route = generateApiRoute(def, stubServices)!;

    const request = makeRequest("http://localhost/api/g2/search?q=bun", { method: "GET" });
    const response = await route.handler(request, {}, null!);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ query: "bun" });
  });

  test("merges path params into POST body", async () => {
    const def = makeDef({
      input: z.object({ id: z.string(), action: z.string() }),
      handler: async (input) => ({ id: (input as Record<string, string>).id, action: (input as Record<string, string>).action }),
      http: { method: "POST", path: "/api/g2/items/:id" },
    });

    const route = generateApiRoute(def, stubServices)!;

    const request = makeRequest("http://localhost/api/g2/items/42", {
      method: "POST",
      body: { action: "archive" },
    });
    // Path params are provided by the router, not extracted from the URL here
    const response = await route.handler(request, { id: "42" }, null!);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ id: "42", action: "archive" });
  });

  test("merges path params into GET query params", async () => {
    const def = makeDef({
      input: z.object({ id: z.string(), format: z.string().optional() }),
      handler: async (input) => ({ id: (input as Record<string, string>).id, format: (input as Record<string, string>).format }),
      http: { method: "GET", path: "/api/g2/items/:id" },
    });

    const route = generateApiRoute(def, stubServices)!;

    const request = makeRequest("http://localhost/api/g2/items/99?format=json", { method: "GET" });
    const response = await route.handler(request, { id: "99" }, null!);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ id: "99", format: "json" });
  });

  test("path params override query params for GET", async () => {
    const def = makeDef({
      input: z.object({ id: z.string() }),
      handler: async (input) => ({ id: (input as Record<string, string>).id }),
      http: { method: "GET", path: "/api/g2/items/:id" },
    });

    const route = generateApiRoute(def, stubServices)!;

    // Query has id=query-val, path params have id=path-val; path should win
    const request = makeRequest("http://localhost/api/g2/items/path-val?id=query-val", { method: "GET" });
    const response = await route.handler(request, { id: "path-val" }, null!);

    const data = await response.json();
    expect(data).toEqual({ id: "path-val" });
  });

  test("handles POST with empty body gracefully", async () => {
    const def = makeDef({
      input: z.object({ id: z.string() }),
      handler: async (input) => ({ id: (input as Record<string, string>).id }),
      http: { method: "POST", path: "/api/g2/items/:id" },
    });

    const route = generateApiRoute(def, stubServices)!;

    const request = makeRequest("http://localhost/api/g2/items/7", { method: "POST" });
    const response = await route.handler(request, { id: "7" }, null!);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ id: "7" });
  });
});

describe("route handler: Zod validation", () => {
  test("returns 400 for invalid input", async () => {
    const def = makeDef({
      input: z.object({ greeting: z.string().min(3) }),
    });
    const route = generateApiRoute(def, stubServices)!;

    const request = makeRequest("http://localhost/api/g2/test", {
      method: "POST",
      body: { greeting: "hi" },
    });
    const response = await route.handler(request, {}, null!);

    expect(response.status).toBe(400);
    const data = await response.json();
    expect((data as Record<string, string>).error).toBeDefined();
  });

  test("returns 400 when required fields are missing", async () => {
    const def = makeDef({
      input: z.object({ greeting: z.string() }),
    });
    const route = generateApiRoute(def, stubServices)!;

    const request = makeRequest("http://localhost/api/g2/test", {
      method: "POST",
      body: {},
    });
    const response = await route.handler(request, {}, null!);

    expect(response.status).toBe(400);
  });

  test("accepts valid input and returns 200", async () => {
    const def = makeDef({
      input: z.object({ greeting: z.string().min(3) }),
    });
    const route = generateApiRoute(def, stubServices)!;

    const request = makeRequest("http://localhost/api/g2/test", {
      method: "POST",
      body: { greeting: "hello" },
    });
    const response = await route.handler(request, {}, null!);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ echo: "hello" });
  });
});

describe("route handler: error handling", () => {
  test("returns 500 when handler throws", async () => {
    const def = makeDef({
      handler: async () => {
        throw new Error("database exploded");
      },
    });
    const route = generateApiRoute(def, stubServices)!;

    const request = makeRequest("http://localhost/api/g2/test", {
      method: "POST",
      body: { greeting: "boom" },
    });
    const response = await route.handler(request, {}, null!);

    expect(response.status).toBe(500);
    const data = await response.json();
    expect((data as Record<string, string>).error).toBe("database exploded");
  });

  test("returns 500 with fallback message when error has no message", async () => {
    const def = makeDef({
      handler: async () => {
        throw {};
      },
    });
    const route = generateApiRoute(def, stubServices)!;

    const request = makeRequest("http://localhost/api/g2/test", {
      method: "POST",
      body: { greeting: "boom" },
    });
    const response = await route.handler(request, {}, null!);

    expect(response.status).toBe(500);
    const data = await response.json();
    expect((data as Record<string, string>).error).toBe("Internal error");
  });
});

describe("route handler: response transform, custom status, and string wrapping", () => {
  test("applies responseTransform when present", async () => {
    const def = makeDef({
      http: {
        method: "POST",
        path: "/api/g2/test",
        responseTransform: (result: unknown) => ({ wrapped: result }),
      },
    });
    const route = generateApiRoute(def, stubServices)!;

    const request = makeRequest("http://localhost/api/g2/test", {
      method: "POST",
      body: { greeting: "hi" },
    });
    const response = await route.handler(request, {}, null!);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ wrapped: { echo: "hi" } });
  });

  test("uses custom successStatus", async () => {
    const def = makeDef({
      http: {
        method: "POST",
        path: "/api/g2/test",
        successStatus: 201,
      },
    });
    const route = generateApiRoute(def, stubServices)!;

    const request = makeRequest("http://localhost/api/g2/test", {
      method: "POST",
      body: { greeting: "hi" },
    });
    const response = await route.handler(request, {}, null!);

    expect(response.status).toBe(201);
  });

  test("auto-wraps string handler results in { text: string }", async () => {
    const def = makeDef({
      name: "string_fn",
      input: z.object({}),
      handler: async () => "hello world",
      http: undefined,
    });
    const route = generateApiRoute(def, stubServices)!;

    const request = makeRequest("http://localhost/api/g2/string/fn", { method: "GET" });
    const response = await route.handler(request, {}, null!);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ text: "hello world" });
  });

  test("passes through object handler results as-is", async () => {
    const def = makeDef({
      name: "object_fn",
      input: z.object({}),
      handler: async () => ({ count: 42 }),
      http: undefined,
    });
    const route = generateApiRoute(def, stubServices)!;

    const request = makeRequest("http://localhost/api/g2/object/fn", { method: "GET" });
    const response = await route.handler(request, {}, null!);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({ count: 42 });
  });
});

describe("generateApiRoutes", () => {
  test("converts multiple API-surface functions to routes", () => {
    const defs = [
      makeDef({ name: "fn_a" }),
      makeDef({ name: "fn_b", http: { method: "GET", path: "/api/g2/b" } }),
    ];
    const routes = generateApiRoutes(defs, stubServices);

    expect(routes).toHaveLength(2);
    expect(routes[0]!.method).toBe("POST");
    expect(routes[1]!.method).toBe("GET");
  });

  test("includes functions without http annotation via auto-derivation", () => {
    const defs = [
      makeDef({ name: "with_http" }),
      makeDef({ name: "without_http", http: undefined }),
    ];
    const routes = generateApiRoutes(defs, stubServices);

    expect(routes).toHaveLength(2);
  });

  test("excludes functions whose surfaces exclude api", () => {
    const defs = [
      makeDef({ name: "api_fn", surfaces: ["api"] }),
      makeDef({ name: "discord_only", surfaces: ["discord"] }),
    ];
    const routes = generateApiRoutes(defs, stubServices);

    expect(routes).toHaveLength(1);
  });

  test("excludes feature-gated functions when gate is inactive", () => {
    const defs = [
      makeDef({ name: "gated", featureGate: "calendar" }),
      makeDef({ name: "ungated" }),
    ];
    const featureChecker = (id: string) => id !== "calendar";
    const routes = generateApiRoutes(defs, stubServices, featureChecker);

    expect(routes).toHaveLength(1);
  });

  test("includes feature-gated functions when gate is active", () => {
    const defs = [
      makeDef({ name: "gated", featureGate: "calendar" }),
      makeDef({ name: "ungated" }),
    ];
    const featureChecker = (_id: string) => true;
    const routes = generateApiRoutes(defs, stubServices, featureChecker);

    expect(routes).toHaveLength(2);
  });

  test("includes all functions when no featureChecker is provided", () => {
    const defs = [
      makeDef({ name: "gated", featureGate: "calendar" }),
      makeDef({ name: "ungated" }),
    ];
    const routes = generateApiRoutes(defs, stubServices);

    expect(routes).toHaveLength(2);
  });

  test("returns empty array for empty input", () => {
    const routes = generateApiRoutes([], stubServices);

    expect(routes).toEqual([]);
  });
});
