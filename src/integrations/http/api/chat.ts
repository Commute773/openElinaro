import type { RouteDefinition } from "./router";
import { json, error, apiTelemetry } from "./helpers";

export const chatRoutes: RouteDefinition[] = [
  {
    method: "POST",
    pattern: "/api/ask",
    handler: async (request, _params, app) => {
      try {
        const body = (await request.json()) as { text?: string };
        if (!body.text) return error("text is required");

        const response = await app.handleRequest({
          id: `api-ask-${Date.now()}`,
          text: body.text,
          conversationKey: "api-simulator",
        });

        return json({ response: response.message });
      } catch (err: any) {
        apiTelemetry.recordError(err, { operation: "api.ask" });
        return error(err.message ?? "Failed to process query", 500);
      }
    },
  },
];
