import { describe, expect, test } from "bun:test";
import { authenticateApiRequest } from "./api-auth";
import type { RuntimeConfig } from "../../config/runtime-config";

function makeConfig(apiKey: string): RuntimeConfig {
  return { core: { http: { apiKey } } } as unknown as RuntimeConfig;
}

function makeRequest(opts?: { method?: string; token?: string }): Request {
  const headers: Record<string, string> = {};
  if (opts?.token) {
    headers["Authorization"] = `Bearer ${opts.token}`;
  }
  return new Request("http://localhost/api/g2/home", {
    method: opts?.method ?? "GET",
    headers,
  });
}

describe("authenticateApiRequest", () => {
  test("allows all requests when no API key is configured", () => {
    const result = authenticateApiRequest(makeRequest(), "/api/g2/home", makeConfig(""));
    expect(result).toBeNull();
  });

  test("allows /healthz without a token", () => {
    const result = authenticateApiRequest(makeRequest(), "/healthz", makeConfig("secret-key"));
    expect(result).toBeNull();
  });

  test("allows OPTIONS preflight without a token", () => {
    const result = authenticateApiRequest(
      makeRequest({ method: "OPTIONS" }),
      "/api/g2/home",
      makeConfig("secret-key"),
    );
    expect(result).toBeNull();
  });

  test("returns 401 when no token is provided and API key is set", async () => {
    const result = authenticateApiRequest(makeRequest(), "/api/g2/home", makeConfig("secret-key"));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
    expect(result!.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(await result!.json()).toEqual({ error: "Unauthorized" });
  });

  test("returns 401 when wrong token is provided", () => {
    const result = authenticateApiRequest(
      makeRequest({ token: "wrong-key" }),
      "/api/g2/home",
      makeConfig("secret-key"),
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  test("allows request with correct token", () => {
    const result = authenticateApiRequest(
      makeRequest({ token: "secret-key" }),
      "/api/g2/home",
      makeConfig("secret-key"),
    );
    expect(result).toBeNull();
  });

  test("includes CORS headers on 401 response", () => {
    const result = authenticateApiRequest(makeRequest(), "/api/g2/home", makeConfig("secret-key"));
    expect(result).not.toBeNull();
    expect(result!.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
