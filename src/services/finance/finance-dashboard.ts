import type { Database } from "bun:sqlite";
import type {
  FinanceCategoryAggregateData,
  FinancePayableItemData,
  FinancePayablesData,
  FinanceReceivableItemData,
  FinanceReceivablesData,
  FinanceRecurringData,
  FinanceRecurringItemData,
  FinanceTimelineAggregateData,
  FinanceCategoryAggregatesData,
  FinanceSheetInfoData,
  PayableRecord,
  ReceivableRecord,
  RecurringRecord,
} from "./finance-types";
import type {
  FinanceCashflowMonthData,
} from "./finance-forecasting-types";
import type {
  FinanceDashboardAlertData,
  FinanceDashboardCategoryDeltaData,
  FinanceDashboardHorizonPlanData,
  FinanceDashboardReminderData,
  FinanceDashboardSignalsData,
  FinanceOverviewData,
} from "../finance-dashboard-types";
import {
  clamp,
  finiteNumber,
  formatCad,
  formatMoney,
  formatSignedCad,
  heading,
  normText,
  dateKey,
  toIsoDate,
  addDays,
  addMonths,
  daysBetween,
  startEndForMonth,
  stringOrNull,
  numberOrNull,
  toCad,
} from "./finance-helpers";
import {
  allRows,
  getRow,
  getFxRate,
  getSettingOrDefault,
  getNumericSettingOrDefault,
  FINAL_COUNTS,
  FINAL_CATEGORY,
} from "./finance-database";
import {
  resolveBudgetSnapshot,
  describeBudgetPace,
  computeWeeklyBudget,
  renderBudgetBlock,
} from "./finance-budget";
import {
  mapRecurringRow,
  sumRecurringOutflowsWithinHorizon,
  getRecurringCandidatesData,
  refreshRecurringRules,
} from "./finance-recurring";
import {
  loadIncomeSources,
  loadReceivables,
  loadPayables,
  loadAccountBalances,
  proratedForecastMonthValue,
  buildForecastCashflowData,
  buildTaxProjectionData,
} from "./finance-forecasting";
import {
  buildAccountsLiquidityData,
  buildCategoryAggregatesData,
  buildReviewQueueData,
} from "./finance-ledger";
import { sheetCsvUrl } from "./finance-import";
import { loadForecastConfig } from "./finance-database";

export function buildDashboardCategoryDeltas(
  current: FinanceCategoryAggregateData[],
  previous: FinanceCategoryAggregateData[],
): FinanceDashboardCategoryDeltaData[] {
  const previousByCategory = new Map(previous.map((row) => [row.category, row]));
  return current
    .map((row) => {
      const previousRow = previousByCategory.get(row.category);
      const previousSpendCad = previousRow?.spendCad ?? 0;
      return {
        category: row.category,
        currentSpendCad: row.spendCad,
        previousSpendCad,
        deltaCad: row.spendCad - previousSpendCad,
        reviewCount: row.reviewCount,
      } satisfies FinanceDashboardCategoryDeltaData;
    })
    .sort((left, right) => Math.abs(right.deltaCad) - Math.abs(left.deltaCad));
}

