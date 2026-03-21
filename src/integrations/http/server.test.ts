import { describe, expect, test } from "bun:test";
import { createHttpRequestHandler } from "./server";
import type { VonageService } from "../../services/vonage-service";

describe("HTTP webhook server", () => {
  test("serves healthz and routes Vonage webhook paths", async () => {
    const service = {
      handleVoiceAnswerWebhook: async () => new Response("voice-answer", { status: 200 }),
      handleVoiceEventWebhook: async () => new Response("voice-event", { status: 200 }),
      handleVoiceFallbackWebhook: async () => new Response("voice-fallback", { status: 200 }),
      handleMessagesInboundWebhook: async () => new Response("messages-inbound", { status: 200 }),
      handleMessagesStatusWebhook: async () => new Response("messages-status", { status: 200 }),
    } as unknown as VonageService;
    const handler = createHttpRequestHandler(service);

    const healthz = await handler(new Request("http://localhost/healthz"));
    expect(healthz.status).toBe(200);
    expect(await healthz.json()).toEqual({ ok: true });

    const answer = await handler(new Request("http://localhost/webhooks/vonage/voice/answer"));
    expect(await answer.text()).toBe("voice-answer");

    const inbound = await handler(new Request("http://localhost/webhooks/vonage/messages/inbound"));
    expect(await inbound.text()).toBe("messages-inbound");

    const missing = await handler(new Request("http://localhost/not-found"));
    expect(missing.status).toBe(404);
  });
});
