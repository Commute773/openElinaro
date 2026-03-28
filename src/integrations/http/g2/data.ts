import type { RouteDefinition } from "./router";
import { json } from "./helpers";

export const dataRoutes: RouteDefinition[] = [
  {
    method: "GET",
    pattern: "/api/g2/openapi.json",
    handler: async (_request, _params, app) => {
      const fnRegistry = app.getFunctionRegistry?.();
      if (!fnRegistry) return json({ error: "Function registry not ready" }, 503);
      const spec = fnRegistry.generateOpenApiSpec(
        (featureId) => app.isFeatureActive?.(featureId) ?? true,
      );
      return json(spec);
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