export function buildDashboardAlerts(input: {
  overview: FinanceOverviewData;
  receivables: FinanceReceivablesData;
  payables: FinancePayablesData;
  recurring: FinanceRecurringData;
  reviewCount: number;
  current: FinanceCategoryAggregatesData;
  previous: FinanceCategoryAggregatesData;
  trailingTimeline: FinanceTimelineAggregateData[];
  categoryDeltas: FinanceDashboardCategoryDeltaData[];
}): FinanceDashboardAlertData[] {
  const alerts: FinanceDashboardAlertData[] = [];

  if (input.overview.budget.remaining < 0) {
    alerts.push({
      id: "budget-over",
      tone: "critical",
      title: "Weekly budget is already overspent",
      detail: `${formatCad(Math.abs(input.overview.budget.remaining))} below zero with ${formatCad(input.overview.budget.spentCad)} spent this week.`,
    });
  }

  if (input.payables.overdue.length > 0) {
    alerts.push({
      id: "payables-overdue",
      tone: "critical",
      title: `${input.payables.overdue.length} payable${input.payables.overdue.length === 1 ? "" : "s"} overdue`,
      detail: `${formatCad(input.payables.overdue.reduce((sum, row) => sum + row.convertedCad, 0))} is already past due.`,
    });
  }

  if (input.receivables.overdue.length > 0) {
    alerts.push({
      id: "receivables-overdue",
      tone: "warning",
      title: `${input.receivables.overdue.length} receivable${input.receivables.overdue.length === 1 ? "" : "s"} overdue`,
      detail: `${formatCad(input.receivables.overdue.reduce((sum, row) => sum + row.convertedCad, 0))} needs follow-up.`,
    });
  }

  if (input.recurring.halted.length > 0) {
    alerts.push({
      id: "recurring-halted",
      tone: "warning",
      title: `${input.recurring.halted.length} recurring item${input.recurring.halted.length === 1 ? "" : "s"} look stalled`,
      detail: "Recurring obligations were expected but not seen on time.",
    });
  }

  if (input.reviewCount > 0) {
    alerts.push({
      id: "review-queue",
      tone: "warning",
      title: `${input.reviewCount} transaction${input.reviewCount === 1 ? "" : "s"} need review`,
      detail: "Budget totals remain less trustworthy until the review queue is cleared.",
    });
  }

  const trailingMonths = input.trailingTimeline.filter((row) => row.bucket < input.current.filters.month!).slice(-3);
  if (trailingMonths.length >= 2) {
    const avgBudgetNetCad = trailingMonths.reduce((sum, row) => sum + row.budgetNetCad, 0) / trailingMonths.length;
    if (input.current.totalBudgetNetCad > avgBudgetNetCad * 1.2) {
      alerts.push({
        id: "month-spike",
        tone: "warning",
        title: "Current discretionary spend is running hot",
        detail: `${formatCad(input.current.totalBudgetNetCad)} this month vs ${formatCad(avgBudgetNetCad)} trailing three-month average.`,
      });
    }
  }

  const topDelta = input.categoryDeltas[0];
  if (topDelta && topDelta.deltaCad > 150) {
    alerts.push({
      id: "category-spike",
      tone: "warning",
      title: `${topDelta.category} is up sharply month over month`,
      detail: `${formatSignedCad(topDelta.deltaCad)} versus ${input.previous.filters.month ?? "the previous month"}.`,
    });
  }

  if (input.overview.confirmedPayablesCad > input.overview.netLiquidCad + input.overview.pendingReceivablesCad) {
    alerts.push({
      id: "liquidity-gap",
      tone: "critical",
      title: "Confirmed payables exceed liquid coverage",
      detail: `${formatCad(input.overview.confirmedPayablesCad - (input.overview.netLiquidCad + input.overview.pendingReceivablesCad))} gap after pending receivables.`,
    });
  }

  return alerts.slice(0, 6);
}

export function buildDashboardReminders(input: {
  today: string;
  receivables: FinanceReceivablesData;
  payables: FinancePayablesData;
  recurring: FinanceRecurringData;
}): FinanceDashboardReminderData[] {
  const reminders: FinanceDashboardReminderData[] = [];

  for (const row of input.payables.rows.filter((entry) => entry.isOverdue || daysBetween(input.today, entry.dueDate) <= 14)) {
    reminders.push({
      id: `payable-${row.id}`,
      tone: row.isOverdue ? "critical" : "warning",
      title: row.isOverdue ? "Payable overdue" : "Payable due soon",
      dueDate: row.dueDate,
      amountCad: row.convertedCad,
      detail: `${row.counterparty}${row.description ? ` · ${row.description}` : ""}`,
    });
  }

  for (const row of input.receivables.rows.filter((entry) => entry.isOverdue || daysBetween(input.today, entry.expectedDate) <= 14)) {
    reminders.push({
      id: `receivable-${row.id}`,
      tone: row.isOverdue ? "warning" : "positive",
      title: row.isOverdue ? "Receivable overdue" : "Receivable landing soon",
      dueDate: row.expectedDate,
      amountCad: row.convertedCad,
      detail: `${row.counterparty} · ${row.nextAction}`,
    });
  }

  for (const row of input.recurring.rows.filter((entry) => entry.nextExpectedDate && daysBetween(input.today, entry.nextExpectedDate) <= 10)) {
    reminders.push({
      id: `recurring-${row.id}`,
      tone: row.isPastDue ? "warning" : "neutral",
      title: row.isPastDue ? "Recurring item missed" : "Recurring charge approaching",
      dueDate: row.nextExpectedDate ?? input.today,
      amountCad: row.amountCad,
      detail: row.name,
    });
  }

  return reminders
    .sort((left, right) => left.dueDate.localeCompare(right.dueDate))
    .slice(0, 8);
}

