import { test, expect, describe } from "bun:test";
import {
  nowInTimezone,
  localDateKey,
  startOfDay,
  isSameLocalDay,
  utcDateKey,
  startOfUtcDay,
  addDaysLocal,
  addMonthsLocal,
  setDayOfMonth,
  addDaysUtc,
  addMonthsUtc,
  parseTime,
  setTime,
  weekdayKey,
  parseIso,
  toIso,
} from "./time-helpers";

// ---------------------------------------------------------------------------
// nowInTimezone
// ---------------------------------------------------------------------------

describe("nowInTimezone", () => {
  test("returns a Date interpreted in the given timezone", () => {
    const ref = new Date("2026-06-15T12:00:00Z");
    const result = nowInTimezone("America/New_York", ref);
    expect(result).toBeInstanceOf(Date);
    // New York is UTC-4 in June (EDT)
    expect(result.getHours()).toBe(8);
  });

  test("uses current time when no reference supplied", () => {
    const before = Date.now();
    const result = nowInTimezone("UTC");
    const after = Date.now();
    expect(result.getTime()).toBeGreaterThanOrEqual(before - 2000);
    expect(result.getTime()).toBeLessThanOrEqual(after + 2000);
  });
});

// ---------------------------------------------------------------------------
// localDateKey / utcDateKey
// ---------------------------------------------------------------------------

describe("localDateKey", () => {
  test("formats date as YYYY-MM-DD using local components", () => {
    const d = new Date(2026, 0, 5, 10, 30); // Jan 5, 2026 local
    expect(localDateKey(d)).toBe("2026-01-05");
  });

  test("zero-pads month and day", () => {
    const d = new Date(2026, 2, 3); // Mar 3
    expect(localDateKey(d)).toBe("2026-03-03");
  });
});

describe("utcDateKey", () => {
  test("formats date as YYYY-MM-DD using UTC components", () => {
    const d = new Date(Date.UTC(2026, 11, 25)); // Dec 25 UTC
    expect(utcDateKey(d)).toBe("2026-12-25");
  });

  test("zero-pads month and day", () => {
    const d = new Date(Date.UTC(2026, 0, 1));
    expect(utcDateKey(d)).toBe("2026-01-01");
  });
});

// ---------------------------------------------------------------------------
// startOfDay / startOfUtcDay
// ---------------------------------------------------------------------------

describe("startOfDay", () => {
  test("returns midnight local of the same day", () => {
    const d = new Date(2026, 5, 15, 14, 30, 45, 123);
    const result = startOfDay(d);
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
    expect(result.getSeconds()).toBe(0);
    expect(result.getMilliseconds()).toBe(0);
    expect(result.getDate()).toBe(15);
  });

  test("does not mutate original date", () => {
    const d = new Date(2026, 5, 15, 14, 30);
    startOfDay(d);
    expect(d.getHours()).toBe(14);
  });
});

