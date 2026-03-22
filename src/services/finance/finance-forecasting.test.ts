import { test, expect, describe } from "bun:test";
import {
  calcProgressiveTax,
  calcContributions,
  calcAnnualTax,
  computeRunwayMonths,
  projectAnnualIncome,
  buildForecastScenario,
  addCumulativeCashflow,
  proratedForecastMonthValue,
  loadRecurringExpenses,
  loadAccountBalances,
} from "./finance-forecasting";
import { DEFAULT_FINANCE_FORECAST_CONFIG } from "../../config/finance-config";
import { Database } from "bun:sqlite";
import { SCHEMA } from "./finance-database";

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return db;
}

const config = DEFAULT_FINANCE_FORECAST_CONFIG;

describe("calcProgressiveTax", () => {
  test("returns zero for zero income", () => {
    expect(calcProgressiveTax(0, [[50000, 0.15], [null, 0.20]], 10000)).toBe(0);
  });

  test("returns zero when income below personal amount", () => {
    expect(calcProgressiveTax(5000, [[50000, 0.15], [null, 0.20]], 10000)).toBe(0);
  });

  test("taxes only income above personal amount in first bracket", () => {
    const tax = calcProgressiveTax(20000, [[50000, 0.15], [null, 0.20]], 10000);
    expect(tax).toBeCloseTo(10000 * 0.15, 2);
  });

  test("spans multiple brackets correctly", () => {
    // 100k income, 10k personal => 90k taxable
    // first 50k at 15%, next 40k at 20%
    const tax = calcProgressiveTax(100000, [[50000, 0.15], [null, 0.20]], 10000);
    expect(tax).toBeCloseTo(50000 * 0.15 + 40000 * 0.20, 2);
  });

  test("handles null bracket size (unlimited top bracket)", () => {
    const tax = calcProgressiveTax(200000, [[50000, 0.10], [null, 0.25]], 0);
    expect(tax).toBeCloseTo(50000 * 0.10 + 150000 * 0.25, 2);
  });
});

describe("calcContributions", () => {
  test("computes QPP, QPP2, QPIP, FSS contributions", () => {
    const result = calcContributions(80000, config.tax);
    expect(result.QPP).toBeGreaterThan(0);
    expect(result.QPIP).toBeGreaterThan(0);
    expect(result.FSS).toBeCloseTo(80000 * config.tax.fss_rate, 2);
    expect(result.total).toBeCloseTo(result.QPP + result.QPP2 + result.QPIP + result.FSS, 2);
  });

  test("QPP is capped at max pensionable", () => {
    const lowResult = calcContributions(50000, config.tax);
    const highResult = calcContributions(200000, config.tax);
    // At 200k, QPP should be capped at max pensionable - exemption
    expect(highResult.QPP).toBeCloseTo(
      (config.tax.qpp_max_pensionable - config.tax.qpp_exemption) * config.tax.qpp_rate,
      2,
    );
    expect(highResult.QPP).toBeGreaterThan(lowResult.QPP);
  });

  test("returns zero contributions for zero income", () => {
    const result = calcContributions(0, config.tax);
    expect(result.QPP).toBe(0);
    expect(result.FSS).toBe(0);
    expect(result.total).toBeGreaterThanOrEqual(0);
  });
});

describe("calcAnnualTax", () => {
  test("returns zero effective rate for zero income", () => {
    const result = calcAnnualTax(0, config);
    expect(result.effectiveRate).toBe(0);
    expect(result.effectiveRateWithContribs).toBe(0);
    expect(result.grossCad).toBe(0);
  });

  test("computes federal and quebec taxes", () => {
    const result = calcAnnualTax(100000, config);
    expect(result.federalTax).toBeGreaterThan(0);
    expect(result.quebecTax).toBeGreaterThan(0);
    expect(result.totalTax).toBeCloseTo(result.federalTax + result.quebecTax, 2);
  });

  test("netAfterTax accounts for tax and contributions", () => {
    const result = calcAnnualTax(100000, config);
    expect(result.netAfterTax).toBeCloseTo(
      100000 - result.totalTax - result.contributions.total,
      2,
    );
  });

  test("effective rate increases with income", () => {
    const low = calcAnnualTax(50000, config);
    const high = calcAnnualTax(200000, config);
    expect(high.effectiveRate).toBeGreaterThan(low.effectiveRate);
  });
});

