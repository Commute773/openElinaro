import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA } from "./finance-database";
import {
  normRecurringKey,
  detectIntervalFromGaps,
  ruleMatchesTransaction,
  recurringAmountMatches,
  assertRecurringInput,
  mapRecurringRow,
  mapImportRunRow,
  detectRecurringCandidates,
  refreshRecurringRules,
  sumRecurringOutflowsWithinHorizon,
} from "./finance-recurring";

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return db;
}

describe("normRecurringKey", () => {
  test("lowercases and collapses whitespace", () => {
    expect(normRecurringKey("Hello  World")).toBe("hello world");
  });

  test("strips non-alphanumeric chars", () => {
    expect(normRecurringKey("Tim Hortons #123")).toBe("tim hortons 123");
  });

  test("handles empty string", () => {
    expect(normRecurringKey("")).toBe("");
  });
});

describe("detectIntervalFromGaps", () => {
  test("detects monthly intervals", () => {
    const result = detectIntervalFromGaps([30, 31, 30, 29]);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("monthly");
  });

  test("detects weekly intervals", () => {
    const result = detectIntervalFromGaps([7, 7, 7, 7]);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("weekly");
    expect(result!.intervalDays).toBe(7);
  });

  test("detects biweekly intervals", () => {
    const result = detectIntervalFromGaps([14, 14, 14]);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("biweekly");
    expect(result!.intervalDays).toBe(14);
  });

  test("detects yearly intervals", () => {
    const result = detectIntervalFromGaps([365, 365, 364]);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("yearly");
  });

  test("returns null for insufficient gaps", () => {
    expect(detectIntervalFromGaps([30])).toBeNull();
  });

  test("returns null for irregular gaps", () => {
    expect(detectIntervalFromGaps([5, 45, 10, 60])).toBeNull();
  });

  test("filters out zero gaps", () => {
    expect(detectIntervalFromGaps([0, 0, 30])).toBeNull();
  });
});

describe("ruleMatchesTransaction", () => {
  test("matches by merchant name", () => {
    const rule = { match_kind: "merchant", match_value: "tim hortons" };
    const tx = { merchant_name: "Tim Hortons" };
    expect(ruleMatchesTransaction(rule, tx)).toBe(true);
  });

  test("matches by description", () => {
    const rule = { match_kind: "description", match_value: "netflix subscription" };
    const tx = { description_clean: "Netflix Subscription" };
    expect(ruleMatchesTransaction(rule, tx)).toBe(true);
  });

  test("matches by regex fallback", () => {
    const rule = { match_kind: "regex", match_value: "tim.*hortons" };
    const tx = { merchant_name: "Tim Hortons #42" };
    expect(ruleMatchesTransaction(rule, tx)).toBe(true);
  });

  test("returns false for non-matching merchant", () => {
    const rule = { match_kind: "merchant", match_value: "starbucks" };
    const tx = { merchant_name: "Tim Hortons" };
    expect(ruleMatchesTransaction(rule, tx)).toBe(false);
  });

  test("returns false for empty transaction name", () => {
    const rule = { match_kind: "merchant", match_value: "starbucks" };
    const tx = { merchant_name: "" };
    expect(ruleMatchesTransaction(rule, tx)).toBe(false);
  });
});

describe("recurringAmountMatches", () => {
  test("matches exact CAD amount", () => {
    const rule = { amount_cad: 50, amount_tolerance_cad: 0 };
    const tx = { amount: -50, currency: "CAD" };
    expect(recurringAmountMatches(rule, tx)).toBe(true);
  });

  test("matches within tolerance", () => {
    const rule = { amount_cad: 50, amount_tolerance_cad: 5 };
    const tx = { amount: -53, currency: "CAD" };
    expect(recurringAmountMatches(rule, tx)).toBe(true);
  });

  test("rejects amount outside tolerance", () => {
    const rule = { amount_cad: 50, amount_tolerance_cad: 2 };
    const tx = { amount: -60, currency: "CAD" };
    expect(recurringAmountMatches(rule, tx)).toBe(false);
  });

  test("uses amount_cad for non-CAD transactions", () => {
    const rule = { amount_cad: 100, amount_tolerance_cad: 0 };
    const tx = { amount: -75, currency: "USD", amount_cad: -100 };
    expect(recurringAmountMatches(rule, tx)).toBe(true);
  });

  test("returns false when no CAD amount available for non-CAD", () => {
    const rule = { amount_cad: 100, amount_tolerance_cad: 0 };
    const tx = { amount: -75, currency: "USD" };
    expect(recurringAmountMatches(rule, tx)).toBe(false);
  });
});

