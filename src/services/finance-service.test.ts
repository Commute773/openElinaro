import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { updateTestRuntimeConfig } from "../test/runtime-config-test-helpers";
import { FinanceService } from "./finance-service";

const services: FinanceService[] = [];
const tempRoots: string[] = [];
let runtimeConfigRoot = "";
let previousUserDataDirEnv: string | undefined;

beforeEach(() => {
  previousUserDataDirEnv = process.env.OPENELINARO_USER_DATA_DIR;
  runtimeConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-finance-config-"));
  process.env.OPENELINARO_USER_DATA_DIR = runtimeConfigRoot;
});

afterEach(() => {
  while (services.length > 0) {
    services.pop()?.close();
  }
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  if (previousUserDataDirEnv === undefined) {
    delete process.env.OPENELINARO_USER_DATA_DIR;
  } else {
    process.env.OPENELINARO_USER_DATA_DIR = previousUserDataDirEnv;
  }
  if (runtimeConfigRoot) {
    fs.rmSync(runtimeConfigRoot, { recursive: true, force: true });
    runtimeConfigRoot = "";
  }
});

function createService(options?: { forecastConfig?: Record<string, unknown> }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-finance-"));
  tempRoots.push(root);
  const forecastConfigPath = path.join(root, "forecast-config.json");
  if (options?.forecastConfig) {
    fs.writeFileSync(forecastConfigPath, `${JSON.stringify(options.forecastConfig, null, 2)}\n`);
  }
  const service = new FinanceService({
    dbPath: path.join(root, "finance.db"),
    forecastConfigPath,
  });
  services.push(service);
  return service;
}

async function seedStructuredFixture(service: FinanceService) {
  await service.importTransactions({
    source: "csv",
    csvText: [
      "Transaction ID,Date,Amount,Description,Account,Currency,Amount CAD,Raw Data",
      'tx-budget-1,2026-03-09,-120.00,Uber Eats order,Checking,CAD,-120.00,"{""personal_finance_category"": {""primary"": ""FOOD_AND_DRINK"", ""detailed"": ""FAST_FOOD"", ""confidence_level"": ""high""}, ""merchant_name"": ""Uber Eats""}"',
      'tx-budget-2,2026-03-10,-80.00,Amazon Marketplace,Checking,CAD,-80.00,"{""personal_finance_category"": {""primary"": ""GENERAL_MERCHANDISE"", ""detailed"": ""ONLINE_MARKETPLACE"", ""confidence_level"": ""medium""}, ""merchant_name"": ""Amazon""}"',
      'tx-credit-1,2026-03-11,20.00,Expense reimbursement,Checking,CAD,20.00,"{""personal_finance_category"": {""primary"": ""INCOME"", ""detailed"": ""OTHER_INCOME"", ""confidence_level"": ""high""}, ""merchant_name"": ""Client Refund""}"',
      'tx-foreign-1,2026-03-12,-15.00,US app charge,Checking,USD,,"{""personal_finance_category"": {""primary"": ""ENTERTAINMENT"", ""detailed"": ""DIGITAL_GOODS"", ""confidence_level"": ""medium""}, ""merchant_name"": ""US App""}"',
      'tx-old-1,2026-03-03,-100.00,DoorDash order,Checking,CAD,-100.00,"{""personal_finance_category"": {""primary"": ""FOOD_AND_DRINK"", ""detailed"": ""FAST_FOOD"", ""confidence_level"": ""high""}, ""merchant_name"": ""DoorDash""}"',
      'tx-sub-1,2026-03-01,-50.00,Netflix subscription,Checking,CAD,-50.00,"{""personal_finance_category"": {""primary"": ""ENTERTAINMENT"", ""detailed"": ""TV_AND_MOVIES"", ""confidence_level"": ""high""}, ""merchant_name"": ""Netflix""}"',
    ].join("\n"),
  });

  service.addReceivable({
    counterparty: "Client A",
    amountCad: 500,
    earnedDate: "2026-03-01",
    expectedDate: "2026-03-15",
    status: "pending",
    notes: "March invoice",
  });
  service.addReceivable({
    counterparty: "Client B",
    amountCad: 250,
    earnedDate: "2026-02-15",
    expectedDate: "2026-03-05",
    status: "pending",
    notes: "Late payment",
  });

  service.addPayable({
    counterparty: "CRA",
    amount: 300,
    currency: "CAD",
    dueDate: "2026-03-20",
    certainty: "confirmed",
    category: "Taxes/Federal",
  });
  service.addPayable({
    counterparty: "Roof Repair",
    amount: 1000,
    currency: "CAD",
    dueDate: "2026-04-01",
    certainty: "speculative",
    category: "Housing/Repair",
  });

  service.addRecurring({
    name: "Netflix",
    matchKind: "merchant",
    matchValue: "netflix",
    intervalKind: "monthly",
    amountCad: 50,
  });
  service.addRecurring({
    name: "Gym",
    matchKind: "merchant",
    matchValue: "gym",
    intervalKind: "monthly",
    amountCad: 75,
  });

  service.addIncomeSource({
    name: "Client Retainer",
    amountPerPeriod: 5000,
    currency: "USD",
    period: "monthly",
    startDate: "2026-01-01",
    confirmed: true,
  });
  service.addIncomeSource({
    name: "Restricted Labs",
    amountPerPeriod: 2000,
    currency: "USD",
    period: "monthly",
    startDate: "2026-03-01",
    confirmed: false,
    guaranteedMonths: 1,
  });

  service.addFxEvent({
    date: "2026-03-08",
    amountFrom: 1000,
    currencyFrom: "USD",
    amountTo: 1365,
    currencyTo: "CAD",
    method: "wire",
  });

  service.categorize([
    {
      externalId: "tx-budget-2",
      category: "Shopping/Office",
      countsTowardBudget: false,
      descriptionClean: "Amazon Workspace",
      note: "work purchase",
    },
  ]);
}

