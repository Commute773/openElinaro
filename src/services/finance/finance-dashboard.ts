import type { Database } from "bun:sqlite";
import type {
  FinanceCategoryAggregateData,
  FinanceDashboardAlertData,
  FinanceDashboardCategoryDeltaData,
  FinanceDashboardReminderData,
  FinanceOverviewData,
  FinancePayableItemData,
  FinancePayablesData,
  FinanceReceivableItemData,
  FinanceReceivablesData,
  FinanceRecurringData,
  FinanceTimelineAggregateData,
  FinanceCategoryAggregatesData,
} from "../finance-dashboard-types";
import type { PayableRecord, ReceivableRecord } from "./finance-types";
import {
  finiteNumber,
  formatCad,
  formatSignedCad,
  formatMoney,
  normText,
  addDays,
  daysBetween,
  stringOrNull,
  numberOrNull,
  toCad,
} from "./finance-helpers";
import {
  allRows,
  getFxRate,
  FINAL_COUNTS,
  FINAL_CATEGORY,
} from "./finance-database";

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
