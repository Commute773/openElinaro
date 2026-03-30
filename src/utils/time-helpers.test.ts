import { test, expect, describe } from "bun:test";
import {
  parseTime,
  parseIso,
  toIso,
  addDaysLocal,
  addMonthsLocal,
  localDateKey,
  utcDateKey,
  weekdayKey,
  isSameLocalDay,
  nowInTimezone,
  startOfDay,
  startOfUtcDay,
  setDayOfMonth,
  setTime,
  addDaysUtc,
  addMonthsUtc,
} from "./time-helpers";

// ---------------------------------------------------------------------------
// parseTime
// ---------------------------------------------------------------------------
describe("parseTime", () => {
  test("parses standard HH:MM", () => {
    expect(parseTime("09:30")).toEqual({ hours: 9, minutes: 30 });
  });

  test("parses midnight", () => {
    expect(parseTime("00:00")).toEqual({ hours: 0, minutes: 0 });
  });

  test("parses end-of-day", () => {
    expect(parseTime("23:59")).toEqual({ hours: 23, minutes: 59 });
  });

  test("parses single-digit hour", () => {
    expect(parseTime("5:07")).toEqual({ hours: 5, minutes: 7 });
  });

  test("throws on invalid input", () => {
    expect(() => parseTime("abc")).toThrow("Invalid time value");
  });

  test("throws on empty string", () => {
    expect(() => parseTime("")).toThrow("Invalid time value");
  });
});