describe("computeRunwayMonths", () => {
  test("returns null when burn is zero", () => {
    expect(computeRunwayMonths(50000, 0)).toBeNull();
  });

  test("returns null when burn is negative", () => {
    expect(computeRunwayMonths(50000, -100)).toBeNull();
  });

  test("computes correct months", () => {
    expect(computeRunwayMonths(10000, 2000)).toBeCloseTo(5, 2);
  });

  test("returns zero for negative liquidity", () => {
    expect(computeRunwayMonths(-5000, 2000)).toBe(0);
  });
});

describe("projectAnnualIncome", () => {
  test("returns empty for no sources", () => {
    const result = projectAnnualIncome([], 1.365, false);
    expect(result.items).toHaveLength(0);
    expect(result.totalCad).toBe(0);
  });

  test("includes confirmed sources", () => {
    const sources = [
      {
        name: "ClientA",
        confirmed: 1,
        amount_per_period: 5000,
        period: "monthly",
        currency: "CAD",
        start_date: "2026-01-01",
      },
    ];
    const result = projectAnnualIncome(sources, 1.365, false);
    expect(result.items).toHaveLength(1);
    expect(result.totalCad).toBeGreaterThan(0);
    expect(result.items[0]!.confirmed).toBe(true);
  });

  test("excludes unconfirmed when includeUnconfirmed is false", () => {
    const sources = [
      {
        name: "PotentialClient",
        confirmed: 0,
        guaranteed_months: 0,
        amount_per_period: 10000,
        period: "monthly",
        currency: "USD",
        start_date: "2026-01-01",
      },
    ];
    const result = projectAnnualIncome(sources, 1.365, false);
    // With guaranteed_months=0, annual = 0
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.confirmed).toBe(false);
    expect(result.items[0]!.annualCad).toBe(0);
  });

  test("includes unconfirmed with guaranteed months when includeUnconfirmed is false", () => {
    const sources = [
      {
        name: "PotentialClient",
        confirmed: 0,
        guaranteed_months: 3,
        amount_per_period: 10000,
        period: "monthly",
        currency: "CAD",
        start_date: "2026-01-01",
      },
    ];
    const result = projectAnnualIncome(sources, 1.365, false);
    expect(result.items).toHaveLength(1);
    expect(result.totalCad).toBeCloseTo(30000, 2);
  });

  test("converts USD to CAD", () => {
    const fxRate = 1.40;
    const sources = [
      {
        name: "USClient",
        confirmed: 1,
        amount_per_period: 1000,
        period: "monthly",
        currency: "USD",
        start_date: "2026-01-01",
      },
    ];
    const result = projectAnnualIncome(sources, fxRate, false);
    // Monthly amount * months * fxRate
    expect(result.items[0]!.currency).toBe("USD");
    expect(result.items[0]!.annualCad).toBeGreaterThan(result.items[0]!.annualOrig);
  });
});

describe("buildForecastScenario", () => {
  test("computes scenario with positive surplus", () => {
    const income = { items: [], totalCad: 200000 };
    const result = buildForecastScenario("conservative", income, 2000, 500, config, 50000);
    expect(result.label).toBe("conservative");
    expect(result.incomeCad).toBe(200000);
    expect(result.annualExpensesCad).toBe((2000 + 500) * 12);
  });

  test("computes burn rate from negative surplus", () => {
    const income = { items: [], totalCad: 10000 };
    const result = buildForecastScenario("conservative", income, 5000, 1000, config, 50000);
    // expenses are 6000/mo = 72000/yr which exceeds net income
    expect(result.monthlyBurnCad).toBeGreaterThan(0);
    expect(result.runwayMonths).toBeGreaterThan(0);
  });
});

