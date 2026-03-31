import type { AgentStreamEvent } from "../../../domain/assistant";
import type { RouteDefinition } from "./router";
import { json, error, getApiTelemetry, CORS_HEADERS } from "./helpers";
import { attempt } from "../../../utils/result";

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  ...CORS_HEADERS,
};

function sseEvent(event: AgentStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

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
        getApiTelemetry().recordError(err, { operation: "api.ask" });
        return error(err.message ?? "Failed to process query", 500);
      }
    },
  },
  {
    method: "POST",
    pattern: "/api/chat/stream",
    handler: async (request, _params, app) => {
      try {
        const body = (await request.json()) as { text?: string };
        if (!body.text) return error("text is required");

        const text = body.text;
        let streamClosed = false;

        const stream = new ReadableStream<string>({
          start(controller) {
            const enqueue = (event: AgentStreamEvent) => {
              if (streamClosed) return;
              const result = attempt(() => controller.enqueue(sseEvent(event)));
              if (!result.ok) streamClosed = true;
            };

            app.handleRequest(
              {
                id: `api-chat-${Date.now()}`,
                text,
                conversationKey: "api-agent-chat",
              },
              {
                onToolUse: async (event) => {
                  enqueue(event);
                },
              },
            ).then((response) => {
              if (!streamClosed) {
                enqueue({ type: "text", text: response.message });
                controller.close();
              }
            }).catch((err) => {
              if (!streamClosed) {
                enqueue({ type: "error", message: err.message ?? "Request failed" });
                attempt(() => controller.close());
              }
              getApiTelemetry().recordError(err, { operation: "api.chat.stream" });
            });
          },
          cancel() {
            streamClosed = true;
          },
        });

        request.signal?.addEventListener("abort", () => { streamClosed = true; });

        return new Response(stream, { headers: SSE_HEADERS });
      } catch (err: any) {
        getApiTelemetry().recordError(err, { operation: "api.chat.stream" });
        return error(err.message ?? "Failed to start stream", 500);
      }
    },
  },
];