describe("assertRecurringInput", () => {
  const validInput = {
    name: "Netflix",
    match_kind: "merchant",
    match_value: "netflix",
    interval_kind: "monthly",
    amount_cad: 20,
  };

  test("does not throw for valid input", () => {
    expect(() => assertRecurringInput(validInput)).not.toThrow();
  });

  test("throws for missing name", () => {
    expect(() => assertRecurringInput({ ...validInput, name: "" })).toThrow("name is required");
  });

  test("throws for missing match_kind", () => {
    expect(() => assertRecurringInput({ ...validInput, match_kind: "" })).toThrow("matchKind is required");
  });

  test("throws for missing match_value", () => {
    expect(() => assertRecurringInput({ ...validInput, match_value: "" })).toThrow("matchValue is required");
  });

  test("throws for zero amount", () => {
    expect(() => assertRecurringInput({ ...validInput, amount_cad: 0 })).toThrow("amountCad must be greater than zero");
  });

  test("throws for negative amount", () => {
    expect(() => assertRecurringInput({ ...validInput, amount_cad: -10 })).toThrow("amountCad must be greater than zero");
  });

  test("throws for negative tolerance", () => {
    expect(() => assertRecurringInput({ ...validInput, amount_tolerance_cad: -1 })).toThrow("amountToleranceCad must be zero or positive");
  });

  test("throws for negative grace days", () => {
    expect(() => assertRecurringInput({ ...validInput, grace_days: -1 })).toThrow("graceDays must be zero or positive");
  });
});

describe("mapRecurringRow", () => {
  test("maps a monthly recurring row", () => {
    const row = {
      id: 1,
      name: "Netflix",
      match_kind: "merchant",
      match_value: "netflix",
      interval_kind: "monthly",
      interval_days: null,
      amount_cad: 20,
      amount_tolerance_cad: 0,
      currency: "CAD",
      next_expected_date: "2026-04-01",
      last_seen_date: "2026-03-01",
      status: "active",
      grace_days: 2,
      notes: null,
    };
    const result = mapRecurringRow(row, "2026-03-22");
    expect(result.id).toBe(1);
    expect(result.name).toBe("Netflix");
    expect(result.monthlyCad).toBe(20);
    expect(result.isPastDue).toBe(false);
  });

  test("computes monthly amount for biweekly interval", () => {
    const row = {
      id: 2,
      name: "BiweeklyBill",
      match_kind: "merchant",
      match_value: "bill",
      interval_kind: "biweekly",
      interval_days: 14,
      amount_cad: 100,
      amount_tolerance_cad: 0,
      currency: "CAD",
      next_expected_date: "2026-04-01",
      last_seen_date: "2026-03-15",
      status: "active",
      grace_days: 1,
      notes: null,
    };
    const result = mapRecurringRow(row, "2026-03-22");
    expect(result.monthlyCad).toBeCloseTo(100 * 26 / 12, 2);
  });

  test("marks past due when next expected is before today minus grace", () => {
    const row = {
      id: 3,
      name: "Late",
      match_kind: "merchant",
      match_value: "late",
      interval_kind: "monthly",
      interval_days: null,
      amount_cad: 50,
      amount_tolerance_cad: 0,
      currency: "CAD",
      next_expected_date: "2026-01-01",
      last_seen_date: "2025-12-01",
      status: "active",
      grace_days: 2,
      notes: null,
    };
    const result = mapRecurringRow(row, "2026-03-22");
    expect(result.isPastDue).toBe(true);
  });
});

