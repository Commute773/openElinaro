import type { Server, ServerWebSocket } from "bun";
import { getRuntimeConfig } from "../../config/runtime-config";
import { telemetry } from "../../services/telemetry";
import {
  GeminiLivePhoneService,
  type GeminiLivePhoneSocketData,
} from "../../services/gemini-live-phone-service";
import { VonageService, getVonageWebhookPath } from "../../services/vonage-service";
import type { OpenElinaroApp } from "../../app/runtime";
import { handleG2ApiRequest } from "./g2-api";

function normalizePath(pathname: string) {
  return pathname.replace(/\/+$/, "") || "/";
}

export function createHttpRequestHandler(
  vonage = new VonageService(),
  geminiLivePhone?: GeminiLivePhoneService,
  app?: OpenElinaroApp,
) {
  return async (request: Request) => {
    const url = new URL(request.url, "http://localhost");
    const pathname = normalizePath(url.pathname);

    if (pathname === "/healthz") {
      return Response.json({ ok: true }, { status: 200 });
    }

    // G2 API routes
    if (app && pathname.startsWith("/api/g2")) {
      const g2Response = await handleG2ApiRequest(request, pathname, app);
      if (g2Response) return g2Response;
    }
    if (pathname === normalizePath(`${getVonageWebhookPath("voice.answer").replace(/\/answer$/, "")}/test-answer`)) {
      return Response.json([
        {
          action: "talk",
          text: "The quick brown fox jumps over the lazy dog. The test phrase is alpha bravo charlie delta echo.",
          language: "en-US",
          bargeIn: false,
        },
      ], { status: 200, headers: { "content-type": "application/json" } });
    }
    if (pathname === normalizePath(getVonageWebhookPath("voice.answer"))) {
      return vonage.handleVoiceAnswerWebhook(request);
    }
    if (pathname === normalizePath(getVonageWebhookPath("voice.event"))) {
      const livePhone = geminiLivePhone;
      const liveRequest = livePhone ? (request.clone() as Request) : null;
      const response = await vonage.handleVoiceEventWebhook(request);
      if (livePhone && liveRequest) {
        await livePhone.recordVoiceEventWebhook(liveRequest);
      }
      return response;
    }
    if (pathname === normalizePath(getVonageWebhookPath("voice.fallback"))) {
      return vonage.handleVoiceFallbackWebhook(request);
    }
    if (pathname === normalizePath(getVonageWebhookPath("messages.inbound"))) {
      return vonage.handleMessagesInboundWebhook(request);
    }
    if (pathname === normalizePath(getVonageWebhookPath("messages.status"))) {
      return vonage.handleMessagesStatusWebhook(request);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  };
}

function maybeUpgradeGeminiLiveCallSocket(
  request: Request,
  server: Server<GeminiLivePhoneSocketData>,
  vonage: VonageService,
  geminiLivePhone: GeminiLivePhoneService,
) {
  const pathname = normalizePath(new URL(request.url, "http://localhost").pathname);
  const sessionId = geminiLivePhone.resolveSessionIdFromPath(pathname);
  if (!sessionId) {
    return null;
  }
  if (!geminiLivePhone.getSession(sessionId)) {
    return Response.json({ error: "Unknown live-call session" }, { status: 404 });
  }
  const verification = vonage.verifySignedRequest(request);
  if (!verification.verified) {
    return Response.json({ error: "Unauthorized websocket request" }, { status: 401 });
  }
  const upgraded = server.upgrade(request, {
    data: {
      kind: "gemini-live-phone",
      sessionId,
    },
  });
  if (!upgraded) {
    return Response.json({ error: "WebSocket upgrade failed" }, { status: 500 });
  }
  return undefined;
}

export function startHttpServer(
  vonage = new VonageService(),
  geminiLivePhone = new GeminiLivePhoneService({ vonage }),
  app?: OpenElinaroApp,
) {
  const config = getRuntimeConfig();
  const port = config.core.http.port || 3000;
  const hostname = config.core.http.host || "0.0.0.0";
  const handler = createHttpRequestHandler(vonage, geminiLivePhone, app);

  const server = Bun.serve<GeminiLivePhoneSocketData>({
    port,
    hostname,
    fetch(request, server) {
      const upgradeResponse = maybeUpgradeGeminiLiveCallSocket(request, server, vonage, geminiLivePhone);
      if (upgradeResponse !== null) {
        return upgradeResponse;
      }
      return handler(request);
    },
    websocket: {
      open(ws) {
        if (ws.data.kind === "gemini-live-phone") {
          void geminiLivePhone.handleVonageSocketOpen(ws as ServerWebSocket<GeminiLivePhoneSocketData>);
        }
      },
      message(ws, message) {
        if (ws.data.kind === "gemini-live-phone") {
          geminiLivePhone.handleVonageSocketMessage(ws as ServerWebSocket<GeminiLivePhoneSocketData>, message);
        }
      },
      close(ws, code, reason) {
        if (ws.data.kind === "gemini-live-phone") {
          geminiLivePhone.handleVonageSocketClose(ws as ServerWebSocket<GeminiLivePhoneSocketData>, code, reason.toString());
        }
      },
    },
  });

  telemetry.event("http.server.started", {
    component: "http",
    hostname,
    port,
    webhookBasePath: config.communications.vonage.webhookBasePath || "/webhooks/vonage",
  });

  return server;
}
