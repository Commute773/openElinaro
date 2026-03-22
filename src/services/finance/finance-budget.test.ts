import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  SCHEMA,
  run,
  setSetting,
} from "./finance-database";
import {
  computeSpendStats,
  computeWeeklyBudget,
  computeMonthlyBudget,
  renderBudgetBlock,
  resolveBudgetSnapshot,
  describeBudgetPace,
} from "./finance-budget";
import type { FinanceBudgetSnapshot } from "./finance-types";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA);
});

afterEach(() => {
  db.close();
});

function insertTransaction(
  db: Database,
  opts: {
    externalId: string;
    postedDate: string;
    amount: number;
    currency?: string;
    amountCad?: number | null;
    countsAuto?: number | null;
    countsUser?: number | null;
    needsReview?: number;
  },
) {
  run(
    db,
    `INSERT INTO transactions(
       external_id, source, posted_date, amount, currency,
       amount_cad, counts_toward_budget_auto, counts_toward_budget_user,
       needs_review, imported_at
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    opts.externalId,
    "test",
    opts.postedDate,
    opts.amount,
    opts.currency ?? "CAD",
    opts.amountCad ?? null,
    opts.countsAuto ?? null,
    opts.countsUser ?? null,
    opts.needsReview ?? 0,
    "2026-01-01T00:00:00Z",
  );
}

function weekSnapshot(
  overrides: Partial<Extract<FinanceBudgetSnapshot, { mode: "week" }>> = {},
): Extract<FinanceBudgetSnapshot, { mode: "week" }> {
  return {
    mode: "week",
    date: "2026-03-05",
    weekIndex: 0,
    weekStart: "2026-03-01",
    weekEndExclusive: "2026-03-08",
    weeklyLimitCad: 700,
    carryIn: 0,
    available: 700,
    spentCad: 0,
    grossSpentCad: 0,
    incomeCad: 0,
    remaining: 700,
    expectedToDate: 400,
    paceDelta: 0,
    uncertainSpentCad: 0,
    unknownFxSpend: 0,
    ...overrides,
  };
}

function monthSnapshot(
  overrides: Partial<Extract<FinanceBudgetSnapshot, { mode: "month" }>> = {},
): Extract<FinanceBudgetSnapshot, { mode: "month" }> {
  return {
    mode: "month",
    month: "2026-03",
    from: "2026-03-01",
    toExclusive: "2026-04-01",
    limitCad: 2000,
    spentCad: 0,
    grossSpentCad: 0,
    incomeCad: 0,
    remaining: 2000,
    expectedToDate: 1000,
    paceDelta: 0,
    uncertainSpentCad: 0,
    unknownFxSpend: 0,
    ...overrides,
  };
}

describe("computeSpendStats", () => {
  test("returns zeros when no transactions", () => {
    const stats = computeSpendStats(db, "2026-03-01", "2026-04-01");
    expect(stats.spentCad).toBe(0);
    expect(stats.grossSpentCad).toBe(0);
    expect(stats.incomeCad).toBe(0);
    expect(stats.uncertainSpentCad).toBe(0);
    expect(stats.unknownFxSpend).toBe(0);
  });

  test("calculates spending from negative amounts (budget-counted)", () => {
    insertTransaction(db, { externalId: "t1", postedDate: "2026-03-05", amount: -100, countsAuto: 1 });
    insertTransaction(db, { externalId: "t2", postedDate: "2026-03-10", amount: -50, countsAuto: 1 });
    const stats = computeSpendStats(db, "2026-03-01", "2026-04-01");
    expect(stats.grossSpentCad).toBe(150);
    expect(stats.spentCad).toBe(150);
  });

  test("nets out income (positive amounts)", () => {
    insertTransaction(db, { externalId: "t1", postedDate: "2026-03-05", amount: -100, countsAuto: 1 });
    insertTransaction(db, { externalId: "t2", postedDate: "2026-03-10", amount: 30, countsAuto: 1 });
    const stats = computeSpendStats(db, "2026-03-01", "2026-04-01");
    expect(stats.grossSpentCad).toBe(100);
    expect(stats.incomeCad).toBe(30);
    expect(stats.spentCad).toBe(70);
  });

  test("excludes transactions outside date range", () => {
    insertTransaction(db, { externalId: "t1", postedDate: "2026-02-28", amount: -100, countsAuto: 1 });
    insertTransaction(db, { externalId: "t2", postedDate: "2026-04-01", amount: -50, countsAuto: 1 });
    const stats = computeSpendStats(db, "2026-03-01", "2026-04-01");
    expect(stats.spentCad).toBe(0);
  });

  test("excludes transactions not counted toward budget", () => {
    insertTransaction(db, { externalId: "t1", postedDate: "2026-03-05", amount: -100, countsAuto: 0 });
    const stats = computeSpendStats(db, "2026-03-01", "2026-04-01");
    expect(stats.spentCad).toBe(0);
  });

  test("tracks uncertain spending (needs_review = 1)", () => {
    insertTransaction(db, { externalId: "t1", postedDate: "2026-03-05", amount: -75, countsAuto: 1, needsReview: 1 });
    const stats = computeSpendStats(db, "2026-03-01", "2026-04-01");
    expect(stats.uncertainSpentCad).toBe(75);
  });

  test("tracks unknown FX spend for non-CAD without amount_cad", () => {
    insertTransaction(db, { externalId: "t1", postedDate: "2026-03-05", amount: -50, currency: "USD", countsAuto: 1 });
    const stats = computeSpendStats(db, "2026-03-01", "2026-04-01");
    expect(stats.unknownFxSpend).toBe(50);
    // Should not count toward spentCad since no CAD conversion
    expect(stats.spentCad).toBe(0);
  });

  test("uses amount_cad for non-CAD when available", () => {
    insertTransaction(db, { externalId: "t1", postedDate: "2026-03-05", amount: -50, currency: "USD", amountCad: -68, countsAuto: 1 });
    const stats = computeSpendStats(db, "2026-03-01", "2026-04-01");
    expect(stats.grossSpentCad).toBe(68);
    expect(stats.unknownFxSpend).toBe(0);
  });
});

describe("computeWeeklyBudget", () => {
  test("computes budget for first week with no spending", () => {
    const result = computeWeeklyBudget(db, "2026-03-03", 700, "2026-03-01");
    expect(result.mode).toBe("week");
    expect(result.weekIndex).toBe(0);
    expect(result.weekStart).toBe("2026-03-01");
    expect(result.weekEndExclusive).toBe("2026-03-08");
    expect(result.weeklyLimitCad).toBe(700);
    expect(result.carryIn).toBe(0);
    expect(result.available).toBe(700);
    expect(result.spentCad).toBe(0);
    expect(result.remaining).toBe(700);
  });

  test("carries unspent budget forward", () => {
    // Week 0: budget 700, spent 0 => carry 700
    // Week 1: available = 700 + 700 = 1400
    const result = computeWeeklyBudget(db, "2026-03-09", 700, "2026-03-01");
    expect(result.weekIndex).toBe(1);
    expect(result.carryIn).toBe(700);
    expect(result.available).toBe(1400);
  });

  test("carries negative budget forward when overspent", () => {
    insertTransaction(db, { externalId: "t1", postedDate: "2026-03-02", amount: -1000, countsAuto: 1 });
    const result = computeWeeklyBudget(db, "2026-03-09", 700, "2026-03-01");
    expect(result.weekIndex).toBe(1);
    expect(result.carryIn).toBe(-300); // 700 budget - 1000 spent = -300
    expect(result.available).toBe(400); // 700 + (-300) = 400
  });

  test("throws when date is before weekly start", () => {
    expect(() => computeWeeklyBudget(db, "2026-02-28", 700, "2026-03-01")).toThrow();
  });

  test("calculates pace delta", () => {
    // Day 4 of 7, available 700 => expected ~400
    insertTransaction(db, { externalId: "t1", postedDate: "2026-03-02", amount: -500, countsAuto: 1 });
    const result = computeWeeklyBudget(db, "2026-03-04", 700, "2026-03-01");
    expect(result.paceDelta).toBeGreaterThan(0); // spent more than expected pace
  });
});

describe("computeMonthlyBudget", () => {
  test("computes budget for month with no spending", () => {
    const result = computeMonthlyBudget(db, "2026-03", 2000);
    expect(result.mode).toBe("month");
    expect(result.month).toBe("2026-03");
    expect(result.from).toBe("2026-03-01");
    expect(result.toExclusive).toBe("2026-04-01");
    expect(result.limitCad).toBe(2000);
    expect(result.spentCad).toBe(0);
    expect(result.remaining).toBe(2000);
  });

  test("calculates spent and remaining", () => {
    insertTransaction(db, { externalId: "t1", postedDate: "2026-03-05", amount: -800, countsAuto: 1 });
    const result = computeMonthlyBudget(db, "2026-03", 2000);
    expect(result.spentCad).toBe(800);
    expect(result.remaining).toBe(1200);
  });

  test("calculates pace based on reference date", () => {
    const result = computeMonthlyBudget(db, "2026-03", 3100, "2026-03-15");
    // Day 15 of 31 => expected ~1500
    expect(result.expectedToDate).toBeCloseTo(1500, 0);
  });
});

describe("renderBudgetBlock", () => {
  test("renders weekly budget block", () => {
    const snapshot = weekSnapshot({ spentCad: 200, grossSpentCad: 200, remaining: 500, paceDelta: -200 });
    setSetting(db, "budget.weekly_start_date", "2026-03-01");
    const block = renderBudgetBlock(db, snapshot, {});
    expect(block).toContain("Week: 2026-03-01 -> 2026-03-08");
    expect(block).toContain("Weekly limit: $700.00 CAD");
    expect(block).toContain("Remaining: $500.00 CAD");
    expect(block).toContain("On track");
  });

  test("renders monthly budget block", () => {
    const snapshot = monthSnapshot({ spentCad: 800, grossSpentCad: 800, remaining: 1200, paceDelta: -200 });
    const block = renderBudgetBlock(db, snapshot, {});
    expect(block).toContain("Month: 2026-03");
    expect(block).toContain("Limit: $2000.00 CAD");
    expect(block).toContain("On track");
  });

  test("shows income breakdown when income > 0", () => {
    const snapshot = weekSnapshot({ spentCad: 150, grossSpentCad: 200, incomeCad: 50, remaining: 550, paceDelta: -250 });
    setSetting(db, "budget.weekly_start_date", "2026-03-01");
    const block = renderBudgetBlock(db, snapshot, {});
    expect(block).toContain("Gross spending:");
    expect(block).toContain("Credits/reimbursements:");
    expect(block).toContain("Net spent:");
  });

  test("shows uncertain and unknown FX when present", () => {
    const snapshot = monthSnapshot({ spentCad: 800, grossSpentCad: 800, remaining: 1200, paceDelta: -200, uncertainSpentCad: 100, unknownFxSpend: 50 });
    const block = renderBudgetBlock(db, snapshot, {});
    expect(block).toContain("Uncertain (needs review):");
    expect(block).toContain("Non-CAD missing FX (excluded):");
  });

  test("renders pace states correctly for weekly", () => {
    const base = weekSnapshot({ available: 1000, remaining: 1000, expectedToDate: 500 });
    setSetting(db, "budget.weekly_start_date", "2026-03-01");

    expect(renderBudgetBlock(db, weekSnapshot({ ...base, paceDelta: 50 }), {})).toContain("Slightly ahead");
    expect(renderBudgetBlock(db, weekSnapshot({ ...base, paceDelta: 200 }), {})).toContain("Ahead (red)");
  });
});

describe("resolveBudgetSnapshot", () => {
  test("uses weekly mode when date >= weekly start", () => {
    const defaults = {
      "budget.weekly_start_date": "2026-03-01",
      "budget.weekly_limit_cad": "700",
      "budget.monthly_limit_cad": "2000",
    };
    const snapshot = resolveBudgetSnapshot(db, "2026-03-05", defaults);
    expect(snapshot.mode).toBe("week");
  });

  test("falls back to monthly mode when date < weekly start", () => {
    const defaults = {
      "budget.weekly_start_date": "2026-03-01",
      "budget.weekly_limit_cad": "700",
      "budget.monthly_limit_cad": "2000",
    };
    const snapshot = resolveBudgetSnapshot(db, "2026-02-15", defaults);
    expect(snapshot.mode).toBe("month");
  });

  test("accepts weekly limit override", () => {
    const defaults = {
      "budget.weekly_start_date": "2026-03-01",
      "budget.weekly_limit_cad": "700",
    };
    const snapshot = resolveBudgetSnapshot(db, "2026-03-05", defaults, 999);
    expect(snapshot.mode).toBe("week");
    if (snapshot.mode === "week") {
      expect(snapshot.weeklyLimitCad).toBe(999);
    }
  });
});

describe("describeBudgetPace", () => {
  test("returns on_track when paceDelta <= 0", () => {
    expect(describeBudgetPace(weekSnapshot({ paceDelta: -200 }))).toBe("on_track");
  });

  test("returns slightly_ahead for weekly within 10%", () => {
    expect(describeBudgetPace(weekSnapshot({ available: 1000, paceDelta: 50 }))).toBe("slightly_ahead");
  });

  test("returns ahead_red for weekly over 10%", () => {
    expect(describeBudgetPace(weekSnapshot({ available: 1000, paceDelta: 300 }))).toBe("ahead_red");
  });

  test("returns correct pace for monthly snapshots", () => {
    expect(describeBudgetPace(monthSnapshot({ paceDelta: 500 }))).toBe("ahead_red");
  });
});
