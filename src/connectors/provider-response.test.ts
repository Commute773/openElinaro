import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { assertSuccessfulProviderResponse } from "./provider-response";

function buildResponse(overrides?: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.4",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("assertSuccessfulProviderResponse", () => {
  test("passes through successful responses", () => {
    const response = buildResponse();
    expect(assertSuccessfulProviderResponse(response)).toBe(response);
  });

  test("throws the provider error message for failed responses", () => {
    expect(() =>
      assertSuccessfulProviderResponse(buildResponse({
        stopReason: "error",
        errorMessage: "400 status code (no body)",
      }))
    ).toThrow("400 status code (no body)");
  });

  test("unwraps structured provider error details", () => {
    expect(() =>
      assertSuccessfulProviderResponse(buildResponse({
        stopReason: "error",
        errorMessage: "{\"detail\":\"Unsupported parameter: model_context_window\"}",
      }))
    ).toThrow("Unsupported parameter: model_context_window");
  });

  test("throws a generic message for aborted responses without details", () => {
    expect(() =>
      assertSuccessfulProviderResponse(buildResponse({
        stopReason: "aborted",
      }))
    ).toThrow("Model request was aborted.");
  });
});