describe("mapImportRunRow", () => {
  test("maps import run data", () => {
    const row = {
      id: 5,
      source: "gsheet",
      started_at: "2026-03-22T10:00:00Z",
      finished_at: "2026-03-22T10:00:05Z",
      rows_seen: 100,
      rows_inserted: 80,
      rows_updated: 20,
      error: null,
    };
    const result = mapImportRunRow(row);
    expect(result.id).toBe(5);
    expect(result.source).toBe("gsheet");
    expect(result.durationMs).toBe(5000);
    expect(result.error).toBeNull();
  });

  test("handles null finished_at", () => {
    const row = {
      id: 6,
      source: "csv",
      started_at: "2026-03-22T10:00:00Z",
      finished_at: null,
      rows_seen: 0,
      rows_inserted: 0,
      rows_updated: 0,
      error: "interrupted",
    };
    const result = mapImportRunRow(row);
    expect(result.durationMs).toBeNull();
    expect(result.error).toBe("interrupted");
  });
});

describe("detectRecurringCandidates", () => {
  test("detects monthly recurring from transaction history", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    // Insert 4 monthly transactions for the same merchant
    const dates = ["2026-01-05", "2026-02-05", "2026-03-05", "2026-04-05"];
    for (let i = 0; i < dates.length; i++) {
      db.query(
        `INSERT INTO transactions(external_id, source, posted_date, amount, currency, description_raw, merchant_name, is_transfer, is_cc_payment, needs_review, imported_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(`rec-${i}`, "test", dates[i]!, -49.99, "CAD", "Netflix Monthly", "Netflix", 0, 0, 0, now);
    }

    const candidates = detectRecurringCandidates(db, "2026-04-10");
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const netflix = candidates.find((c) => String(c.name).toLowerCase().includes("netflix"));
    expect(netflix).toBeDefined();
    expect(netflix!.interval_kind).toBe("monthly");
    db.close();
  });

  test("ignores transfers and CC payments", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    const dates = ["2026-01-05", "2026-02-05", "2026-03-05", "2026-04-05"];
    for (let i = 0; i < dates.length; i++) {
      db.query(
        `INSERT INTO transactions(external_id, source, posted_date, amount, currency, description_raw, merchant_name, is_transfer, is_cc_payment, needs_review, imported_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(`xfer-${i}`, "test", dates[i]!, -100, "CAD", "Transfer to Savings", "Transfer", 1, 0, 0, now);
    }

    const candidates = detectRecurringCandidates(db, "2026-04-10");
    expect(candidates).toHaveLength(0);
    db.close();
  });

  test("requires at least 3 occurrences", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    for (let i = 0; i < 2; i++) {
      db.query(
        `INSERT INTO transactions(external_id, source, posted_date, amount, currency, description_raw, merchant_name, is_transfer, is_cc_payment, needs_review, imported_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(`few-${i}`, "test", `2026-0${i + 1}-15`, -25, "CAD", "Rare Vendor", "RareVendor", 0, 0, 0, now);
    }

    const candidates = detectRecurringCandidates(db, "2026-04-10");
    expect(candidates).toHaveLength(0);
    db.close();
  });
});

describe("refreshRecurringRules", () => {
  test("refreshes last_seen and next_expected dates", () => {
    const db = createTestDb();
    const now = new Date().toISOString();

    // Insert a recurring rule
    db.query(
      `INSERT INTO recurring(name, match_kind, match_value, interval_kind, amount_cad, amount_tolerance_cad, currency, status, grace_days, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("Spotify", "merchant", "spotify", "monthly", 12.99, 1, "CAD", "active", 2, now, now);

    // Insert matching transactions
    for (let i = 1; i <= 3; i++) {
      db.query(
        `INSERT INTO transactions(external_id, source, posted_date, amount, currency, description_raw, merchant_name, is_transfer, is_cc_payment, needs_review, imported_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(`sp-${i}`, "test", `2026-0${i}-01`, -12.99, "CAD", "Spotify Premium", "Spotify", 0, 0, 0, now);
    }

    const result = refreshRecurringRules(db, "2026-03-22", false, 0);
    expect(result.active.length + result.halted.length).toBeGreaterThanOrEqual(1);
    const spotify = [...result.active, ...result.halted].find(
      (r) => String(r.name) === "Spotify",
    );
    expect(spotify).toBeDefined();
    expect(spotify!.last_seen_date).toBe("2026-03-01");
    db.close();
  });

  test("auto-seeds new recurring rules when enabled", () => {
    const db = createTestDb();
    const now = new Date().toISOString();

    // Insert enough monthly transactions to be detected as recurring
    const dates = ["2026-01-10", "2026-02-10", "2026-03-10", "2026-04-10"];
    for (let i = 0; i < dates.length; i++) {
      db.query(
        `INSERT INTO transactions(external_id, source, posted_date, amount, currency, description_raw, merchant_name, is_transfer, is_cc_payment, needs_review, imported_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(`seed-${i}`, "test", dates[i]!, -35, "CAD", "Gym Membership", "FitGym", 0, 0, 0, now);
    }

    const result = refreshRecurringRules(db, "2026-04-15", true, 10);
    expect(result.seeded.length).toBeGreaterThanOrEqual(1);
    db.close();
  });
});

describe("sumRecurringOutflowsWithinHorizon", () => {
  test("sums monthly outflows within horizon", () => {
    const row = {
      amountCad: 100,
      intervalKind: "monthly",
      intervalDays: null,
      nextExpectedDate: "2026-04-01",
      lastSeenDate: "2026-03-01",
      status: "active" as const,
    };
    // 3-month horizon should include ~3 payments
    const total = sumRecurringOutflowsWithinHorizon(row, "2026-04-01", "2026-07-01");
    expect(total).toBeCloseTo(300, 0);
  });

  test("returns zero for halted items", () => {
    const row = {
      amountCad: 100,
      intervalKind: "monthly",
      intervalDays: null,
      nextExpectedDate: "2026-04-01",
      lastSeenDate: "2026-03-01",
      status: "halted" as const,
    };
    expect(sumRecurringOutflowsWithinHorizon(row, "2026-04-01", "2026-07-01")).toBe(0);
  });

  test("includes overdue payment", () => {
    const row = {
      amountCad: 50,
      intervalKind: "monthly",
      intervalDays: null,
      nextExpectedDate: "2026-03-01",
      lastSeenDate: "2026-02-01",
      status: "active" as const,
    };
    // reference is after nextExpected, so should include overdue + future
    const total = sumRecurringOutflowsWithinHorizon(row, "2026-03-15", "2026-05-15");
    expect(total).toBeGreaterThanOrEqual(100);
  });

  test("handles weekly interval", () => {
    const row = {
      amountCad: 25,
      intervalKind: "weekly",
      intervalDays: 7,
      nextExpectedDate: "2026-04-01",
      lastSeenDate: "2026-03-25",
      status: "active" as const,
    };
    // 4 weeks should have ~4 payments
    const total = sumRecurringOutflowsWithinHorizon(row, "2026-04-01", "2026-04-29");
    expect(total).toBe(100);
  });

  test("uses lastSeenDate to compute nextExpected if not set", () => {
    const row = {
      amountCad: 200,
      intervalKind: "monthly",
      intervalDays: null,
      nextExpectedDate: null,
      lastSeenDate: "2026-03-01",
      status: "active" as const,
    };
    const total = sumRecurringOutflowsWithinHorizon(row, "2026-04-01", "2026-06-01");
    expect(total).toBeGreaterThan(0);
  });
});