export function findTaxAccountBalanceCad(
  db: Database,
  defaultSettings: Record<string, string>,
  getAccountsLiquidityDataFn: () => { accounts: Array<{ name: string; balanceCad: number }> },
) {
  const taxAccount = getAccountsLiquidityDataFn().accounts.find((row) => normText(row.name).includes("tax"));
  return taxAccount?.balanceCad ?? 0;
}

export function isTaxCategory(category: string | null) {
  const normalized = normText(category ?? "");
  return normalized === "tax" || normalized.startsWith("tax/");
}

export function computeIncomeImportSanity(
  db: Database,
  referenceDate: string,
  fxRate: number,
  loadIncomeSourcesFn: () => Array<Record<string, unknown>>,
) {
  const currentMonth = referenceDate.slice(0, 7);
  const completedMonths = Math.max(0, Number.parseInt(currentMonth.slice(5, 7), 10) - 1);
  const yearStart = `${referenceDate.slice(0, 4)}-01-01`;
  const received = allRows<Record<string, unknown>>(
    db,
    `SELECT amount, currency, amount_cad, ${FINAL_CATEGORY} AS category_final
      FROM transactions
      WHERE posted_date >= ? AND posted_date < ? AND amount > 0`,
    yearStart,
    addDays(referenceDate, 1),
  ).filter((row) => {
    const category = String(row.category_final ?? "");
    return category === "Income/Client" || category === "Income/Contract";
  });
  const clientIncomeReceivedYtdCad = received.reduce(
    (sum, row) => sum + Number(row.amount_cad ?? row.amount ?? 0),
    0,
  );
  const clientIncomeReceivedYtdUsd = clientIncomeReceivedYtdCad / fxRate;

  const sources = loadIncomeSourcesFn().filter((row) => Number(row.confirmed ?? 0) === 1);
  const expectedConfirmedReceivedYtdUsd = sources.reduce((sum, row) => {
    const startDate = String(row.start_date ?? "");
    const startMonth = startDate.slice(0, 7);
    const eligibleMonths = completedMonths - Math.max(0, Number.parseInt(startMonth.slice(5, 7) || "1", 10) - 1);
    if (eligibleMonths <= 0) {
      return sum;
    }
    const amountPerPeriod = Number(row.amount_per_period ?? 0);
    const period = String(row.period ?? "monthly");
    if (period === "monthly") {
      return sum + amountPerPeriod * eligibleMonths;
    }
    if (period === "biweekly") {
      return sum + (amountPerPeriod * 26 / 12) * eligibleMonths;
    }
    return sum + amountPerPeriod * eligibleMonths;
  }, 0);
  const expectedConfirmedReceivedYtdCad = expectedConfirmedReceivedYtdUsd * fxRate;
  const importGapCad = expectedConfirmedReceivedYtdCad - clientIncomeReceivedYtdCad;

  return {
    clientIncomeReceivedYtdCad,
    clientIncomeReceivedYtdUsd,
    expectedConfirmedReceivedYtdCad,
    expectedConfirmedReceivedYtdUsd,
    importGapCad,
    importLooksWrong: importGapCad > 5000,
  };
}

export function receivableNextAction(status: string) {
  return ({
    pending: 'Send invoice / confirm timeline',
    invoiced: 'Follow up receipt + date',
    chasing: 'Escalate / firm date',
  }[status] ?? 'Follow up');
}

export function mapReceivableRow(row: ReceivableRecord, today: string, fxRate: number): FinanceReceivableItemData {
  const currency = String(row.currency ?? 'CAD').toUpperCase();
  return {
    id: Number(row.id ?? 0),
    counterparty: String(row.counterparty ?? ''),
    amount: numberOrNull(row.amount),
    currency,
    amountCad: numberOrNull(row.amount_cad),
    convertedCad: toCad(Number(row.amount ?? row.amount_cad ?? 0), currency, fxRate),
    earnedDate: String(row.earned_date ?? ''),
    expectedDate: String(row.expected_date ?? ''),
    status: String(row.status ?? ''),
    lastFollowupDate: stringOrNull(row.last_followup_date),
    notes: stringOrNull(row.notes),
    isOverdue: String(row.expected_date ?? '') < today,
    nextAction: receivableNextAction(String(row.status ?? '')),
  };
}

