import { timingSafeEqual } from "node:crypto";
import type { RuntimeConfig } from "../../config/runtime-config";
import { CORS_HEADERS } from "./cors";

/**
 * Returns null if authenticated, or a 401 Response if not.
 * Skips auth for /healthz and OPTIONS preflight.
 * If no API key is configured, all requests pass through (local dev mode).
 */
export function authenticateApiRequest(
  request: Request,
  pathname: string,
  config: RuntimeConfig,
): Response | null {
  if (pathname === "/healthz" || request.method === "OPTIONS") {
    return null;
  }

  const apiKey = config.core.http.apiKey;
  if (!apiKey) {
    return null;
  }

  const authHeader = request.headers.get("Authorization") ?? "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1] ?? "";

  if (!token || !constantTimeEquals(token, apiKey)) {
    return Response.json(
      { error: "Unauthorized" },
      {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          "WWW-Authenticate": "Bearer",
        },
      },
    );
  }

  return null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // Prevent length-based timing leak
    timingSafeEqual(bBuf, bBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
