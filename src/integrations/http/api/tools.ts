import type { RouteDefinition } from "./router";
import { json, error, getApiTelemetry } from "./helpers";
import { attemptOrAsync } from "../../../utils/result";

export const toolRoutes: RouteDefinition[] = [
  {
    method: "GET",
    pattern: "/api/tools",
    handler: async (_request, _params, app) => {
      try {
        const catalog = app.getToolCatalog();
        return json(
          catalog.map((card) => ({
            name: card.name,
            description: card.description,
            domains: card.domains,
            tags: card.tags,
            mutatesState: card.mutatesState,
            parameters: app.getToolJsonSchema(card.name),
          })),
        );
      } catch (err: any) {
        getApiTelemetry().recordError(err, { operation: "api.tools_list" });
        return error(err.message ?? "Failed to list tools", 500);
      }
    },
  },
  {
    method: "POST",
    pattern: "/api/tools/:name",
    handler: async (request, params, app) => {
      const toolName = params.name!;
      try {
        const body = await attemptOrAsync(() => request.json(), {}) as Record<string, unknown>;
        const result = await app.invokeRoutineTool(toolName, body, {
          conversationKey: `api-tool-${Date.now()}`,
        });
        return json({ tool: toolName, result });
      } catch (err: any) {
        getApiTelemetry().recordError(err, { operation: "api.tool_exec", toolName });
        const msg = err.message ?? "Tool execution failed";
        const status = msg.includes("Unknown tool") ? 404
          : msg.includes("not allowed") ? 403
          : 500;
        return error(msg, status);
      }
    },
  },
];
