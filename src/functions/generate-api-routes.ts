/**
 * Generates HTTP route definitions from FunctionDefinitions.
 * The output is compatible with the existing G2 router's RouteDefinition interface.
 */
import { z } from "zod";
import type { FunctionDefinition, FunctionContext } from "./define-function";
import { API_PATH_PREFIX } from "./define-function";
import type { RouteDefinition } from "../integrations/http/g2/router";
import type { ToolBuildContext } from "../tools/groups/tool-group-types";
import type { FeatureId } from "../services/feature-config-service";
import { CORS_HEADERS, json, error } from "../integrations/http/g2/helpers";
import { createTraceSpan } from "../utils/telemetry-helpers";
import { telemetry } from "../services/infrastructure/telemetry";

const apiTelemetry = telemetry.child({ component: "function_api" });
const traceSpan = createTraceSpan(apiTelemetry);

/**
 * Extract path parameter names from an Express-style route pattern.
 * e.g. "/api/g2/routines/:id/done" -> ["id"]
 */
function extractPathParamNames(pattern: string): string[] {
  const names: string[] = [];
  const re = /:([^/]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pattern)) !== null) {
    names.push(match[1]!);
  }
  return names;
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
    const inner = fieldSchema instanceof z.ZodOptional || fieldSchema instanceof z.ZodDefault
      ? (fieldSchema as any)._def.innerType as z.ZodType | undefined
      : fieldSchema;
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
): Promise<unknown> {
  const method = def.http!.method;

  if (method === "GET") {
    // Merge path params + query params, coercing types
    const queryParams = parseQueryParams(request);
    const coerced = coerceQueryParams(queryParams, def.input);
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
 * Convert a single FunctionDefinition into a RouteDefinition.
 * Returns null if the function has no HTTP annotation or excludes the API surface.
 */
export function generateApiRoute(
  def: FunctionDefinition,
  resolveServices: () => ToolBuildContext,
): RouteDefinition | null {
  const surfaces = def.surfaces ?? ["api", "discord", "agent"];
  if (!surfaces.includes("api")) return null;
  if (!def.http) return null;

  const fullPath = def.http.path.startsWith("/api/")
    ? def.http.path                            // already absolute (legacy)
    : `${API_PATH_PREFIX}${def.http.path}`;    // relative → prepend prefix

  return {
    method: def.http.method,
    pattern: fullPath,
    handler: async (request, params, _app) => {
      return traceSpan(`api.${def.name}`, async () => {
        // 1. Build input from request
        const rawInput = await buildInput(def, request, params);

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

          // 5. Apply response transform if present
          const responseData = def.http!.responseTransform
            ? def.http!.responseTransform(result)
            : result;

          return json(responseData, def.http!.successStatus ?? 200);
        } catch (err: any) {
          return error(err.message ?? "Internal error", 500);
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
