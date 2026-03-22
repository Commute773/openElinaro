import { test, expect, describe } from "bun:test";
import {
  clamp,
  finiteNumber,
  formatCad,
  formatSignedCad,
  formatMoney,
  normText,
  heading,
  dateKey,
  parseNumberLike,
  toIsoDate,
  toIsoMonth,
  daysInMonth,
  startEndForMonth,
  addDays,
  daysBetween,
  addMonths,
  addYears,
  computeNextExpected,
  isPastDue,
  defaultGraceDays,
  stringOrNull,
  numberOrNull,
  booleanOrNull,
  rawCategoryFromJson,
  parseIsoToMs,
  toCad,
} from "./finance-helpers";

describe("clamp", () => {
  test("returns value when within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  test("clamps to min", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
  });
  test("clamps to max", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });
  test("returns boundary values", () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });
});

describe("finiteNumber", () => {
  test("returns finite numbers unchanged", () => {
    expect(finiteNumber(42)).toBe(42);
    expect(finiteNumber(0)).toBe(0);
    expect(finiteNumber(-7.5)).toBe(-7.5);
  });
  test("returns fallback for null/undefined", () => {
    expect(finiteNumber(null)).toBe(0);
    expect(finiteNumber(undefined)).toBe(0);
    expect(finiteNumber(null, 99)).toBe(99);
  });
  test("returns fallback for Infinity/NaN", () => {
    expect(finiteNumber(Infinity)).toBe(0);
    expect(finiteNumber(NaN)).toBe(0);
  });
});

describe("formatCad", () => {
  test("formats positive values", () => {
    expect(formatCad(123.45)).toBe("$123.45 CAD");
  });
  test("formats negative values with sign", () => {
    expect(formatCad(-50)).toBe("-$50.00 CAD");
  });
  test("formats zero", () => {
    expect(formatCad(0)).toBe("$0.00 CAD");
  });
});

describe("formatSignedCad", () => {
  test("formats positive with + sign", () => {
    expect(formatSignedCad(10)).toBe("+$10.00 CAD");
  });
  test("formats negative with - sign", () => {
    expect(formatSignedCad(-10)).toBe("-$10.00 CAD");
  });
});

describe("formatMoney", () => {
  test("formats with default currency and precision", () => {
    const result = formatMoney(1234.5);
    expect(result).toContain("1,234.50");
    expect(result).toContain("CAD");
  });
  test("formats negative values", () => {
    expect(formatMoney(-50, "USD")).toMatch(/^-\$/);
    expect(formatMoney(-50, "USD")).toContain("USD");
  });
});

describe("normText", () => {
  test("lowercases and trims", () => {
    expect(normText("  Hello World  ")).toBe("hello world");
  });
  test("collapses whitespace", () => {
    expect(normText("a   b\tc")).toBe("a b c");
  });
  test("handles null/undefined", () => {
    expect(normText(null)).toBe("");
    expect(normText(undefined)).toBe("");
  });
});

describe("heading", () => {
  test("creates heading with dashes", () => {
    const result = heading("Test");
    expect(result).toBe("\nTest\n----");
  });
  test("limits dash length to 60", () => {
    const long = "A".repeat(100);
    const result = heading(long);
    const dashes = result.split("\n")[2] ?? "";
    expect(dashes.length).toBe(60);
  });
});

describe("dateKey", () => {
  test("formats UTC date correctly", () => {
    expect(dateKey(new Date("2026-03-05T00:00:00Z"))).toBe("2026-03-05");
  });
  test("pads single-digit months and days", () => {
    expect(dateKey(new Date("2026-01-02T00:00:00Z"))).toBe("2026-01-02");
  });
});

