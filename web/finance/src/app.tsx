import { useEffect, useState, useTransition, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  FinanceImportRunRowData,
  FinanceNormalizedTransaction,
  FinanceRecurringItemData,
} from "../../../src/services/finance-dashboard-types.ts";
import {
  getAccounts,
  getBudget,
  getForecastCashflow,
  getForecastSummary,
  getFxInfo,
  getImportRuns,
  getIncomeSources,
  getMetadata,
  getOverview,
  getPayables,
  getReceivables,
  getRecurring,
  getReview,
  getSignals,
  getSpending,
  getTaxProjection,
  getTransactions,
  importFinance,
  saveSettings,
  simulateWhatIf,
  submitReview,
  type FinanceBudgetEnvelope,
  type FinanceImportResponse,
  type FinanceMetadataEnvelope,
  type ReviewDecisionInput,
  type SettingsUpdateInput,
  type TransactionsFilterInput,
} from "./api";

type TabId = "overview" | "insights" | "forecast" | "operations" | "review" | "setup";
type AlertTone = "critical" | "warning" | "positive" | "neutral";

interface DashboardState {
  metadata: FinanceMetadataEnvelope;
  overview: Awaited<ReturnType<typeof getOverview>>;
  accounts: Awaited<ReturnType<typeof getAccounts>>;
  budget: FinanceBudgetEnvelope;
  timeline: Awaited<ReturnType<typeof getSpending>>;
  currentMonth: Awaited<ReturnType<typeof getSpending>>;
  previousMonth: Awaited<ReturnType<typeof getSpending>>;
  receivables: Awaited<ReturnType<typeof getReceivables>>;
  payables: Awaited<ReturnType<typeof getPayables>>;
  recurring: Awaited<ReturnType<typeof getRecurring>>;
  forecastSummary: Awaited<ReturnType<typeof getForecastSummary>>;
  cashflow: Awaited<ReturnType<typeof getForecastCashflow>>;
  tax: Awaited<ReturnType<typeof getTaxProjection>>;
  incomeSources: Awaited<ReturnType<typeof getIncomeSources>>;
  importRuns: Awaited<ReturnType<typeof getImportRuns>>;
  review: Awaited<ReturnType<typeof getReview>>;
  signals: Awaited<ReturnType<typeof getSignals>>;
  transactions: Awaited<ReturnType<typeof getTransactions>>;
  fx: Awaited<ReturnType<typeof getFxInfo>>;
  whatIf: Awaited<ReturnType<typeof simulateWhatIf>>;
}

interface SetupFormState {
  timezone: string;
  weeklyLimitCad: string;
  monthlyLimitCad: string;
  weeklyStartDate: string;
  fxUsdCad: string;
  spreadsheetId: string;
  accountsGid: string;
  transactionsGid: string;
}

interface ReviewFormState {
  category: string;
  countsTowardBudget: boolean;
  descriptionClean: string;
  note: string;
}

interface BreakdownItem {
  id: string;
  label: string;
  value?: number;
  note?: string;
  signed?: boolean;
}

interface BalanceLine {
  id: string;
  label: string;
  value: number;
  signed?: boolean;
  total?: boolean;
  tone?: "positive" | "critical";
  details: BreakdownItem[];
}

const TAB_ORDER: Array<{ id: TabId; label: string; eyebrow: string }> = [
  { id: "overview", label: "Overview", eyebrow: "Current position" },
  { id: "insights", label: "Insights", eyebrow: "Trends and anomalies" },
  { id: "forecast", label: "Forecast", eyebrow: "Cashflow and tax" },
  { id: "operations", label: "Operations", eyebrow: "AR, AP, recurring" },
  { id: "review", label: "Review", eyebrow: "Transactions and queue" },
  { id: "setup", label: "Setup", eyebrow: "Onboarding and imports" },
];

const CHART_COLORS = {
  teal: "#007a78",
  coral: "#d86045",
  gold: "#d59b0d",
  navy: "#28435f",
  mint: "#5abf95",
  plum: "#6f587e",
  sky: "#7da8d8",
  paper: "#f4efe6",
};

const DEFAULT_TX_FILTERS: TransactionsFilterInput = {
  month: "",
  search: "",
  account: "",
  category: "",
  limit: 50,
  onlyBudget: false,
  onlyReview: false,
};

function formatMoney(value: number, options?: { signed?: boolean; digits?: number }) {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    maximumFractionDigits: options?.digits ?? 0,
    minimumFractionDigits: options?.digits ?? 0,
    signDisplay: options?.signed ? "always" : "auto",
  }).format(value);
}

function formatNumber(value: number, digits = 0) {
  return new Intl.NumberFormat("en-CA", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);
}

function formatPercent(value: number, digits = 0) {
  return `${(value * 100).toFixed(digits)}%`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatMonth(value: string) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "short",
  }).format(new Date(`${value}-01T12:00:00`));
}

function tooltipMoney(value: unknown) {
  return formatMoney(Number(value ?? 0));
}

function tooltipMonth(label: unknown) {
  return typeof label === "string" ? formatMonth(label) : String(label ?? "");
}

function monthKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
}

function subtractMonths(month: string, count: number) {
  const [year, monthIndex] = month.split("-").map(Number);
  const next = new Date((year ?? 2026), (monthIndex ?? 1) - 1 - count, 1, 12, 0, 0, 0);
  return monthKey(next);
}

function startOfMonth(month: string) {
  return `${month}-01`;
}