export function mapPayableRow(row: PayableRecord, today: string, fxRate: number): FinancePayableItemData {
  const currency = String(row.currency ?? 'CAD').toUpperCase();
  const certaintyValue = String(row.certainty ?? 'confirmed');
  const certainty = (certaintyValue === 'expected' || certaintyValue === 'speculative' ? certaintyValue : 'confirmed') as FinancePayableItemData['certainty'];
  return {
    id: Number(row.id ?? 0),
    counterparty: String(row.counterparty ?? ''),
    description: stringOrNull(row.description),
    amount: Number(row.amount ?? 0),
    currency,
    amountCad: numberOrNull(row.amount_cad),
    convertedCad: toCad(Number(row.amount ?? 0), currency, fxRate),
    dueDate: String(row.due_date ?? ''),
    certainty,
    category: stringOrNull(row.category),
    status: String(row.status ?? 'pending'),
    notes: stringOrNull(row.notes),
    isOverdue: String(row.due_date ?? '') < today,
  };
}

export function buildReceivablesData(db: Database, defaultSettings: Record<string, string>, options?: { today?: string; horizonDays?: number; status?: string }): FinanceReceivablesData {
  const today = options?.today ? toIsoDate(options.today) : dateKey(new Date());
  const horizonDays = options?.horizonDays ?? 14;
  const horizonDate = addDays(today, horizonDays);
  const fxRate = getFxRate(db, defaultSettings);
  const rows = loadReceivables(db, options?.status).map((row) => mapReceivableRow(row, today, fxRate));
  const overdue = rows.filter((row) => row.isOverdue);
  const upcoming = rows.filter((row) => !row.isOverdue && row.expectedDate <= horizonDate);
  return {
    today,
    horizonDays,
    horizonDate,
    totals: {
      pendingCad: rows.reduce((sum, row) => sum + row.convertedCad, 0),
      overdueCad: overdue.reduce((sum, row) => sum + row.convertedCad, 0),
      upcomingCad: upcoming.reduce((sum, row) => sum + row.convertedCad, 0),
    },
    next: rows[0] ?? null,
    overdue,
    upcoming,
    rows,
  };
}

export function buildPayablesData(db: Database, defaultSettings: Record<string, string>, options?: { today?: string; status?: string }): FinancePayablesData {
  const today = options?.today ? toIsoDate(options.today) : dateKey(new Date());
  const fxRate = getFxRate(db, defaultSettings);
  const rows = loadPayables(db, options?.status ?? 'pending').map((row) => mapPayableRow(row, today, fxRate));
  const overdue = rows.filter((row) => row.isOverdue);
  return {
    today,
    totals: {
      confirmedCad: rows.filter((row) => row.certainty === 'confirmed').reduce((sum, row) => sum + row.convertedCad, 0),
      expectedCad: rows.filter((row) => row.certainty === 'expected').reduce((sum, row) => sum + row.convertedCad, 0),
      speculativeCad: rows.filter((row) => row.certainty === 'speculative').reduce((sum, row) => sum + row.convertedCad, 0),
      totalCad: rows.reduce((sum, row) => sum + row.convertedCad, 0),
    },
    next: rows[0] ?? null,
    overdue,
    rows,
  };
}

export function buildRecurringData(db: Database, options?: { today?: string; refresh?: boolean; noAutoSeed?: boolean; seedLimit?: number }): import("./finance-types").FinanceRecurringData {
  const today = options?.today ? toIsoDate(options.today) : dateKey(new Date());
  const refreshResult = options?.refresh
    ? refreshRecurringRules(db, today, !(options?.noAutoSeed ?? false), options?.seedLimit ?? 12)
    : null;
  const rows = allRows<RecurringRecord>(
    db,
    'SELECT * FROM recurring ORDER BY status ASC, next_expected_date ASC, id ASC',
  ).map((row) => mapRecurringRow(row, today));
  return {
    today,
    totalMonthlyCad: rows.filter((row) => row.status === 'active').reduce((sum, row) => sum + row.monthlyCad, 0),
    active: rows.filter((row) => row.status === 'active'),
    halted: rows.filter((row) => row.status === 'halted'),
    rows,
    candidates: getRecurringCandidatesData(db, { today, includeKnown: false, maxAgeDays: 365 }),
    refresh: refreshResult
      ? {
          seeded: refreshResult.seeded.map((row) => mapRecurringRow(row, today)),
          active: refreshResult.active.map((row) => mapRecurringRow(row, today)),
          halted: refreshResult.halted.map((row) => mapRecurringRow(row, today)),
        }
      : null,
  };
}

