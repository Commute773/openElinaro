/**
 * Generates HTTP route definitions from FunctionDefinitions.
 * The output is compatible with the existing G2 router's RouteDefinition interface.
 *
 * Functions with explicit `http` annotations use those settings.
 * Functions without `http` get an auto-derived route:
 *   - Method: POST if mutatesState, GET otherwise
 *   - Path: function name with underscores converted to slashes
 *
 * String handler results are auto-wrapped in { text: string } for JSON responses.
 */
import { z } from "zod";
import type { FunctionDefinition, FunctionContext, HttpMethod } from "./define-function";
import { API_PATH_PREFIX, deriveHttpAnnotation } from "./define-function";
import type { RouteDefinition } from "../integrations/http/g2/router";
import type { ToolBuildContext } from "../tools/groups/tool-group-types";
import type { FeatureId } from "../services/feature-config-service";
import { json, error } from "../integrations/http/g2/helpers";
import { createTraceSpan } from "../utils/telemetry-helpers";
import { telemetry } from "../services/infrastructure/telemetry";

const apiTelemetry = telemetry.child({ component: "function_api" });
const traceSpan = createTraceSpan(apiTelemetry);

/**
 * Resolved HTTP configuration for a route, combining explicit annotation
 * with auto-derived defaults.
 */
interface ResolvedHttp {
  method: HttpMethod;
  path: string;
  queryParams?: z.ZodObject<Record<string, z.ZodType>>;
  successStatus?: number;
  responseTransform?: (result: unknown) => unknown;
}

/**
 * Parse query parameters from a Request URL.
 */
function parseQueryParams(request: Request): Record<string, string> {
  const url = new URL(request.url);
  const params: Record<string, string> = {};
  url.searchParams.forEach((value: string, key: string) => {
    params[key] = value;
  });
  return params;
}

/**
 * Unwrap one layer of ZodOptional or ZodDefault to find the inner type.
 */
function unwrapOptional(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return (schema as z.ZodOptional<z.ZodType> | z.ZodDefault<z.ZodType>).unwrap();
  }
  return schema;
}

/**
 * Coerce string query param values to match expected Zod schema types.
 * Query params are always strings, but schemas may expect boolean/number.
 */
function coerceQueryParams(
  params: Record<string, string>,
  schema: z.ZodType,
): Record<string, unknown> {
  if (!(schema instanceof z.ZodObject)) return params;
  const shape = (schema as z.ZodObject<Record<string, z.ZodType>>).shape as Record<string, z.ZodType>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    const fieldSchema = shape[key];
    const inner = fieldSchema ? unwrapOptional(fieldSchema) : undefined;
    if (inner instanceof z.ZodBoolean) {
      result[key] = value === "true" || value === "1";
    } else if (inner instanceof z.ZodNumber) {
      result[key] = Number(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Build handler input by merging path params, query params, and/or request body.
 */
async function buildInput(
  def: FunctionDefinition,
  request: Request,
  pathParams: Record<string, string>,
  http: ResolvedHttp,
): Promise<unknown> {
  if (http.method === "GET") {
    // Merge path params + query params, coercing types against the input schema
    const queryParams = parseQueryParams(request);
    const coerced = coerceQueryParams(queryParams, http.queryParams ?? def.input);
    return { ...coerced, ...pathParams };
  }

  // POST/PUT/PATCH/DELETE: merge path params + request body
  let body: Record<string, unknown> = {};
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      body = (await request.json()) as Record<string, unknown>;
    }
  } catch {
    // Empty body is fine for some endpoints
  }

  return { ...body, ...pathParams };
}

/**
 * Resolve a function's HTTP configuration, falling back to auto-derivation.
 */
function resolveHttp(def: FunctionDefinition): ResolvedHttp {
  if (def.http) return def.http;
  return deriveHttpAnnotation(def);
}

/**
 * Convert a single FunctionDefinition into a RouteDefinition.
 * Returns null only if the function excludes the API surface.
 *
 * Functions without an explicit `http` annotation get an auto-derived route
 * based on their name and mutatesState flag.
 */
export function generateApiRoute(
  def: FunctionDefinition,
  resolveServices: () => ToolBuildContext,
): RouteDefinition | null {
  const surfaces = def.surfaces ?? ["api", "discord", "agent"];
  if (!surfaces.includes("api")) return null;

  const http = resolveHttp(def);

  const fullPath = http.path.startsWith("/api/")
    ? http.path                            // already absolute (legacy)
    : `${API_PATH_PREFIX}${http.path}`;    // relative → prepend prefix

  return {
    method: http.method,
    pattern: fullPath,
    handler: async (request, params, _app) => {
      return traceSpan(`api.${def.name}`, async () => {
        // 1. Build input from request
        const rawInput = await buildInput(def, request, params, http);

        // 2. Validate with Zod
        const parsed = def.input.safeParse(rawInput);
        if (!parsed.success) {
          const messages = parsed.error.issues.map((i: { message: string }) => i.message).join("; ");
          return error(messages, 400);
        }

        // 3. Build context
        const ctx: FunctionContext = {
          services: resolveServices(),
          conversationKey: `api-${Date.now()}`,
        };

        // 4. Execute handler
        try {
          const result = await def.handler(parsed.data, ctx);

          // 5. Apply response transform if present, then auto-wrap strings
          let responseData: unknown;
          if (http.responseTransform) {
            responseData = http.responseTransform(result);
          } else if (typeof result === "string") {
            responseData = { text: result };
          } else {
            responseData = result;
          }

          return json(responseData, http.successStatus ?? 200);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Internal error";
          return error(message, 500);
        }
      });
    },
  };
}

/**
 * Convert all API-surface FunctionDefinitions into RouteDefinition[].
 * Feature-gated functions are excluded when the gate is inactive.
 */
export function generateApiRoutes(
  definitions: FunctionDefinition[],
  resolveServices: () => ToolBuildContext,
  featureChecker?: (featureId: FeatureId) => boolean,
): RouteDefinition[] {
  const routes: RouteDefinition[] = [];
  for (const def of definitions) {
    if (def.featureGate && featureChecker && !featureChecker(def.featureGate)) continue;
    const route = generateApiRoute(def, resolveServices);
    if (route) routes.push(route);
  }
  return routes;
}
