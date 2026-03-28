/**
 * Generates HTTP route definitions from FunctionDefinitions.
 * The output is compatible with the existing G2 router's RouteDefinition interface.
 */
import type { FunctionDefinition, FunctionContext } from "./define-function";
import type { RouteDefinition } from "../integrations/http/g2/router";
import type { ToolBuildContext } from "../tools/groups/tool-group-types";
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
 * Build handler input by merging path params, query params, and/or request body.
 */
async function buildInput(
  def: FunctionDefinition,
  request: Request,
  pathParams: Record<string, string>,
): Promise<unknown> {
  const method = def.http!.method;

  if (method === "GET") {
    // Merge path params + query params
    const queryParams = parseQueryParams(request);
    return { ...queryParams, ...pathParams };
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

  return {
    method: def.http.method,
    pattern: def.http.path,
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
  featureChecker?: (featureId: string) => boolean,
): RouteDefinition[] {
  const routes: RouteDefinition[] = [];
  for (const def of definitions) {
    if (def.featureGate && featureChecker && !featureChecker(def.featureGate)) continue;
    const route = generateApiRoute(def, resolveServices);
    if (route) routes.push(route);
  }
  return routes;
}