describe("addCumulativeCashflow", () => {
  test("accumulates cashflow from starting balance", () => {
    const rows = [
      { month: "2026-03", incomeCad: 5000, expensesCad: 3000, discretionaryCad: 500, taxSetAside: 400, apDue: 0, arExpected: 0, totalOut: 3900, net: 1100 },
      { month: "2026-04", incomeCad: 5000, expensesCad: 3000, discretionaryCad: 500, taxSetAside: 400, apDue: 0, arExpected: 0, totalOut: 3900, net: 1100 },
    ];
    const result = addCumulativeCashflow(10000, rows);
    expect(result).toHaveLength(2);
    expect(result[0]!.cumulativeCad).toBeCloseTo(11100, 2);
    expect(result[1]!.cumulativeCad).toBeCloseTo(12200, 2);
  });

  test("handles negative net months", () => {
    const rows = [
      { month: "2026-03", incomeCad: 1000, expensesCad: 3000, discretionaryCad: 0, taxSetAside: 0, apDue: 0, arExpected: 0, totalOut: 3000, net: -2000 },
    ];
    const result = addCumulativeCashflow(5000, rows);
    expect(result[0]!.cumulativeCad).toBeCloseTo(3000, 2);
  });
});

describe("proratedForecastMonthValue", () => {
  test("returns full value when horizon covers full month", () => {
    const value = proratedForecastMonthValue("2026-03", 3000, "2026-03-01", "2026-04-01");
    expect(value).toBeCloseTo(3000, 2);
  });

  test("returns prorated value for partial overlap at start", () => {
    // reference date is mid-month
    const value = proratedForecastMonthValue("2026-03", 3100, "2026-03-16", "2026-04-01");
    // 16 out of 31 days remaining
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(3100);
  });

  test("returns zero when no overlap", () => {
    const value = proratedForecastMonthValue("2026-03", 3000, "2026-04-01", "2026-05-01");
    expect(value).toBe(0);
  });
});

describe("loadRecurringExpenses", () => {
  test("computes monthly amounts from different intervals", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    db.query(
      `INSERT INTO recurring(name, match_kind, match_value, interval_kind, amount_cad, amount_tolerance_cad, currency, status, grace_days, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("Monthly Bill", "merchant", "bill", "monthly", 100, 0, "CAD", "active", 2, now, now);
    db.query(
      `INSERT INTO recurring(name, match_kind, match_value, interval_kind, amount_cad, amount_tolerance_cad, currency, status, grace_days, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("Biweekly Bill", "merchant", "biweekly-bill", "biweekly", 200, 0, "CAD", "active", 1, now, now);

    const result = loadRecurringExpenses(db);
    expect(result).toHaveLength(2);

    const biweekly = result.find((r) => r.name === "Biweekly Bill")!;
    expect(biweekly.monthlyCad).toBeCloseTo(200 * 26 / 12, 2);

    const monthly = result.find((r) => r.name === "Monthly Bill")!;
    expect(monthly.monthlyCad).toBeCloseTo(100, 2);

    db.close();
  });

  test("excludes halted recurring items", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    db.query(
      `INSERT INTO recurring(name, match_kind, match_value, interval_kind, amount_cad, amount_tolerance_cad, currency, status, grace_days, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("Halted", "merchant", "halted", "monthly", 50, 0, "CAD", "halted", 2, now, now);

    const result = loadRecurringExpenses(db);
    expect(result).toHaveLength(0);

    db.close();
  });
});

describe("loadAccountBalances", () => {
  test("classifies accounts as liquid, registered, or debt", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    db.query(
      `INSERT INTO accounts(external_id, name, currency, balance, updated_at)
       VALUES(?, ?, ?, ?, ?)`,
    ).run("chk1", "Chequing", "CAD", 5000, now);
    db.query(
      `INSERT INTO accounts(external_id, name, currency, balance, updated_at)
       VALUES(?, ?, ?, ?, ?)`,
    ).run("rrsp1", "RRSP Growth", "CAD", 20000, now);
    db.query(
      `INSERT INTO accounts(external_id, name, currency, balance, updated_at)
       VALUES(?, ?, ?, ?, ?)`,
    ).run("cc1", "Credit Card", "CAD", -1500, now);

    const result = loadAccountBalances(db);
    expect(result.liquid).toHaveLength(1);
    expect(result.registered).toHaveLength(1);
    expect(result.debt).toHaveLength(1);
    expect(result.registered[0]!.name).toBe("RRSP Growth");
    expect(Number(result.debt[0]!.balance)).toBe(-1500);

    db.close();
  });
});
