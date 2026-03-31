// Breaks the circular dependency: result → telemetry → TelemetryStore → result.
// By the time any function here is *called*, all modules have finished loading,
// so the deferred require() always succeeds.
function getTelemetry(): { event: Function; recordError: Function } {
  return require("../services/infrastructure/telemetry").telemetry;
}

/**
 * Discriminated union for fallible operations.
 * Forces callers to check .ok before accessing .value.
 */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Error };

/** Construct a success result. */
export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function wrapError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function logExpectedFailure(error: Error) {
  getTelemetry().event("result.expected_failure", {
    error: { name: error.name, message: error.message },
  }, { level: "debug", outcome: "error" });
}

/**
 * Construct an explicit failure. Always logs at error level.
 */
export function fail(error: unknown, context: Record<string, unknown>): Result<never> {
  getTelemetry().recordError(error, context);
  return { ok: false, error: wrapError(error) };
}

/**
 * Catch UNEXPECTED errors. Logs at error level, returns Result.
 */
export function tryCatch<T>(fn: () => T, context: Record<string, unknown>): Result<T> {
  try {
    return ok(fn());
  } catch (error) {
    return fail(error, context);
  }
}

/**
 * Async tryCatch. Logs at error level, returns Result.
 */
export async function tryCatchAsync<T>(
  fn: () => Promise<T>,
  context: Record<string, unknown>,
): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    return fail(error, context);
  }
}

/**
 * Catch EXPECTED failures. Logs at debug level, returns Result.
 * The type system forces the caller to handle both paths.
 */
export function attempt<T>(fn: () => T): Result<T> {
  try {
    return ok(fn());
  } catch (error) {
    const wrapped = wrapError(error);
    logExpectedFailure(wrapped);
    return { ok: false, error: wrapped };
  }
}

/**
 * Async attempt. Logs at debug level, returns Result.
 */
export async function attemptAsync<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    const wrapped = wrapError(error);
    logExpectedFailure(wrapped);
    return { ok: false, error: wrapped };
  }
}

/**
 * Catch expected failure with an inline fallback.
 * Logs at debug level. The secondary path is explicit in the call.
 */
export function attemptOr<T, F>(fn: () => T, fallback: F): T | F {
  try {
    return fn();
  } catch (error) {
    logExpectedFailure(wrapError(error));
    return fallback;
  }
}

/**
 * Async attemptOr. Logs at debug level.
 */
export async function attemptOrAsync<T, F>(fn: () => Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await fn();
  } catch (error) {
    logExpectedFailure(wrapError(error));
    return fallback;
  }
}

/**
 * Fire-and-forget with guaranteed error-level logging.
 */
export function fireAndForget(
  fn: () => Promise<unknown>,
  context: Record<string, unknown>,
): void {
  void fn().catch((error) => {
    getTelemetry().recordError(error, context);
  });
}

/** Extract the value or throw the error. */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw result.error;
}

/** Extract the value or return a fallback. */
export function unwrapOr<T, F>(result: Result<T>, fallback: F): T | F {
  return result.ok ? result.value : fallback;
}

/** Map the success value, passing errors through unchanged. */
export function mapResult<T, U>(result: Result<T>, fn: (value: T) => U): Result<U> {
  if (!result.ok) return result;
  return ok(fn(result.value));
}
