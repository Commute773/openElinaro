import type { RouteDefinition } from "./router";
import { json, error, g2Telemetry } from "./helpers";

export const toolRoutes: RouteDefinition[] = [
  {
    method: "GET",
    pattern: "/api/g2/tools",
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
        g2Telemetry.recordError(err, { operation: "g2_api.tools_list" });
        return error(err.message ?? "Failed to list tools", 500);
      }
    },
  },
  {
    method: "POST",
    pattern: "/api/g2/tools/:name",
    handler: async (request, params, app) => {
      const toolName = params.name!;
      try {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const result = await app.invokeRoutineTool(toolName, body, {
          conversationKey: `g2-tool-${Date.now()}`,
        });
        return json({ tool: toolName, result });
      } catch (err: any) {
        g2Telemetry.recordError(err, { operation: "g2_api.tool_exec", toolName });
        const msg = err.message ?? "Tool execution failed";
        const status = msg.includes("Unknown tool") ? 404
          : msg.includes("not allowed") ? 403
          : 500;
        return error(msg, status);
      }
    },
  },
];