export function buildDashboardHorizonPlan(input: {
  referenceDate: string;
  horizonDays: number;
  startingCashCad: number;
  taxReserveCad: number;
  currentTaxBackpayCad: number;
  taxAccountBalanceCad: number;
  receivables: FinanceReceivablesData;
  payables: FinancePayablesData;
  recurring: import("./finance-types").FinanceRecurringData;
  forecastMonths: Array<Omit<FinanceCashflowMonthData, "cumulativeCad"> | FinanceCashflowMonthData>;
}): FinanceDashboardHorizonPlanData {
  const horizonEndExclusive = addDays(input.referenceDate, input.horizonDays + 1);
  const payableOutflowsCad = input.payables.rows
    .filter((row) => {
      const delta = daysBetween(input.referenceDate, row.dueDate);
      return delta >= 0 && delta <= input.horizonDays;
    })
    .reduce((sum, row) => sum + finiteNumber(row.convertedCad), 0);
  const recurringOutflowsCad = input.recurring.rows
    .filter((row) => row.status === "active")
    .reduce((sum, row) => sum + sumRecurringOutflowsWithinHorizon(row, input.referenceDate, horizonEndExclusive), 0);
  const knownOutflowsCad = finiteNumber(payableOutflowsCad + recurringOutflowsCad);
  const expectedReceivablesCad = input.receivables.rows
    .filter((row) => {
      const delta = daysBetween(input.referenceDate, row.expectedDate);
      return delta >= 0 && delta <= input.horizonDays;
    })
    .reduce((sum, row) => sum + finiteNumber(row.convertedCad), 0);
  const forecastIncomeCad = input.forecastMonths.reduce((sum, row) => {
    return sum + proratedForecastMonthValue(row.month, finiteNumber(row.incomeCad), input.referenceDate, horizonEndExclusive);
  }, 0);
  const forecastTaxReserveCad = input.forecastMonths.reduce((sum, row) => {
    return sum + proratedForecastMonthValue(row.month, finiteNumber(row.taxSetAside), input.referenceDate, horizonEndExclusive);
  }, 0);
  const budgetedSpendCad = input.forecastMonths.reduce((sum, row) => {
    return sum + proratedForecastMonthValue(row.month, finiteNumber(row.discretionaryCad), input.referenceDate, horizonEndExclusive);
  }, 0);
  const afterTaxReserveCad = finiteNumber(input.startingCashCad - input.taxReserveCad);
  const afterCurrentTaxBackpayCad = finiteNumber(input.startingCashCad - input.currentTaxBackpayCad);
  const projectedTaxReserveCad = finiteNumber(input.taxReserveCad + forecastTaxReserveCad);
  const projectedTaxShortfallCad = finiteNumber(Math.max(projectedTaxReserveCad - input.taxAccountBalanceCad, 0));
  const projectedCad = finiteNumber(
    input.startingCashCad
    + expectedReceivablesCad
    + forecastIncomeCad
    - forecastTaxReserveCad
    - budgetedSpendCad
    - knownOutflowsCad,
  );
  const projectedAfterCurrentTaxBackpayCad = finiteNumber(projectedCad - input.currentTaxBackpayCad);
  return {
    days: input.horizonDays,
    startingCashCad: finiteNumber(input.startingCashCad),
    taxReserveCad: finiteNumber(input.taxReserveCad),
    currentTaxBackpayCad: finiteNumber(input.currentTaxBackpayCad),
    afterTaxReserveCad,
    afterCurrentTaxBackpayCad,
    expectedReceivablesCad,
    forecastIncomeCad: finiteNumber(forecastIncomeCad),
    forecastTaxReserveCad: finiteNumber(forecastTaxReserveCad),
    budgetedSpendCad: finiteNumber(budgetedSpendCad),
    payableOutflowsCad: finiteNumber(payableOutflowsCad),
    recurringOutflowsCad: finiteNumber(recurringOutflowsCad),
    knownOutflowsCad: finiteNumber(knownOutflowsCad),
    projectedTaxReserveCad,
    projectedTaxShortfallCad,
    projectedCad,
    projectedAfterCurrentTaxBackpayCad,
    status: projectedAfterCurrentTaxBackpayCad >= 0 ? "on_track" : "short",
  };
}

