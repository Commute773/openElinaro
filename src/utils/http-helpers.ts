import { attemptOr } from "./result";

/**
 * Parse the payload from an incoming webhook request.
 *
 * Handles GET query-string params, JSON bodies, URL-encoded form bodies,
 * and falls back to raw text.
 */
export async function readWebhookPayload(
  request: Request,
): Promise<Record<string, unknown>> {
  const method = request.method.toUpperCase();
  if (method === "GET") {
    return Object.fromEntries(new URL(request.url).searchParams.entries());
  }
  const contentType =
    request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    return (await request.json()) as Record<string, unknown>;
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    return Object.fromEntries(new URLSearchParams(text).entries());
  }
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }
  return attemptOr(() => JSON.parse(text) as Record<string, unknown>, { raw: text });
}