describe("parseNumberLike", () => {
  test("returns finite numbers as-is", () => {
    expect(parseNumberLike(42)).toBe(42);
    expect(parseNumberLike(-3.5)).toBe(-3.5);
  });
  test("returns null for non-finite numbers", () => {
    expect(parseNumberLike(Infinity)).toBeNull();
    expect(parseNumberLike(NaN)).toBeNull();
  });
  test("parses string numbers", () => {
    expect(parseNumberLike("123.45")).toBe(123.45);
    expect(parseNumberLike("$1,234.56 CAD")).toBe(1234.56);
  });
  test("handles parenthesized negatives", () => {
    expect(parseNumberLike("(100.00)")).toBe(-100);
  });
  test("returns null for empty/non-string", () => {
    expect(parseNumberLike("")).toBeNull();
    expect(parseNumberLike(null)).toBeNull();
    expect(parseNumberLike(undefined)).toBeNull();
    expect(parseNumberLike({})).toBeNull();
  });
});

describe("toIsoDate", () => {
  test("passes through YYYY-MM-DD", () => {
    expect(toIsoDate("2026-03-15")).toBe("2026-03-15");
  });
  test("extracts date from ISO datetime", () => {
    expect(toIsoDate("2026-03-15T12:30:00Z")).toBe("2026-03-15");
  });
  test("parses slash-separated dates", () => {
    expect(toIsoDate("03/15/2026")).toBe("2026-03-15");
  });
  test("throws on empty string", () => {
    expect(() => toIsoDate("")).toThrow("Missing date");
  });
  test("throws on garbage", () => {
    expect(() => toIsoDate("not-a-date")).toThrow("Invalid date");
  });
});

describe("toIsoMonth", () => {
  test("passes through YYYY-MM", () => {
    expect(toIsoMonth("2026-03")).toBe("2026-03");
  });
  test("extracts month from full date", () => {
    expect(toIsoMonth("2026-03-15")).toBe("2026-03");
  });
  test("throws on invalid input", () => {
    expect(() => toIsoMonth("March 2026")).toThrow("Invalid month");
  });
});

describe("daysInMonth", () => {
  test("returns 31 for January", () => {
    expect(daysInMonth("2026-01")).toBe(31);
  });
  test("returns 28 for Feb in non-leap year", () => {
    expect(daysInMonth("2026-02")).toBe(28);
  });
  test("returns 29 for Feb in leap year", () => {
    expect(daysInMonth("2024-02")).toBe(29);
  });
  test("returns 30 for April", () => {
    expect(daysInMonth("2026-04")).toBe(30);
  });
});

describe("startEndForMonth", () => {
  test("returns correct range for mid-year", () => {
    const { from, toExclusive } = startEndForMonth("2026-03");
    expect(from).toBe("2026-03-01");
    expect(toExclusive).toBe("2026-04-01");
  });
  test("wraps December to next year January", () => {
    const { from, toExclusive } = startEndForMonth("2026-12");
    expect(from).toBe("2026-12-01");
    expect(toExclusive).toBe("2027-01-01");
  });
});

describe("addDays", () => {
  test("adds positive days", () => {
    expect(addDays("2026-03-01", 5)).toBe("2026-03-06");
  });
  test("crosses month boundary", () => {
    expect(addDays("2026-03-30", 5)).toBe("2026-04-04");
  });
  test("subtracts with negative days", () => {
    expect(addDays("2026-03-05", -5)).toBe("2026-02-28");
  });
});

describe("daysBetween", () => {
  test("returns positive for later end", () => {
    expect(daysBetween("2026-03-01", "2026-03-08")).toBe(7);
  });
  test("returns 0 for same date", () => {
    expect(daysBetween("2026-03-01", "2026-03-01")).toBe(0);
  });
  test("returns negative for earlier end", () => {
    expect(daysBetween("2026-03-08", "2026-03-01")).toBe(-7);
  });
});

describe("addMonths", () => {
  test("adds months within year", () => {
    expect(addMonths("2026-01-15", 3)).toBe("2026-04-15");
  });
  test("wraps to next year", () => {
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
  });
  test("clamps day to month end", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  });
});

describe("addYears", () => {
  test("adds years", () => {
    expect(addYears("2026-03-15", 2)).toBe("2028-03-15");
  });
  test("handles leap day", () => {
    expect(addYears("2024-02-29", 1)).toBe("2025-02-28");
  });
});