export function buildOverviewData(
  db: Database,
  defaultSettings: Record<string, string>,
  reference: Date | string = new Date(),
): FinanceOverviewData {
  const referenceDate = typeof reference === 'string' ? toIsoDate(reference) : dateKey(reference);
  const budget = resolveBudgetSnapshot(db, referenceDate, defaultSettings);
  const accounts = buildAccountsLiquidityDataForOverview(db, defaultSettings);
  const receivables = buildReceivablesData(db, defaultSettings, { today: referenceDate });
  const payables = buildPayablesData(db, defaultSettings, { today: referenceDate });
  const reviewCount = Number(getRow<{ count: number }>(db, "SELECT COUNT(1) AS count FROM transactions WHERE needs_review = 1")?.count ?? 0);
  return {
    referenceDate,
    budget,
    paceIndicator: describeBudgetPace(budget),
    reviewCount,
    netLiquidCad: accounts.totals.netLiquidCad,
    pendingReceivablesCad: receivables.totals.pendingCad,
    confirmedPayablesCad: payables.totals.confirmedCad,
    netPositionConfirmedCad: accounts.totals.netLiquidCad + receivables.totals.pendingCad - payables.totals.confirmedCad,
    netPositionAllCad: accounts.totals.netLiquidCad + receivables.totals.pendingCad - payables.totals.totalCad,
    nextReceivable: receivables.next,
    nextPayable: payables.next,
  };
}

function buildAccountsLiquidityDataForOverview(db: Database, defaultSettings: Record<string, string>) {
  return buildAccountsLiquidityData(db, defaultSettings);
}

