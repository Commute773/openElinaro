import { test, expect, describe } from "bun:test";
import { z } from "zod";
import { generateOpenApiSpec } from "./generate-openapi";
import type { FunctionDefinition } from "./define-function";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal scaffolding shared by most test definitions. */
function makeDef(
  overrides: Partial<FunctionDefinition> & { name: string },
): FunctionDefinition {
  return {
    description: `${overrides.name} description`,
    input: z.object({}),
    handler: async () => ({}),
    surfaces: ["api"],
    http: { method: "GET", path: `/api/${overrides.name}` },
    auth: { access: "anyone", behavior: "uniform" },
    domains: ["test"],
    agentScopes: ["chat"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Spec structure
// ---------------------------------------------------------------------------

describe("generateOpenApiSpec", () => {
  describe("spec structure", () => {
    test("generates valid OpenAPI 3.1.0 envelope with defaults", () => {
      const spec = generateOpenApiSpec([]);
      expect(spec.openapi).toBe("3.1.0");
      expect(spec.info).toEqual({ title: "OpenElinaro API", version: "2.0.0" });
      expect(spec.servers).toEqual([{ url: "http://localhost:3000" }]);
      expect(spec.security).toEqual([{ bearerAuth: [] }]);
      expect(spec.paths).toEqual({});
      expect((spec.components as any).securitySchemes).toEqual({
        bearerAuth: { type: "http", scheme: "bearer" },
      });
      expect((spec.components as any).schemas.Error).toEqual({
        type: "object",
        properties: { error: { type: "string" } },
        required: ["error"],
      });
    });

    test("empty definitions produce empty paths", () => {
      const spec = generateOpenApiSpec([]);
      expect(spec.paths).toEqual({});
    });

    test("respects custom options", () => {
      const spec = generateOpenApiSpec([], undefined, {
        title: "Custom",
        version: "9.0.0",
        serverUrl: "https://example.com",
      });
      expect(spec.info).toEqual({ title: "Custom", version: "9.0.0" });
      expect(spec.servers).toEqual([{ url: "https://example.com" }]);
    });

});

  // -------------------------------------------------------------------------
  // Path parameter conversion
  // -------------------------------------------------------------------------

  describe("path parameter conversion", () => {
    test("converts Express :param to OpenAPI {param}", () => {
      const def = makeDef({
        name: "getItem",
        http: { method: "GET", path: "/api/items/:id" },
      });
      const spec = generateOpenApiSpec([def]);
      const paths = spec.paths as Record<string, any>;
      expect(paths["/api/items/{id}"]).toBeDefined();
      expect(paths["/api/items/:id"]).toBeUndefined();
    });

    test("converts multiple path params", () => {
      const def = makeDef({
        name: "nested",
        http: { method: "GET", path: "/api/orgs/:orgId/members/:memberId" },
      });
      const spec = generateOpenApiSpec([def]);
      const paths = spec.paths as Record<string, any>;
      expect(paths["/api/orgs/{orgId}/members/{memberId}"]).toBeDefined();

      const params = paths["/api/orgs/{orgId}/members/{memberId}"].get.parameters;
      const pathParams = params.filter((p: any) => p.in === "path");
      expect(pathParams).toHaveLength(2);
      expect(pathParams[0].name).toBe("orgId");
      expect(pathParams[1].name).toBe("memberId");
      expect(pathParams.every((p: any) => p.required === true)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Zod-to-JSON-Schema conversion
  // -------------------------------------------------------------------------

  describe("schema generation from Zod types", () => {
    test("string", () => {
      const def = makeDef({
        name: "strTest",
        http: { method: "POST", path: "/api/str" },
        input: z.object({ name: z.string() }),
      });
      const spec = generateOpenApiSpec([def]);
      const body = (spec.paths as any)["/api/str"].post.requestBody;
      const schema = body.content["application/json"].schema;
      expect(schema.properties.name).toEqual({ type: "string" });
      expect(schema.required).toContain("name");
    });

    test("number", () => {
      const def = makeDef({
        name: "numTest",
        http: { method: "POST", path: "/api/num" },
        input: z.object({ amount: z.number() }),
      });
      const spec = generateOpenApiSpec([def]);
      const schema = (spec.paths as any)["/api/num"].post.requestBody.content["application/json"].schema;
      expect(schema.properties.amount).toEqual({ type: "number" });
    });

    test("boolean", () => {
      const def = makeDef({
        name: "boolTest",
        http: { method: "POST", path: "/api/bool" },
        input: z.object({ active: z.boolean() }),
      });
      const spec = generateOpenApiSpec([def]);
      const schema = (spec.paths as any)["/api/bool"].post.requestBody.content["application/json"].schema;
      expect(schema.properties.active).toEqual({ type: "boolean" });
    });

    test("object (nested)", () => {
      const def = makeDef({
        name: "objTest",
        http: { method: "POST", path: "/api/obj" },
        input: z.object({
          meta: z.object({ key: z.string() }),
        }),
      });
      const spec = generateOpenApiSpec([def]);
      const schema = (spec.paths as any)["/api/obj"].post.requestBody.content["application/json"].schema;
      expect(schema.properties.meta).toEqual({
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      });
    });

    test("array", () => {
      const def = makeDef({
        name: "arrTest",
        http: { method: "POST", path: "/api/arr" },
        input: z.object({ tags: z.array(z.string()) }),
      });
      const spec = generateOpenApiSpec([def]);
      const schema = (spec.paths as any)["/api/arr"].post.requestBody.content["application/json"].schema;
      expect(schema.properties.tags.type).toBe("array");
      expect(schema.properties.tags.items).toBeDefined();
    });

    test("enum produces string type", () => {
      const def = makeDef({
        name: "enumTest",
        http: { method: "POST", path: "/api/enum" },
        input: z.object({ status: z.enum(["active", "inactive"]) }),
      });
      const spec = generateOpenApiSpec([def]);
      const schema = (spec.paths as any)["/api/enum"].post.requestBody.content["application/json"].schema;
      expect(schema.properties.status.type).toBe("string");
    });

    test("optional fields are not in required", () => {
      const def = makeDef({
        name: "optTest",
        http: { method: "POST", path: "/api/opt" },
        input: z.object({ required: z.string(), optional: z.string().optional() }),
      });
      const spec = generateOpenApiSpec([def]);
      const schema = (spec.paths as any)["/api/opt"].post.requestBody.content["application/json"].schema;
      expect(schema.required).toEqual(["required"]);
      // Optional field is still present in properties
      expect(schema.properties.optional).toEqual({ type: "string" });
    });

    test("nullable wraps in oneOf with null", () => {
      const def = makeDef({
        name: "nullTest",
        http: { method: "POST", path: "/api/null" },
        input: z.object({ value: z.string().nullable() }),
      });
      const spec = generateOpenApiSpec([def]);
      const schema = (spec.paths as any)["/api/null"].post.requestBody.content["application/json"].schema;
      expect(schema.properties.value).toEqual({
        oneOf: [{ type: "string" }, { type: "null" }],
      });
    });
  });

  // -------------------------------------------------------------------------
  // Query parameters (GET)
  // -------------------------------------------------------------------------

  describe("query parameter handling for GET endpoints", () => {
    test("generates query params from queryParams schema", () => {
      const def = makeDef({
        name: "search",
        http: {
          method: "GET",
          path: "/api/search",
          queryParams: z.object({
            q: z.string(),
            limit: z.number().optional(),
          }),
        },
      });
      const spec = generateOpenApiSpec([def]);
      const op = (spec.paths as any)["/api/search"].get;
      const queryParams = op.parameters.filter((p: any) => p.in === "query");
      expect(queryParams).toHaveLength(2);

      const qParam = queryParams.find((p: any) => p.name === "q");
      expect(qParam.required).toBe(true);
      expect(qParam.schema).toEqual({ type: "string" });

      const limitParam = queryParams.find((p: any) => p.name === "limit");
      expect(limitParam.required).toBe(false);
      expect(limitParam.schema).toEqual({ type: "number" });
    });

    test("does not generate request body for GET endpoints", () => {
      const def = makeDef({
        name: "getOnly",
        http: { method: "GET", path: "/api/get" },
        input: z.object({ ignored: z.string() }),
      });
      const spec = generateOpenApiSpec([def]);
      const op = (spec.paths as any)["/api/get"].get;
      expect(op.requestBody).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Request body (POST)
  // -------------------------------------------------------------------------

  describe("request body generation for POST endpoints", () => {
    test("generates request body with application/json content type", () => {
      const def = makeDef({
        name: "create",
        http: { method: "POST", path: "/api/items" },
        input: z.object({ name: z.string(), count: z.number() }),
      });
      const spec = generateOpenApiSpec([def]);
      const body = (spec.paths as any)["/api/items"].post.requestBody;
      expect(body.required).toBe(true);
      expect(body.content["application/json"].schema).toEqual({
        type: "object",
        properties: {
          name: { type: "string" },
          count: { type: "number" },
        },
        required: ["name", "count"],
      });
    });

    test("generates request body for PUT, PATCH, DELETE", () => {
      for (const method of ["PUT", "PATCH", "DELETE"] as const) {
        const def = makeDef({
          name: `${method.toLowerCase()}Test`,
          http: { method, path: `/api/${method.toLowerCase()}` },
          input: z.object({ data: z.string() }),
        });
        const spec = generateOpenApiSpec([def]);
        const op = (spec.paths as any)[`/api/${method.toLowerCase()}`][method.toLowerCase()];
        expect(op.requestBody).toBeDefined();
        expect(op.requestBody.required).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Response schema
  // -------------------------------------------------------------------------

  describe("response schema generation", () => {
    test("uses output schema when defined", () => {
      const def = makeDef({
        name: "withOutput",
        http: { method: "GET", path: "/api/out" },
        output: z.object({ id: z.string(), value: z.number() }),
      });
      const spec = generateOpenApiSpec([def]);
      const responses = (spec.paths as any)["/api/out"].get.responses;
      expect(responses["200"].content["application/json"].schema).toEqual({
        type: "object",
        properties: {
          id: { type: "string" },
          value: { type: "number" },
        },
        required: ["id", "value"],
      });
    });

    test("falls back to generic object when output is not defined", () => {
      const def = makeDef({ name: "noOutput" });
      const spec = generateOpenApiSpec([def]);
      const responses = (spec.paths as any)["/api/noOutput"].get.responses;
      expect(responses["200"].content["application/json"].schema).toEqual({ type: "object" });
    });

    test("uses custom successStatus", () => {
      const def = makeDef({
        name: "created",
        http: { method: "POST", path: "/api/create", successStatus: 201 },
        input: z.object({ name: z.string() }),
      });
      const spec = generateOpenApiSpec([def]);
      const responses = (spec.paths as any)["/api/create"].post.responses;
      expect(responses["201"]).toBeDefined();
      expect(responses["200"]).toBeUndefined();
    });

    test("always includes 400 and 500 error responses", () => {
      const def = makeDef({ name: "errors" });
      const spec = generateOpenApiSpec([def]);
      const responses = (spec.paths as any)["/api/errors"].get.responses;
      expect(responses["400"].content["application/json"].schema).toEqual({
        $ref: "#/components/schemas/Error",
      });
      expect(responses["500"].content["application/json"].schema).toEqual({
        $ref: "#/components/schemas/Error",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Feature gating
  // -------------------------------------------------------------------------

  describe("feature gating", () => {
    test("excludes function when featureGate check returns false", () => {
      const def = makeDef({
        name: "gated",
        featureGate: "premium-feature",
      });
      const checker = (id: string) => id !== "premium-feature";
      const spec = generateOpenApiSpec([def], checker);
      expect((spec.paths as any)["/api/gated"]).toBeUndefined();
    });

    test("includes function when featureGate check returns true", () => {
      const def = makeDef({
        name: "gated",
        featureGate: "premium-feature",
      });
      const checker = (_id: string) => true;
      const spec = generateOpenApiSpec([def], checker);
      expect((spec.paths as any)["/api/gated"]).toBeDefined();
    });

    test("includes function when no featureChecker is provided", () => {
      const def = makeDef({
        name: "gated",
        featureGate: "premium-feature",
      });
      const spec = generateOpenApiSpec([def]);
      expect((spec.paths as any)["/api/gated"]).toBeDefined();
    });

    test("includes function when featureGate is not set", () => {
      const def = makeDef({ name: "ungated" });
      const checker = (_id: string) => false;
      const spec = generateOpenApiSpec([def], checker);
      expect((spec.paths as any)["/api/ungated"]).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Surface filtering
  // -------------------------------------------------------------------------

  describe("surface filtering", () => {
    test("skips functions without api surface", () => {
      const def = makeDef({
        name: "discordOnly",
        surfaces: ["discord"],
      });
      const spec = generateOpenApiSpec([def]);
      expect(spec.paths).toEqual({});
    });

    test("skips functions without http annotation", () => {
      const def = makeDef({ name: "noHttp" });
      delete (def as any).http;
      const spec = generateOpenApiSpec([def]);
      expect(spec.paths).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // Multiple functions
  // -------------------------------------------------------------------------

  describe("multiple functions", () => {
    test("produces multiple paths from multiple definitions", () => {
      const defs = [
        makeDef({ name: "listItems", http: { method: "GET", path: "/api/items" } }),
        makeDef({ name: "createItem", http: { method: "POST", path: "/api/items" }, input: z.object({ name: z.string() }) }),
        makeDef({ name: "getItem", http: { method: "GET", path: "/api/items/:id" } }),
      ];
      const spec = generateOpenApiSpec(defs);
      const paths = spec.paths as Record<string, any>;

      expect(Object.keys(paths)).toHaveLength(2); // /api/items and /api/items/{id}
      expect(paths["/api/items"].get).toBeDefined();
      expect(paths["/api/items"].post).toBeDefined();
      expect(paths["/api/items/{id}"].get).toBeDefined();
    });

    test("sets operationId, summary, and tags on each operation", () => {
      const def = makeDef({
        name: "myOp",
        description: "My operation",
        domains: ["finance", "core"],
      });
      const spec = generateOpenApiSpec([def]);
      const op = (spec.paths as any)["/api/myOp"].get;
      expect(op.operationId).toBe("myOp");
      expect(op.summary).toBe("My operation");
      expect(op.tags).toEqual(["finance", "core"]);
    });
  });
});