describe("startOfUtcDay", () => {
  test("returns midnight UTC of the same day", () => {
    const d = new Date(Date.UTC(2026, 5, 15, 14, 30, 45, 123));
    const result = startOfUtcDay(d);
    expect(result.getUTCHours()).toBe(0);
    expect(result.getUTCMinutes()).toBe(0);
    expect(result.getUTCSeconds()).toBe(0);
    expect(result.getUTCMilliseconds()).toBe(0);
    expect(result.getUTCDate()).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// isSameLocalDay
// ---------------------------------------------------------------------------

describe("isSameLocalDay", () => {
  test("returns true for same calendar day", () => {
    const a = new Date(2026, 5, 15, 8, 0);
    const b = new Date(2026, 5, 15, 22, 0);
    expect(isSameLocalDay(a, b)).toBe(true);
  });

  test("returns false for different calendar days", () => {
    const a = new Date(2026, 5, 15, 8, 0);
    const b = new Date(2026, 5, 16, 8, 0);
    expect(isSameLocalDay(a, b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// addDaysLocal / addDaysUtc
// ---------------------------------------------------------------------------

describe("addDaysLocal", () => {
  test("adds positive days", () => {
    const d = new Date(2026, 0, 1);
    const result = addDaysLocal(d, 5);
    expect(result.getDate()).toBe(6);
    expect(result.getMonth()).toBe(0);
  });

  test("subtracts days with negative value", () => {
    const d = new Date(2026, 0, 10);
    const result = addDaysLocal(d, -3);
    expect(result.getDate()).toBe(7);
  });

  test("crosses month boundary", () => {
    const d = new Date(2026, 0, 30); // Jan 30
    const result = addDaysLocal(d, 5);
    expect(result.getMonth()).toBe(1); // Feb
    expect(result.getDate()).toBe(4);
  });

  test("does not mutate original", () => {
    const d = new Date(2026, 0, 1);
    addDaysLocal(d, 5);
    expect(d.getDate()).toBe(1);
  });
});

describe("addDaysUtc", () => {
  test("adds days in UTC", () => {
    const d = new Date(Date.UTC(2026, 0, 1));
    const result = addDaysUtc(d, 10);
    expect(result.getUTCDate()).toBe(11);
  });

  test("subtracts days in UTC", () => {
    const d = new Date(Date.UTC(2026, 0, 15));
    const result = addDaysUtc(d, -5);
    expect(result.getUTCDate()).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// addMonthsLocal / addMonthsUtc
// ---------------------------------------------------------------------------

describe("addMonthsLocal", () => {
  test("adds months", () => {
    const d = new Date(2026, 0, 15); // Jan
    const result = addMonthsLocal(d, 3);
    expect(result.getMonth()).toBe(3); // Apr
    expect(result.getDate()).toBe(15);
  });

  test("subtracts months", () => {
    const d = new Date(2026, 5, 15); // Jun
    const result = addMonthsLocal(d, -2);
    expect(result.getMonth()).toBe(3); // Apr
  });

  test("does not mutate original", () => {
    const d = new Date(2026, 0, 15);
    addMonthsLocal(d, 3);
    expect(d.getMonth()).toBe(0);
  });
});

describe("addMonthsUtc", () => {
  test("adds months in UTC", () => {
    const d = new Date(Date.UTC(2026, 0, 15));
    const result = addMonthsUtc(d, 2);
    expect(result.getUTCMonth()).toBe(2); // Mar
  });

  test("subtracts months in UTC", () => {
    const d = new Date(Date.UTC(2026, 5, 15));
    const result = addMonthsUtc(d, -1);
    expect(result.getUTCMonth()).toBe(4); // May
  });
});

// ---------------------------------------------------------------------------
// setDayOfMonth
// ---------------------------------------------------------------------------

describe("setDayOfMonth", () => {
  test("sets day of month", () => {
    const d = new Date(2026, 0, 1);
    const result = setDayOfMonth(d, 20);
    expect(result.getDate()).toBe(20);
  });

  test("clamps to last day of month for February", () => {
    const d = new Date(2026, 1, 1); // Feb 2026 (28 days)
    const result = setDayOfMonth(d, 31);
    expect(result.getDate()).toBe(28);
  });

  test("clamps to last day of 30-day month", () => {
    const d = new Date(2026, 3, 1); // April (30 days)
    const result = setDayOfMonth(d, 31);
    expect(result.getDate()).toBe(30);
  });

  test("does not mutate original", () => {
    const d = new Date(2026, 0, 1);
    setDayOfMonth(d, 20);
    expect(d.getDate()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// parseTime / setTime
// ---------------------------------------------------------------------------

describe("parseTime", () => {
  test("parses HH:MM string", () => {
    expect(parseTime("14:30")).toEqual({ hours: 14, minutes: 30 });
  });

  test("parses midnight", () => {
    expect(parseTime("00:00")).toEqual({ hours: 0, minutes: 0 });
  });

  test("throws for invalid time", () => {
    expect(() => parseTime("abc:def")).toThrow("Invalid time value");
  });

  test("throws for empty string", () => {
    expect(() => parseTime("")).toThrow("Invalid time value");
  });
});

describe("setTime", () => {
  test("sets time on a date", () => {
    const d = new Date(2026, 5, 15, 0, 0, 0, 0);
    const result = setTime(d, "14:30");
    expect(result.getHours()).toBe(14);
    expect(result.getMinutes()).toBe(30);
    expect(result.getSeconds()).toBe(0);
    expect(result.getMilliseconds()).toBe(0);
  });

  test("does not mutate original", () => {
    const d = new Date(2026, 5, 15, 8, 0);
    setTime(d, "14:30");
    expect(d.getHours()).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// weekdayKey
// ---------------------------------------------------------------------------

describe("weekdayKey", () => {
  test("returns correct weekday abbreviations", () => {
    // 2026-03-22 is a Sunday
    const sunday = new Date(2026, 2, 22);
    expect(weekdayKey(sunday)).toBe("sun");

    const monday = new Date(2026, 2, 23);
    expect(weekdayKey(monday)).toBe("mon");

    const saturday = new Date(2026, 2, 28);
    expect(weekdayKey(saturday)).toBe("sat");
  });
});

// ---------------------------------------------------------------------------
// parseIso / toIso
// ---------------------------------------------------------------------------

describe("parseIso", () => {
  test("parses ISO string to Date", () => {
    const result = parseIso("2026-06-15T12:00:00Z");
    expect(result).toBeInstanceOf(Date);
    expect(result!.getUTCFullYear()).toBe(2026);
  });

  test("returns null for undefined", () => {
    expect(parseIso(undefined)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseIso("")).toBeNull();
  });
});

describe("toIso", () => {
  test("returns ISO string", () => {
    const d = new Date(Date.UTC(2026, 5, 15, 12, 0, 0));
    expect(toIso(d)).toBe("2026-06-15T12:00:00.000Z");
  });
});