export function buildSheetInfo(db: Database, defaultSettings: Record<string, string>): FinanceSheetInfoData {
  const spreadsheetId = getSettingOrDefault(db, "import.fintable.spreadsheet_id", defaultSettings);
  const accountsGid = getSettingOrDefault(db, "import.fintable.accounts_gid", defaultSettings);
  const transactionsGid = getSettingOrDefault(db, "import.fintable.transactions_gid", defaultSettings);
  return {
    spreadsheetId,
    accountsGid,
    transactionsGid,
    sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${transactionsGid}`,
    accountsCsvUrl: sheetCsvUrl(spreadsheetId, accountsGid),
    transactionsCsvUrl: sheetCsvUrl(spreadsheetId, transactionsGid),
  };
}

export function renderSummaryText(
  db: Database,
  defaultSettings: Record<string, string>,
  reference: Date = new Date(),
) {
  const today = dateKey(reference);
  const weeklyStart = toIsoDate(getSettingOrDefault(db, "budget.weekly_start_date", defaultSettings));
  const weeklyLimit = getNumericSettingOrDefault(db, "budget.weekly_limit_cad", defaultSettings);
  let output = "";

  if (today >= weeklyStart) {
    const budget = computeWeeklyBudget(db, today, weeklyLimit, weeklyStart);
    output += `${heading("Budget")}\n${renderBudgetBlock(db, budget, defaultSettings)}\n`;
    const recent = allRows<Record<string, unknown>>(
      db,
      `SELECT posted_date, amount, currency, amount_cad, ${FINAL_CATEGORY} AS category,
          COALESCE(description_clean, description_raw) AS description
        FROM transactions
        WHERE posted_date >= ? AND posted_date < ? AND amount < 0 AND ${FINAL_COUNTS} = 1
          AND (currency = 'CAD' OR amount_cad IS NOT NULL)
        ORDER BY posted_date DESC, id DESC LIMIT 8`,
      budget.weekStart,
      budget.weekEndExclusive,
    );
    output += heading("Recent discretionary (this week)");
    output += recent.length === 0
      ? "\n(none)\n"
      : `\n${recent.map((row) => {
          const amountCad = Number(row.amount_cad ?? row.amount ?? 0);
          return `- ${row.posted_date}: ${formatCad(Math.abs(amountCad))} | ${row.category} | ${row.description}`;
        }).join("\n")}\n`;
  }

  const reviewCount = Number(getRow<{ count: number }>(db, "SELECT COUNT(1) AS count FROM transactions WHERE needs_review = 1")?.count ?? 0);
  const reviewRows = allRows<Record<string, unknown>>(
    db,
    `SELECT id, posted_date, amount, currency, amount_cad, COALESCE(merchant_name, '') AS merchant,
        ${FINAL_CATEGORY} AS category, ${FINAL_COUNTS} AS counts_toward_budget,
        review_reason, COALESCE(description_clean, description_raw) AS description
      FROM transactions
      WHERE needs_review = 1
      ORDER BY posted_date DESC, id DESC LIMIT 10`,
  );
  output += heading(`Needs review (${reviewCount})`);
  output += reviewRows.length === 0
    ? "\n(none)\n"
    : `\n${reviewRows.map((row, index) => {
        const amount = Number(row.amount_cad ?? row.amount ?? 0);
        const display = Number(row.amount ?? 0) < 0 ? formatCad(Math.abs(amount)) : formatCad(amount);
        const who = String(row.merchant || row.description || "").trim();
        return `${index + 1}) ${row.posted_date} ${display} | ${who} | suggest ${row.category} | counts=${row.counts_toward_budget} | ${row.review_reason ?? "?"} [id:${row.id}]`;
      }).join("\n")}\n`;

  const overdue = allRows<Record<string, unknown>>(
    db,
    "SELECT counterparty, amount_cad, expected_date, status FROM receivables WHERE status <> 'received' AND expected_date < ? ORDER BY expected_date",
    today,
  );
  const dueSoon = allRows<Record<string, unknown>>(
    db,
    "SELECT counterparty, amount_cad, expected_date, status FROM receivables WHERE status <> 'received' AND expected_date >= ? AND expected_date <= date(?, '+14 day') ORDER BY expected_date",
    today,
    today,
  );
  output += heading("Accounts receivable");
  if (overdue.length === 0 && dueSoon.length === 0) {
    output += "\n(none due soon / overdue)";
  } else {
    if (overdue.length > 0) {
      output += `\nOverdue:\n${overdue.map((row) => `- ${row.counterparty}: ${formatCad(Number(row.amount_cad ?? 0))} (expected ${row.expected_date}, ${row.status})`).join("\n")}`;
    }
    if (dueSoon.length > 0) {
      output += `\nDue soon:\n${dueSoon.map((row) => `- ${row.counterparty}: ${formatCad(Number(row.amount_cad ?? 0))} (expected ${row.expected_date}, ${row.status})`).join("\n")}`;
    }
  }

  const sheet = buildSheetInfo(db, defaultSettings);
  output += `${heading("Source")}\nGoogle Sheet: ${sheet.sheetUrl}`;

  return output.trim();
}

export function buildDashboardSignalsData(
  db: Database,
  defaultSettings: Record<string, string>,
  forecastConfigPath: string,
  reference: Date | string = new Date(),
): FinanceDashboardSignalsData {
  const referenceDate = typeof reference === 'string' ? toIsoDate(reference) : dateKey(reference);
  const currentMonth = referenceDate.slice(0, 7);
  const previousMonth = addMonths(`${currentMonth}-01`, -1).slice(0, 7);
  const trailingStartMonth = addMonths(`${currentMonth}-01`, -3).slice(0, 7);
  const yearStart = `${referenceDate.slice(0, 4)}-01-01`;
  const overview = buildOverviewData(db, defaultSettings, referenceDate);
  const receivables = buildReceivablesData(db, defaultSettings, { today: referenceDate });
  const payables = buildPayablesData(db, defaultSettings, { today: referenceDate });
  const recurring = buildRecurringData(db, { today: referenceDate });
  const review = buildReviewQueueData(db, 25);
  const current = buildCategoryAggregatesData(db, { month: currentMonth });
  const previous = buildCategoryAggregatesData(db, { month: previousMonth });
  const ytd = buildCategoryAggregatesData(db, { fromDate: yearStart, toDate: addDays(referenceDate, 1) });
  const trailing = buildCategoryAggregatesData(db, {
    fromDate: startEndForMonth(trailingStartMonth).from,
    toDate: startEndForMonth(currentMonth).toExclusive,
  });
  const taxAccountBalanceCadVal = finiteNumber(findTaxAccountBalanceCad(db, defaultSettings, () => buildAccountsLiquidityData(db, defaultSettings)));
  const dueNowCad = payables.rows
    .filter((row) => row.status !== "paid" && isTaxCategory(row.category))
    .reduce((sum, row) => sum + finiteNumber(row.convertedCad), 0);
  const fxRate = getFxRate(db, defaultSettings);
  const incomeSanity = computeIncomeImportSanity(db, referenceDate, fxRate, () => loadIncomeSources(db));
  const forecastConfig = loadForecastConfig(forecastConfigPath);
  const taxProjection = buildTaxProjectionData(db, forecastConfig, defaultSettings);
  const estimatedTaxRateOnReceivedIncome = finiteNumber(taxProjection.conservative.currentRate.rate);
  const estimatedTaxOnReceivedIncomeCad = finiteNumber(
    finiteNumber(incomeSanity.clientIncomeReceivedYtdCad) * estimatedTaxRateOnReceivedIncome,
  );
  const estimatedTaxShortfallCad = finiteNumber(Math.max(estimatedTaxOnReceivedIncomeCad - taxAccountBalanceCadVal, 0));
  const cashflow = buildForecastCashflowData(db, forecastConfig, defaultSettings);
  const horizonBase = {
    referenceDate,
    startingCashCad: overview.netLiquidCad,
    taxReserveCad: estimatedTaxOnReceivedIncomeCad,
    currentTaxBackpayCad: estimatedTaxShortfallCad,
    taxAccountBalanceCad: taxAccountBalanceCadVal,
    receivables,
    payables,
    recurring,
  };
  const next30Days = buildDashboardHorizonPlan({
    ...horizonBase,
    horizonDays: 30,
    forecastMonths: cashflow.conservative,
  });
  const next60Days = buildDashboardHorizonPlan({
    ...horizonBase,
    horizonDays: 60,
    forecastMonths: cashflow.conservative,
  });
  const yearEnd = `${referenceDate.slice(0, 4)}-12-31`;
  const endOfYear = buildDashboardHorizonPlan({
    ...horizonBase,
    horizonDays: Math.max(0, daysBetween(referenceDate, yearEnd)),
    forecastMonths: cashflow.conservative,
  });
  const endOfYearOptimistic = buildDashboardHorizonPlan({
    ...horizonBase,
    horizonDays: Math.max(0, daysBetween(referenceDate, yearEnd)),
    forecastMonths: cashflow.optimistic,
  });
  const categoryDeltas = buildDashboardCategoryDeltas(current.groups, previous.groups);
  const alerts = buildDashboardAlerts({
    overview,
    receivables,
    payables,
    recurring,
    reviewCount: review.total,
    current,
    previous,
    trailingTimeline: trailing.timeline,
    categoryDeltas,
  });
  const reminders = buildDashboardReminders({
    today: referenceDate,
    receivables,
    payables,
    recurring,
  });
  const completedTrailingMonths = trailing.timeline.filter((row) => row.bucket < currentMonth).slice(-3);
  const trailingThreeMonthBudgetAverageCad = completedTrailingMonths.length > 0
    ? completedTrailingMonths.reduce((sum, row) => sum + row.budgetNetCad, 0) / completedTrailingMonths.length
    : null;

  return {
    referenceDate,
    currentMonth,
    previousMonth,
    spend: {
      currentMonthTotalCad: current.totalSpendCad,
      currentMonthDiscretionaryCad: current.totalBudgetNetCad,
      ytdTotalCad: ytd.totalSpendCad,
      ytdDiscretionaryCad: ytd.totalBudgetNetCad,
    },
    tax: {
      dueNowCad,
      taxAccountBalanceCad: taxAccountBalanceCadVal,
      coverageCad: finiteNumber(taxAccountBalanceCadVal - dueNowCad),
      enoughInTaxAccount: taxAccountBalanceCadVal >= dueNowCad,
      estimatedTaxOnReceivedIncomeCad,
      estimatedTaxRateOnReceivedIncome,
      estimatedTaxShortfallCad,
      enoughReservedForEstimatedTax: estimatedTaxShortfallCad === 0,
    },
    income: incomeSanity,
    currentBudgetNetCad: current.totalBudgetNetCad,
    previousBudgetNetCad: previous.totalBudgetNetCad,
    currentSpendCad: current.totalSpendCad,
    previousSpendCad: previous.totalSpendCad,
    trailingThreeMonthBudgetAverageCad,
    horizons: {
      next30Days,
      next60Days,
      endOfYear,
      endOfYearOptimistic,
    },
    alerts,
    reminders,
    categoryDeltas,
  };
}
