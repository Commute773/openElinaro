import { test, expect, describe } from "bun:test";
import { timestamp } from "./timestamp";

describe("timestamp", () => {
  test("returns a valid ISO-8601 string", () => {
    const result = timestamp();
    // ISO 8601 format: YYYY-MM-DDTHH:mm:ss.sssZ
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("returns a timestamp close to now", () => {
    const before = Date.now();
    const result = timestamp();
    const after = Date.now();
    const ts = new Date(result).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test("parses back to a valid Date", () => {
    const result = timestamp();
    const d = new Date(result);
    expect(d.toString()).not.toBe("Invalid Date");
  });
});
