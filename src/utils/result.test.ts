import { test, expect, mock } from "bun:test";

const sharedMockTelemetry: Record<string, unknown> = {
  recordError: mock(() => {}),
  event: mock(() => {}),
  span: mock((_op: string, _attrs: unknown, fn?: () => unknown) => {
    const f = typeof _attrs === "function" ? _attrs : fn;
    return f ? f() : undefined;
  }),
  run: mock((_ctx: unknown, fn: () => unknown) => fn()),
  instrumentMethods: mock((target: unknown) => target),
};
sharedMockTelemetry.child = mock(() => sharedMockTelemetry);
mock.module("../services/infrastructure/telemetry", () => ({
  telemetry: sharedMockTelemetry,
  TelemetryService: class {},
}));

const { ok, fail, tryCatch, tryCatchAsync, attempt, attemptAsync, attemptOr, attemptOrAsync, fireAndForget, unwrap, unwrapOr, mapResult } = await import("./result");
const recordErrorMock = sharedMockTelemetry.recordError as ReturnType<typeof mock>;

test("ok() creates success result", () => {
  const result = ok(42);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value).toBe(42);
});

test("fail() creates error result and logs", () => {
  const before = recordErrorMock.mock.calls.length;
  const result = fail(new Error("boom"), { operation: "test" });
  expect(result.ok).toBe(false);
  expect(recordErrorMock.mock.calls.length).toBe(before + 1);
});

test("tryCatch() returns ok on success", () => {
  const result = tryCatch(() => 42, { operation: "test" });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value).toBe(42);
});

test("tryCatch() returns fail and logs on error", () => {
  const before = recordErrorMock.mock.calls.length;
  const result = tryCatch(() => JSON.parse("nope"), { operation: "test" });
  expect(result.ok).toBe(false);
  expect(recordErrorMock.mock.calls.length).toBe(before + 1);
});

test("tryCatchAsync() returns ok on success", async () => {
  const result = await tryCatchAsync(async () => 42, { operation: "test" });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value).toBe(42);
});

test("tryCatchAsync() returns fail and logs on error", async () => {
  const before = recordErrorMock.mock.calls.length;
  const result = await tryCatchAsync(async () => { throw new Error("async boom"); }, { operation: "test" });
  expect(result.ok).toBe(false);
  expect(recordErrorMock.mock.calls.length).toBe(before + 1);
});

test("attempt() returns ok on success", () => {
  const result = attempt(() => JSON.parse('{"a":1}'));
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value).toEqual({ a: 1 });
});

test("attempt() returns error on failure WITHOUT logging", () => {
  const before = recordErrorMock.mock.calls.length;
  const result = attempt(() => JSON.parse("nope"));
  expect(result.ok).toBe(false);
  expect(recordErrorMock.mock.calls.length).toBe(before); // no new calls
});

test("attemptAsync() returns ok on success", async () => {
  const result = await attemptAsync(async () => 42);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value).toBe(42);
});

test("attemptAsync() returns error on failure WITHOUT logging", async () => {
  const before = recordErrorMock.mock.calls.length;
  const result = await attemptAsync(async () => { throw new Error("nope"); });
  expect(result.ok).toBe(false);
  expect(recordErrorMock.mock.calls.length).toBe(before);
});

test("attemptOr() returns value on success", () => {
  expect(attemptOr(() => JSON.parse('{"a":1}'), null)).toEqual({ a: 1 });
});

test("attemptOr() returns fallback on failure", () => {
  expect(attemptOr(() => JSON.parse("nope"), "fallback")).toBe("fallback");
});

test("attemptOrAsync() returns value on success", async () => {
  expect(await attemptOrAsync(async () => 42, 0)).toBe(42);
});

test("attemptOrAsync() returns fallback on failure", async () => {
  expect(await attemptOrAsync(async () => { throw new Error("nope"); }, 0)).toBe(0);
});

test("unwrap() returns value on ok", () => {
  expect(unwrap(ok(42))).toBe(42);
});

test("unwrap() throws on fail", () => {
  const result = fail(new Error("boom"), { operation: "test" });
  expect(() => unwrap(result)).toThrow("boom");
});

test("unwrapOr() returns value on ok", () => {
  expect(unwrapOr(ok(42), 0)).toBe(42);
});

test("unwrapOr() returns fallback on fail", () => {
  const result = fail(new Error("boom"), { operation: "test" });
  expect(unwrapOr(result, 0)).toBe(0);
});

test("mapResult() maps success value", () => {
  const result = mapResult(ok(42), (v) => v * 2);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value).toBe(84);
});

test("mapResult() passes through error", () => {
  const error = fail(new Error("boom"), { operation: "test" });
  const result = mapResult(error, (v: number) => v * 2);
  expect(result.ok).toBe(false);
});