// ---------------------------------------------------------------------------
// parseIso / toIso round-trip
// ---------------------------------------------------------------------------
describe("parseIso / toIso", () => {
  test("round-trips a date", () => {
    const d = new Date("2026-03-15T12:00:00.000Z");
    const iso = toIso(d);
    const parsed = parseIso(iso);
    expect(parsed!.getTime()).toBe(d.getTime());
  });

  test("parseIso returns null for undefined", () => {
    expect(parseIso(undefined)).toBeNull();
  });

  test("parseIso returns null for empty string", () => {
    expect(parseIso("")).toBeNull();
  });

  test("toIso returns ISO 8601 string", () => {
    const d = new Date("2026-01-01T00:00:00Z");
    expect(toIso(d)).toBe("2026-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// addDaysLocal
// ---------------------------------------------------------------------------
describe("addDaysLocal", () => {
  test("adds days", () => {
    const d = new Date(2026, 0, 1); // Jan 1, 2026
    const result = addDaysLocal(d, 5);
    expect(result.getDate()).toBe(6);
    expect(result.getMonth()).toBe(0);
  });

  test("crosses month boundary", () => {
    const d = new Date(2026, 0, 30); // Jan 30
    const result = addDaysLocal(d, 3);
    expect(result.getMonth()).toBe(1); // February
    expect(result.getDate()).toBe(2);
  });

  test("subtracts days", () => {
    const d = new Date(2026, 1, 1); // Feb 1
    const result = addDaysLocal(d, -1);
    expect(result.getMonth()).toBe(0); // January
    expect(result.getDate()).toBe(31);
  });

  test("crosses year boundary", () => {
    const d = new Date(2025, 11, 31); // Dec 31, 2025
    const result = addDaysLocal(d, 1);
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(0);
    expect(result.getDate()).toBe(1);
  });

  test("does not mutate original date", () => {
    const d = new Date(2026, 0, 1);
    const original = d.getTime();
    addDaysLocal(d, 10);
    expect(d.getTime()).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// addMonthsLocal
// ---------------------------------------------------------------------------
describe("addMonthsLocal", () => {
  test("adds months", () => {
    const d = new Date(2026, 0, 15); // Jan 15
    const result = addMonthsLocal(d, 2);
    expect(result.getMonth()).toBe(2); // March
    expect(result.getDate()).toBe(15);
  });

  test("handles month-end clamping (Jan 31 + 1 month)", () => {
    // JS Date behavior: Jan 31 + 1 month = March 3 (not Feb 28)
    // This tests the actual JS behavior the function wraps
    const d = new Date(2026, 0, 31);
    const result = addMonthsLocal(d, 1);
    // JS setMonth overflows: month 1 day 31 => Mar 3
    expect(result.getMonth()).toBe(2);
    expect(result.getDate()).toBe(3);
  });

  test("leap year: Jan 31 + 1 month in leap year", () => {
    const d = new Date(2028, 0, 31); // 2028 is a leap year
    const result = addMonthsLocal(d, 1);
    // month 1 day 31 => Mar 2 in leap year (Feb has 29 days, 31-29=2)
    expect(result.getMonth()).toBe(2);
    expect(result.getDate()).toBe(2);
  });

  test("subtracts months across year boundary", () => {
    const d = new Date(2026, 1, 15); // Feb 15, 2026
    const result = addMonthsLocal(d, -3);
    expect(result.getFullYear()).toBe(2025);
    expect(result.getMonth()).toBe(10); // November
  });
});

// ---------------------------------------------------------------------------
// localDateKey / utcDateKey
// ---------------------------------------------------------------------------
describe("localDateKey", () => {
  test("formats date as YYYY-MM-DD", () => {
    const d = new Date(2026, 2, 5); // March 5, 2026 local
    expect(localDateKey(d)).toBe("2026-03-05");
  });

  test("pads single-digit months and days", () => {
    const d = new Date(2026, 0, 1); // Jan 1
    expect(localDateKey(d)).toBe("2026-01-01");
  });
});

describe("utcDateKey", () => {
  test("formats UTC date as YYYY-MM-DD", () => {
    const d = new Date(Date.UTC(2026, 11, 25)); // Dec 25 UTC
    expect(utcDateKey(d)).toBe("2026-12-25");
  });

  test("pads single-digit UTC components", () => {
    const d = new Date(Date.UTC(2026, 0, 3));
    expect(utcDateKey(d)).toBe("2026-01-03");
  });
});

// ---------------------------------------------------------------------------
// weekdayKey
// ---------------------------------------------------------------------------
describe("weekdayKey", () => {
  test("returns all 7 weekdays correctly", () => {
    // 2026-03-29 is a Sunday
    const sunday = new Date(2026, 2, 29);
    expect(weekdayKey(sunday)).toBe("sun");

    const monday = new Date(2026, 2, 30);
    expect(weekdayKey(monday)).toBe("mon");

    const tuesday = new Date(2026, 2, 31);
    expect(weekdayKey(tuesday)).toBe("tue");

    const wednesday = new Date(2026, 3, 1);
    expect(weekdayKey(wednesday)).toBe("wed");

    const thursday = new Date(2026, 3, 2);
    expect(weekdayKey(thursday)).toBe("thu");

    const friday = new Date(2026, 3, 3);
    expect(weekdayKey(friday)).toBe("fri");

    const saturday = new Date(2026, 3, 4);
    expect(weekdayKey(saturday)).toBe("sat");
  });
});

// ---------------------------------------------------------------------------
// isSameLocalDay
// ---------------------------------------------------------------------------
describe("isSameLocalDay", () => {
  test("same date different times returns true", () => {
    const a = new Date(2026, 5, 15, 3, 0, 0);
    const b = new Date(2026, 5, 15, 23, 59, 59);
    expect(isSameLocalDay(a, b)).toBe(true);
  });

  test("different dates returns false", () => {
    const a = new Date(2026, 5, 15);
    const b = new Date(2026, 5, 16);
    expect(isSameLocalDay(a, b)).toBe(false);
  });

  test("same exact instant returns true", () => {
    const d = new Date(2026, 0, 1, 12, 0, 0);
    expect(isSameLocalDay(d, d)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// nowInTimezone
// ---------------------------------------------------------------------------
describe("nowInTimezone", () => {
  test("returns a Date object", () => {
    const result = nowInTimezone("America/New_York");
    expect(result).toBeInstanceOf(Date);
  });

  test("different timezone gives different result from UTC", () => {
    const reference = new Date("2026-06-15T12:00:00Z");
    const utc = nowInTimezone("UTC", reference);
    const tokyo = nowInTimezone("Asia/Tokyo", reference);
    // Tokyo is UTC+9, so hours should differ
    expect(tokyo.getHours()).not.toBe(utc.getHours());
  });

  test("uses reference date when provided", () => {
    const ref = new Date("2026-01-01T00:00:00Z");
    const result = nowInTimezone("UTC", ref);
    expect(result.getFullYear()).toBe(2026);
  });
});

// ---------------------------------------------------------------------------
// startOfDay / startOfUtcDay
// ---------------------------------------------------------------------------
describe("startOfDay", () => {
  test("returns midnight local time", () => {
    const d = new Date(2026, 5, 15, 14, 30, 45, 123);
    const result = startOfDay(d);
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
    expect(result.getSeconds()).toBe(0);
    expect(result.getMilliseconds()).toBe(0);
    expect(result.getDate()).toBe(15);
  });

  test("does not mutate original", () => {
    const d = new Date(2026, 5, 15, 14, 30);
    const original = d.getTime();
    startOfDay(d);
    expect(d.getTime()).toBe(original);
  });
});

describe("startOfUtcDay", () => {
  test("returns UTC midnight", () => {
    const d = new Date(Date.UTC(2026, 5, 15, 14, 30));
    const result = startOfUtcDay(d);
    expect(result.getUTCHours()).toBe(0);
    expect(result.getUTCMinutes()).toBe(0);
    expect(result.getUTCSeconds()).toBe(0);
    expect(result.getUTCMilliseconds()).toBe(0);
    expect(result.getUTCDate()).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// setDayOfMonth
// ---------------------------------------------------------------------------
describe("setDayOfMonth", () => {
  test("sets the day", () => {
    const d = new Date(2026, 0, 1);
    const result = setDayOfMonth(d, 15);
    expect(result.getDate()).toBe(15);
  });

  test("clamps to last day of month", () => {
    const d = new Date(2026, 1, 1); // Feb 2026 (non-leap: 28 days)
    const result = setDayOfMonth(d, 31);
    expect(result.getDate()).toBe(28);
  });

  test("clamps to last day of leap February", () => {
    const d = new Date(2028, 1, 1); // Feb 2028 (leap: 29 days)
    const result = setDayOfMonth(d, 31);
    expect(result.getDate()).toBe(29);
  });
});

// ---------------------------------------------------------------------------
// setTime
// ---------------------------------------------------------------------------
describe("setTime", () => {
  test("sets clock to given time", () => {
    const d = new Date(2026, 0, 1, 0, 0, 0);
    const result = setTime(d, "14:30");
    expect(result.getHours()).toBe(14);
    expect(result.getMinutes()).toBe(30);
    expect(result.getSeconds()).toBe(0);
    expect(result.getMilliseconds()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// addDaysUtc / addMonthsUtc
// ---------------------------------------------------------------------------
describe("addDaysUtc", () => {
  test("adds UTC days across month boundary", () => {
    const d = new Date(Date.UTC(2026, 0, 31));
    const result = addDaysUtc(d, 1);
    expect(result.getUTCMonth()).toBe(1);
    expect(result.getUTCDate()).toBe(1);
  });
});

describe("addMonthsUtc", () => {
  test("adds UTC months", () => {
    const d = new Date(Date.UTC(2026, 0, 15));
    const result = addMonthsUtc(d, 3);
    expect(result.getUTCMonth()).toBe(3); // April
  });
});

// ---------------------------------------------------------------------------
// Edge cases: year boundary
// ---------------------------------------------------------------------------
describe("edge cases", () => {
  test("localDateKey at year boundary", () => {
    const d = new Date(2025, 11, 31); // Dec 31, 2025
    expect(localDateKey(d)).toBe("2025-12-31");

    const next = addDaysLocal(d, 1);
    expect(localDateKey(next)).toBe("2026-01-01");
  });

  test("utcDateKey at year boundary", () => {
    const d = new Date(Date.UTC(2025, 11, 31, 23, 59, 59));
    expect(utcDateKey(d)).toBe("2025-12-31");
  });
});
