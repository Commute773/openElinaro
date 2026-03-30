import { test, expect, describe } from "bun:test";
import { readWebhookPayload } from "./http-helpers";

// ---------------------------------------------------------------------------
// readWebhookPayload
// ---------------------------------------------------------------------------
describe("readWebhookPayload", () => {
  test("GET request extracts query params", async () => {
    const request = new Request("https://example.com/webhook?foo=bar&baz=42", {
      method: "GET",
    });
    const result = await readWebhookPayload(request);
    expect(result).toEqual({ foo: "bar", baz: "42" });
  });

  test("GET request with no params returns empty object", async () => {
    const request = new Request("https://example.com/webhook", {
      method: "GET",
    });
    const result = await readWebhookPayload(request);
    expect(result).toEqual({});
  });

  test("POST JSON body is parsed", async () => {
    const body = { message: "hello", count: 5 };
    const request = new Request("https://example.com/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await readWebhookPayload(request);
    expect(result).toEqual(body);
  });

  test("POST form-encoded body is parsed", async () => {
    const request = new Request("https://example.com/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "name=John&age=30",
    });
    const result = await readWebhookPayload(request);
    expect(result).toEqual({ name: "John", age: "30" });
  });

  test("POST with empty body returns empty object", async () => {
    const request = new Request("https://example.com/webhook", {
      method: "POST",
      body: "",
    });
    const result = await readWebhookPayload(request);
    expect(result).toEqual({});
  });

  test("POST with whitespace-only body returns empty object", async () => {
    const request = new Request("https://example.com/webhook", {
      method: "POST",
      body: "   \n  ",
    });
    const result = await readWebhookPayload(request);
    expect(result).toEqual({});
  });

  test("POST with JSON body but no content-type header parses as JSON", async () => {
    const body = { key: "value" };
    const request = new Request("https://example.com/webhook", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const result = await readWebhookPayload(request);
    expect(result).toEqual(body);
  });

  test("POST with non-JSON text body returns raw wrapper", async () => {
    const request = new Request("https://example.com/webhook", {
      method: "POST",
      body: "just some text",
    });
    const result = await readWebhookPayload(request);
    expect(result).toEqual({ raw: "just some text" });
  });

  test("POST with application/json charset=utf-8", async () => {
    const body = { hello: "world" };
    const request = new Request("https://example.com/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    const result = await readWebhookPayload(request);
    expect(result).toEqual(body);
  });
});