function classNames(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function deltaTone(value: number) {
  if (value < 0) {
    return "positive";
  }
  if (value > 0) {
    return "critical";
  }
  return "neutral";
}

function formatBudgetState(tx: FinanceNormalizedTransaction) {
  if (tx.countsTowardBudget.final) {
    return "Counts toward budget";
  }
  return "Excluded from budget";
}

function buildSetupChecklist(state: DashboardState) {
  const settings = state.metadata.serviceMetadata.settings;
  return [
    {
      label: "Source sheet configured",
      done: Boolean(state.metadata.serviceMetadata.sheet.spreadsheetId && state.metadata.serviceMetadata.sheet.transactionsGid),
      detail: state.metadata.serviceMetadata.sheet.sheetUrl,
    },
    {
      label: "Accounts imported",
      done: state.metadata.serviceMetadata.tableCounts.some((row) => row.table === "accounts" && row.count > 0),
      detail: `${state.accounts.accounts.length} account rows available`,
    },
    {
      label: "Transactions imported",
      done: state.metadata.serviceMetadata.tableCounts.some((row) => row.table === "transactions" && row.count > 0),
      detail: `${formatNumber(state.transactions.total)} transactions in the ledger`,
    },
    {
      label: "Budget settings configured",
      done: Boolean(settings.weeklyLimitCad > 0 && settings.weeklyStartDate),
      detail: `${formatMoney(settings.weeklyLimitCad)}/week from ${settings.weeklyStartDate ?? "unset"}`,
    },
    {
      label: "Latest import healthy",
      done: Boolean(state.importRuns.rows[0] && !state.importRuns.rows[0].error),
      detail: state.importRuns.rows[0]
        ? `${formatDateTime(state.importRuns.rows[0].startedAt)} · ${formatNumber(state.importRuns.rows[0].rowsSeen)} rows`
        : "No import run recorded yet",
    },
  ];
}

function collectCategoryOptions(state: DashboardState) {
  const categories = new Set<string>();
  for (const row of state.transactions.rows) {
    if (row.category.final) {
      categories.add(row.category.final);
    }
  }
  for (const row of state.currentMonth.groups) {
    categories.add(row.category);
  }
  return Array.from(categories).sort((left, right) => left.localeCompare(right));
}

function collectAccountOptions(state: DashboardState) {
  const accounts = new Set<string>();
  for (const row of state.accounts.accounts) {
    accounts.add(row.name);
  }
  for (const row of state.transactions.rows) {
    if (row.accountName) {
      accounts.add(row.accountName);
    }
  }
  return Array.from(accounts).sort((left, right) => left.localeCompare(right));
}

function accountCompositionData(state: DashboardState) {
  return [
    { name: "Liquid", value: Math.max(state.accounts.totals.liquidCad, 0), color: CHART_COLORS.teal },
    { name: "Registered", value: Math.max(state.accounts.totals.registeredCad, 0), color: CHART_COLORS.navy },
    { name: "Debt", value: Math.max(state.accounts.totals.debtCad, 0), color: CHART_COLORS.coral },
  ].filter((row) => row.value > 0);
}

function cashflowRows(state: DashboardState) {
  return state.cashflow.conservative.map((row, index) => {
    const optimistic = state.cashflow.optimistic[index];
    return {
      month: row.month,
      incomeCad: row.incomeCad,
      totalOut: row.totalOut,
      arExpected: row.arExpected,
      apDue: row.apDue,
      conservativeNet: row.net,
      optimisticNet: optimistic?.net ?? 0,
      optimisticCumulative: optimistic?.cumulativeCad ?? 0,
    };
  });
}

function payableTimeline(state: DashboardState) {
  const buckets = new Map<string, { month: string; receivableCad: number; payableCad: number }>();
  for (const row of state.receivables.rows) {
    const month = row.expectedDate.slice(0, 7);
    const bucket = buckets.get(month) ?? { month, receivableCad: 0, payableCad: 0 };
    bucket.receivableCad += row.convertedCad;
    buckets.set(month, bucket);
  }
  for (const row of state.payables.rows) {
    const month = row.dueDate.slice(0, 7);
    const bucket = buckets.get(month) ?? { month, receivableCad: 0, payableCad: 0 };
    bucket.payableCad += row.convertedCad;
    buckets.set(month, bucket);
  }
  return Array.from(buckets.values())
    .sort((left, right) => left.month.localeCompare(right.month))
    .slice(0, 8);
}

function daysUntil(referenceDate: string, targetDate: string) {
  const start = new Date(`${referenceDate}T12:00:00`);
  const end = new Date(`${targetDate}T12:00:00`);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

function isoDate(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function addDaysIso(value: string, days: number) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

function startEndForMonthIso(month: string) {
  const [year, monthIndex] = month.split("-").map(Number);
  const from = `${month}-01`;
  const toExclusiveDate = new Date((year ?? 2026), monthIndex ?? 1, 1, 12, 0, 0, 0);
  return {
    from,
    toExclusive: isoDate(toExclusiveDate),
  };
}

function computeNextExpectedIso(lastSeen: string, intervalKind: string, intervalDays: number | null) {
  const date = new Date(`${lastSeen}T12:00:00`);
  if (intervalKind === "weekly") {
    date.setDate(date.getDate() + 7);
  } else if (intervalKind === "biweekly") {
    date.setDate(date.getDate() + 14);
  } else if (intervalKind === "yearly") {
    date.setFullYear(date.getFullYear() + 1);
  } else if (intervalKind === "custom" && intervalDays && intervalDays > 0) {
    date.setDate(date.getDate() + intervalDays);
  } else {
    date.setMonth(date.getMonth() + 1);
  }
  return isoDate(date);
}

function proratedMonthValue(month: string, monthValue: number, referenceDate: string, horizonDays: number) {
  const horizonEndExclusive = addDaysIso(referenceDate, horizonDays + 1);
  const monthRange = startEndForMonthIso(month);
  const overlapStart = referenceDate > monthRange.from ? referenceDate : monthRange.from;
  const overlapEnd = horizonEndExclusive < monthRange.toExclusive ? horizonEndExclusive : monthRange.toExclusive;
  const overlapDays = Math.max(0, daysUntil(overlapStart, overlapEnd));
  if (overlapDays === 0) {
    return 0;
  }
  const monthDays = Math.max(1, daysUntil(monthRange.from, monthRange.toExclusive));
  return monthValue * (overlapDays / monthDays);
}

function buildCurrentCashDetails(state: DashboardState): BreakdownItem[] {
  return state.accounts.accounts
    .filter((row) => row.classification !== "registered")
    .sort((left, right) => right.balanceCad - left.balanceCad)
    .map((row) => ({
      id: `account-${row.id}`,
      label: row.name,
      value: row.balanceCad,
      note: [row.institution, row.classification === "debt" ? "debt" : "usable cash"].filter(Boolean).join(" · "),
      signed: true,
    }));
}

function buildTaxBackpayDetails(state: DashboardState): BreakdownItem[] {
  return [
    {
      id: "income",
      label: "Income received YTD",
      value: state.signals.income.clientIncomeReceivedYtdCad,
      note: "Income currently in the ledger",
    },
    {
      id: "rate",
      label: `Reserve rate`,
      note: formatPercent(state.signals.tax.estimatedTaxRateOnReceivedIncome, 1),
    },
    {
      id: "tax-account",
      label: "Tax account balance",
      value: -state.signals.tax.taxAccountBalanceCad,
      note: "Already reserved",
      signed: true,
    },
    {
      id: "shortfall",
      label: "Current tax backpay / shortfall",
      value: -state.signals.tax.estimatedTaxShortfallCad,
      note: "Subtracted once in the projection",
      signed: true,
    },
  ];
}

function buildForecastDetails(
  state: DashboardState,
  horizonDays: number,
  field: "incomeCad" | "taxSetAside" | "discretionaryCad",
  scenario: "conservative" | "optimistic" = "conservative",
): BreakdownItem[] {
  return state.cashflow[scenario].reduce<BreakdownItem[]>((items, row) => {
      const value = proratedMonthValue(row.month, row[field], state.overview.referenceDate, horizonDays);
      if (value <= 0.005) {
        return items;
      }
      items.push({
        id: `${field}-${row.month}`,
        label: formatMonth(row.month),
        value,
        note: field === "incomeCad"
          ? "Conservative forecast income"
          : field === "taxSetAside"
            ? "Tax reserve on that month of forecast income"
            : `${formatMoney(state.metadata.serviceMetadata.settings.weeklyLimitCad)}/week envelope`,
      });
      return items;
    }, []);
}

function buildReceivableDetails(state: DashboardState, horizonDays: number): BreakdownItem[] {
  return state.receivables.rows
    .filter((row) => {
      const delta = daysUntil(state.overview.referenceDate, row.expectedDate);
      return delta >= 0 && delta <= horizonDays;
    })
    .sort((left, right) => left.expectedDate.localeCompare(right.expectedDate) || right.convertedCad - left.convertedCad)
    .map((row) => ({
      id: `receivable-${row.id}`,
      label: row.counterparty,
      value: row.convertedCad,
      note: `${formatDate(row.expectedDate)} · ${row.status}`,
      signed: true,
    }));
}

function buildPayableDetails(state: DashboardState, horizonDays: number): BreakdownItem[] {
  return state.payables.rows
    .filter((row) => {
      const delta = daysUntil(state.overview.referenceDate, row.dueDate);
      return delta >= 0 && delta <= horizonDays;
    })
    .sort((left, right) => left.dueDate.localeCompare(right.dueDate) || right.convertedCad - left.convertedCad)
    .map((row) => ({
      id: `payable-${row.id}`,
      label: row.description ? `${row.counterparty} · ${row.description}` : row.counterparty,
      value: -row.convertedCad,
      note: `${formatDate(row.dueDate)} · ${row.certainty}`,
      signed: true,
    }));
}

function buildRecurringDetails(state: DashboardState, horizonDays: number): BreakdownItem[] {
  const referenceDate = state.overview.referenceDate;
  const horizonEndExclusive = addDaysIso(referenceDate, horizonDays + 1);
  const details: BreakdownItem[] = [];
  for (const row of state.recurring.rows) {
    if (row.status !== "active") {
      continue;
    }
    let nextExpected = row.nextExpectedDate ?? (row.lastSeenDate
      ? computeNextExpectedIso(row.lastSeenDate, row.intervalKind, row.intervalDays)
      : referenceDate);
    let overdueIncluded = false;
    for (let iteration = 0; iteration < 48; iteration += 1) {
      if (nextExpected < referenceDate) {
        if (!overdueIncluded) {
          details.push({
            id: `recurring-${row.id}-overdue`,
            label: row.name,
            value: -row.amountCad,
            note: `Overdue since ${formatDate(nextExpected)}`,
            signed: true,
          });
          overdueIncluded = true;
        }
        const advanced = computeNextExpectedIso(nextExpected, row.intervalKind, row.intervalDays);
        if (advanced <= nextExpected) {
          break;
        }
        nextExpected = advanced;
        continue;
      }
      if (nextExpected >= horizonEndExclusive) {
        break;
      }
      details.push({
        id: `recurring-${row.id}-${nextExpected}`,
        label: row.name,
        value: -row.amountCad,
        note: `${formatDate(nextExpected)} · ${row.intervalKind}`,
        signed: true,
      });
      const advanced = computeNextExpectedIso(nextExpected, row.intervalKind, row.intervalDays);
      if (advanced <= nextExpected) {
        break;
      }
      nextExpected = advanced;
    }
  }
  return details.sort((left, right) => left.id.localeCompare(right.id));
}

function buildProjectedDetails(plan: DashboardState["signals"]["horizons"]["next30Days"], currentTaxBackpayCad: number): BreakdownItem[] {
  return [
    { id: "starting", label: "Amount you have now", value: plan.startingCashCad, signed: true },
    { id: "income", label: "Forecast income", value: plan.forecastIncomeCad, signed: true },
    { id: "forecast-tax", label: "Tax to reserve on that income", value: -plan.forecastTaxReserveCad, signed: true },
    { id: "receivables", label: "Expected receivables", value: plan.expectedReceivablesCad, signed: true },
    { id: "budget", label: "Weekly budget", value: -plan.budgetedSpendCad, signed: true },
    { id: "recurring", label: "Recurring expenses", value: -plan.recurringOutflowsCad, signed: true },
    { id: "payables", label: "Dated payables and bills", value: -plan.payableOutflowsCad, signed: true },
    { id: "backpay", label: "Current tax backpay", value: -currentTaxBackpayCad, signed: true },
  ];
}

function buildSuspiciousItems(state: DashboardState) {
  const reviewRows = state.review.rows
    .map((row) => {
      const amountCad = Math.abs(row.amountCadResolved ?? row.amount);
      const issue = row.category.final === "Uncategorized"
        ? "No category"
        : row.flags.isCcPayment
          ? "Credit-card payment not mapped cleanly"
          : row.flags.isTransfer && amountCad >= 5000
            ? "Large transfer, verify it is not misread as income"
            : row.countsTowardBudget.final
              ? "Still affects budget while unresolved"
              : row.review.reasonParts[0] ?? "Needs review";
      const tone: AlertTone = row.category.final === "Uncategorized" || amountCad >= 5000 ? "critical" : "warning";
      const score = amountCad
        + (row.category.final === "Uncategorized" ? 100_000 : 0)
        + (row.flags.isCcPayment ? 50_000 : 0)
        + (row.flags.isTransfer && amountCad >= 5000 ? 30_000 : 0)
        + (row.countsTowardBudget.final ? 10_000 : 0);
      return {
        id: row.id,
        postedDate: row.postedDate,
        label: row.descriptionFinal ?? row.descriptionRaw ?? "Unknown transaction",
        amountCad,
        issue,
        tone,
        accountName: row.accountName ?? "Unknown account",
      score,
      };
    })
    .filter((row) => row.amountCad >= 500 || row.tone === "critical" || row.issue.includes("budget"))
    .sort((left, right) => right.score - left.score)
    .slice(0, 6);

  return {
    importMismatch: state.signals.income.importLooksWrong,
    reviewCount: state.review.total,
    rows: reviewRows,
  };
}

function toneLabel(tone: AlertTone) {
  switch (tone) {
    case "critical":
      return "Critical";
    case "warning":
      return "Watch";
    case "positive":
      return "Good";
    default:
      return "Info";
  }
}

function buildReviewForm(transaction: FinanceNormalizedTransaction): ReviewFormState {
  return {
    category: transaction.category.final,
    countsTowardBudget: transaction.countsTowardBudget.final,
    descriptionClean: transaction.descriptionClean ?? transaction.descriptionFinal ?? "",
    note: transaction.note ?? "",
  };
}

function sanitizeFilters(input: TransactionsFilterInput): TransactionsFilterInput {
  return {
    month: input.month || undefined,
    search: input.search?.trim() || undefined,
    account: input.account || undefined,
    category: input.category || undefined,
    limit: input.limit ?? 50,
    onlyBudget: Boolean(input.onlyBudget),
    onlyReview: Boolean(input.onlyReview),
  };
}

function SectionTitle(props: { eyebrow: string; title: string; copy: string }) {
  return (
    <header className="section-title">
      <div>
        <p className="eyebrow">{props.eyebrow}</p>
        <h2>{props.title}</h2>
      </div>
      <p className="section-copy">{props.copy}</p>
    </header>
  );
}

function MetricCard(props: { label: string; value: string; tone?: AlertTone; caption: string }) {
  return (
    <article className={classNames("metric-card", props.tone && `metric-card-${props.tone}`)}>
      <span className="metric-label">{props.label}</span>
      <strong className="metric-value">{props.value}</strong>
      <p className="metric-caption">{props.caption}</p>
    </article>
  );
}

function Panel(props: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-header">
        <div>
          <h3>{props.title}</h3>
          {props.subtitle ? <p>{props.subtitle}</p> : null}
        </div>
        {props.actions}
      </header>
      {props.children}
    </section>
  );
}

function Badge(props: { tone: AlertTone; children: ReactNode }) {
  return <span className={classNames("badge", `badge-${props.tone}`)}>{props.children}</span>;
}

function ExpandableBalanceRow(props: BalanceLine) {
  const toneClass = props.tone === "positive"
    ? "balance-row-positive"
    : props.tone === "critical"
      ? "balance-row-critical"
      : "";
  return (
    <details className={classNames("balance-row-disclosure", props.total && "balance-row-total", toneClass)}>
      <summary className={classNames("balance-row", "balance-row-summary", props.total && "balance-row-total", toneClass)}>
        <span>{props.label}</span>
        <span className="balance-row-summary-end">
          <strong>{formatMoney(props.value, { signed: props.signed })}</strong>
          <small>{props.details.length === 1 ? "1 item" : `${props.details.length} items`}</small>
        </span>
      </summary>
      <div className="balance-row-details">
        {props.details.map((item) => (
          <div key={item.id} className="balance-detail-row">
            <div>
              <strong>{item.label}</strong>
              {item.note ? <small>{item.note}</small> : null}
            </div>
            {item.value != null ? <strong>{formatMoney(item.value, { signed: item.signed })}</strong> : null}
          </div>
        ))}
      </div>
    </details>
  );
}

function EmptyState(props: { title: string; copy: string }) {
  return (
    <div className="empty-state">
      <strong>{props.title}</strong>
      <p>{props.copy}</p>
    </div>
  );
}

async function loadDashboard(filters: TransactionsFilterInput, simulator: { amount: number; countsTowardBudget: boolean }) {
  const overview = await getOverview();
  const referenceMonth = overview.referenceDate.slice(0, 7);
  const timelineFromDate = startOfMonth(subtractMonths(referenceMonth, 11));

  const [
    metadata,
    accounts,
    budget,
    timeline,
    currentMonth,
    previousMonth,
    receivables,
    payables,
    recurring,
    forecastSummary,
    cashflow,
    tax,
    incomeSources,
    importRuns,
    review,
    signals,
    transactions,
    fx,
    whatIf,
  ] = await Promise.all([
    getMetadata(),
    getAccounts(),
    getBudget(12),
    getSpending({ fromDate: timelineFromDate, toDate: `${referenceMonth}-31` }),
    getSpending({ month: referenceMonth }),
    getSpending({ month: subtractMonths(referenceMonth, 1) }),
    getReceivables(),
    getPayables(),
    getRecurring(),
    getForecastSummary(),
    getForecastCashflow(),
    getTaxProjection(),
    getIncomeSources(),
    getImportRuns(12),
    getReview(25),
    getSignals(),
    getTransactions({
      ...sanitizeFilters(filters),
      month: filters.month || referenceMonth,
    }),
    getFxInfo(),
    simulateWhatIf({
      purchaseAmountCad: simulator.amount,
      countsTowardBudget: simulator.countsTowardBudget,
      date: overview.referenceDate,
    }),
  ]);

  return {
    metadata,
    overview,
    accounts,
    budget,
    timeline,
    currentMonth,
    previousMonth,
    receivables,
    payables,
    recurring,
    forecastSummary,
    cashflow,
    tax,
    incomeSources,
    importRuns,
    review,
    signals,
    transactions,
    fx,
    whatIf,
  } satisfies DashboardState;
}

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedReviewId, setSelectedReviewId] = useState<number | null>(null);
  const [reviewForm, setReviewForm] = useState<ReviewFormState | null>(null);
  const [setupForm, setSetupForm] = useState<SetupFormState>({
    timezone: "",
    weeklyLimitCad: "",
    monthlyLimitCad: "",
    weeklyStartDate: "",
    fxUsdCad: "",
    spreadsheetId: "",
    accountsGid: "",
    transactionsGid: "",
  });
  const [transactionFilters, setTransactionFilters] = useState<TransactionsFilterInput>(DEFAULT_TX_FILTERS);
  const [transactionDraft, setTransactionDraft] = useState<TransactionsFilterInput>(DEFAULT_TX_FILTERS);
  const [simulatorAmount, setSimulatorAmount] = useState("250");
  const [simulatorCounts, setSimulatorCounts] = useState(true);
  const [csvText, setCsvText] = useState("");
  const [csvFileName, setCsvFileName] = useState("");
  const [yearEndScenario, setYearEndScenario] = useState<"conservative" | "optimistic">("conservative");
  const [importResult, setImportResult] = useState<FinanceImportResponse | null>(null);
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    void refreshDashboard(DEFAULT_TX_FILTERS);
  }, []);

  useEffect(() => {
    if (!dashboard) {
      return;
    }
    const selected = dashboard.review.rows.find((row) => row.id === selectedReviewId) ?? dashboard.review.rows[0] ?? null;
    if (!selected) {
      setSelectedReviewId(null);
      setReviewForm(null);
      return;
    }
    setSelectedReviewId(selected.id);
    setReviewForm(buildReviewForm(selected));
  }, [dashboard?.review.rows, selectedReviewId]);

  useEffect(() => {
    if (!dashboard) {
      return;
    }
    setSetupForm({
      timezone: dashboard.metadata.serviceMetadata.settings.timezone ?? "",
      weeklyLimitCad: String(dashboard.metadata.serviceMetadata.settings.weeklyLimitCad),
      monthlyLimitCad: String(dashboard.metadata.serviceMetadata.settings.monthlyLimitCad),
      weeklyStartDate: dashboard.metadata.serviceMetadata.settings.weeklyStartDate ?? "",
      fxUsdCad: String(dashboard.metadata.serviceMetadata.settings.fxUsdCad),
      spreadsheetId: dashboard.metadata.serviceMetadata.sheet.spreadsheetId,
      accountsGid: dashboard.metadata.serviceMetadata.sheet.accountsGid,
      transactionsGid: dashboard.metadata.serviceMetadata.sheet.transactionsGid,
    });
    setTransactionDraft((previous) => ({
      ...previous,
      month: previous.month || dashboard.overview.referenceDate.slice(0, 7),
    }));
  }, [dashboard?.metadata.timestamp, dashboard?.overview.referenceDate]);

  async function refreshDashboard(filters = transactionFilters) {
    setLoading(true);
    setError(null);
    try {
      const next = await loadDashboard(filters, {
        amount: Number(simulatorAmount) || 250,
        countsTowardBudget: simulatorCounts,
      });
      startTransition(() => {
        setDashboard(next);
        if (!selectedReviewId && next.review.rows[0]) {
          setSelectedReviewId(next.review.rows[0].id);
        }
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function handleApplyTransactionFilters(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextFilters = sanitizeFilters(transactionDraft);
    setTransactionFilters(nextFilters);
    await refreshDashboard(nextFilters);
  }

  async function handleReviewSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dashboard || !reviewForm || selectedReviewId == null) {
      return;
    }
    setRunningAction("review");
    setNotice(null);
    try {
      const decision: ReviewDecisionInput = {
        id: selectedReviewId,
        category: reviewForm.category,
        countsTowardBudget: reviewForm.countsTowardBudget,
        descriptionClean: reviewForm.descriptionClean,
        note: reviewForm.note || null,
      };
      await submitReview([decision]);
      setNotice("Review decision saved.");
      await refreshDashboard(transactionFilters);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunningAction(null);
    }
  }

  async function handleSaveSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRunningAction("settings");
    setNotice(null);
    try {
      const payload: SettingsUpdateInput = {
        timezone: setupForm.timezone,
        weeklyLimitCad: Number(setupForm.weeklyLimitCad),
        monthlyLimitCad: Number(setupForm.monthlyLimitCad),
        weeklyStartDate: setupForm.weeklyStartDate,
        fxUsdCad: Number(setupForm.fxUsdCad),
        spreadsheetId: setupForm.spreadsheetId,
        accountsGid: setupForm.accountsGid,
        transactionsGid: setupForm.transactionsGid,
      };
      await saveSettings(payload);
      setNotice("Finance settings updated.");
      await refreshDashboard(transactionFilters);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunningAction(null);
    }
  }

  async function handleSheetImport(dryRun: boolean) {
    setRunningAction(dryRun ? "sheet-dry-run" : "sheet-import");
    setNotice(null);
    try {
      const response = await importFinance({
        source: "fintable_gsheet",
        dryRun,
        spreadsheetId: setupForm.spreadsheetId,
        accountsGid: setupForm.accountsGid,
        transactionsGid: setupForm.transactionsGid,
      });
      setImportResult(response);
      setNotice(dryRun ? "Sheet dry run complete." : "Sheet import complete.");
      await refreshDashboard(transactionFilters);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunningAction(null);
    }
  }

  async function handleCsvImport(dryRun: boolean) {
    if (!csvText.trim()) {
      setError("Attach or paste a CSV file before importing.");
      return;
    }
    setRunningAction(dryRun ? "csv-dry-run" : "csv-import");
    setNotice(null);
    try {
      const response = await importFinance({
        source: "csv",
        dryRun,
        csvText,
      });
      setImportResult(response);
      setNotice(dryRun ? "CSV dry run complete." : "CSV import complete.");
      await refreshDashboard(transactionFilters);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunningAction(null);
    }
  }

  async function handleSimulator(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dashboard) {
      return;
    }
    setRunningAction("simulator");
    try {
      const next = await simulateWhatIf({
        purchaseAmountCad: Number(simulatorAmount),
        countsTowardBudget: simulatorCounts,
        date: dashboard.overview.referenceDate,
      });
      setDashboard({ ...dashboard, whatIf: next });
      setNotice("Scenario updated.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunningAction(null);
    }
  }

  async function handleCsvFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const text = await file.text();
    setCsvText(text);
    setCsvFileName(file.name);
  }

  if (loading && !dashboard) {
    return (
      <main className="app-shell">
        <div className="loading-screen">
          <p className="eyebrow">OpenElinaro finance dashboard</p>
          <h1>Loading live finance data</h1>
          <p>Reading the SQLite finance system, forecast config, and transaction history.</p>
        </div>
      </main>
    );
  }

  if (!dashboard) {
    return (
      <main className="app-shell">
        <div className="loading-screen">
          <p className="eyebrow">Finance dashboard unavailable</p>
          <h1>Data could not be loaded</h1>
          <p>{error ?? "Unknown error."}</p>
        </div>
      </main>
    );
  }

  const alerts = dashboard.signals.alerts;
  const reminders = dashboard.signals.reminders;
  const categoryDeltas = dashboard.signals.categoryDeltas.slice(0, 8);
  const checklist = buildSetupChecklist(dashboard);
  const selectedReview = dashboard.review.rows.find((row) => row.id === selectedReviewId) ?? dashboard.review.rows[0] ?? null;
  const accountOptions = collectAccountOptions(dashboard);
  const categoryOptions = collectCategoryOptions(dashboard);
  const composition = accountCompositionData(dashboard);
  const cashflowData = cashflowRows(dashboard);
  const arApData = payableTimeline(dashboard);
  const currentMonthLabel = formatMonth(dashboard.currentMonth.filters.month ?? dashboard.overview.referenceDate.slice(0, 7));
  const previousMonthLabel = formatMonth(dashboard.previousMonth.filters.month ?? subtractMonths(dashboard.overview.referenceDate.slice(0, 7), 1));
  const plan30 = dashboard.signals.horizons.next30Days;
  const plan60 = dashboard.signals.horizons.next60Days;
  const planEndOfYear = dashboard.signals.horizons.endOfYear;
  const planEndOfYearOptimistic = dashboard.signals.horizons.endOfYearOptimistic;
  const suspicious = buildSuspiciousItems(dashboard);
  const obviousIssueCount = suspicious.rows.length + (suspicious.importMismatch ? 1 : 0);
  const taxAccountBalanceCad = dashboard.signals.tax.taxAccountBalanceCad;
  const estimatedTaxOnReceivedIncomeCad = dashboard.signals.tax.estimatedTaxOnReceivedIncomeCad;
  const estimatedTaxRateOnReceivedIncome = dashboard.signals.tax.estimatedTaxRateOnReceivedIncome;
  const estimatedTaxShortfallCad = Math.max(dashboard.signals.tax.estimatedTaxShortfallCad, 0);
  const enoughReservedForEstimatedTax = dashboard.signals.tax.enoughReservedForEstimatedTax;
  const taxReservedCad = Math.min(taxAccountBalanceCad, estimatedTaxOnReceivedIncomeCad);
  const currentCashDetails = buildCurrentCashDetails(dashboard);
  const taxBackpayDetails = buildTaxBackpayDetails(dashboard);
  const taxAccountDetails: BreakdownItem[] = currentCashDetails.filter((item) => item.label.toLowerCase().includes("tax"));
  const taxAccountBreakdown = taxAccountDetails.length > 0
    ? taxAccountDetails
    : [{ id: "tax-account-none", label: "No tax account balance found", note: "Current balance is zero." }];
  const taxReserveTargetDetails: BreakdownItem[] = [
    {
      id: "target-income",
      label: "Income received YTD",
      value: dashboard.signals.income.clientIncomeReceivedYtdCad,
      note: "Base used for the current reserve target",
    },
    {
      id: "target-rate",
      label: "Current reserve rate",
      note: formatPercent(estimatedTaxRateOnReceivedIncome, 1),
    },
    {
      id: "target-total",
      label: "Current reserve target",
      value: estimatedTaxOnReceivedIncomeCad,
    },
  ];
  const plan30IncomeDetails = buildForecastDetails(dashboard, 30, "incomeCad");
  const plan60IncomeDetails = buildForecastDetails(dashboard, 60, "incomeCad");
  const planEndIncomeDetails = buildForecastDetails(dashboard, planEndOfYear.days, "incomeCad");
  const planEndIncomeOptimisticDetails = buildForecastDetails(dashboard, planEndOfYearOptimistic.days, "incomeCad", "optimistic");
  const plan30TaxDetails = buildForecastDetails(dashboard, 30, "taxSetAside");
  const plan60TaxDetails = buildForecastDetails(dashboard, 60, "taxSetAside");
  const planEndTaxDetails = buildForecastDetails(dashboard, planEndOfYear.days, "taxSetAside");
  const planEndTaxOptimisticDetails = buildForecastDetails(dashboard, planEndOfYearOptimistic.days, "taxSetAside", "optimistic");
  const plan30BudgetDetails = buildForecastDetails(dashboard, 30, "discretionaryCad");
  const plan60BudgetDetails = buildForecastDetails(dashboard, 60, "discretionaryCad");
  const planEndBudgetDetails = buildForecastDetails(dashboard, planEndOfYear.days, "discretionaryCad");
  const planEndBudgetOptimisticDetails = buildForecastDetails(dashboard, planEndOfYearOptimistic.days, "discretionaryCad", "optimistic");
  const plan30ReceivableDetails = buildReceivableDetails(dashboard, 30);
  const plan60ReceivableDetails = buildReceivableDetails(dashboard, 60);
  const planEndReceivableDetails = buildReceivableDetails(dashboard, planEndOfYear.days);
  const planEndReceivableOptimisticDetails = buildReceivableDetails(dashboard, planEndOfYearOptimistic.days);
  const plan30PayableDetails = buildPayableDetails(dashboard, 30);
  const plan60PayableDetails = buildPayableDetails(dashboard, 60);
  const planEndPayableDetails = buildPayableDetails(dashboard, planEndOfYear.days);
  const planEndPayableOptimisticDetails = buildPayableDetails(dashboard, planEndOfYearOptimistic.days);
  const plan30RecurringDetails = buildRecurringDetails(dashboard, 30);
  const plan60RecurringDetails = buildRecurringDetails(dashboard, 60);
  const planEndRecurringDetails = buildRecurringDetails(dashboard, planEndOfYear.days);
  const planEndRecurringOptimisticDetails = buildRecurringDetails(dashboard, planEndOfYearOptimistic.days);
  const plan30ProjectedDetails = buildProjectedDetails(plan30, estimatedTaxShortfallCad);
  const plan60ProjectedDetails = buildProjectedDetails(plan60, estimatedTaxShortfallCad);
  const planEndProjectedDetails = buildProjectedDetails(planEndOfYear, estimatedTaxShortfallCad);
  const planEndProjectedOptimisticDetails = buildProjectedDetails(planEndOfYearOptimistic, estimatedTaxShortfallCad);
  const selectedYearEndPlan = yearEndScenario === "optimistic" ? planEndOfYearOptimistic : planEndOfYear;
  const selectedYearEndIncomeDetails = yearEndScenario === "optimistic" ? planEndIncomeOptimisticDetails : planEndIncomeDetails;
  const selectedYearEndTaxDetails = yearEndScenario === "optimistic" ? planEndTaxOptimisticDetails : planEndTaxDetails;
  const selectedYearEndBudgetDetails = yearEndScenario === "optimistic" ? planEndBudgetOptimisticDetails : planEndBudgetDetails;
  const selectedYearEndReceivableDetails = yearEndScenario === "optimistic" ? planEndReceivableOptimisticDetails : planEndReceivableDetails;
  const selectedYearEndPayableDetails = yearEndScenario === "optimistic" ? planEndPayableOptimisticDetails : planEndPayableDetails;
  const selectedYearEndRecurringDetails = yearEndScenario === "optimistic" ? planEndRecurringOptimisticDetails : planEndRecurringDetails;
  const selectedYearEndProjectedDetails = yearEndScenario === "optimistic" ? planEndProjectedOptimisticDetails : planEndProjectedDetails;

  return (
    <main className="app-shell">
      <header className="hero">
        <div className="hero-copy">
          <p className="eyebrow">OpenElinaro finance dashboard</p>
          <h1>Cash, taxes, and what is left</h1>
          <p className="hero-text">
            Start from net liquid cash, reserve what the tax forecast says you already owe on received income,
            then show what remains after the next known obligations. RRSP balances are ignored here.
          </p>
        </div>
        <div className="hero-status">
          <div className="status-card">
            <span>Available after tax backpay</span>
            <strong>{formatMoney(plan30.afterCurrentTaxBackpayCad, { signed: true })}</strong>
            <small>Net liquid minus the tax account shortfall that already exists today.</small>
          </div>
          <div className="status-card">
            <span>After 30 days</span>
            <strong>{formatMoney(plan30.projectedAfterCurrentTaxBackpayCad, { signed: true })}</strong>
            <small>Projected left after future tax reserve, weekly budget, known outflows, and current tax backpay.</small>
          </div>
          <div className="status-card">
            <span>Obvious issues</span>
            <strong>{formatNumber(obviousIssueCount)}</strong>
            <small>The short list of imports or tags that look obviously wrong.</small>
          </div>
          <button className="button button-primary" type="button" onClick={() => void refreshDashboard()}>
            Refresh dashboard
          </button>
        </div>
      </header>

      <section className="tab-strip" aria-label="Finance sections">
        {TAB_ORDER.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={classNames("tab-button", activeTab === tab.id && "tab-button-active")}
            onClick={() => setActiveTab(tab.id)}
          >
            <span>{tab.label}</span>
            <small>{tab.eyebrow}</small>
          </button>
        ))}
      </section>

      {notice ? <div className="flash flash-success">{notice}</div> : null}
      {error ? <div className="flash flash-error">{error}</div> : null}

      <div className="tab-panel" key={activeTab}>
        {activeTab === "overview" ? (
          <div className="page-grid">
            <SectionTitle
              eyebrow="Today"
              title="Glance board"
              copy="This screen shows the balancing math directly: amount you have, amount already owed or reserved, and what is left now and after the next known obligations."
            />
            <div className="glance-board">
              <Panel title="Current position" subtitle="RRSP balances are ignored. This uses non-RRSP cash and debt only.">
                <div className="stack-list">
                  <div className="balance-group">
                    <div className="balance-group-header">
                      <strong>Today</strong>
                    </div>
                    <ExpandableBalanceRow
                      id="today-amount"
                      label="Amount you have now"
                      value={plan30.startingCashCad}
                      details={currentCashDetails}
                    />
                    <ExpandableBalanceRow
                      id="today-tax-backpay"
                      label="Less tax backpay right now"
                      value={-estimatedTaxShortfallCad}
                      signed
                      details={taxBackpayDetails}
                    />
                    <ExpandableBalanceRow
                      id="today-left"
                      label="What you have left now"
                      value={plan30.afterCurrentTaxBackpayCad}
                      signed
                      total
                      tone={plan30.afterCurrentTaxBackpayCad >= 0 ? "positive" : "critical"}
                      details={[
                        { id: "today-left-cash", label: "Amount you have now", value: plan30.startingCashCad, signed: true },
                        { id: "today-left-backpay", label: "Current tax backpay", value: -estimatedTaxShortfallCad, signed: true },
                      ]}
                    />
                  </div>
                  <div className="balance-group">
                    <div className="balance-group-header">
                      <strong>Tax reserve check</strong>
                      <Badge tone={enoughReservedForEstimatedTax ? "positive" : "critical"}>
                        {enoughReservedForEstimatedTax ? "Covered" : "Underfunded"}
                      </Badge>
                    </div>
                    <ExpandableBalanceRow
                      id="tax-account-balance"
                      label="Already sitting in tax account"
                      value={taxAccountBalanceCad}
                      details={taxAccountBreakdown}
                    />
                    <ExpandableBalanceRow
                      id="tax-account-counts"
                      label="Counts toward the reserve needed"
                      value={taxReservedCad}
                      details={[
                        { id: "tax-counts-balance", label: "Tax account balance", value: taxAccountBalanceCad },
                        { id: "tax-counts-cap", label: "Capped by reserve target", value: estimatedTaxOnReceivedIncomeCad, note: "Only counts up to the target." },
                      ]}
                    />
                    <ExpandableBalanceRow
                      id="tax-account-missing"
                      label="Still missing in tax account"
                      value={estimatedTaxShortfallCad}
                      details={taxBackpayDetails}
                    />
                    <ExpandableBalanceRow
                      id="tax-account-target"
                      label="Total tax reserve target"
                      value={estimatedTaxOnReceivedIncomeCad}
                      total
                      details={taxReserveTargetDetails}
                    />
                  </div>
                  <p className="helper-text">
                    Tax reserve uses the current forecast rate of {formatPercent(estimatedTaxRateOnReceivedIncome, 1)} on income already received.
                  </p>
                </div>
              </Panel>
              <Panel title="Projected coverage" subtitle="Start from current cash, subtract future tax reserve and planned obligations, then subtract current tax backpay once.">
                <div className="stack-list">
                  <div className="balance-group">
                    <div className="balance-group-header">
                      <strong>Next 30 days</strong>
                      <Badge tone={plan30.status === "on_track" ? "positive" : "critical"}>{plan30.status === "on_track" ? "On track" : "Short"}</Badge>
                    </div>
                    <ExpandableBalanceRow id="30-amount" label="Amount you have now" value={plan30.startingCashCad} signed details={currentCashDetails} />
                    <ExpandableBalanceRow id="30-income" label="Plus forecast income" value={plan30.forecastIncomeCad} signed details={plan30IncomeDetails} />
                    <ExpandableBalanceRow id="30-tax" label="Less tax to reserve on that income" value={-plan30.forecastTaxReserveCad} signed details={plan30TaxDetails} />
                    <ExpandableBalanceRow id="30-receivables" label="Plus expected receivables" value={plan30.expectedReceivablesCad} signed details={plan30ReceivableDetails.length > 0 ? plan30ReceivableDetails : [{ id: "30-receivables-none", label: "No receivables due in this window" }]} />
                    <ExpandableBalanceRow id="30-budget" label="Less weekly budget" value={-plan30.budgetedSpendCad} signed details={plan30BudgetDetails} />
                    <ExpandableBalanceRow id="30-recurring" label="Less recurring expenses" value={-plan30.recurringOutflowsCad} signed details={plan30RecurringDetails.length > 0 ? plan30RecurringDetails : [{ id: "30-recurring-none", label: "No recurring expenses in this window" }]} />
                    <ExpandableBalanceRow id="30-payables" label="Less dated payables and bills" value={-plan30.payableOutflowsCad} signed details={plan30PayableDetails.length > 0 ? plan30PayableDetails : [{ id: "30-payables-none", label: "No dated payables in this window" }]} />
                    <ExpandableBalanceRow id="30-projected-pre" label="Projected left before tax backpay" value={plan30.projectedCad} signed total tone={plan30.projectedCad >= 0 ? "positive" : "critical"} details={plan30ProjectedDetails.slice(0, 7)} />
                    <ExpandableBalanceRow id="30-backpay" label="Less tax backpay" value={-estimatedTaxShortfallCad} signed details={taxBackpayDetails} />
                    <ExpandableBalanceRow id="30-projected-post" label="Projected left after 30 days" value={plan30.projectedAfterCurrentTaxBackpayCad} signed total tone={plan30.projectedAfterCurrentTaxBackpayCad >= 0 ? "positive" : "critical"} details={plan30ProjectedDetails} />
                  </div>
                  <div className="balance-group">
                    <div className="balance-group-header">
                      <strong>Next 60 days</strong>
                      <Badge tone={plan60.status === "on_track" ? "positive" : "critical"}>{plan60.status === "on_track" ? "On track" : "Short"}</Badge>
                    </div>
                    <ExpandableBalanceRow id="60-amount" label="Amount you have now" value={plan60.startingCashCad} signed details={currentCashDetails} />
                    <ExpandableBalanceRow id="60-income" label="Plus forecast income" value={plan60.forecastIncomeCad} signed details={plan60IncomeDetails} />
                    <ExpandableBalanceRow id="60-tax" label="Less tax to reserve on that income" value={-plan60.forecastTaxReserveCad} signed details={plan60TaxDetails} />
                    <ExpandableBalanceRow id="60-receivables" label="Plus expected receivables" value={plan60.expectedReceivablesCad} signed details={plan60ReceivableDetails.length > 0 ? plan60ReceivableDetails : [{ id: "60-receivables-none", label: "No receivables due in this window" }]} />
                    <ExpandableBalanceRow id="60-budget" label="Less weekly budget" value={-plan60.budgetedSpendCad} signed details={plan60BudgetDetails} />
                    <ExpandableBalanceRow id="60-recurring" label="Less recurring expenses" value={-plan60.recurringOutflowsCad} signed details={plan60RecurringDetails.length > 0 ? plan60RecurringDetails : [{ id: "60-recurring-none", label: "No recurring expenses in this window" }]} />
                    <ExpandableBalanceRow id="60-payables" label="Less dated payables and bills" value={-plan60.payableOutflowsCad} signed details={plan60PayableDetails.length > 0 ? plan60PayableDetails : [{ id: "60-payables-none", label: "No dated payables in this window" }]} />
                    <ExpandableBalanceRow id="60-projected-pre" label="Projected left before tax backpay" value={plan60.projectedCad} signed total tone={plan60.projectedCad >= 0 ? "positive" : "critical"} details={plan60ProjectedDetails.slice(0, 7)} />
                    <ExpandableBalanceRow id="60-backpay" label="Less tax backpay" value={-estimatedTaxShortfallCad} signed details={taxBackpayDetails} />
                    <ExpandableBalanceRow id="60-projected-post" label="Projected left after 60 days" value={plan60.projectedAfterCurrentTaxBackpayCad} signed total tone={plan60.projectedAfterCurrentTaxBackpayCad >= 0 ? "positive" : "critical"} details={plan60ProjectedDetails} />
                  </div>
                  <div className="balance-group">
                    <div className="balance-group-header">
                      <div className="balance-group-heading">
                        <strong>End of year</strong>
                        <div className="scenario-toggle" aria-label="End-of-year projection scenario">
                          <button
                            type="button"
                            className={classNames("scenario-toggle-button", yearEndScenario === "conservative" && "scenario-toggle-button-active")}
                            aria-pressed={yearEndScenario === "conservative"}
                            onClick={() => setYearEndScenario("conservative")}
                          >
                            Conservative
                          </button>
                          <button
                            type="button"
                            className={classNames("scenario-toggle-button", yearEndScenario === "optimistic" && "scenario-toggle-button-active")}
                            aria-pressed={yearEndScenario === "optimistic"}
                            onClick={() => setYearEndScenario("optimistic")}
                          >
                            Optimistic
                          </button>
                        </div>
                      </div>
                      <Badge tone={selectedYearEndPlan.status === "on_track" ? "positive" : "critical"}>
                        {selectedYearEndPlan.status === "on_track" ? "On track" : "Short"}
                      </Badge>
                    </div>
                    <ExpandableBalanceRow id="eoy-amount" label="Amount you have now" value={selectedYearEndPlan.startingCashCad} signed details={currentCashDetails} />
                    <ExpandableBalanceRow id="eoy-income" label="Plus forecast income" value={selectedYearEndPlan.forecastIncomeCad} signed details={selectedYearEndIncomeDetails} />
                    <ExpandableBalanceRow id="eoy-tax" label="Less tax to reserve on that income" value={-selectedYearEndPlan.forecastTaxReserveCad} signed details={selectedYearEndTaxDetails} />
                    <ExpandableBalanceRow id="eoy-receivables" label="Plus expected receivables" value={selectedYearEndPlan.expectedReceivablesCad} signed details={selectedYearEndReceivableDetails.length > 0 ? selectedYearEndReceivableDetails : [{ id: "eoy-receivables-none", label: "No receivables due in this window" }]} />
                    <ExpandableBalanceRow id="eoy-budget" label="Less weekly budget" value={-selectedYearEndPlan.budgetedSpendCad} signed details={selectedYearEndBudgetDetails} />
                    <ExpandableBalanceRow id="eoy-recurring" label="Less recurring expenses" value={-selectedYearEndPlan.recurringOutflowsCad} signed details={selectedYearEndRecurringDetails.length > 0 ? selectedYearEndRecurringDetails : [{ id: "eoy-recurring-none", label: "No recurring expenses in this window" }]} />
                    <ExpandableBalanceRow id="eoy-payables" label="Less dated payables and bills" value={-selectedYearEndPlan.payableOutflowsCad} signed details={selectedYearEndPayableDetails.length > 0 ? selectedYearEndPayableDetails : [{ id: "eoy-payables-none", label: "No dated payables in this window" }]} />
                    <ExpandableBalanceRow id="eoy-projected-pre" label="Projected left before tax backpay" value={selectedYearEndPlan.projectedCad} signed total tone={selectedYearEndPlan.projectedCad >= 0 ? "positive" : "critical"} details={selectedYearEndProjectedDetails.slice(0, 7)} />
                    <ExpandableBalanceRow id="eoy-backpay" label="Less tax backpay" value={-estimatedTaxShortfallCad} signed details={taxBackpayDetails} />
                    <ExpandableBalanceRow id="eoy-projected-post" label="Projected left at year end" value={selectedYearEndPlan.projectedAfterCurrentTaxBackpayCad} signed total tone={selectedYearEndPlan.projectedAfterCurrentTaxBackpayCad >= 0 ? "positive" : "critical"} details={selectedYearEndProjectedDetails} />
                  </div>
                </div>
              </Panel>
            </div>
            <Panel title="What looks wrong?" subtitle="Likely tagging or import issues, kept separate from the balance math.">
              <div className="stack-list">
                <article className={classNames("detail-card", obviousIssueCount > 0 ? "detail-card-critical" : "detail-card-positive")}>
                  <span className="detail-label">Current obvious issues</span>
                  <strong>{formatNumber(obviousIssueCount)}</strong>
                  <small>{formatNumber(dashboard.review.total)} total review items exist, but only the most likely mistakes are shown here.</small>
                </article>
                {suspicious.importMismatch ? (
                  <article className="alert-card alert-card-critical">
                    <Badge tone="critical">Import mismatch</Badge>
                    <strong>Imported client income does not match expected confirmed receipts.</strong>
                    <p>
                      Imported: USD {formatNumber(dashboard.signals.income.clientIncomeReceivedYtdUsd, 2)}.
                      Expected: USD {formatNumber(dashboard.signals.income.expectedConfirmedReceivedYtdUsd, 2)}.
                    </p>
                  </article>
                ) : null}
                {suspicious.rows.map((item) => (
                  <article key={item.id} className={classNames("glance-row", `glance-row-${item.tone}`)}>
                    <div>
                      <div className="glance-row-topline">
                        <strong>{item.label}</strong>
                        <Badge tone={item.tone}>{item.issue}</Badge>
                      </div>
                      <small>{formatDate(item.postedDate)} · {item.accountName}</small>
                    </div>
                    <strong>{formatMoney(item.amountCad)}</strong>
                  </article>
                ))}
                {suspicious.rows.length === 0 && !suspicious.importMismatch ? (
                  <EmptyState
                    title="Nothing obvious is broken right now"
                    copy="The full review queue still exists, but there are no large or obviously wrong items on top."
                  />
                ) : null}
              </div>
            </Panel>
          </div>
        ) : null}

        {activeTab === "insights" ? (
          <div className="page-grid">
            <SectionTitle
              eyebrow="Insights"
              title="Trends, month-over-month comparisons, and anomalies"
              copy="Budget analytics now separate discretionary budget volume from tax and other non-discretionary outflows."
            />
            <div className="metric-grid compact">
              <MetricCard
                label={`${currentMonthLabel} discretionary`}
                value={formatMoney(dashboard.signals.currentBudgetNetCad)}
                tone={deltaTone(dashboard.signals.currentBudgetNetCad - dashboard.signals.previousBudgetNetCad)}
                caption={`${formatMoney(dashboard.signals.currentBudgetNetCad - dashboard.signals.previousBudgetNetCad, { signed: true })} vs ${previousMonthLabel}.`}
              />
              <MetricCard
                label={`${currentMonthLabel} total spend`}
                value={formatMoney(dashboard.signals.currentSpendCad)}
                tone="neutral"
                caption={`${formatMoney(dashboard.signals.currentSpendCad - dashboard.signals.previousSpendCad, { signed: true })} vs last month.`}
              />
              <MetricCard
                label="Review-sensitive spend"
                value={formatMoney(
                  dashboard.currentMonth.groups.reduce((sum, row) => sum + (row.reviewCount > 0 ? row.spendCad : 0), 0),
                )}
                tone="warning"
                caption="Current month spend tied to rows still needing review."
              />
              <MetricCard
                label="Budget burn rate"
                value={`${formatNumber(dashboard.budget.history.rows[dashboard.budget.history.rows.length - 1]?.burnRate ?? 0, 2)}x`}
                tone={dashboard.overview.budget.paceDelta > 0 ? "warning" : "positive"}
                caption="Current week spend divided by available budget."
              />
            </div>
            <div className="split-grid">
              <Panel title="12-month trendline" subtitle="Monthly total spend, income, and budget-counted net.">
                <div className="chart-frame tall">
                  <ResponsiveContainer width="100%" height={320}>
                    <AreaChart data={dashboard.timeline.timeline}>
                      <CartesianGrid stroke="#d3c7b3" strokeDasharray="4 4" />
                      <XAxis dataKey="bucket" tickFormatter={formatMonth} />
                      <YAxis tickFormatter={(value) => formatMoney(Number(value))} />
                      <Tooltip formatter={tooltipMoney} labelFormatter={tooltipMonth} />
                      <Legend />
                      <Area type="monotone" dataKey="spendCad" name="Spend" stroke={CHART_COLORS.coral} fill="#efc1b5" />
                      <Area type="monotone" dataKey="incomeCad" name="Income" stroke={CHART_COLORS.teal} fill="#b9e1d3" />
                      <Area type="monotone" dataKey="budgetNetCad" name="Budget net" stroke={CHART_COLORS.navy} fill="#ccd6e4" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </Panel>
              <Panel title="Category deltas" subtitle={`${currentMonthLabel} compared with ${previousMonthLabel}.`}>
                <div className="chart-frame tall">
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart data={categoryDeltas}>
                      <CartesianGrid stroke="#d3c7b3" strokeDasharray="4 4" />
                      <XAxis dataKey="category" angle={-18} textAnchor="end" interval={0} height={96} />
                      <YAxis tickFormatter={(value) => formatMoney(Number(value))} />
                      <Tooltip formatter={tooltipMoney} />
                      <Legend />
                      <Bar dataKey="currentSpendCad" name={currentMonthLabel} fill={CHART_COLORS.teal} radius={[8, 8, 0, 0]} />
                      <Bar dataKey="previousSpendCad" name={previousMonthLabel} fill={CHART_COLORS.gold} radius={[8, 8, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Panel>
            </div>
            <Panel title="Anomaly scan" subtitle="Largest month-over-month category changes and review concentration.">
              <div className="table-shell">
                <table>
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th className="numeric">{currentMonthLabel}</th>
                      <th className="numeric">{previousMonthLabel}</th>
                      <th className="numeric">Delta</th>
                      <th className="numeric">Review rows</th>
                    </tr>
                  </thead>
                  <tbody>
                    {categoryDeltas.map((row) => (
                      <tr key={row.category}>
                        <td>{row.category}</td>
                        <td className="numeric">{formatMoney(row.currentSpendCad)}</td>
                        <td className="numeric">{formatMoney(row.previousSpendCad)}</td>
                        <td className={classNames("numeric", row.deltaCad > 0 ? "text-danger" : "text-positive")}>
                          {formatMoney(row.deltaCad, { signed: true })}
                        </td>
                        <td className="numeric">{formatNumber(row.reviewCount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
        ) : null}

        {activeTab === "forecast" ? (
          <div className="page-grid">
            <SectionTitle
              eyebrow="Forecast"
              title="Cashflow, runway, tax, and purchase simulation"
              copy="This is still driven by the existing forecast config and the same forecast summary logic the agent uses today."
            />
            <div className="metric-grid compact">
              <MetricCard
                label="Conservative annual surplus"
                value={formatMoney(dashboard.forecastSummary.scenarios.conservative.annualSurplusCad)}
                tone={dashboard.forecastSummary.scenarios.conservative.annualSurplusCad < 0 ? "critical" : "positive"}
                caption={`Runway: ${dashboard.forecastSummary.scenarios.conservative.runwayMonths ?? "∞"} months`}
              />
              <MetricCard
                label="Optimistic annual surplus"
                value={formatMoney(dashboard.forecastSummary.scenarios.optimistic.annualSurplusCad)}
                tone={dashboard.forecastSummary.scenarios.optimistic.annualSurplusCad < 0 ? "warning" : "positive"}
                caption={`Runway: ${dashboard.forecastSummary.scenarios.optimistic.runwayMonths ?? "∞"} months`}
              />
              <MetricCard
                label="Tax set-aside now"
                value={formatMoney(dashboard.forecastSummary.currentTaxRates.optimistic.monthlySetAside)}
                tone="neutral"
                caption={`${formatPercent(dashboard.forecastSummary.currentTaxRates.optimistic.rate)} current monthly rate.`}
              />
              <MetricCard
                label="Discretionary monthly budget"
                value={formatMoney(dashboard.forecastSummary.expenses.discretionaryMonthlyCad)}
                tone="neutral"
                caption="Derived from weekly budget settings, separate from tax obligations."
              />
            </div>
            <div className="split-grid">
              <Panel title="Cashflow curve" subtitle="Monthly net and cumulative cash position by scenario.">
                <div className="chart-frame tall">
                  <ResponsiveContainer width="100%" height={320}>
                    <ComposedChart data={cashflowData}>
                      <CartesianGrid stroke="#d3c7b3" strokeDasharray="4 4" />
                      <XAxis dataKey="month" tickFormatter={formatMonth} />
                      <YAxis tickFormatter={(value) => formatMoney(Number(value))} />
                      <Tooltip formatter={tooltipMoney} labelFormatter={tooltipMonth} />
                      <Legend />
                      <Bar dataKey="conservativeNet" name="Conservative net" fill={CHART_COLORS.coral} radius={[8, 8, 0, 0]} />
                      <Bar dataKey="optimisticNet" name="Optimistic net" fill={CHART_COLORS.teal} radius={[8, 8, 0, 0]} />
                      <Line type="monotone" dataKey="optimisticCumulative" name="Optimistic cumulative" stroke={CHART_COLORS.navy} strokeWidth={3} dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </Panel>
              <Panel title="Tax scenario mix" subtitle="Federal, Quebec, and contributions by scenario.">
                <div className="chart-frame tall">
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart
                      data={[
                        {
                          label: "Conservative",
                          federal: dashboard.tax.conservative.annual.federalTax,
                          quebec: dashboard.tax.conservative.annual.quebecTax,
                          contributions: dashboard.tax.conservative.annual.contributions.total,
                        },
                        {
                          label: "Optimistic",
                          federal: dashboard.tax.optimistic.annual.federalTax,
                          quebec: dashboard.tax.optimistic.annual.quebecTax,
                          contributions: dashboard.tax.optimistic.annual.contributions.total,
                        },
                      ]}
                    >
                      <CartesianGrid stroke="#d3c7b3" strokeDasharray="4 4" />
                      <XAxis dataKey="label" />
                      <YAxis tickFormatter={(value) => formatMoney(Number(value))} />
                      <Tooltip formatter={tooltipMoney} />
                      <Legend />
                      <Bar dataKey="federal" stackId="tax" fill={CHART_COLORS.navy} />
                      <Bar dataKey="quebec" stackId="tax" fill={CHART_COLORS.plum} />
                      <Bar dataKey="contributions" stackId="tax" fill={CHART_COLORS.gold} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Panel>
            </div>
            <div className="split-grid">
              <Panel title="What-if simulator" subtitle="Projected budget, liquidity, and annual surplus impact of one hypothetical purchase.">
                <form className="stack-form" onSubmit={(event) => void handleSimulator(event)}>
                  <div className="form-grid">
                    <label>
                      Purchase amount (CAD)
                      <input
                        type="number"
                        min="1"
                        step="0.01"
                        value={simulatorAmount}
                        onChange={(event) => setSimulatorAmount(event.target.value)}
                      />
                    </label>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={simulatorCounts}
                        onChange={(event) => setSimulatorCounts(event.target.checked)}
                      />
                      Counts toward discretionary budget
                    </label>
                  </div>
                  <button className="button button-primary" type="submit" disabled={runningAction === "simulator"}>
                    {runningAction === "simulator" ? "Running…" : "Run scenario"}
                  </button>
                </form>
                <div className="chart-frame">
                  <ResponsiveContainer width="100%" height={260}>
                    <BarChart
                      data={[
                        {
                          label: "Budget remaining",
                          before: dashboard.whatIf.budget.before.remaining,
                          after: dashboard.whatIf.budget.afterRemainingCad,
                        },
                        {
                          label: "Net liquid",
                          before: dashboard.whatIf.liquidity.netLiquidBeforeCad,
                          after: dashboard.whatIf.liquidity.netLiquidAfterCad,
                        },
                        {
                          label: "Opt. annual surplus",
                          before: dashboard.whatIf.forecast.optimisticAnnualSurplusBeforeCad,
                          after: dashboard.whatIf.forecast.optimisticAnnualSurplusAfterCad,
                        },
                      ]}
                    >
                      <CartesianGrid stroke="#d3c7b3" strokeDasharray="4 4" />
                      <XAxis dataKey="label" />
                      <YAxis tickFormatter={(value) => formatMoney(Number(value))} />
                      <Tooltip formatter={tooltipMoney} />
                      <Legend />
                      <Bar dataKey="before" fill={CHART_COLORS.gold} radius={[8, 8, 0, 0]} />
                      <Bar dataKey="after" fill={CHART_COLORS.teal} radius={[8, 8, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Panel>
              <Panel title="Forecast detail" subtitle="Month-by-month cashflow assumptions by scenario.">
                <div className="table-shell">
                  <table>
                    <thead>
                      <tr>
                        <th>Month</th>
                        <th className="numeric">Income</th>
                        <th className="numeric">Out</th>
                        <th className="numeric">AR</th>
                        <th className="numeric">AP</th>
                        <th className="numeric">Conservative</th>
                        <th className="numeric">Optimistic</th>
                        <th className="numeric">Opt. cumulative</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cashflowData.map((row) => (
                        <tr key={row.month}>
                          <td>{formatMonth(row.month)}</td>
                          <td className="numeric">{formatMoney(row.incomeCad)}</td>
                          <td className="numeric">{formatMoney(row.totalOut)}</td>
                          <td className="numeric">{formatMoney(row.arExpected)}</td>
                          <td className="numeric">{formatMoney(row.apDue)}</td>
                          <td className={classNames("numeric", row.conservativeNet < 0 ? "text-danger" : "text-positive")}>
                            {formatMoney(row.conservativeNet, { signed: true })}
                          </td>
                          <td className={classNames("numeric", row.optimisticNet < 0 ? "text-danger" : "text-positive")}>
                            {formatMoney(row.optimisticNet, { signed: true })}
                          </td>
                          <td className="numeric">{formatMoney(row.optimisticCumulative)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>
          </div>
        ) : null}

        {activeTab === "operations" ? (
          <div className="page-grid">
            <SectionTitle
              eyebrow="Operations"
              title="Receivables, payables, recurring items, and import health"
              copy="This section surfaces the near-term operational queue and import history instead of burying it in text-only tool output."
            />
            <div className="split-grid">
              <Panel title="AR / AP timeline" subtitle="Incoming cash stays positive; outflows are shown below zero.">
                <div className="chart-frame tall">
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart data={arApData}>
                      <CartesianGrid stroke="#d3c7b3" strokeDasharray="4 4" />
                      <XAxis dataKey="month" tickFormatter={formatMonth} />
                      <YAxis tickFormatter={(value) => formatMoney(Number(value))} />
                      <Tooltip formatter={tooltipMoney} labelFormatter={tooltipMonth} />
                      <Legend />
                      <Bar dataKey="receivableCad" name="Receivable" fill={CHART_COLORS.teal} radius={[8, 8, 0, 0]} />
                      <Bar dataKey="payableCad" name="Payable" fill={CHART_COLORS.coral} radius={[8, 8, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Panel>
              <Panel title="Recurring watchlist" subtitle="Past-due recurring items and the next expected dates for active ones.">
                <div className="stack-list">
                  {dashboard.recurring.rows.length === 0 ? (
                    <EmptyState title="No recurring items" copy="Recurring obligations have not been seeded yet." />
                  ) : (
                    dashboard.recurring.rows.map((row: FinanceRecurringItemData) => (
                      <article key={row.id} className="recurring-card">
                        <div className="recurring-topline">
                          <strong>{row.name}</strong>
                          <Badge tone={row.isPastDue ? "warning" : "neutral"}>{row.status}</Badge>
                        </div>
                        <p>
                          {formatMoney(row.amountCad)} · next {row.nextExpectedDate ? formatDate(row.nextExpectedDate) : "unknown"}
                        </p>
                        <small>{row.notes ?? row.matchValue}</small>
                      </article>
                    ))
                  )}
                </div>
              </Panel>
            </div>
            <div className="split-grid">
              <Panel title="Receivables" subtitle="Expected inflows and next action.">
                <div className="table-shell">
                  <table>
                    <thead>
                      <tr>
                        <th>Counterparty</th>
                        <th>Expected</th>
                        <th>Status</th>
                        <th className="numeric">CAD</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dashboard.receivables.rows.map((row) => (
                        <tr key={row.id}>
                          <td>{row.counterparty}</td>
                          <td>{formatDate(row.expectedDate)}</td>
                          <td>{row.status}</td>
                          <td className="numeric">{formatMoney(row.convertedCad)}</td>
                          <td>{row.nextAction}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
              <Panel title="Payables" subtitle="Outgoing obligations, certainty, and notes.">
                <div className="table-shell">
                  <table>
                    <thead>
                      <tr>
                        <th>Counterparty</th>
                        <th>Due</th>
                        <th>Certainty</th>
                        <th className="numeric">CAD</th>
                        <th>Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dashboard.payables.rows.map((row) => (
                        <tr key={row.id}>
                          <td>{row.counterparty}</td>
                          <td>{formatDate(row.dueDate)}</td>
                          <td>{row.certainty}</td>
                          <td className="numeric">{formatMoney(row.convertedCad)}</td>
                          <td>{row.notes ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>
            <Panel title="Import runs" subtitle="Most recent sheet or CSV imports into the finance ledger.">
              <div className="table-shell">
                <table>
                  <thead>
                    <tr>
                      <th>Started</th>
                      <th>Source</th>
                      <th className="numeric">Rows seen</th>
                      <th className="numeric">Inserted</th>
                      <th className="numeric">Updated</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.importRuns.rows.map((run: FinanceImportRunRowData) => (
                      <tr key={run.id}>
                        <td>{formatDateTime(run.startedAt)}</td>
                        <td>{run.source}</td>
                        <td className="numeric">{formatNumber(run.rowsSeen)}</td>
                        <td className="numeric">{formatNumber(run.rowsInserted)}</td>
                        <td className="numeric">{formatNumber(run.rowsUpdated)}</td>
                        <td>{run.error ? run.error : "OK"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
        ) : null}

        {activeTab === "review" ? (
          <div className="page-grid">
            <SectionTitle
              eyebrow="Review"
              title="Transaction review and search"
              copy="The queue is still the same finance review system, but now the UI makes raw, auto, user, and final states visible without digging through tool text."
            />
            <Panel title="Filters" subtitle="Search the ledger and isolate budget-counted or review-only rows.">
              <form className="filter-grid" onSubmit={(event) => void handleApplyTransactionFilters(event)}>
                <label>
                  Search
                  <input
                    type="search"
                    placeholder="Merchant, note, description"
                    value={transactionDraft.search ?? ""}
                    onChange={(event) => setTransactionDraft({ ...transactionDraft, search: event.target.value })}
                  />
                </label>
                <label>
                  Month
                  <input
                    type="month"
                    value={transactionDraft.month ?? ""}
                    onChange={(event) => setTransactionDraft({ ...transactionDraft, month: event.target.value })}
                  />
                </label>
                <label>
                  Account
                  <select
                    value={transactionDraft.account ?? ""}
                    onChange={(event) => setTransactionDraft({ ...transactionDraft, account: event.target.value })}
                  >
                    <option value="">All accounts</option>
                    {accountOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Category
                  <select
                    value={transactionDraft.category ?? ""}
                    onChange={(event) => setTransactionDraft({ ...transactionDraft, category: event.target.value })}
                  >
                    <option value="">All categories</option>
                    {categoryOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Limit
                  <select
                    value={String(transactionDraft.limit ?? 50)}
                    onChange={(event) => setTransactionDraft({ ...transactionDraft, limit: Number(event.target.value) })}
                  >
                    <option value="25">25</option>
                    <option value="50">50</option>
                    <option value="100">100</option>
                    <option value="150">150</option>
                    <option value="250">250</option>
                  </select>
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={Boolean(transactionDraft.onlyBudget)}
                    onChange={(event) => setTransactionDraft({ ...transactionDraft, onlyBudget: event.target.checked })}
                  />
                  Budget-counted only
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={Boolean(transactionDraft.onlyReview)}
                    onChange={(event) => setTransactionDraft({ ...transactionDraft, onlyReview: event.target.checked })}
                  />
                  Review queue only
                </label>
                <div className="button-row">
                  <button className="button button-primary" type="submit">
                    Apply filters
                  </button>
                  <button
                    className="button button-secondary"
                    type="button"
                    onClick={() => {
                      setTransactionDraft({ ...DEFAULT_TX_FILTERS, month: dashboard.overview.referenceDate.slice(0, 7) });
                      void refreshDashboard(DEFAULT_TX_FILTERS);
                    }}
                  >
                    Reset
                  </button>
                </div>
              </form>
            </Panel>
            <div className="split-grid">
              <Panel title="Review queue" subtitle="Select a row to confirm or override category and budget status.">
                <div className="stack-list">
                  {dashboard.review.rows.length === 0 ? (
                    <EmptyState title="Queue is clear" copy="No transactions currently need review." />
                  ) : (
                    dashboard.review.rows.map((row) => (
                      <button
                        key={row.id}
                        type="button"
                        className={classNames("review-item", row.id === selectedReview?.id && "review-item-active")}
                        onClick={() => setSelectedReviewId(row.id)}
                      >
                        <div className="review-item-topline">
                          <strong>{row.descriptionFinal ?? row.merchantName ?? row.descriptionRaw ?? "Transaction"}</strong>
                          <span>{formatMoney(Math.abs(row.amountCadResolved ?? row.amount))}</span>
                        </div>
                        <p>{formatDate(row.postedDate)} · {row.category.final}</p>
                        <small>{row.review.reason ?? "Needs review"}</small>
                      </button>
                    ))
                  )}
                </div>
              </Panel>
              <Panel title="Review detail" subtitle="Manual overrides update the same transaction review fields the finance agent already uses.">
                {!selectedReview || !reviewForm ? (
                  <EmptyState title="No review item selected" copy="Choose a transaction from the queue to inspect it." />
                ) : (
                  <form className="stack-form" onSubmit={(event) => void handleReviewSubmit(event)}>
                    <div className="detail-grid">
                      <div className="detail-card">
                        <span className="detail-label">Merchant</span>
                        <strong>{selectedReview.merchantName ?? selectedReview.descriptionRaw ?? "—"}</strong>
                      </div>
                      <div className="detail-card">
                        <span className="detail-label">Amount</span>
                        <strong>{formatMoney(selectedReview.amountCadResolved ?? selectedReview.amount, { signed: true, digits: 2 })}</strong>
                      </div>
                      <div className="detail-card">
                        <span className="detail-label">Auto category</span>
                        <strong>{selectedReview.category.auto ?? "—"}</strong>
                      </div>
                      <div className="detail-card">
                        <span className="detail-label">Reason</span>
                        <strong>{selectedReview.review.reason ?? "—"}</strong>
                      </div>
                    </div>
                    <div className="form-grid">
                      <label>
                        Final category
                        <input
                          value={reviewForm.category}
                          onChange={(event) => setReviewForm({ ...reviewForm, category: event.target.value })}
                        />
                      </label>
                      <label>
                        Display label
                        <input
                          value={reviewForm.descriptionClean}
                          onChange={(event) => setReviewForm({ ...reviewForm, descriptionClean: event.target.value })}
                        />
                      </label>
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={reviewForm.countsTowardBudget}
                          onChange={(event) => setReviewForm({ ...reviewForm, countsTowardBudget: event.target.checked })}
                        />
                        Counts toward discretionary budget
                      </label>
                      <label>
                        Note
                        <textarea
                          rows={4}
                          value={reviewForm.note}
                          onChange={(event) => setReviewForm({ ...reviewForm, note: event.target.value })}
                        />
                      </label>
                    </div>
                    <button className="button button-primary" type="submit" disabled={runningAction === "review"}>
                      {runningAction === "review" ? "Saving…" : "Save review"}
                    </button>
                  </form>
                )}
              </Panel>
            </div>
            <Panel title="Transactions" subtitle={`${formatNumber(dashboard.transactions.total)} matching rows.`}>
              <div className="table-shell">
                <table>
                  <thead>
                    <tr>
                      <th>Date / merchant</th>
                      <th>Account</th>
                      <th className="numeric">Amount</th>
                      <th>Category state</th>
                      <th>Budget state</th>
                      <th>Review / flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.transactions.rows.map((row) => (
                      <tr key={row.id}>
                        <td>
                          <div className="table-stack">
                            <strong>{row.descriptionFinal ?? row.merchantName ?? row.descriptionRaw ?? "Transaction"}</strong>
                            <small>{formatDate(row.postedDate)}</small>
                          </div>
                        </td>
                        <td>{row.accountName ?? "—"}</td>
                        <td className="numeric">{formatMoney(row.amountCadResolved ?? row.amount, { signed: true, digits: 2 })}</td>
                        <td>
                          <div className="table-stack">
                            <strong>{row.category.final}</strong>
                            <small>Auto: {row.category.auto ?? "—"} · User: {row.category.user ?? "—"}</small>
                          </div>
                        </td>
                        <td>
                          <div className="table-stack">
                            <strong>{formatBudgetState(row)}</strong>
                            <small>Auto: {String(row.countsTowardBudget.auto)} · User: {String(row.countsTowardBudget.user)}</small>
                          </div>
                        </td>
                        <td>
                          <div className="table-stack">
                            <strong>{row.review.needsReview ? "Needs review" : "Reviewed"}</strong>
                            <small>
                              {row.review.reason ?? "No outstanding reason"}
                              {row.flags.isTransfer ? " · Transfer" : ""}
                              {row.flags.isCcPayment ? " · CC payment" : ""}
                            </small>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
        ) : null}

        {activeTab === "setup" ? (
          <div className="page-grid">
            <SectionTitle
              eyebrow="Setup"
              title="Onboarding, source settings, and CSV import"
              copy="The old dashboard never finished setup/import workflows. This tab closes that gap so the finance workspace can actually be maintained."
            />
            <div className="checklist-grid">
              {checklist.map((item) => (
                <article key={item.label} className={classNames("check-card", item.done ? "check-card-done" : "check-card-open")}>
                  <div className="check-card-topline">
                    <strong>{item.label}</strong>
                    <Badge tone={item.done ? "positive" : "warning"}>{item.done ? "Ready" : "Needs attention"}</Badge>
                  </div>
                  <p>{item.detail}</p>
                </article>
              ))}
            </div>
            <div className="split-grid">
              <Panel title="Finance settings" subtitle="Budget, source sheet, timezone, and FX configuration.">
                <form className="stack-form" onSubmit={(event) => void handleSaveSettings(event)}>
                  <div className="form-grid">
                    <label>
                      Timezone
                      <input value={setupForm.timezone} onChange={(event) => setSetupForm({ ...setupForm, timezone: event.target.value })} />
                    </label>
                    <label>
                      Weekly limit (CAD)
                      <input
                        type="number"
                        step="0.01"
                        value={setupForm.weeklyLimitCad}
                        onChange={(event) => setSetupForm({ ...setupForm, weeklyLimitCad: event.target.value })}
                      />
                    </label>
                    <label>
                      Monthly limit (CAD)
                      <input
                        type="number"
                        step="0.01"
                        value={setupForm.monthlyLimitCad}
                        onChange={(event) => setSetupForm({ ...setupForm, monthlyLimitCad: event.target.value })}
                      />
                    </label>
                    <label>
                      Weekly start date
                      <input
                        type="date"
                        value={setupForm.weeklyStartDate}
                        onChange={(event) => setSetupForm({ ...setupForm, weeklyStartDate: event.target.value })}
                      />
                    </label>
                    <label>
                      USD/CAD planning FX
                      <input
                        type="number"
                        step="0.001"
                        value={setupForm.fxUsdCad}
                        onChange={(event) => setSetupForm({ ...setupForm, fxUsdCad: event.target.value })}
                      />
                    </label>
                    <label>
                      Spreadsheet ID
                      <input
                        value={setupForm.spreadsheetId}
                        onChange={(event) => setSetupForm({ ...setupForm, spreadsheetId: event.target.value })}
                      />
                    </label>
                    <label>
                      Accounts GID
                      <input value={setupForm.accountsGid} onChange={(event) => setSetupForm({ ...setupForm, accountsGid: event.target.value })} />
                    </label>
                    <label>
                      Transactions GID
                      <input
                        value={setupForm.transactionsGid}
                        onChange={(event) => setSetupForm({ ...setupForm, transactionsGid: event.target.value })}
                      />
                    </label>
                  </div>
                  <div className="button-row">
                    <button className="button button-primary" type="submit" disabled={runningAction === "settings"}>
                      {runningAction === "settings" ? "Saving…" : "Save settings"}
                    </button>
                    <button
                      className="button button-secondary"
                      type="button"
                      disabled={Boolean(runningAction)}
                      onClick={() => void handleSheetImport(true)}
                    >
                      Dry-run sheet sync
                    </button>
                    <button
                      className="button button-secondary"
                      type="button"
                      disabled={Boolean(runningAction)}
                      onClick={() => void handleSheetImport(false)}
                    >
                      Run sheet sync
                    </button>
                  </div>
                </form>
              </Panel>
              <Panel title="CSV import" subtitle="Paste raw CSV text or attach a file and import it into the finance ledger.">
                <div className="stack-form">
                  <label className="file-picker">
                    <span>Attach CSV file</span>
                    <input type="file" accept=".csv,text/csv" onChange={(event) => void handleCsvFileChange(event)} />
                  </label>
                  {csvFileName ? <p className="helper-text">Loaded file: {csvFileName}</p> : null}
                  <label>
                    CSV content
                    <textarea rows={12} value={csvText} onChange={(event) => setCsvText(event.target.value)} />
                  </label>
                  <div className="button-row">
                    <button className="button button-secondary" type="button" disabled={Boolean(runningAction)} onClick={() => void handleCsvImport(true)}>
                      Dry-run CSV import
                    </button>
                    <button className="button button-primary" type="button" disabled={Boolean(runningAction)} onClick={() => void handleCsvImport(false)}>
                      Import CSV
                    </button>
                  </div>
                  <p className="helper-text">
                    Imports go through the existing `finance_import` path, not a separate dashboard-only store.
                  </p>
                </div>
              </Panel>
            </div>
            <Panel title="Last import result" subtitle="Results from the most recent dashboard-driven sheet or CSV import.">
              {!importResult ? (
                <EmptyState title="No dashboard import run yet" copy="Run a sheet sync or CSV import to see live results here." />
              ) : (
                <div className="import-summary">
                  <MetricCard
                    label="Rows seen"
                    value={formatNumber(importResult.result.rowsSeen)}
                    caption={`Source: ${importResult.result.source}`}
                  />
                  <MetricCard
                    label="Inserted"
                    value={formatNumber(importResult.result.rowsInserted)}
                    caption={importResult.result.dryRun ? "Dry run only" : "New ledger rows"}
                  />
                  <MetricCard
                    label="Updated"
                    value={formatNumber(importResult.result.rowsUpdated)}
                    caption="Existing rows updated"
                  />
                </div>
              )}
            </Panel>
          </div>
        ) : null}
      </div>

      <footer className="app-footer">
        <div>
          <p className="eyebrow">Runtime details</p>
          <h3>FinanceService + SQLite + forecast config</h3>
          <p>
            {dashboard.metadata.serviceMetadata.databasePath}
            {" · "}
            {dashboard.metadata.serviceMetadata.forecastConfigPath}
          </p>
        </div>
        <div className="footer-meta">
          <span>{dashboard.metadata.app}</span>
          <span>Last metadata refresh: {formatDateTime(dashboard.metadata.timestamp)}</span>
          <span>Review queue: {formatNumber(dashboard.review.total)}</span>
        </div>
      </footer>
    </main>
  );
}