describe("FinanceService", () => {
  test("imports CSV rows with slash dates and comma-formatted amounts", async () => {
    const service = createService();
    const result = await service.importTransactions({
      source: "csv",
      csvText: [
        "Transaction ID,Date,Amount,Description,Account,Currency",
        'tx-1,3/7/2026,"-1,783.17",Mortgage payment,Checking,CAD',
      ].join("\n"),
    });

    expect(result.rowsSeen).toBe(1);
    expect(result.rowsInserted).toBe(1);

    const history = service.history({ limit: 1 });
    expect(history).toContain("2026-03-07");
    expect(history).toContain("-$1,783.17 CAD");
  });

  test("summary exposes the imported sheet link", () => {
    const service = createService();
    const summary = service.summary();

    expect(summary).toContain("Google Sheet:");
    expect(summary).toContain("YOUR_SPREADSHEET_ID");
  });

  test("uses finance runtime config for default paths and seeded defaults", () => {
    updateTestRuntimeConfig((config) => {
      config.finance.enabled = true;
      config.finance.dbPath = "finance/custom-state.sqlite";
      config.finance.forecastConfigPath = "finance/custom-forecast.json";
      config.finance.defaults.settings["budget.weekly_limit_cad"] = "950";
      config.finance.defaults.settings["budget.monthly_limit_cad"] = "4100";
      config.finance.defaults.settings["import.fintable.spreadsheet_id"] = "CONFIGURED_SHEET";
    });

    const service = new FinanceService();
    services.push(service);

    expect(service.getDatabasePath()).toBe(path.join(runtimeConfigRoot, "finance/custom-state.sqlite"));
    expect(service.getForecastConfigPath()).toBe(path.join(runtimeConfigRoot, "finance/custom-forecast.json"));
    expect(service.getSheetInfo().spreadsheetId).toBe("CONFIGURED_SHEET");
    expect(service.getMetadataData().settings.weeklyLimitCad).toBe(950);
    expect(service.getMetadataData().settings.monthlyLimitCad).toBe(4100);
  });

  test("classifies federal tax bill payments as non-discretionary tax", async () => {
    const service = createService();
    await service.importTransactions({
      source: "csv",
      csvText: [
        "Transaction ID,Date,Amount,Description,Account,Currency",
        "tx-tax-1,2026-03-17,-12109.23,Federal tax - Bill payment,Cash,CAD",
      ].join("\n"),
    });

    const transactions = service.listTransactionsStructured({ limit: 5 });
    const tax = transactions.rows.find((row) => row.externalId === "tx-tax-1");
    expect(tax?.category.final).toBe("Tax/Federal");
    expect(tax?.countsTowardBudget.final).toBe(false);
    expect(tax?.review.needsReview).toBe(false);
  });

  test("structured transaction and review data expose raw/auto/user/final fields", async () => {
    const service = createService();
    await seedStructuredFixture(service);

    const transactions = service.listTransactionsStructured({ month: "2026-03", limit: 10 });
    expect(transactions.total).toBe(6);
    expect(transactions.filters.month).toBe("2026-03");
    const amazon = transactions.rows.find((row) => row.externalId === "tx-budget-2");
    expect(amazon).toBeDefined();
    expect(amazon?.category.auto).toBe("Shopping/Online");
    expect(amazon?.category.user).toBe("Shopping/Office");
    expect(amazon?.category.final).toBe("Shopping/Office");
    expect(amazon?.countsTowardBudget.auto).toBe(true);
    expect(amazon?.countsTowardBudget.user).toBe(false);
    expect(amazon?.countsTowardBudget.final).toBe(false);
    expect(amazon?.descriptionFinal).toBe("Amazon Workspace");
    expect(amazon?.review.needsReview).toBe(false);
    expect(amazon?.note).toBe("work purchase");

    const foreign = transactions.rows.find((row) => row.externalId === "tx-foreign-1");
    expect(foreign?.review.needsReview).toBe(true);
    expect(foreign?.review.reasonParts.some((reason) => reason.includes("Non-CAD currency"))).toBe(true);
    expect(foreign?.amountCadResolved).toBeNull();

    const reviewQueue = service.getReviewQueueData(10);
    expect(reviewQueue.total).toBe(1);
    expect(reviewQueue.rows.some((row) => row.externalId === "tx-foreign-1")).toBe(true);
  });

  test("overview, aggregates, liquidity, receivables/payables, recurring, forecast, metadata and what-if are structured", async () => {
    const service = createService();
    await seedStructuredFixture(service);

    const overview = service.getOverviewData("2026-03-12");
    expect(overview.referenceDate).toBe("2026-03-12");
    expect(overview.budget.mode).toBe("week");
    expect(overview.budget.spentCad).toBe(120);
    expect(overview.budget.remaining).toBe(3980);
    expect(overview.netLiquidCad).toBe(0);
    expect(overview.pendingReceivablesCad).toBe(750);
    expect(overview.confirmedPayablesCad).toBe(300);
    expect(overview.netPositionConfirmedCad).toBe(450);
    expect(overview.nextReceivable?.counterparty).toBe("Client B");
    expect(overview.nextPayable?.counterparty).toBe("CRA");

    const categories = service.getCategoryAggregates({ month: "2026-03" });
    const delivery = categories.groups.find((group) => group.category === "Food/Delivery");
    expect(delivery?.spendCad).toBe(220);
    expect(delivery?.incomeCad).toBe(0);
    expect(delivery?.netCad).toBe(220);
    expect(categories.totalSpendCad).toBe(350);
    expect(categories.totalIncomeCad).toBe(20);

    const liquidity = service.getAccountsLiquidityData();
    expect(liquidity.totals.netLiquidCad).toBe(0);

    const receivables = service.getReceivablesData({ today: "2026-03-12", horizonDays: 10 });
    expect(receivables.overdue.map((row) => row.counterparty)).toEqual(["Client B"]);
    expect(receivables.upcoming.map((row) => row.counterparty)).toEqual(["Client A"]);
    expect(receivables.totals.pendingCad).toBe(750);

    const payables = service.getPayablesData({ today: "2026-03-12" });
    expect(payables.totals.confirmedCad).toBe(300);
    expect(payables.totals.totalCad).toBe(1300);
    expect(payables.next?.counterparty).toBe("CRA");

    const recurring = service.getRecurringData({ today: "2026-03-12" });
    expect(recurring.totalMonthlyCad).toBe(125);
    expect(recurring.active.map((row) => row.name)).toEqual(["Netflix", "Gym"]);

    const forecastSummary = service.getForecastSummaryData();
    expect(forecastSummary.income.conservative.totalCad).toBe(84630);
    expect(forecastSummary.income.optimistic.totalCad).toBe(109200);
    expect(forecastSummary.standing.netPositionConfirmedCad).toBe(450);
    expect(forecastSummary.expenses.totalMonthlyCad).toBeGreaterThanOrEqual(recurring.totalMonthlyCad);

    const taxProjection = service.getTaxProjectionData();
    expect(taxProjection.conservative.annual.totalTax).toBeGreaterThan(0);
    expect(taxProjection.optimistic.annual.totalTax).toBeGreaterThan(taxProjection.conservative.annual.totalTax);

    const cashflow = service.getForecastCashflowData();
    expect(cashflow.startingLiquidCad).toBe(0);
    expect(cashflow.conservative[0]?.month).toBe("2026-03");
    expect(cashflow.conservative[0]?.cumulativeCad).toBeGreaterThan(0);

    const importRuns = service.listImportRunsData(5);
    expect(importRuns.rows[0]?.source).toBe("csv");
    expect(importRuns.bySource[0]?.runCount).toBe(1);

    const metadata = service.getMetadataData();
    expect(metadata.reviewCount).toBe(1);
    expect(metadata.finalBudgetCountBreakdown).toEqual([
      { countsTowardBudget: false, count: 3 },
      { countsTowardBudget: true, count: 3 },
    ]);
    expect(metadata.latestImportRun?.rowsInserted).toBe(6);

    const signals = service.getDashboardSignalsData("2026-03-12");
    expect(signals.referenceDate).toBe("2026-03-12");
    expect(signals.currentMonth).toBe("2026-03");
    expect(signals.previousMonth).toBe("2026-02");
    expect(signals.tax.estimatedTaxOnReceivedIncomeCad).toBeGreaterThan(0);
    expect(signals.tax.enoughReservedForEstimatedTax).toBe(false);
    expect(Number.isFinite(signals.tax.estimatedTaxOnReceivedIncomeCad)).toBe(true);
    expect(Number.isFinite(signals.tax.estimatedTaxRateOnReceivedIncome)).toBe(true);
    expect(Number.isFinite(signals.tax.estimatedTaxShortfallCad)).toBe(true);
    expect(signals.tax.estimatedTaxShortfallCad).toBeGreaterThan(0);
    expect(signals.horizons.next30Days.currentTaxBackpayCad).toBe(signals.tax.estimatedTaxShortfallCad);
    expect(signals.horizons.next60Days.currentTaxBackpayCad).toBe(signals.tax.estimatedTaxShortfallCad);
    expect(signals.horizons.endOfYear.currentTaxBackpayCad).toBe(signals.tax.estimatedTaxShortfallCad);
    expect(signals.horizons.endOfYearOptimistic.currentTaxBackpayCad).toBe(signals.tax.estimatedTaxShortfallCad);
    expect(signals.horizons.next30Days.forecastIncomeCad).toBeGreaterThan(0);
    expect(signals.horizons.next60Days.forecastIncomeCad).toBeGreaterThan(signals.horizons.next30Days.forecastIncomeCad);
    expect(signals.horizons.endOfYear.forecastIncomeCad).toBeGreaterThan(signals.horizons.next60Days.forecastIncomeCad);
    expect(signals.horizons.endOfYearOptimistic.forecastIncomeCad).toBeGreaterThan(signals.horizons.endOfYear.forecastIncomeCad);
    expect(signals.horizons.next30Days.forecastTaxReserveCad).toBeGreaterThan(0);
    expect(signals.horizons.next60Days.forecastTaxReserveCad).toBeGreaterThan(signals.horizons.next30Days.forecastTaxReserveCad);
    expect(signals.horizons.endOfYear.forecastTaxReserveCad).toBeGreaterThan(signals.horizons.next60Days.forecastTaxReserveCad);
    expect(signals.horizons.next30Days.budgetedSpendCad).toBeGreaterThan(0);
    expect(signals.horizons.next60Days.budgetedSpendCad).toBeGreaterThan(signals.horizons.next30Days.budgetedSpendCad);
    expect(signals.horizons.endOfYear.budgetedSpendCad).toBeGreaterThan(signals.horizons.next60Days.budgetedSpendCad);
    expect(signals.horizons.endOfYearOptimistic.budgetedSpendCad).toBe(signals.horizons.endOfYear.budgetedSpendCad);
    expect(signals.horizons.next30Days.payableOutflowsCad).toBe(1300);
    expect(signals.horizons.next30Days.recurringOutflowsCad).toBe(125);
    expect(signals.horizons.next60Days.recurringOutflowsCad).toBe(250);
    expect(signals.horizons.endOfYear.recurringOutflowsCad).toBeGreaterThan(signals.horizons.next60Days.recurringOutflowsCad);
    expect(signals.horizons.next30Days.knownOutflowsCad).toBe(1425);
    expect(signals.horizons.next60Days.knownOutflowsCad).toBeGreaterThan(signals.horizons.next30Days.knownOutflowsCad);
    expect(signals.horizons.endOfYear.knownOutflowsCad).toBeGreaterThan(signals.horizons.next60Days.knownOutflowsCad);
    expect(signals.horizons.next30Days.projectedCad).toBeGreaterThan(signals.horizons.next30Days.projectedAfterCurrentTaxBackpayCad);
    expect(signals.horizons.next60Days.projectedCad).toBeGreaterThan(signals.horizons.next60Days.projectedAfterCurrentTaxBackpayCad);
    expect(signals.horizons.endOfYear.projectedCad).toBeGreaterThan(signals.horizons.endOfYear.projectedAfterCurrentTaxBackpayCad);
    expect(signals.horizons.next60Days.projectedAfterCurrentTaxBackpayCad).toBeGreaterThan(signals.horizons.next30Days.projectedAfterCurrentTaxBackpayCad);
    expect(signals.horizons.endOfYear.projectedAfterCurrentTaxBackpayCad).toBeGreaterThan(signals.horizons.next60Days.projectedAfterCurrentTaxBackpayCad);
    expect(signals.horizons.endOfYearOptimistic.projectedAfterCurrentTaxBackpayCad).toBeGreaterThan(signals.horizons.endOfYear.projectedAfterCurrentTaxBackpayCad);
    expect(signals.alerts.some((alert) => alert.id === "review-queue")).toBe(true);
    expect(signals.reminders.some((reminder) => reminder.id === "receivable-2")).toBe(true);
    expect(signals.categoryDeltas[0]?.category).toBe("Food/Delivery");

    const whatIf = service.simulatePurchaseImpact({ purchaseAmountCad: 200, date: "2026-03-12" });
    expect(whatIf.budget.afterRemainingCad).toBe(3780);
    expect(whatIf.budget.afterPaceDeltaCad).toBeCloseTo(-2608.5714285714284, 6);
    expect(whatIf.liquidity.netPositionConfirmedAfterCad).toBe(250);
    expect(whatIf.forecast.conservativeAnnualSurplusAfterCad).toBeGreaterThan(0);
    expect(whatIf.forecast.optimisticAnnualSurplusAfterCad).toBeGreaterThan(
      whatIf.forecast.conservativeAnnualSurplusAfterCad,
    );
    expect(whatIf.forecast.conservativeRunwayMonthsAfter).toBeNull();
  });

  test("infers client income from non-registered balance deltas and clears matching receivables", async () => {
    const service = createService();
    const emptyTransactionsCsv = "Transaction ID,Date,Amount,Description,Account,Currency\n";
    const accountImports = [
      [
        "Account ID,Account Name,Balance,Currency,Last Update,Institution,Raw Data",
        'acct-nr,Non-registered (4R09),1000.00,CAD,2026-03-10T08:00:00+00:00,Wealthsimple (Canada),"{""name"":""Non-registered"",""official_name"":""Non-registered"",""subtype"":""brokerage"",""type"":""investment""}"',
      ].join("\n"),
      [
        "Account ID,Account Name,Balance,Currency,Last Update,Institution,Raw Data",
        'acct-nr,Non-registered (4R09),24000.00,CAD,2026-03-17T08:00:00+00:00,Wealthsimple (Canada),"{""name"":""Non-registered"",""official_name"":""Non-registered"",""subtype"":""brokerage"",""type"":""investment""}"',
      ].join("\n"),
    ];
    let fetchCount = 0;
    const fetcher = async () => {
      const currentImport = Math.floor(fetchCount / 2);
      const isAccounts = fetchCount % 2 === 0;
      fetchCount += 1;
      return isAccounts ? (accountImports[currentImport] ?? accountImports[accountImports.length - 1] ?? "") : emptyTransactionsCsv;
    };

    await service.importTransactions({ source: "fintable_gsheet", fetcher });
    service.addReceivable({
      counterparty: "Remote Client",
      amountCad: 23000,
      earnedDate: "2026-03-01",
      expectedDate: "2026-04-01",
      status: "pending",
    });
    await service.importTransactions({ source: "fintable_gsheet", fetcher });

    const transactions = service.listTransactionsStructured({ limit: 10 });
    const inferred = transactions.rows.find((row) => row.source === "account_balance_inference");
    expect(inferred).toBeDefined();
    expect(inferred?.amount).toBe(23000);
    expect(inferred?.accountName).toBe("Non-registered (4R09)");
    expect(inferred?.category.final).toBe("Income/Client");
    expect(inferred?.note).toContain("Auto-inferred from account balance delta");

    const receivables = service.getReceivablesData({ today: "2026-03-17" });
    expect(receivables.totals.pendingCad).toBe(0);

    const liquidity = service.getAccountsLiquidityData();
    expect(liquidity.liquid.some((row) => row.name === "Non-registered (4R09)")).toBe(true);
    expect(liquidity.registered.some((row) => row.name === "Non-registered (4R09)")).toBe(false);

    const metadata = service.getMetadataData();
    expect(metadata.tableCounts.find((row) => row.table === "account_balance_snapshots")?.count).toBe(2);
  });

  test("recurring rules are editable and tolerate learned amount drift", async () => {
    const service = createService();
    await service.importTransactions({
      source: "csv",
      csvText: [
        "Transaction ID,Date,Amount,Description,Account,Currency,Amount CAD,Raw Data",
        'stream-1,2026-01-01,-15.00,Streaming subscription,Cash,CAD,-15.00,"{""merchant_name"":""StreamCo""}"',
        'stream-2,2026-02-01,-15.00,Streaming subscription,Cash,CAD,-15.00,"{""merchant_name"":""StreamCo""}"',
        'stream-3,2026-03-02,-15.00,Streaming subscription,Cash,CAD,-15.00,"{""merchant_name"":""StreamCo""}"',
      ].join("\n"),
    });

    const candidates = service.getRecurringCandidatesData({ today: "2026-03-17", includeKnown: false, maxAgeDays: 120 });
    const streamCo = candidates.find((row) => row.matchValue === "streamco");
    expect(streamCo).toBeDefined();
    expect(streamCo?.occurrences).toBe(3);

    const added = service.setRecurring({
      name: "StreamCo",
      matchKind: "merchant",
      matchValue: "streamco",
      intervalKind: "monthly",
      amountCad: 15,
      amountToleranceCad: 15,
      currency: "CAD",
      graceDays: 3,
      notes: "Learned from repeated StreamCo charges",
    });
    expect(added.status).toBe("added");

    await service.importTransactions({
      source: "csv",
      csvText: [
        "Transaction ID,Date,Amount,Description,Account,Currency,Amount CAD,Raw Data",
        'stream-4,2026-04-05,-22.00,Streaming subscription,Cash,CAD,-22.00,"{""merchant_name"":""StreamCo""}"',
      ].join("\n"),
    });

    const recurring = service.getRecurringData({ today: "2026-04-10", refresh: true, noAutoSeed: true });
    const streamRule = recurring.rows.find((row) => row.name === "StreamCo");
    expect(streamRule?.lastSeenDate).toBe("2026-04-05");
    expect(streamRule?.nextExpectedDate).toBe("2026-05-05");
    expect(streamRule?.amountToleranceCad).toBe(15);

    const utility = service.setRecurring({
      name: "Utility",
      matchKind: "regex",
      matchValue: "hydro|utility",
      intervalKind: "monthly",
      amountCad: 250,
      amountToleranceCad: 50,
      currency: "CAD",
      graceDays: 3,
      lastSeenDate: "2026-03-01",
      nextExpectedDate: "2026-04-01",
      status: "active",
      notes: "Known active even when the feed misses a charge",
    });
    expect(utility.status).toBe("added");

    const afterManualRefresh = service.getRecurringData({ today: "2026-04-10", refresh: true, noAutoSeed: true });
    const utilityRule = afterManualRefresh.rows.find((row) => row.name === "Utility");
    expect(utilityRule?.status).toBe("active");
    expect(utilityRule?.lastSeenDate).toBe("2026-03-01");
    expect(utilityRule?.nextExpectedDate).toBe("2026-04-01");
    expect(utilityRule?.isPastDue).toBe(true);

    const updated = service.setRecurring({
      id: streamRule?.id,
      amountCad: 22,
      amountToleranceCad: 0,
      notes: "Exact amount after latest bill",
    });
    expect(updated.status).toBe("updated");

    const afterUpdate = service.getRecurringData({ today: "2026-04-10" });
    expect(afterUpdate.rows.find((row) => row.name === "StreamCo")?.amountCad).toBe(22);
    expect(afterUpdate.rows.find((row) => row.name === "StreamCo")?.amountToleranceCad).toBe(0);

    const deleted = service.deleteRecurring(streamRule?.id ?? 0);
    expect(deleted.status).toBe("deleted");
    expect(service.getRecurringData({ today: "2026-04-10" }).rows.find((row) => row.name === "StreamCo")).toBeUndefined();
  });
});
