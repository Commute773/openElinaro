import type { RouteDefinition } from "./router";
import { json } from "./helpers";

export const dataRoutes: RouteDefinition[] = [
  {
    method: "GET",
    pattern: "/api/openapi.json",
    handler: async (_request, _params, app) => {
      const fnRegistry = app.getFunctionRegistry?.();
      if (!fnRegistry) return json({ error: "Function registry not ready" }, 503);
      const spec = fnRegistry.generateOpenApiSpec(
        (featureId) => app.isFeatureActive?.(featureId) ?? true,
      );
      return json(spec);
    },
  },
];
