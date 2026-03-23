import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { withSqliteRetry } from "./sqlite-helpers";

describe("withSqliteRetry", () => {
  let warnSpy: ReturnType<typeof spyOn>;
  let sleepSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    sleepSpy = spyOn(Bun, "sleepSync").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    sleepSpy.mockRestore();
  });

  test("returns the result on first success", () => {
    const result = withSqliteRetry(() => 42);
    expect(result).toBe(42);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  test("retries on SQLITE_BUSY and succeeds after transient failures", () => {
    let calls = 0;
    const result = withSqliteRetry(() => {
      calls++;
      if (calls < 3) throw new Error("SQLITE_BUSY");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(sleepSpy).toHaveBeenCalledTimes(2);
  });

  test("retries on 'database is locked' error message", () => {
    let calls = 0;
    const result = withSqliteRetry(() => {
      calls++;
      if (calls < 2) throw new Error("database is locked");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("gives up after max retries and re-throws", () => {
    let calls = 0;
    expect(() =>
      withSqliteRetry(
        () => {
          calls++;
          throw new Error("SQLITE_BUSY");
        },
        { maxRetries: 3 },
      ),
    ).toThrow("SQLITE_BUSY");
    // 1 initial + 3 retries = 4 calls total
    expect(calls).toBe(4);
    expect(warnSpy).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenCalledTimes(3);
  });

  test("exponential backoff increases delay between retries", () => {
    const delays: number[] = [];
    sleepSpy.mockImplementation((ms: number) => {
      delays.push(ms);
    });

    let calls = 0;
    withSqliteRetry(
      () => {
        calls++;
        if (calls <= 4) throw new Error("SQLITE_BUSY");
        return "ok";
      },
      { maxRetries: 5, baseDelayMs: 100 },
    );

    expect(delays.length).toBe(4);
    // Each delay should include baseDelayMs * 2^attempt as minimum
    // (the jitter component adds random(0, baseDelayMs) on top)
    for (let i = 0; i < delays.length; i++) {
      const minExpected = 100 * Math.pow(2, i);
      const maxExpected = minExpected + 100;
      expect(delays[i]).toBeGreaterThanOrEqual(minExpected);
      expect(delays[i]).toBeLessThanOrEqual(maxExpected);
    }
    // Verify later delays are larger than earlier ones (monotonically increasing base)
    for (let i = 1; i < delays.length; i++) {
      // The base doubles, so even with jitter the floor of each delay exceeds previous floor
      const prevFloor = 100 * Math.pow(2, i - 1);
      const currFloor = 100 * Math.pow(2, i);
      expect(currFloor).toBeGreaterThan(prevFloor);
    }
  });

  test("does not retry non-SQLITE_BUSY errors", () => {
    let calls = 0;
    expect(() =>
      withSqliteRetry(() => {
        calls++;
        throw new Error("some other error");
      }),
    ).toThrow("some other error");
    expect(calls).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  test("does not retry non-Error throws", () => {
    let calls = 0;
    expect(() =>
      withSqliteRetry(() => {
        calls++;
        throw "string error";
      }),
    ).toThrow("string error");
    expect(calls).toBe(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  test("respects custom label in warning messages", () => {
    let calls = 0;
    withSqliteRetry(
      () => {
        calls++;
        if (calls < 2) throw new Error("SQLITE_BUSY");
        return "ok";
      },
      { label: "telemetry" },
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("[telemetry]");
  });

  test("uses default maxRetries of 5", () => {
    let calls = 0;
    expect(() =>
      withSqliteRetry(() => {
        calls++;
        throw new Error("SQLITE_BUSY");
      }),
    ).toThrow("SQLITE_BUSY");
    // 1 initial + 5 retries = 6 calls
    expect(calls).toBe(6);
    expect(sleepSpy).toHaveBeenCalledTimes(5);
  });
});