describe("computeNextExpected", () => {
  test("uses intervalDays when provided", () => {
    expect(computeNextExpected("2026-03-01", "monthly", 10)).toBe("2026-03-11");
  });
  test("uses weekly interval", () => {
    expect(computeNextExpected("2026-03-01", "weekly")).toBe("2026-03-08");
  });
  test("uses biweekly interval", () => {
    expect(computeNextExpected("2026-03-01", "biweekly")).toBe("2026-03-15");
  });
  test("uses monthly interval", () => {
    expect(computeNextExpected("2026-03-01", "monthly")).toBe("2026-04-01");
  });
  test("defaults to yearly", () => {
    expect(computeNextExpected("2026-03-01", "yearly")).toBe("2027-03-01");
    expect(computeNextExpected("2026-03-01", "other")).toBe("2027-03-01");
  });
});

describe("isPastDue", () => {
  test("returns true when null nextExpected", () => {
    expect(isPastDue("2026-03-10", null, 2)).toBe(true);
  });
  test("returns false within grace period", () => {
    expect(isPastDue("2026-03-10", "2026-03-09", 2)).toBe(false);
  });
  test("returns true after grace period", () => {
    expect(isPastDue("2026-03-15", "2026-03-09", 2)).toBe(true);
  });
});

describe("defaultGraceDays", () => {
  test("returns 2 for monthly and yearly", () => {
    expect(defaultGraceDays("monthly")).toBe(2);
    expect(defaultGraceDays("yearly")).toBe(2);
  });
  test("returns 1 for others", () => {
    expect(defaultGraceDays("weekly")).toBe(1);
    expect(defaultGraceDays("biweekly")).toBe(1);
  });
});

describe("stringOrNull", () => {
  test("returns string for non-empty values", () => {
    expect(stringOrNull("hello")).toBe("hello");
  });
  test("returns null for null/undefined/empty", () => {
    expect(stringOrNull(null)).toBeNull();
    expect(stringOrNull(undefined)).toBeNull();
    expect(stringOrNull("  ")).toBeNull();
  });
});

describe("numberOrNull", () => {
  test("returns number for valid values", () => {
    expect(numberOrNull(42)).toBe(42);
    expect(numberOrNull("3.14")).toBeCloseTo(3.14);
  });
  test("returns null for invalid/null", () => {
    expect(numberOrNull(null)).toBeNull();
    expect(numberOrNull("abc")).toBeNull();
  });
});

describe("booleanOrNull", () => {
  test("returns true for 1", () => {
    expect(booleanOrNull(1)).toBe(true);
  });
  test("returns false for 0", () => {
    expect(booleanOrNull(0)).toBe(false);
  });
  test("returns null for null/undefined", () => {
    expect(booleanOrNull(null)).toBeNull();
    expect(booleanOrNull(undefined)).toBeNull();
  });
});

describe("rawCategoryFromJson", () => {
  test("returns detailed category", () => {
    expect(rawCategoryFromJson({ personal_finance_category: { detailed: "Food", primary: "General" } })).toBe("Food");
  });
  test("falls back to primary", () => {
    expect(rawCategoryFromJson({ personal_finance_category: { primary: "General" } })).toBe("General");
  });
  test("returns null for missing", () => {
    expect(rawCategoryFromJson(null)).toBeNull();
    expect(rawCategoryFromJson({})).toBeNull();
  });
});

describe("parseIsoToMs", () => {
  test("returns milliseconds for valid ISO string", () => {
    const ms = parseIsoToMs("2026-03-15T00:00:00Z");
    expect(ms).toBe(new Date("2026-03-15T00:00:00Z").getTime());
  });
  test("returns null for null/empty", () => {
    expect(parseIsoToMs(null)).toBeNull();
    expect(parseIsoToMs("")).toBeNull();
  });
});

describe("toCad", () => {
  test("returns amount unchanged for CAD", () => {
    expect(toCad(100, "CAD", 1.365)).toBe(100);
  });
  test("converts USD to CAD using rate", () => {
    expect(toCad(100, "USD", 1.365)).toBeCloseTo(136.5);
  });
  test("returns amount unchanged for unknown currency", () => {
    expect(toCad(100, "EUR", 1.365)).toBe(100);
  });
});
