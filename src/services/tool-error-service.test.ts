import { describe, expect, test } from "bun:test";
import { buildToolErrorEnvelope, stringifyToolErrorEnvelope } from "./tool-error-service";

describe("buildToolErrorEnvelope", () => {
  test("classifies tool_unavailable from 'not available in the current visible bundle'", () => {
    const envelope = buildToolErrorEnvelope("my_tool", new Error("Tool is not available in the current visible bundle"));
    expect(envelope.ok).toBe(false);
    expect(envelope.tool).toBe("my_tool");
    expect(envelope.error.type).toBe("tool_unavailable");
    expect(envelope.error.retryable).toBe(false);
  });

  test("classifies tool_unavailable from 'unknown tool:'", () => {
    const envelope = buildToolErrorEnvelope("x", new Error("Unknown tool: x"));
    expect(envelope.error.type).toBe("tool_unavailable");
  });

  test("classifies tool_unavailable from 'not allowed in this program run'", () => {
    const envelope = buildToolErrorEnvelope("x", new Error("x is not allowed in this program run"));
    expect(envelope.error.type).toBe("tool_unavailable");
  });

  test("classifies configuration_error from 'not configured'", () => {
    const envelope = buildToolErrorEnvelope("web_search", new Error("Web search is not configured"));
    expect(envelope.error.type).toBe("configuration_error");
    expect(envelope.error.retryable).toBe(false);
  });

  test("classifies configuration_error from 'set brave_api_key'", () => {
    const envelope = buildToolErrorEnvelope("web_search", new Error("Please set BRAVE_API_KEY first"));
    expect(envelope.error.type).toBe("configuration_error");
  });

  test("classifies validation_error from 'requires'", () => {
    const envelope = buildToolErrorEnvelope("t", new Error("Parameter requires a value"));
    expect(envelope.error.type).toBe("validation_error");
    expect(envelope.error.retryable).toBe(false);
  });

  test("classifies validation_error from 'must be'", () => {
    const envelope = buildToolErrorEnvelope("t", new Error("Value must be a string"));
    expect(envelope.error.type).toBe("validation_error");
  });

  test("classifies validation_error from 'is required'", () => {
    const envelope = buildToolErrorEnvelope("t", new Error("Field is required"));
    expect(envelope.error.type).toBe("validation_error");
  });

  test("classifies validation_error from 'non-empty'", () => {
    const envelope = buildToolErrorEnvelope("t", new Error("Must be non-empty"));
    expect(envelope.error.type).toBe("validation_error");
  });

  test("classifies validation_error from 'expected'", () => {
    const envelope = buildToolErrorEnvelope("t", new Error("Expected number, got string"));
    expect(envelope.error.type).toBe("validation_error");
  });

  test("classifies validation_error from 'invalid'", () => {
    const envelope = buildToolErrorEnvelope("t", new Error("Invalid parameter"));
    expect(envelope.error.type).toBe("validation_error");
  });

  test("classifies validation_error from 'failed validation'", () => {
    const envelope = buildToolErrorEnvelope("t", new Error("Input failed validation"));
    expect(envelope.error.type).toBe("validation_error");
  });

  test("classifies not_found", () => {
    const envelope = buildToolErrorEnvelope("t", new Error("Resource not found"));
    expect(envelope.error.type).toBe("not_found");
    expect(envelope.error.retryable).toBe(false);
  });

  test("classifies permission_error from 'permission denied'", () => {
    const envelope = buildToolErrorEnvelope("t", new Error("Permission denied"));
    expect(envelope.error.type).toBe("permission_error");
    expect(envelope.error.retryable).toBe(false);
  });

  test("classifies permission_error from 'eacces'", () => {
    const envelope = buildToolErrorEnvelope("t", new Error("EACCES: access denied"));
    expect(envelope.error.type).toBe("permission_error");
  });

  test("classifies permission_error from 'operation not permitted'", () => {
    const envelope = buildToolErrorEnvelope("t", new Error("Operation not permitted"));
    expect(envelope.error.type).toBe("permission_error");
  });

  test("classifies timeout_error and marks retryable", () => {
    const envelope = buildToolErrorEnvelope("t", new Error("Request timed out"));
    expect(envelope.error.type).toBe("timeout_error");
    expect(envelope.error.retryable).toBe(true);
  });

  test("classifies timeout_error from 'timeout'", () => {
    const envelope = buildToolErrorEnvelope("t", new Error("Connection timeout"));
    expect(envelope.error.type).toBe("timeout_error");
    expect(envelope.error.retryable).toBe(true);
  });

  test("classifies upstream_error and marks retryable", () => {
    const envelope = buildToolErrorEnvelope("t", new Error("API error from provider"));
    expect(envelope.error.type).toBe("upstream_error");
    expect(envelope.error.retryable).toBe(true);
  });

  test("classifies upstream_error from 'rejected ui_lang'", () => {
    const envelope = buildToolErrorEnvelope("t", new Error("Server rejected ui_lang parameter"));
    expect(envelope.error.type).toBe("upstream_error");
  });

  test("classifies upstream_error from 'upstream'", () => {
    const envelope = buildToolErrorEnvelope("t", new Error("Upstream service failed"));
    expect(envelope.error.type).toBe("upstream_error");
  });

  test("falls back to tool_error for unrecognized messages", () => {
    const envelope = buildToolErrorEnvelope("t", new Error("Something went wrong"));
    expect(envelope.error.type).toBe("tool_error");
    expect(envelope.error.retryable).toBe(false);
  });

  test("normalizes Error with empty message to Error.name", () => {
    const err = new Error("");
    const envelope = buildToolErrorEnvelope("t", err);
    expect(envelope.debug.raw).toBe("Error");
  });

  test("handles non-Error values", () => {
    const envelope = buildToolErrorEnvelope("t", "plain string error");
    expect(envelope.debug.raw).toBe("plain string error");
    expect(envelope.ok).toBe(false);
  });

  test("handles null error by stringifying it", () => {
    const envelope = buildToolErrorEnvelope("my_tool", null);
    expect(envelope.debug.raw).toBe("null");
    expect(envelope.ok).toBe(false);
  });

  test("handles undefined error by stringifying it", () => {
    const envelope = buildToolErrorEnvelope("my_tool", undefined);
    expect(envelope.debug.raw).toBe("undefined");
  });

  test("uses fallback message when error stringifies to empty", () => {
    const envelope = buildToolErrorEnvelope("my_tool", "");
    expect(envelope.debug.raw).toBe("Tool my_tool failed.");
  });

  test("extracts details from error object", () => {
    const err = Object.assign(new Error("failed"), { details: { code: 42 } });
    const envelope = buildToolErrorEnvelope("t", err);
    expect(envelope.details).toEqual({ code: 42 });
  });

  test("details is undefined when error has no details property", () => {
    const envelope = buildToolErrorEnvelope("t", new Error("plain"));
    expect(envelope.details).toBeUndefined();
  });

  test("details is undefined when error is not an object", () => {
    const envelope = buildToolErrorEnvelope("t", "string error");
    expect(envelope.details).toBeUndefined();
  });

  test("produces correct summary messages for each error type", () => {
    expect(buildToolErrorEnvelope("foo", new Error("not found")).message).toBe(
      "Requested resource was not found while running `foo`.",
    );
    expect(buildToolErrorEnvelope("foo", new Error("timed out")).message).toBe("`foo` timed out.");
    expect(buildToolErrorEnvelope("foo", new Error("Permission denied")).message).toBe(
      "Permission was denied while running `foo`.",
    );
    expect(buildToolErrorEnvelope("foo", new Error("not configured")).message).toBe(
      "`foo` is not configured correctly.",
    );
    expect(buildToolErrorEnvelope("foo", new Error("Unknown tool: foo")).message).toBe(
      "`foo` is not available in the current tool bundle.",
    );
    expect(buildToolErrorEnvelope("foo", new Error("API error")).message).toBe(
      "Upstream provider error while running `foo`.",
    );
    expect(buildToolErrorEnvelope("foo", new Error("is required")).message).toBe(
      "Validation failed while running `foo`.",
    );
    expect(buildToolErrorEnvelope("foo", new Error("something")).message).toBe("`foo` failed. something");
  });
});

describe("stringifyToolErrorEnvelope", () => {
  test("returns valid JSON string", () => {
    const json = stringifyToolErrorEnvelope("t", new Error("oops"));
    const parsed = JSON.parse(json);
    expect(parsed.ok).toBe(false);
    expect(parsed.tool).toBe("t");
    expect(parsed.debug.raw).toBe("oops");
  });
});
