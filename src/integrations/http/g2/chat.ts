import type { RouteDefinition } from "./router";
import { json, error, g2Telemetry } from "./helpers";

export const chatRoutes: RouteDefinition[] = [
  {
    method: "POST",
    pattern: "/api/g2/ask",
    handler: async (request, _params, app) => {
      try {
        const body = (await request.json()) as { text?: string };
        if (!body.text) return error("text is required");

        const response = await app.handleRequest({
          id: `g2-ask-${Date.now()}`,
          kind: "chat",
          text: body.text,
          conversationKey: "g2-simulator",
        });

        return json({ response: response.message });
      } catch (err: any) {
        g2Telemetry.recordError(err, { operation: "g2_api.ask" });
        return error(err.message ?? "Failed to process query", 500);
      }
    },
  },
];
