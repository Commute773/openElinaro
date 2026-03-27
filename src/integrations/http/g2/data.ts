import type { RouteDefinition } from "./router";
import { json } from "./helpers";
import { getOpenApiSpec } from "../openapi";

export const dataRoutes: RouteDefinition[] = [
  {
    method: "GET",
    pattern: "/api/g2/openapi.json",
    handler: async (_request, _params, app) => {
      // Merge the static OpenAPI spec (app-level routes) with generated spec
      // from the function layer (service-level routes)
      const staticSpec = getOpenApiSpec() as Record<string, any>;
      const fnRegistry = app.getFunctionRegistry?.();
      if (fnRegistry) {
        const generatedSpec = fnRegistry.generateOpenApiSpec(
          (featureId) => app.isFeatureActive?.(featureId) ?? true,
        ) as Record<string, any>;
        // Merge generated paths into static spec
        if (generatedSpec.paths) {
          staticSpec.paths = { ...staticSpec.paths, ...generatedSpec.paths };
        }
      }
      return json(staticSpec);
    },
  },
  {
    method: "GET",
    pattern: "/api/g2/health",
    handler: async (request, _params, app) => {
      const url = new URL(request.url, "http://localhost");
      const limit = parseInt(url.searchParams.get("limit") ?? "10", 10);
      const summary = app.getHealthSummary();
      const checkins = app.listHealthCheckins(limit);
      return json({ summary, checkins });
    },
  },
  {
    method: "GET",
    pattern: "/api/g2/projects",
    handler: async (_request, _params, app) => {
      const projects = app.listProjectSummaries();
      return json(projects);
    },
  },
  {
    method: "GET",
    pattern: "/api/g2/conversations",
    handler: async (_request, _params, app) => {
      const conversations = await app.listConversationSummaries();
      return json(conversations);
    },
  },
];
