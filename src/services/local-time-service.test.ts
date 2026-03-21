import { describe, expect, test } from "bun:test";
import { buildCurrentLocalTimePrefix, formatLocalTime } from "./local-time-service";

describe("local-time-service", () => {
  test("formats local time with the provided timezone", () => {
    const formatted = formatLocalTime(new Date("2026-03-13T17:05:06.000Z"), "America/New_York");

    expect(formatted).toContain("Friday");
    expect(formatted).toContain("March");
    expect(formatted).toContain("2026");
    expect(formatted).toContain("1:05:06 PM");
    expect(formatted).toContain("EDT");
  });

  test("builds a prompt prefix that includes both the formatted time and timezone id", () => {
    const prefix = buildCurrentLocalTimePrefix(
      new Date("2026-03-13T17:05:06.000Z"),
      "America/New_York",
    );

    expect(prefix).toContain("Current local time:");
    expect(prefix).toContain("America/New_York");
    expect(prefix).toContain("EDT");
  });
});
