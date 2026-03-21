import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { getRuntimeConfig } from "../config/runtime-config";
import {
  DEFAULT_FINANCE,
  DEFAULT_FINANCE_SETTINGS,
  type FinanceForecastConfig,
} from "../config/finance-config";
import type {
  FinanceAccountLiquidityRow,
  FinanceAccountsLiquidityData,
  FinanceAnnualTaxProjectionData,
  FinanceDashboardAlertData,
  FinanceDashboardCategoryDeltaData,
  FinanceDashboardHorizonPlanData,
  FinanceDashboardReminderData,
  FinanceDashboardSignalsData,
  FinanceBudgetHistoryData,
  FinanceBudgetSnapshotData,
  FinanceCashflowMonthData,
  FinanceCategoryAggregateData,
  FinanceCategoryAggregatesData,
  FinanceForecastCashflowData,
  FinanceForecastScenarioData,
  FinanceForecastSummaryData,
  FinanceFxEventData,
  FinanceFxInfoData,
  FinanceImportRunRowData,
  FinanceImportRunsData,
  FinanceIncomeProjectionData,
  FinanceIncomeSourceRowData,
  FinanceIncomeSourcesData,
  FinanceMetadataData,
  FinanceMonthlyTaxRateProjectionData,
  FinanceNormalizedTransaction,
  FinanceOverviewData,
  FinancePayableItemData,
  FinancePayablesData,
  FinanceRecurringCandidateData,
  FinanceReceivableItemData,
  FinanceReceivablesData,
  FinanceRecurringData,
  FinanceRecurringItemData,
  FinanceReviewQueueData,
  FinanceSheetInfoData,
  FinanceTaxProjectionData,
  FinanceTimelineAggregateData,
  FinanceTransactionsData,
  FinanceWhatIfData,
  FinanceWhatIfInput,
} from "./finance-dashboard-types";
import { resolveRuntimePath } from "./runtime-root";

type SqlValue = string | number | bigint | boolean | null;

export interface FinanceHistoryOptions {
  month?: string;
  fromDate?: string;
  toDate?: string;
  account?: string;
  category?: string;
  search?: string;
  onlyBudget?: boolean;
  onlyReview?: boolean;
  limit?: number;
}

export interface FinanceCategorizeDecision {
  id?: number;
  externalId?: string;
  category?: string | null;
  countsTowardBudget?: boolean | null;
  descriptionClean?: string | null;
  note?: string | null;
}

export interface FinanceImportOptions {
  source?: "fintable_gsheet" | "csv";
  dryRun?: boolean;
  spreadsheetId?: string;
  accountsGid?: string;
  transactionsGid?: string;
  csvText?: string;
}

export interface FinanceSettingsUpdateInput {
  timezone?: string;
  weeklyLimitCad?: number;
  monthlyLimitCad?: number;
  weeklyStartDate?: string;
  fxUsdCad?: number;
  spreadsheetId?: string;
  accountsGid?: string;
  transactionsGid?: string;
}

export interface FinanceAddExpenseInput {
  postedDate: string;
  amount: number;
  currency?: string;
  merchant?: string;
  description?: string;
  account?: string;
  category?: string;
  counts?: boolean;
  note?: string;
}

export interface FinanceAddReceivableInput {
  counterparty: string;
  amount?: number;
  amountCad?: number;
  currency?: string;
  earnedDate: string;
  expectedDate: string;
  status?: string;
  notes?: string;
}

export interface FinanceAddRecurringInput {
  name: string;
  matchKind?: string;
  matchValue: string;
  intervalKind?: string;
  intervalDays?: number;
  amountCad: number;
  amountToleranceCad?: number;
  currency?: string;
  graceDays?: number;
  nextExpectedDate?: string | null;
  lastSeenDate?: string | null;
  status?: string;
  notes?: string;
}

export interface FinanceSetRecurringInput {
  id?: number;
  name?: string;
  matchKind?: string;
  matchValue?: string;
  intervalKind?: string;
  intervalDays?: number;
  amountCad?: number;
  amountToleranceCad?: number;
  currency?: string;
  graceDays?: number;
  nextExpectedDate?: string | null;
  lastSeenDate?: string | null;
  status?: string;
  notes?: string;
}

export interface FinanceAddPayableInput {
  counterparty: string;
  description?: string;
  amount: number;
  currency?: string;
  amountCad?: number;
  dueDate: string;
  certainty?: "confirmed" | "expected" | "speculative";
  category?: string;
  notes?: string;
}

export interface FinanceAddIncomeSourceInput {
  name: string;
  type?: string;
  currency?: string;
  amountPerPeriod: number;
  period?: string;
  billing?: string;
  startDate: string;
  endDate?: string;
  confirmed?: boolean;
  guaranteedMonths?: number;
  notes?: string;
}

export interface FinanceAddFxEventInput {
  date: string;
  amountFrom: number;
  currencyFrom?: string;
  amountTo: number;
  currencyTo?: string;
  method?: string;
  notes?: string;
}

interface FinanceUpsertAccountOptions {
  importRunId?: number;
  source?: string;
}

interface FinanceSyntheticIncomeInput {
  externalId?: string;
  source?: string;
  accountExternalId?: string | null;
  accountName?: string | null;
  postedDate: string;
  amountCad: number;
  currency?: string;
  amount?: number;
  description: string;
  merchantName?: string | null;
  category?: string;
  note?: string | null;
  rawJson?: Record<string, unknown> | null;
}

type FinanceBudgetSnapshot =
  | {
      mode: "week";
      date: string;
      weekIndex: number;
      weekStart: string;
      weekEndExclusive: string;
      weeklyLimitCad: number;
      carryIn: number;
      available: number;
      spentCad: number;
      grossSpentCad: number;
      incomeCad: number;
      remaining: number;
      expectedToDate: number;
      paceDelta: number;
      uncertainSpentCad: number;
      unknownFxSpend: number;
    }
  | {
      mode: "month";
      month: string;
      from: string;
      toExclusive: string;
      limitCad: number;
      spentCad: number;
      grossSpentCad: number;
      incomeCad: number;
      remaining: number;
      expectedToDate: number;
      paceDelta: number;
      uncertainSpentCad: number;
      unknownFxSpend: number;
    };

type CategorizationRuleRow = {
  id: number;
  pattern: string;
  match_field: string;
  category: string;
  counts_toward_budget: number | null;
  confidence: number;
};

type TransactionRow = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  external_id TEXT UNIQUE,
  name TEXT,
  institution TEXT,
  currency TEXT,
  balance REAL,
  last_update TEXT,
  raw_json TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS account_balance_snapshots (
  id INTEGER PRIMARY KEY,
  import_run_id INTEGER,
  source TEXT NOT NULL,
  account_external_id TEXT NOT NULL,
  account_name TEXT,
  currency TEXT,
  balance REAL,
  captured_at TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(import_run_id, account_external_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  external_id TEXT UNIQUE,
  source TEXT NOT NULL,
  account_external_id TEXT,
  account_name TEXT,
  posted_date TEXT NOT NULL,
  authorized_date TEXT,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  amount_cad REAL,
  description_raw TEXT,
  merchant_name TEXT,
  description_clean TEXT,
  category_auto TEXT,
  category_auto_confidence REAL,
  category_user TEXT,
  counts_toward_budget_auto INTEGER,
  counts_toward_budget_user INTEGER,
  needs_review INTEGER NOT NULL DEFAULT 0,
  review_reason TEXT,
  is_transfer INTEGER NOT NULL DEFAULT 0,
  is_cc_payment INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  raw_json TEXT,
  imported_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS transactions_posted_date ON transactions(posted_date);
CREATE INDEX IF NOT EXISTS transactions_needs_review ON transactions(needs_review);

CREATE TABLE IF NOT EXISTS categorization_rules (
  id INTEGER PRIMARY KEY,
  pattern TEXT NOT NULL,
  match_field TEXT NOT NULL,
  category TEXT NOT NULL,
  counts_toward_budget INTEGER,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receivables (
  id INTEGER PRIMARY KEY,
  counterparty TEXT NOT NULL,
  amount_cad REAL NOT NULL,
  earned_date TEXT NOT NULL,
  expected_date TEXT NOT NULL,
  status TEXT NOT NULL,
  last_followup_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  amount REAL,
  currency TEXT DEFAULT 'CAD'
);

CREATE TABLE IF NOT EXISTS import_runs (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  rows_seen INTEGER,
  rows_inserted INTEGER,
  rows_updated INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS recurring (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  match_kind TEXT NOT NULL,
  match_value TEXT NOT NULL,
  interval_kind TEXT NOT NULL,
  interval_days INTEGER,
  amount_cad REAL NOT NULL,
  amount_tolerance_cad REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL,
  next_expected_date TEXT,
  last_seen_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  grace_days INTEGER NOT NULL DEFAULT 2,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS recurring_unique
  ON recurring(match_kind, match_value, interval_kind, amount_cad, currency);
CREATE INDEX IF NOT EXISTS recurring_status ON recurring(status);
CREATE INDEX IF NOT EXISTS recurring_next_expected ON recurring(next_expected_date);

CREATE TABLE IF NOT EXISTS payables (
  id INTEGER PRIMARY KEY,
  counterparty TEXT NOT NULL,
  description TEXT,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CAD',
  amount_cad REAL,
  due_date TEXT NOT NULL,
  certainty TEXT NOT NULL DEFAULT 'confirmed',
  category TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS payables_due_date ON payables(due_date);
CREATE INDEX IF NOT EXISTS payables_status ON payables(status);

CREATE TABLE IF NOT EXISTS income_sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  amount_per_period REAL NOT NULL,
  period TEXT NOT NULL,
  billing TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT,
  confirmed INTEGER NOT NULL DEFAULT 1,
  guaranteed_months INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fx_events (
  id INTEGER PRIMARY KEY,
  event_date TEXT NOT NULL,
  amount_from REAL NOT NULL,
  currency_from TEXT NOT NULL,
  amount_to REAL NOT NULL,
  currency_to TEXT NOT NULL,
  rate REAL NOT NULL,
  method TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);
`;

const DEFAULT_RULES: Array<[string, string, string, number, number]> = [
  ["doordash", "description_raw", "Food/Delivery", 1, 0.95],
  ["uber eats", "description_raw", "Food/Delivery", 1, 0.95],
  ["ubereats", "description_raw", "Food/Delivery", 1, 0.95],
  ["tim hortons", "description_raw", "Food/Coffee", 1, 0.85],
  ["starbucks", "description_raw", "Food/Coffee", 1, 0.85],
  ["spotify", "description_raw", "Bills/Subscriptions", 0, 0.9],
  ["netflix", "description_raw", "Bills/Subscriptions", 0, 0.9],
  ["bell", "description_raw", "Bills/Phone", 0, 0.75],
  ["rogers", "description_raw", "Bills/Phone", 0, 0.75],
  ["hydro", "description_raw", "Bills/Utilities", 0, 0.7],
  ["amazon", "description_raw", "Shopping/Online", 1, 0.6],
  ["shoppers drug mart", "description_raw", "Health/Pharmacy", 1, 0.6],
  ["rexall", "description_raw", "Health/Pharmacy", 1, 0.6],
  ["federal tax", "description_raw", "Tax/Federal", 0, 0.95],
  ["revenu quebec", "description_raw", "Tax/Quebec", 0, 0.95],
  ["cra", "description_raw", "Tax/Federal", 0, 0.9],
];

const INFERRED_ACCOUNT_INCOME_MIN_DELTA_CAD = 1000;
const INFERRED_ACCOUNT_INCOME_ACCOUNT_HINT = "non-registered";
const INFERRED_ACCOUNT_INCOME_COUNTERPARTY = "Client Payment";
const INFERRED_ACCOUNT_INCOME_RECEIVABLE_HINT = "client";
const RECEIVABLE_CLEAR_TOLERANCE_CAD = 25;

const FINAL_COUNTS =
  "COALESCE(counts_toward_budget_user, counts_toward_budget_auto, 0)";
const FINAL_CATEGORY =
  "COALESCE(category_user, category_auto, 'Uncategorized')";

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function finiteNumber(value: number | null | undefined, fallback = 0) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function formatCad(value: number) {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)} CAD`;
}

function formatSignedCad(value: number) {
  const sign = value < 0 ? "-" : "+";
  return `${sign}$${Math.abs(value).toFixed(2)} CAD`;
}

function formatMoney(value: number, currency = "CAD", precision = 2) {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-CA", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  })} ${currency}`;
}

function normText(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function heading(title: string) {
  return `\n${title}\n${"-".repeat(Math.min(60, title.length))}`;
}

function nowIso() {
  return new Date().toISOString();
}

function dateKey(date: Date) {
  return `${date.getUTCFullYear()}-${`${date.getUTCMonth() + 1}`.padStart(2, "0")}-${`${date.getUTCDate()}`.padStart(2, "0")}`;
}

function parseNumberLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const negative = /^\(.*\)$/.test(trimmed);
  const normalized = trimmed
    .replace(/^\(/, "")
    .replace(/\)$/, "")
    .replace(/[$,\s]/g, "")
    .replace(/[A-Za-z]/g, "");
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return negative ? -parsed : parsed;
}

function toIsoDate(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Missing date.");
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  const isoLike = /^\d{4}-\d{2}-\d{2}T/.exec(trimmed);
  if (isoLike) {
    return trimmed.slice(0, 10);
  }
  const slash = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (slash) {
    const month = Number.parseInt(slash[1] ?? "0", 10);
    const day = Number.parseInt(slash[2] ?? "0", 10);
    const year = Number.parseInt(slash[3] ?? "0", 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
    }
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return dateKey(parsed);
}

function toIsoMonth(value: string) {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed.slice(0, 7);
  }
  throw new Error(`Invalid month: ${value}`);
}

function daysInMonth(month: string) {
  const year = Number.parseInt(month.slice(0, 4), 10);
  const monthIndex = Number.parseInt(month.slice(5, 7), 10);
  return new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
}

function startEndForMonth(month: string) {
  const year = Number.parseInt(month.slice(0, 4), 10);
  const monthIndex = Number.parseInt(month.slice(5, 7), 10);
  const from = `${year.toString().padStart(4, "0")}-${monthIndex.toString().padStart(2, "0")}-01`;
  const nextMonth = monthIndex === 12
    ? `${(year + 1).toString().padStart(4, "0")}-01-01`
    : `${year.toString().padStart(4, "0")}-${(monthIndex + 1).toString().padStart(2, "0")}-01`;
  return { from, toExclusive: nextMonth };
}

function addDays(dateIso: string, days: number) {
  const next = new Date(`${dateIso}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return dateKey(next);
}

function daysBetween(startIso: string, endIso: string) {
  const start = new Date(`${startIso}T00:00:00Z`).getTime();
  const end = new Date(`${endIso}T00:00:00Z`).getTime();
  return Math.floor((end - start) / 86_400_000);
}

function addMonths(dateIso: string, months: number) {
  const [yearRaw, monthRaw, dayRaw] = dateIso.split("-");
  const year = Number.parseInt(yearRaw ?? "0", 10);
  const month = Number.parseInt(monthRaw ?? "0", 10);
  const day = Number.parseInt(dayRaw ?? "0", 10);
  const totalMonths = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(totalMonths / 12);
  const nextMonth = totalMonths % 12 + 1;
  const maxDay = daysInMonth(`${nextYear.toString().padStart(4, "0")}-${nextMonth.toString().padStart(2, "0")}`);
  return `${nextYear.toString().padStart(4, "0")}-${nextMonth.toString().padStart(2, "0")}-${Math.min(day, maxDay).toString().padStart(2, "0")}`;
}

function addYears(dateIso: string, years: number) {
  const [yearRaw, monthRaw, dayRaw] = dateIso.split("-");
  const year = Number.parseInt(yearRaw ?? "0", 10) + years;
  const month = Number.parseInt(monthRaw ?? "0", 10);
  const day = Number.parseInt(dayRaw ?? "0", 10);
  const maxDay = daysInMonth(`${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}`);
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${Math.min(day, maxDay).toString().padStart(2, "0")}`;
}

function computeNextExpected(lastSeen: string, intervalKind: string, intervalDays?: number | null) {
  if (intervalDays && intervalDays > 0) {
    return addDays(lastSeen, intervalDays);
  }
  switch (intervalKind) {
    case "weekly":
      return addDays(lastSeen, 7);
    case "biweekly":
      return addDays(lastSeen, 14);
    case "monthly":
      return addMonths(lastSeen, 1);
    default:
      return addYears(lastSeen, 1);
  }
}

function isPastDue(todayIso: string, nextExpected: string | null, graceDays: number) {
  if (!nextExpected) {
    return true;
  }
  return toIsoDate(todayIso) > addDays(nextExpected, graceDays);
}

function defaultGraceDays(intervalKind: string) {
  return intervalKind === "monthly" || intervalKind === "yearly" ? 2 : 1;
}

function stringOrNull(value: unknown) {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function numberOrNull(value: unknown) {
  if (value == null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanOrNull(value: unknown) {
  if (value == null) {
    return null;
  }
  return Number(value) === 1;
}

function rawCategoryFromJson(rawJson: Record<string, unknown> | null) {
  const category = rawJson?.personal_finance_category as Record<string, unknown> | undefined;
  return stringOrNull(category?.detailed) ?? stringOrNull(category?.primary);
}

function parseIsoToMs(value: string | null) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
type TaxConfig = FinanceForecastConfig["tax"];
type IncomeSourceRecord = Record<string, unknown>;
type RecurringRecord = Record<string, unknown>;
type PayableRecord = Record<string, unknown>;
type AccountBalanceRecord = Record<string, unknown>;
type ReceivableRecord = Record<string, unknown>;

function resolveConfiguredFinancePath(configuredPath: string | undefined, fallback: string) {
  const targetPath = configuredPath?.trim() || fallback;
  return path.isAbsolute(targetPath) ? path.normalize(targetPath) : resolveRuntimePath(targetPath);
}

export class FinanceService {
  private readonly db: Database;
  private readonly dbPath: string;
  private readonly forecastConfigPath: string;
  private readonly defaultSettings: Record<string, string>;
  private readonly defaultForecastConfig: FinanceForecastConfig;
  private closed = false;

  constructor(options?: { dbPath?: string; forecastConfigPath?: string }) {
    const financeConfig = getRuntimeConfig().finance;
    this.defaultSettings = structuredClone(financeConfig.defaults.settings) as Record<string, string>;
    this.defaultForecastConfig = structuredClone(financeConfig.defaults.forecast) as FinanceForecastConfig;
    this.dbPath = options?.dbPath ?? resolveConfiguredFinancePath(financeConfig.dbPath, DEFAULT_FINANCE.dbPath);
    this.forecastConfigPath = options?.forecastConfigPath
      ?? resolveConfiguredFinancePath(financeConfig.forecastConfigPath, DEFAULT_FINANCE.forecastConfigPath);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath, { create: true });

    try {
      this.db.exec("PRAGMA busy_timeout = 5000;");
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.db.exec(SCHEMA);
      this.migrateReceivables();
      this.migrateRecurring();
      this.seedDefaults();
      this.ensureForecastConfig();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  getDatabasePath() {
    return this.dbPath;
  }

  getForecastConfigPath() {
    return this.forecastConfigPath;
  }

  getSheetInfo(): FinanceSheetInfoData {
    const spreadsheetId = this.getSettingOrDefault("import.fintable.spreadsheet_id");
    const accountsGid = this.getSettingOrDefault("import.fintable.accounts_gid");
    const transactionsGid = this.getSettingOrDefault("import.fintable.transactions_gid");
    return {
      spreadsheetId,
      accountsGid,
      transactionsGid,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${transactionsGid}`,
      accountsCsvUrl: this.sheetCsvUrl(spreadsheetId, accountsGid),
      transactionsCsvUrl: this.sheetCsvUrl(spreadsheetId, transactionsGid),
    };
  }

  buildAssistantContext(reference: Date = new Date()) {
    const today = dateKey(reference);
    const weeklyStart = toIsoDate(this.getSettingOrDefault("budget.weekly_start_date"));
    const weeklyLimit = this.getNumericSettingOrDefault("budget.weekly_limit_cad");
    const budget = today >= weeklyStart
      ? this.computeWeeklyBudget(today, weeklyLimit, weeklyStart)
      : this.computeMonthlyBudget(today.slice(0, 7), this.getNumericSettingOrDefault("budget.monthly_limit_cad"), today);
    const reviewCount = Number(this.getRow<{ count: number }>("SELECT COUNT(1) AS count FROM transactions WHERE needs_review = 1")?.count ?? 0);
    const upcomingReceivable = this.getRow<{ counterparty: string; amount_cad: number; expected_date: string }>(
      "SELECT counterparty, amount_cad, expected_date FROM receivables WHERE status <> 'received' ORDER BY expected_date ASC LIMIT 1",
    );
    const nextPayable = this.getRow<{ counterparty: string; amount: number; currency: string; due_date: string }>(
      "SELECT counterparty, amount, currency, due_date FROM payables WHERE status <> 'paid' ORDER BY due_date ASC LIMIT 1",
    );

    return [
      budget.mode === "week"
        ? `Finance context: weekly budget ${formatCad(budget.spentCad)} spent, ${formatCad(budget.remaining)} remaining, carry-in ${formatCad(budget.carryIn)}.`
        : `Finance context: monthly budget ${formatCad(budget.spentCad)} spent, ${formatCad(budget.remaining)} remaining.`,
      reviewCount > 0 ? `Needs review: ${reviewCount} transaction${reviewCount === 1 ? "" : "s"}.` : "Needs review: none.",
      upcomingReceivable
        ? `Next receivable: ${upcomingReceivable.counterparty} ${formatCad(Number(upcomingReceivable.amount_cad ?? 0))} due ${upcomingReceivable.expected_date}.`
        : "No pending receivables.",
      nextPayable
        ? `Next payable: ${nextPayable.counterparty} ${formatMoney(Number(nextPayable.amount ?? 0), String(nextPayable.currency ?? "CAD"))} due ${nextPayable.due_date}.`
        : "No pending payables.",
    ].join("\n");
  }

  summary(reference: Date = new Date()) {
    const today = dateKey(reference);
    const weeklyStart = toIsoDate(this.getSettingOrDefault("budget.weekly_start_date"));
    const weeklyLimit = this.getNumericSettingOrDefault("budget.weekly_limit_cad");
    let output = "";

    if (today >= weeklyStart) {
      const budget = this.computeWeeklyBudget(today, weeklyLimit, weeklyStart);
      output += `${heading("Budget")}\n${this.renderBudgetBlock(budget)}\n`;
      const recent = this.allRows<Record<string, unknown>>(
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

    const reviewCount = Number(this.getRow<{ count: number }>("SELECT COUNT(1) AS count FROM transactions WHERE needs_review = 1")?.count ?? 0);
    const reviewRows = this.allRows<Record<string, unknown>>(
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

    const overdue = this.allRows<Record<string, unknown>>(
      "SELECT counterparty, amount_cad, expected_date, status FROM receivables WHERE status <> 'received' AND expected_date < ? ORDER BY expected_date",
      today,
    );
    const dueSoon = this.allRows<Record<string, unknown>>(
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

    const sheet = this.getSheetInfo();
    output += `${heading("Source")}\nGoogle Sheet: ${sheet.sheetUrl}`;

    return output.trim();
  }

  budget(options?: { date?: string; weeklyLimit?: number }) {
    if (options?.weeklyLimit !== undefined) {
      this.setSetting("budget.weekly_limit_cad", String(options.weeklyLimit));
    }
    const today = options?.date ? toIsoDate(options.date) : dateKey(new Date());
    const weeklyStart = toIsoDate(this.getSettingOrDefault("budget.weekly_start_date"));
    const weeklyLimit = this.getNumericSettingOrDefault("budget.weekly_limit_cad");
    const budget = today >= weeklyStart
      ? this.computeWeeklyBudget(today, weeklyLimit, weeklyStart)
      : this.computeMonthlyBudget(today.slice(0, 7), this.getNumericSettingOrDefault("budget.monthly_limit_cad"), today);
    return this.renderBudgetBlock(budget);
  }

  history(options: FinanceHistoryOptions = {}) {
    const limit = clamp(options.limit ?? 50, 1, 200);
    const { where, params } = this.buildTransactionFilters(options);
    const rows = this.allRows<Record<string, unknown>>(
      `SELECT id, posted_date, amount, currency, amount_cad, ${FINAL_CATEGORY} AS category,
          ${FINAL_COUNTS} AS counts, needs_review,
          COALESCE(description_clean, description_raw) AS description
        FROM transactions ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY posted_date DESC, id DESC LIMIT ?`,
      ...params,
      limit,
    );
    if (rows.length === 0) {
      return "(no transactions)";
    }
    return rows.map((row) => {
      const amount = Number(row.amount ?? 0);
      const currency = String(row.currency ?? "CAD");
      const amountCad = row.amount_cad == null ? null : Number(row.amount_cad);
      const displayAmount = amountCad != null && currency !== "CAD"
        ? `${amount < 0 ? "-" : ""}${formatCad(Math.abs(amountCad))}`
        : formatMoney(amount, currency);
      return `${row.posted_date} ${displayAmount} | ${row.category} | ${row.description}${Number(row.needs_review ?? 0) === 1 ? " (needs_review)" : ""} [id:${row.id}]`;
    }).join("\n");
  }

  reviewQueue(limit = 10) {
    const rows = this.allRows<Record<string, unknown>>(
      `SELECT id, posted_date, amount, currency, amount_cad, COALESCE(merchant_name, '') AS merchant,
          ${FINAL_CATEGORY} AS category, ${FINAL_COUNTS} AS counts_toward_budget,
          review_reason, COALESCE(description_clean, description_raw) AS description
        FROM transactions
        WHERE needs_review = 1
        ORDER BY posted_date DESC, id DESC LIMIT ?`,
      clamp(limit, 1, 50),
    );
    if (rows.length === 0) {
      return "Needs review: none.";
    }
    return rows.map((row, index) => {
      const amount = Number(row.amount_cad ?? row.amount ?? 0);
      return `${index + 1}) ${row.posted_date} ${formatCad(Math.abs(amount))} | ${row.merchant || row.description} | ${row.category} | counts=${row.counts_toward_budget} | ${row.review_reason ?? "?"} [id:${row.id}]`;
    }).join("\n");
  }

  categorize(decisions: FinanceCategorizeDecision[]) {
    let updated = 0;
    for (const decision of decisions) {
      const category = decision.category ?? null;
      const counts = decision.countsTowardBudget == null
        ? null
        : decision.countsTowardBudget ? 1 : 0;
      const descriptionClean = decision.descriptionClean ?? null;
      const note = decision.note ?? null;
      const clearReview = [category, counts, descriptionClean, note].some((value) => value !== null);
      if (decision.id != null) {
        const result = this.run(
          `UPDATE transactions SET
             category_user = COALESCE(?, category_user),
             counts_toward_budget_user = COALESCE(?, counts_toward_budget_user),
             description_clean = COALESCE(?, description_clean),
             note = COALESCE(?, note),
             needs_review = CASE WHEN ? = 1 THEN 0 ELSE needs_review END,
             review_reason = CASE WHEN ? = 1 THEN NULL ELSE review_reason END
           WHERE id = ?`,
          category,
          counts,
          descriptionClean,
          note,
          clearReview ? 1 : 0,
          clearReview ? 1 : 0,
          decision.id,
        );
        updated += Number(result.changes ?? 0);
        continue;
      }
      if (decision.externalId) {
        const result = this.run(
          `UPDATE transactions SET
             category_user = COALESCE(?, category_user),
             counts_toward_budget_user = COALESCE(?, counts_toward_budget_user),
             description_clean = COALESCE(?, description_clean),
             note = COALESCE(?, note),
             needs_review = CASE WHEN ? = 1 THEN 0 ELSE needs_review END,
             review_reason = CASE WHEN ? = 1 THEN NULL ELSE review_reason END
           WHERE external_id = ?`,
          category,
          counts,
          descriptionClean,
          note,
          clearReview ? 1 : 0,
          clearReview ? 1 : 0,
          decision.externalId,
        );
        updated += Number(result.changes ?? 0);
      }
    }
    const remaining = Number(this.getRow<{ count: number }>("SELECT COUNT(1) AS count FROM transactions WHERE needs_review = 1")?.count ?? 0);
    return { updated, remainingReview: remaining };
  }

  addExpense(input: FinanceAddExpenseInput) {
    const postedDate = toIsoDate(input.postedDate);
    const amount = input.amount;
    const currency = (input.currency ?? "CAD").toUpperCase();
    const merchant = input.merchant ?? null;
    const descriptionRaw = input.description ?? input.merchant ?? "Manual entry";
    const externalId = `manual:${crypto.randomUUID()}`;
    const base = {
      external_id: externalId,
      source: "manual",
      account_name: input.account ?? null,
      posted_date: postedDate,
      amount,
      currency,
      amount_cad: currency === "CAD" ? amount : null,
      description_raw: descriptionRaw,
      merchant_name: merchant,
      raw_json: null,
    };
    const auto = this.classifyTransaction(base);
    this.run(
      `INSERT INTO transactions(
         external_id, source, account_external_id, account_name, posted_date, authorized_date,
         amount, currency, amount_cad, description_raw, merchant_name, description_clean,
         category_auto, category_auto_confidence, category_user,
         counts_toward_budget_auto, counts_toward_budget_user,
         needs_review, review_reason, is_transfer, is_cc_payment, note, raw_json, imported_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      externalId,
      "manual",
      null,
      input.account ?? null,
      postedDate,
      null,
      amount,
      currency,
      currency === "CAD" ? amount : null,
      descriptionRaw,
      auto.merchantName,
      auto.descriptionClean,
      auto.categoryAuto,
      auto.categoryAutoConfidence,
      input.category ?? null,
      auto.countsTowardBudgetAuto,
      input.counts == null ? null : input.counts ? 1 : 0,
      auto.needsReview ? 1 : 0,
      auto.reviewReason,
      auto.isTransfer ? 1 : 0,
      auto.isCcPayment ? 1 : 0,
      input.note ?? null,
      null,
      nowIso(),
    );
    const row = this.getRow<{ id: number }>("SELECT last_insert_rowid() AS id");
    return { status: "added", id: Number(row?.id ?? 0), externalId };
  }

  async importTransactions(options: FinanceImportOptions = {}) {
    const source = options.source ?? "fintable_gsheet";
    const dryRun = options.dryRun === true;
    const run = this.run(
      "INSERT INTO import_runs(source, started_at, rows_seen, rows_inserted, rows_updated) VALUES(?, ?, 0, 0, 0)",
      source,
      nowIso(),
    );
    const runId = Number(run.lastInsertRowid ?? this.getRow<{ id: number }>("SELECT last_insert_rowid() AS id")?.id ?? 0);
    let rowsSeen = 0;
    let rowsInserted = 0;
    let rowsUpdated = 0;

    try {
      if (source === "fintable_gsheet") {
        const spreadsheetId = options.spreadsheetId ?? this.getSettingOrDefault("import.fintable.spreadsheet_id");
        const accountsGid = options.accountsGid ?? this.getSettingOrDefault("import.fintable.accounts_gid");
        const transactionsGid = options.transactionsGid ?? this.getSettingOrDefault("import.fintable.transactions_gid");
        if (!spreadsheetId || !accountsGid || !transactionsGid) {
          throw new Error("Missing Fintable sheet settings.");
        }
        const [accountsCsv, transactionsCsv] = await Promise.all([
          this.fetchText(this.sheetCsvUrl(spreadsheetId, accountsGid)),
          this.fetchText(this.sheetCsvUrl(spreadsheetId, transactionsGid)),
        ]);
        const accounts = this.parseCsvText(accountsCsv);
        const transactions = this.parseCsvText(transactionsCsv);
        rowsSeen = transactions.length;
        if (!dryRun) {
          for (const account of accounts) {
            this.upsertAccount(account, { importRunId: runId, source });
          }
          for (const row of transactions) {
            const result = this.upsertTransaction(row, "fintable_gsheet");
            if (result.inserted) {
              rowsInserted += 1;
            }
            if (result.updated) {
              rowsUpdated += 1;
            }
          }
        }
      } else {
        const csvText = options.csvText ?? "";
        if (!csvText.trim()) {
          throw new Error("csvText is required for source=csv.");
        }
        const rows = this.parseCsvText(csvText);
        rowsSeen = rows.length;
        if (!dryRun) {
          for (const row of rows) {
            const result = this.upsertTransaction(row, "csv_upload");
            if (result.inserted) {
              rowsInserted += 1;
            }
            if (result.updated) {
              rowsUpdated += 1;
            }
          }
        }
      }

      this.run(
        "UPDATE import_runs SET finished_at = ?, rows_seen = ?, rows_inserted = ?, rows_updated = ? WHERE id = ?",
        nowIso(),
        rowsSeen,
        rowsInserted,
        rowsUpdated,
        runId,
      );
      const reviewTop = this.allRows<Record<string, unknown>>(
        `SELECT id, posted_date, amount, currency, amount_cad, COALESCE(merchant_name, '') AS merchant,
            ${FINAL_CATEGORY} AS category, ${FINAL_COUNTS} AS counts, review_reason
          FROM transactions WHERE needs_review = 1
          ORDER BY posted_date DESC, id DESC LIMIT 10`,
      );
      return {
        source,
        dryRun,
        rowsSeen,
        rowsInserted,
        rowsUpdated,
        sheet: source === "fintable_gsheet" ? this.getSheetInfo() : undefined,
        needsReviewTop: reviewTop,
      };
    } catch (error) {
      this.run(
        "UPDATE import_runs SET finished_at = ?, error = ? WHERE id = ?",
        nowIso(),
        error instanceof Error ? error.message : String(error),
        runId,
      );
      throw error;
    }
  }

  addReceivable(input: FinanceAddReceivableInput) {
    const currency = (input.currency ?? "CAD").toUpperCase();
    const amount = input.amount ?? null;
    const amountCad = input.amountCad ?? (currency === "CAD" ? amount : null);
    this.run(
      `INSERT INTO receivables(
         counterparty, amount_cad, earned_date, expected_date, status,
         last_followup_date, notes, amount, currency, created_at, updated_at
       ) VALUES(?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      input.counterparty,
      amountCad,
      toIsoDate(input.earnedDate),
      toIsoDate(input.expectedDate),
      input.status ?? "pending",
      input.notes ?? null,
      amount,
      currency,
      nowIso(),
      nowIso(),
    );
    const row = this.getRow<{ id: number }>("SELECT last_insert_rowid() AS id");
    return { status: "added", id: Number(row?.id ?? 0) };
  }

  listReceivables(status?: string) {
    const rows = status
      ? this.allRows<Record<string, unknown>>("SELECT * FROM receivables WHERE status = ? ORDER BY expected_date", status)
      : this.allRows<Record<string, unknown>>("SELECT * FROM receivables WHERE status <> 'received' ORDER BY expected_date");
    if (rows.length === 0) {
      return "(no receivables)";
    }
    return rows.map((row) => {
      const currency = String(row.currency ?? "CAD");
      const amount = row.amount == null ? null : Number(row.amount);
      const amountCad = row.amount_cad == null ? null : Number(row.amount_cad);
      const display = currency !== "CAD" && amount != null && amountCad != null
        ? `${formatMoney(amount, currency)} (~${formatCad(amountCad)})`
        : formatCad(amountCad ?? 0);
      return `${row.counterparty}: ${display} | earned ${row.earned_date} | expected ${row.expected_date} | ${row.status}${row.notes ? ` | ${row.notes}` : ""} [id:${row.id}]`;
    }).join("\n");
  }

  checkReceivables(options?: { today?: string; horizonDays?: number }) {
    const today = options?.today ? toIsoDate(options.today) : dateKey(new Date());
    const horizonDays = options?.horizonDays ?? 14;
    const horizon = addDays(today, horizonDays);
    const overdue = this.allRows<Record<string, unknown>>(
      "SELECT * FROM receivables WHERE status <> 'received' AND expected_date < ? ORDER BY expected_date",
      today,
    );
    const dueSoon = this.allRows<Record<string, unknown>>(
      "SELECT * FROM receivables WHERE status <> 'received' AND expected_date >= ? AND expected_date <= ? ORDER BY expected_date",
      today,
      horizon,
    );
    const nextAction = (status: string) =>
      ({
        pending: "Send invoice / confirm timeline",
        invoiced: "Follow up receipt + date",
        chasing: "Escalate / firm date",
      }[status] ?? "Follow up");
    return [
      `AR check (today ${today}, horizon ${horizonDays}d)`,
      `${heading("Overdue")}\n${overdue.length > 0
        ? overdue.map((row) => `- ${row.counterparty}: ${formatCad(Number(row.amount_cad ?? 0))} (expected ${row.expected_date}, ${row.status}) -> ${nextAction(String(row.status ?? ""))} [id:${row.id}]`).join("\n")
        : "(none)"}`,
      `${heading("Due soon")}\n${dueSoon.length > 0
        ? dueSoon.map((row) => `- ${row.counterparty}: ${formatCad(Number(row.amount_cad ?? 0))} (expected ${row.expected_date}, ${row.status}) -> ${nextAction(String(row.status ?? ""))} [id:${row.id}]`).join("\n")
        : "(none)"}`,
    ].join("");
  }

  addRecurring(input: FinanceAddRecurringInput) {
    this.assertRecurringInput({
      name: input.name,
      match_kind: input.matchKind ?? "description",
      match_value: input.matchValue,
      interval_kind: input.intervalKind ?? "monthly",
      interval_days: input.intervalDays,
      amount_cad: input.amountCad,
      amount_tolerance_cad: input.amountToleranceCad ?? 0,
      currency: input.currency ?? "CAD",
      grace_days: input.graceDays ?? defaultGraceDays(input.intervalKind ?? "monthly"),
    });
    const graceDays = input.graceDays ?? defaultGraceDays(input.intervalKind ?? "monthly");
    const result = this.run(
      `INSERT INTO recurring(
         name, match_kind, match_value, interval_kind, interval_days,
         amount_cad, amount_tolerance_cad, currency, next_expected_date, last_seen_date, status, grace_days,
         notes, created_at, updated_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.name,
      input.matchKind ?? "description",
      input.matchValue,
      input.intervalKind ?? "monthly",
      input.intervalDays ?? null,
      input.amountCad,
      input.amountToleranceCad ?? 0,
      (input.currency ?? "CAD").toUpperCase(),
      input.nextExpectedDate ? toIsoDate(input.nextExpectedDate) : null,
      input.lastSeenDate ? toIsoDate(input.lastSeenDate) : null,
      input.status ?? "active",
      graceDays,
      input.notes ?? null,
      nowIso(),
      nowIso(),
    );
    return { status: "added", id: Number(result.lastInsertRowid ?? 0) };
  }

  setRecurring(input: FinanceSetRecurringInput) {
    if (input.id != null) {
      const existing = this.getRow<RecurringRecord>("SELECT * FROM recurring WHERE id = ?", input.id);
      if (!existing) {
        throw new Error(`Recurring rule ${input.id} not found.`);
      }
      const intervalKind = input.intervalKind ?? String(existing.interval_kind ?? "monthly");
      const graceDays = input.graceDays ?? Number(existing.grace_days ?? defaultGraceDays(intervalKind));
      const updated = {
        name: input.name ?? String(existing.name ?? ""),
        matchKind: input.matchKind ?? String(existing.match_kind ?? ""),
        matchValue: input.matchValue ?? String(existing.match_value ?? ""),
        intervalKind,
        intervalDays: input.intervalDays ?? numberOrNull(existing.interval_days),
        amountCad: input.amountCad ?? Number(existing.amount_cad ?? 0),
        amountToleranceCad: input.amountToleranceCad ?? Number(existing.amount_tolerance_cad ?? 0),
        currency: (input.currency ?? String(existing.currency ?? "CAD")).toUpperCase(),
        nextExpectedDate: input.nextExpectedDate === undefined
          ? stringOrNull(existing.next_expected_date)
          : (input.nextExpectedDate ? toIsoDate(input.nextExpectedDate) : null),
        lastSeenDate: input.lastSeenDate === undefined
          ? stringOrNull(existing.last_seen_date)
          : (input.lastSeenDate ? toIsoDate(input.lastSeenDate) : null),
        status: input.status ?? String(existing.status ?? "active"),
        graceDays,
        notes: input.notes === undefined ? stringOrNull(existing.notes) : input.notes,
      };
      this.assertRecurringInput({
        name: updated.name,
        match_kind: updated.matchKind,
        match_value: updated.matchValue,
        interval_kind: updated.intervalKind,
        interval_days: updated.intervalDays,
        amount_cad: updated.amountCad,
        amount_tolerance_cad: updated.amountToleranceCad,
        currency: updated.currency,
        grace_days: updated.graceDays,
      });
      this.run(
        `UPDATE recurring
          SET name = ?, match_kind = ?, match_value = ?, interval_kind = ?, interval_days = ?,
              amount_cad = ?, amount_tolerance_cad = ?, currency = ?, next_expected_date = ?, last_seen_date = ?,
              status = ?, grace_days = ?, notes = ?, updated_at = ?
          WHERE id = ?`,
        updated.name,
        updated.matchKind,
        updated.matchValue,
        updated.intervalKind,
        updated.intervalDays,
        updated.amountCad,
        updated.amountToleranceCad,
        updated.currency,
        updated.nextExpectedDate,
        updated.lastSeenDate,
        updated.status,
        updated.graceDays,
        updated.notes,
        nowIso(),
        input.id,
      );
      return { status: "updated", id: input.id };
    }
    return this.addRecurring({
      name: input.name!,
      matchKind: input.matchKind,
      matchValue: input.matchValue!,
      intervalKind: input.intervalKind,
      intervalDays: input.intervalDays,
      amountCad: input.amountCad!,
      amountToleranceCad: input.amountToleranceCad,
      currency: input.currency,
      graceDays: input.graceDays,
      nextExpectedDate: input.nextExpectedDate,
      lastSeenDate: input.lastSeenDate,
      status: input.status,
      notes: input.notes,
    });
  }

  deleteRecurring(id: number) {
    const result = this.run("DELETE FROM recurring WHERE id = ?", id);
    if (Number(result.changes ?? 0) === 0) {
      throw new Error(`Recurring rule ${id} not found.`);
    }
    return { status: "deleted", id, deleted: Number(result.changes ?? 0) };
  }

  listRecurring() {
    const rows = this.allRows<Record<string, unknown>>(
      "SELECT * FROM recurring ORDER BY status ASC, next_expected_date ASC, id ASC",
    );
    const active = rows.filter((row) => row.status === "active");
    const halted = rows.filter((row) => row.status === "halted");
    return `${this.renderRecurringList("Active recurring", active)}\n\n${this.renderRecurringList("Halted recurring", halted)}`;
  }

  refreshRecurring(options?: { today?: string; noAutoSeed?: boolean; seedLimit?: number }) {
    const today = options?.today ? toIsoDate(options.today) : dateKey(new Date());
    const result = this.refreshRecurringRules(today, !(options?.noAutoSeed ?? false), options?.seedLimit ?? 12);
    let output = `Recurring refresh (today: ${result.today})\n`;
    if (result.seeded.length > 0) {
      output += `\n${this.renderRecurringList("Auto-seeded new rules", result.seeded)}\n`;
    }
    output += `\n${this.renderRecurringList("ACTIVE", result.active)}`;
    output += `\n\n${this.renderRecurringList("HALTED", result.halted)}`;
    return output;
  }

  listRecurringCandidates(options?: { today?: string; includeKnown?: boolean; maxAgeDays?: number }) {
    const rows = this.getRecurringCandidatesData(options);
    return `${heading(`Recurring candidates (${rows.length})`)}\n${
      rows.length === 0
        ? "(none)"
        : rows.map((row) =>
          `- ${row.name}: ${formatCad(row.amountCad)} | ${row.intervalKind} | occurrences ${row.occurrences} | last ${row.lastSeen} | next ${row.nextExpectedDate}${row.alreadyTracked ? ` | tracked id:${row.existingRecurringId}` : ""}`
        ).join("\n")
    }`;
  }

  addPayable(input: FinanceAddPayableInput) {
    const result = this.run(
      `INSERT INTO payables(
         counterparty, description, amount, currency, amount_cad, due_date,
         certainty, category, status, notes, created_at, updated_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      input.counterparty,
      input.description ?? null,
      input.amount,
      (input.currency ?? "CAD").toUpperCase(),
      input.amountCad ?? null,
      toIsoDate(input.dueDate),
      input.certainty ?? "confirmed",
      input.category ?? null,
      input.notes ?? null,
      nowIso(),
      nowIso(),
    );
    return { status: "added", id: Number(result.lastInsertRowid ?? 0) };
  }

  listPayables(options?: { status?: string; certainty?: string }) {
    const where: string[] = [options?.status ? "status = ?" : "status <> 'paid'"];
    const params: SqlValue[] = [];
    if (options?.status) {
      params.push(options.status);
    }
    if (options?.certainty) {
      where.push("certainty = ?");
      params.push(options.certainty);
    }
    const rows = this.allRows<Record<string, unknown>>(
      `SELECT * FROM payables WHERE ${where.join(" AND ")} ORDER BY due_date`,
      ...params,
    );
    if (rows.length === 0) {
      return "(no payables)";
    }
    return rows.map((row) => {
      const certainty = String(row.certainty ?? "confirmed");
      const icon = certainty === "confirmed" ? "x" : certainty === "expected" ? "~" : "?";
      const amount = Number(row.amount ?? 0);
      const currency = String(row.currency ?? "CAD");
      const amountCad = row.amount_cad == null ? null : Number(row.amount_cad);
      return `[${icon}] ${row.counterparty}: ${formatMoney(amount, currency)}${amountCad != null && currency !== "CAD" ? ` (~${formatCad(amountCad)})` : ""} | due ${row.due_date} | ${certainty} | ${row.category ?? "-"} | ${row.description ?? ""} [id:${row.id}]`;
    }).join("\n");
  }

  markPayablePaid(id: number) {
    this.run(
      "UPDATE payables SET status = 'paid', updated_at = ? WHERE id = ?",
      nowIso(),
      id,
    );
    return { status: "paid", id };
  }

  markReceivableReceived(id: number, options?: { receivedDate?: string; note?: string }) {
    const existing = this.getRow<Record<string, unknown>>(
      "SELECT notes FROM receivables WHERE id = ?",
      id,
    );
    const receivedDate = toIsoDate(options?.receivedDate ?? dateKey(new Date()));
    const noteParts = [
      typeof existing?.notes === "string" && existing.notes.trim() ? existing.notes.trim() : null,
      options?.note?.trim() ? `${options.note.trim()} (${receivedDate})` : null,
    ].filter((value): value is string => Boolean(value));
    this.run(
      "UPDATE receivables SET status = 'received', last_followup_date = ?, notes = ?, updated_at = ? WHERE id = ?",
      receivedDate,
      noteParts.length > 0 ? noteParts.join(" | ") : null,
      nowIso(),
      id,
    );
    return { status: "received", id, receivedDate };
  }

  recordInferredIncome(input: FinanceSyntheticIncomeInput & { clearPendingReceivablesForCounterparty?: string | null }) {
    const result = this.upsertSyntheticIncomeTransaction({
      ...input,
      source: input.source ?? "account_balance_inference",
      category: input.category ?? "Income/Client",
    });
    const clearedReceivableIds = input.clearPendingReceivablesForCounterparty
      ? this.clearMatchingPendingReceivables(
          input.clearPendingReceivablesForCounterparty,
          input.amountCad,
          toIsoDate(input.postedDate),
          `Auto-cleared from inferred income transaction ${result.externalId}`,
        )
      : [];
    return {
      ...result,
      clearedReceivableIds,
    };
  }

  addIncomeSource(input: FinanceAddIncomeSourceInput) {
    const result = this.run(
      `INSERT INTO income_sources(
         name, type, currency, amount_per_period, period, billing,
         start_date, end_date, confirmed, guaranteed_months, notes, created_at, updated_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.name,
      input.type ?? "contract",
      (input.currency ?? "USD").toUpperCase(),
      input.amountPerPeriod,
      input.period ?? "monthly",
      input.billing ?? null,
      toIsoDate(input.startDate),
      input.endDate ? toIsoDate(input.endDate) : null,
      input.confirmed === false ? 0 : 1,
      input.guaranteedMonths ?? null,
      input.notes ?? null,
      nowIso(),
      nowIso(),
    );
    return { status: "added", id: Number(result.lastInsertRowid ?? 0) };
  }

  listIncomeSources() {
    const rows = this.allRows<Record<string, unknown>>(
      "SELECT * FROM income_sources ORDER BY confirmed DESC, start_date",
    );
    if (rows.length === 0) {
      return "(no income sources)";
    }
    return rows.map((row) => {
      const guaranteed = row.guaranteed_months ? ` (${row.guaranteed_months}mo guaranteed)` : "";
      const endDate = row.end_date ? ` -> ${row.end_date}` : "";
      return `[${Number(row.confirmed ?? 1) === 1 ? "x" : "!"}] ${row.name}: ${formatMoney(Number(row.amount_per_period ?? 0), String(row.currency ?? "USD"))}/${row.period} | ${row.type} | ${row.start_date}${endDate}${guaranteed} [id:${row.id}]`;
    }).join("\n");
  }

  addFxEvent(input: FinanceAddFxEventInput) {
    const rate = input.amountTo / input.amountFrom;
    const result = this.run(
      `INSERT INTO fx_events(
         event_date, amount_from, currency_from, amount_to, currency_to,
         rate, method, notes, created_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      toIsoDate(input.date),
      input.amountFrom,
      (input.currencyFrom ?? "USD").toUpperCase(),
      input.amountTo,
      (input.currencyTo ?? "CAD").toUpperCase(),
      rate,
      input.method ?? "norberts_gambit",
      input.notes ?? null,
      nowIso(),
    );
    return { status: "added", id: Number(result.lastInsertRowid ?? 0), rate };
  }

  listFxEvents() {
    const rows = this.allRows<Record<string, unknown>>(
      "SELECT * FROM fx_events ORDER BY event_date DESC",
    );
    if (rows.length === 0) {
      return "(no FX events)";
    }
    return rows.map((row) =>
      `${row.event_date}: ${formatMoney(Number(row.amount_from ?? 0), String(row.currency_from ?? "USD"))} -> ${formatMoney(Number(row.amount_to ?? 0), String(row.currency_to ?? "CAD"))} (rate ${Number(row.rate ?? 0).toFixed(4)}) | ${row.method} [id:${row.id}]`,
    ).join("\n");
  }

  forecast(view: "summary" | "cashflow" | "ar" | "ap" = "summary") {
    const config = this.loadForecastConfig();
    if (view === "cashflow") {
      return this.renderCashflow(config);
    }
    if (view === "ar") {
      return this.renderAr();
    }
    if (view === "ap") {
      return this.renderAp();
    }
    return this.renderForecastSummary(config);
  }

  getBudgetSnapshot(options?: { date?: string; weeklyLimit?: number }): FinanceBudgetSnapshotData {
    const dateIso = options?.date ? toIsoDate(options.date) : dateKey(new Date());
    return this.resolveBudgetSnapshot(dateIso, options?.weeklyLimit);
  }

  getBudgetHistoryData(options?: { date?: string; periods?: number }): FinanceBudgetHistoryData {
    const dateIso = options?.date ? toIsoDate(options.date) : dateKey(new Date());
    const periods = clamp(options?.periods ?? 12, 1, 104);
    const current = this.resolveBudgetSnapshot(dateIso);
    if (current.mode === 'week') {
      const weeklyStart = toIsoDate(this.getSettingOrDefault("budget.weekly_start_date"));
      const rows = [] as FinanceBudgetHistoryData['rows'];
      for (let offset = periods - 1; offset >= 0; offset -= 1) {
        const weekDate = addDays(current.weekStart, -7 * offset);
        if (weekDate < weeklyStart) {
          continue;
        }
        const snapshot = this.resolveBudgetSnapshot(weekDate);
        rows.push({
          snapshot,
          burnRate: snapshot.mode === 'week' && snapshot.available > 0 ? snapshot.spentCad / snapshot.available : 0,
        });
      }
      return {
        mode: 'week',
        periods: rows.length,
        current,
        rows,
      };
    }
    const rows = [] as FinanceBudgetHistoryData['rows'];
    for (let offset = periods - 1; offset >= 0; offset -= 1) {
      const monthDate = addMonths(`${current.month}-01`, -offset);
      const snapshot = this.resolveBudgetSnapshot(addDays(startEndForMonth(monthDate.slice(0, 7)).toExclusive, -1));
      rows.push({
        snapshot,
        burnRate: snapshot.mode === 'month' && snapshot.limitCad > 0 ? snapshot.spentCad / snapshot.limitCad : 0,
      });
    }
    return {
      mode: 'month',
      periods: rows.length,
      current,
      rows,
    };
  }

  getOverviewData(reference: Date | string = new Date()): FinanceOverviewData {
    const referenceDate = this.resolveReferenceDate(reference);
    const budget = this.resolveBudgetSnapshot(referenceDate);
    const accounts = this.getAccountsLiquidityData();
    const receivables = this.getReceivablesData({ today: referenceDate });
    const payables = this.getPayablesData({ today: referenceDate });
    const reviewCount = Number(this.getRow<{ count: number }>("SELECT COUNT(1) AS count FROM transactions WHERE needs_review = 1")?.count ?? 0);
    return {
      referenceDate,
      budget,
      paceIndicator: this.describeBudgetPace(budget),
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

  getDashboardSignalsData(reference: Date | string = new Date()): FinanceDashboardSignalsData {
    const referenceDate = this.resolveReferenceDate(reference);
    const currentMonth = referenceDate.slice(0, 7);
    const previousMonth = addMonths(`${currentMonth}-01`, -1).slice(0, 7);
    const trailingStartMonth = addMonths(`${currentMonth}-01`, -3).slice(0, 7);
    const yearStart = `${referenceDate.slice(0, 4)}-01-01`;
    const overview = this.getOverviewData(referenceDate);
    const receivables = this.getReceivablesData({ today: referenceDate });
    const payables = this.getPayablesData({ today: referenceDate });
    const recurring = this.getRecurringData({ today: referenceDate });
    const review = this.getReviewQueueData(25);
    const current = this.getCategoryAggregates({ month: currentMonth });
    const previous = this.getCategoryAggregates({ month: previousMonth });
    const ytd = this.getCategoryAggregates({ fromDate: yearStart, toDate: addDays(referenceDate, 1) });
    const trailing = this.getCategoryAggregates({
      fromDate: startEndForMonth(trailingStartMonth).from,
      toDate: startEndForMonth(currentMonth).toExclusive,
    });
    const taxAccountBalanceCad = finiteNumber(this.findTaxAccountBalanceCad());
    const dueNowCad = payables.rows
      .filter((row) => row.status !== "paid" && this.isTaxCategory(row.category))
      .reduce((sum, row) => sum + finiteNumber(row.convertedCad), 0);
    const incomeSanity = this.computeIncomeImportSanity(referenceDate);
    const taxProjection = this.getTaxProjectionData();
    const estimatedTaxRateOnReceivedIncome = finiteNumber(taxProjection.conservative.currentRate.rate);
    const estimatedTaxOnReceivedIncomeCad = finiteNumber(
      finiteNumber(incomeSanity.clientIncomeReceivedYtdCad) * estimatedTaxRateOnReceivedIncome,
    );
    const estimatedTaxShortfallCad = finiteNumber(Math.max(estimatedTaxOnReceivedIncomeCad - taxAccountBalanceCad, 0));
    const cashflow = this.getForecastCashflowData();
    const next30Days = this.buildDashboardHorizonPlan({
      referenceDate,
      horizonDays: 30,
      startingCashCad: overview.netLiquidCad,
      taxReserveCad: estimatedTaxOnReceivedIncomeCad,
      currentTaxBackpayCad: estimatedTaxShortfallCad,
      taxAccountBalanceCad,
      receivables,
      payables,
      recurring,
      forecastMonths: cashflow.conservative,
    });
    const next60Days = this.buildDashboardHorizonPlan({
      referenceDate,
      horizonDays: 60,
      startingCashCad: overview.netLiquidCad,
      taxReserveCad: estimatedTaxOnReceivedIncomeCad,
      currentTaxBackpayCad: estimatedTaxShortfallCad,
      taxAccountBalanceCad,
      receivables,
      payables,
      recurring,
      forecastMonths: cashflow.conservative,
    });
    const yearEnd = `${referenceDate.slice(0, 4)}-12-31`;
    const endOfYear = this.buildDashboardHorizonPlan({
      referenceDate,
      horizonDays: Math.max(0, daysBetween(referenceDate, yearEnd)),
      startingCashCad: overview.netLiquidCad,
      taxReserveCad: estimatedTaxOnReceivedIncomeCad,
      currentTaxBackpayCad: estimatedTaxShortfallCad,
      taxAccountBalanceCad,
      receivables,
      payables,
      recurring,
      forecastMonths: cashflow.conservative,
    });
    const endOfYearOptimistic = this.buildDashboardHorizonPlan({
      referenceDate,
      horizonDays: Math.max(0, daysBetween(referenceDate, yearEnd)),
      startingCashCad: overview.netLiquidCad,
      taxReserveCad: estimatedTaxOnReceivedIncomeCad,
      currentTaxBackpayCad: estimatedTaxShortfallCad,
      taxAccountBalanceCad,
      receivables,
      payables,
      recurring,
      forecastMonths: cashflow.optimistic,
    });
    const categoryDeltas = this.buildDashboardCategoryDeltas(current.groups, previous.groups);
    const alerts = this.buildDashboardAlerts({
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
    const reminders = this.buildDashboardReminders({
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
        taxAccountBalanceCad,
        coverageCad: finiteNumber(taxAccountBalanceCad - dueNowCad),
        enoughInTaxAccount: taxAccountBalanceCad >= dueNowCad,
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

  listTransactionsStructured(options: FinanceHistoryOptions = {}): FinanceTransactionsData {
    const limit = clamp(options.limit ?? 50, 1, 250);
    const { where, params, filters } = this.buildTransactionFilters(options);
    const total = Number(this.getRow<{ count: number }>(
      `SELECT COUNT(1) AS count FROM transactions ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}`,
      ...params,
    )?.count ?? 0);
    const rows = this.allRows<Record<string, unknown>>(
      `SELECT id, external_id, source, account_external_id, account_name, posted_date, authorized_date,
          amount, currency, amount_cad, description_raw, merchant_name, description_clean,
          category_auto, category_auto_confidence, category_user, ${FINAL_CATEGORY} AS category_final,
          counts_toward_budget_auto, counts_toward_budget_user, ${FINAL_COUNTS} AS counts_final,
          needs_review, review_reason, is_transfer, is_cc_payment, note, raw_json, imported_at
        FROM transactions ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY posted_date DESC, id DESC LIMIT ?`,
      ...params,
      limit,
    );
    return {
      total,
      limit,
      filters,
      rows: rows.map((row) => this.normalizeTransactionRow(row)),
    };
  }

  getReviewQueueData(limit = 10): FinanceReviewQueueData {
    const structured = this.listTransactionsStructured({ onlyReview: true, limit });
    const reasonBreakdown = this.allRows<Record<string, unknown>>(
      `SELECT COALESCE(review_reason, 'Unknown') AS reason, COUNT(1) AS count
        FROM transactions
        WHERE needs_review = 1
        GROUP BY COALESCE(review_reason, 'Unknown')
        ORDER BY count DESC, reason ASC`,
    ).map((row) => ({
      reason: String(row.reason ?? 'Unknown'),
      count: Number(row.count ?? 0),
    }));
    const categoryBreakdown = this.allRows<Record<string, unknown>>(
      `SELECT ${FINAL_CATEGORY} AS category, COUNT(1) AS count
        FROM transactions
        WHERE needs_review = 1
        GROUP BY ${FINAL_CATEGORY}
        ORDER BY count DESC, category ASC`,
    ).map((row) => ({
      category: String(row.category ?? 'Uncategorized'),
      count: Number(row.count ?? 0),
    }));
    return {
      total: structured.total,
      limit: structured.limit,
      rows: structured.rows,
      reasonBreakdown,
      categoryBreakdown,
    };
  }

  getCategoryAggregates(options: FinanceHistoryOptions = {}): FinanceCategoryAggregatesData {
    const { where, params, filters } = this.buildTransactionFilters(options);
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const groups = this.allRows<Record<string, unknown>>(
      `SELECT ${FINAL_CATEGORY} AS category,
          COUNT(1) AS transaction_count,
          COALESCE(SUM(CASE WHEN amount < 0 AND (currency = 'CAD' OR amount_cad IS NOT NULL)
            THEN -(COALESCE(amount_cad, amount)) ELSE 0 END), 0) AS spend_cad,
          COALESCE(SUM(CASE WHEN amount > 0 AND (currency = 'CAD' OR amount_cad IS NOT NULL)
            THEN COALESCE(amount_cad, amount) ELSE 0 END), 0) AS income_cad,
          COALESCE(SUM(CASE WHEN ${FINAL_COUNTS} = 1 THEN 1 ELSE 0 END), 0) AS budget_counted_transaction_count,
          COALESCE(SUM(CASE WHEN needs_review = 1 THEN 1 ELSE 0 END), 0) AS review_count,
          COALESCE(SUM(CASE WHEN currency <> 'CAD' AND amount_cad IS NULL THEN 1 ELSE 0 END), 0) AS unknown_fx_count
        FROM transactions ${whereSql}
        GROUP BY ${FINAL_CATEGORY}
        ORDER BY spend_cad DESC, category ASC`,
      ...params,
    ).map((row) => {
      const transactionCount = Number(row.transaction_count ?? 0);
      const spendCad = Number(row.spend_cad ?? 0);
      const incomeCad = Number(row.income_cad ?? 0);
      return {
        category: String(row.category ?? 'Uncategorized'),
        transactionCount,
        spendCad,
        incomeCad,
        netCad: spendCad - incomeCad,
        averageSpendCad: transactionCount > 0 ? spendCad / transactionCount : 0,
        budgetCountedTransactionCount: Number(row.budget_counted_transaction_count ?? 0),
        reviewCount: Number(row.review_count ?? 0),
        unknownFxCount: Number(row.unknown_fx_count ?? 0),
      } satisfies FinanceCategoryAggregateData;
    });
    const merchants = this.allRows<Record<string, unknown>>(
      `SELECT COALESCE(NULLIF(TRIM(merchant_name), ''), NULLIF(TRIM(description_clean), ''), NULLIF(TRIM(description_raw), ''), 'Unknown') AS merchant,
          COUNT(1) AS transaction_count,
          COALESCE(SUM(CASE WHEN amount < 0 AND (currency = 'CAD' OR amount_cad IS NOT NULL)
            THEN -(COALESCE(amount_cad, amount)) ELSE 0 END), 0) AS spend_cad,
          COALESCE(SUM(CASE WHEN amount > 0 AND (currency = 'CAD' OR amount_cad IS NOT NULL)
            THEN COALESCE(amount_cad, amount) ELSE 0 END), 0) AS income_cad,
          COALESCE(SUM(CASE WHEN ${FINAL_COUNTS} = 1 THEN 1 ELSE 0 END), 0) AS budget_counted_transaction_count,
          COALESCE(SUM(CASE WHEN needs_review = 1 THEN 1 ELSE 0 END), 0) AS review_count
        FROM transactions ${whereSql}
        GROUP BY merchant
        ORDER BY spend_cad DESC, merchant ASC
        LIMIT 25`,
      ...params,
    ).map((row) => ({
      merchant: String(row.merchant ?? 'Unknown'),
      transactionCount: Number(row.transaction_count ?? 0),
      spendCad: Number(row.spend_cad ?? 0),
      incomeCad: Number(row.income_cad ?? 0),
      netCad: Number(row.spend_cad ?? 0) - Number(row.income_cad ?? 0),
      budgetCountedTransactionCount: Number(row.budget_counted_transaction_count ?? 0),
      reviewCount: Number(row.review_count ?? 0),
    }));
    const timeline = this.allRows<Record<string, unknown>>(
      `SELECT substr(posted_date, 1, 7) AS bucket,
          COUNT(1) AS transaction_count,
          COALESCE(SUM(CASE WHEN amount < 0 AND (currency = 'CAD' OR amount_cad IS NOT NULL)
            THEN -(COALESCE(amount_cad, amount)) ELSE 0 END), 0) AS spend_cad,
          COALESCE(SUM(CASE WHEN amount > 0 AND (currency = 'CAD' OR amount_cad IS NOT NULL)
            THEN COALESCE(amount_cad, amount) ELSE 0 END), 0) AS income_cad,
          COALESCE(SUM(CASE WHEN amount < 0 AND ${FINAL_COUNTS} = 1 AND (currency = 'CAD' OR amount_cad IS NOT NULL)
            THEN -(COALESCE(amount_cad, amount)) ELSE 0 END), 0) AS budget_spend_cad,
          COALESCE(SUM(CASE WHEN amount > 0 AND ${FINAL_COUNTS} = 1 AND (currency = 'CAD' OR amount_cad IS NOT NULL)
            THEN COALESCE(amount_cad, amount) ELSE 0 END), 0) AS budget_income_cad
        FROM transactions ${whereSql}
        GROUP BY bucket
        ORDER BY bucket ASC`,
      ...params,
    ).map((row) => ({
      bucket: String(row.bucket ?? ''),
      transactionCount: Number(row.transaction_count ?? 0),
      spendCad: Number(row.spend_cad ?? 0),
      incomeCad: Number(row.income_cad ?? 0),
      netCad: Number(row.spend_cad ?? 0) - Number(row.income_cad ?? 0),
      budgetSpendCad: Number(row.budget_spend_cad ?? 0),
      budgetIncomeCad: Number(row.budget_income_cad ?? 0),
      budgetNetCad: Number(row.budget_spend_cad ?? 0) - Number(row.budget_income_cad ?? 0),
    } satisfies FinanceTimelineAggregateData));
    return {
      filters,
      totalSpendCad: groups.reduce((sum, group) => sum + group.spendCad, 0),
      totalIncomeCad: groups.reduce((sum, group) => sum + group.incomeCad, 0),
      totalNetCad: groups.reduce((sum, group) => sum + group.netCad, 0),
      totalBudgetNetCad: timeline.reduce((sum, row) => sum + row.budgetNetCad, 0),
      groups,
      merchants,
      timeline,
    };
  }

  getAccountsLiquidityData(): FinanceAccountsLiquidityData {
    const fxRate = this.getFxRate();
    const balances = this.loadAccountBalances();
    const accounts = [
      ...balances.liquid.map((row) => this.mapAccountRow(row, fxRate, 'liquid')),
      ...balances.registered.map((row) => this.mapAccountRow(row, fxRate, 'registered')),
      ...balances.debt.map((row) => this.mapAccountRow(row, fxRate, 'debt')),
    ].sort((left, right) => right.balanceCad - left.balanceCad);
    const liquid = accounts.filter((row) => row.classification === 'liquid');
    const registered = accounts.filter((row) => row.classification === 'registered');
    const debt = accounts.filter((row) => row.classification === 'debt');
    const liquidCad = liquid.reduce((sum, row) => sum + row.balanceCad, 0);
    const registeredCad = registered.reduce((sum, row) => sum + row.balanceCad, 0);
    const debtCad = debt.reduce((sum, row) => sum + Math.abs(row.balanceCad), 0);
    return {
      fxRate,
      accounts,
      liquid,
      registered,
      debt,
      totals: {
        liquidCad,
        registeredCad,
        debtCad,
        netLiquidCad: liquidCad - debtCad,
      },
    };
  }

  getReceivablesData(options?: { today?: string; horizonDays?: number; status?: string }): FinanceReceivablesData {
    const today = options?.today ? toIsoDate(options.today) : dateKey(new Date());
    const horizonDays = options?.horizonDays ?? 14;
    const horizonDate = addDays(today, horizonDays);
    const fxRate = this.getFxRate();
    const rows = this.loadReceivables(options?.status).map((row) => this.mapReceivableRow(row, today, fxRate));
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

  getPayablesData(options?: { today?: string; status?: string }): FinancePayablesData {
    const today = options?.today ? toIsoDate(options.today) : dateKey(new Date());
    const fxRate = this.getFxRate();
    const rows = this.loadPayables(options?.status ?? 'pending').map((row) => this.mapPayableRow(row, today, fxRate));
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

  getRecurringData(options?: { today?: string; refresh?: boolean; noAutoSeed?: boolean; seedLimit?: number }): FinanceRecurringData {
    const today = options?.today ? toIsoDate(options.today) : dateKey(new Date());
    const refreshResult = options?.refresh
      ? this.refreshRecurringRules(today, !(options?.noAutoSeed ?? false), options?.seedLimit ?? 12)
      : null;
    const rows = this.allRows<RecurringRecord>(
      'SELECT * FROM recurring ORDER BY status ASC, next_expected_date ASC, id ASC',
    ).map((row) => this.mapRecurringRow(row, today));
    return {
      today,
      totalMonthlyCad: rows.filter((row) => row.status === 'active').reduce((sum, row) => sum + row.monthlyCad, 0),
      active: rows.filter((row) => row.status === 'active'),
      halted: rows.filter((row) => row.status === 'halted'),
      rows,
      candidates: this.getRecurringCandidatesData({ today, includeKnown: false, maxAgeDays: 365 }),
      refresh: refreshResult
        ? {
            seeded: refreshResult.seeded.map((row) => this.mapRecurringRow(row, today)),
            active: refreshResult.active.map((row) => this.mapRecurringRow(row, today)),
            halted: refreshResult.halted.map((row) => this.mapRecurringRow(row, today)),
          }
        : null,
    };
  }

  getForecastSummaryData(): FinanceForecastSummaryData {
    return this.buildForecastSummaryData(this.loadForecastConfig());
  }

  getForecastCashflowData(): FinanceForecastCashflowData {
    return this.buildForecastCashflowData(this.loadForecastConfig());
  }

  getTaxProjectionData(): FinanceTaxProjectionData {
    return this.buildTaxProjectionData(this.loadForecastConfig());
  }

  getIncomeSourcesData(): FinanceIncomeSourcesData {
    const fxRate = this.getFxRate();
    const sources = this.loadIncomeSources();
    const conservativeProjection = this.projectAnnualIncome(sources, fxRate, false);
    const optimisticProjection = this.projectAnnualIncome(sources, fxRate, true);
    const rows: FinanceIncomeSourceRowData[] = sources.map((source) => {
      const startDate = String(source.start_date ?? '');
      const start = new Date(`${startDate}T00:00:00Z`);
      const monthsActive = Number.isFinite(start.getTime()) ? Math.max(0, 12 - start.getUTCMonth()) : 0;
      const amountPerPeriod = Number(source.amount_per_period ?? 0);
      const period = String(source.period ?? 'monthly');
      const monthlyEquivalent = period === 'biweekly' ? amountPerPeriod * 26 / 12 : amountPerPeriod;
      const confirmed = Number(source.confirmed ?? 1) === 1;
      const guaranteedMonths = Number(source.guaranteed_months ?? 0);
      const annualOrigOptimistic = period === 'biweekly'
        ? amountPerPeriod * Math.floor(26 * monthsActive / 12)
        : amountPerPeriod * monthsActive;
      const annualOrigConservative = confirmed ? annualOrigOptimistic : monthlyEquivalent * guaranteedMonths;
      return {
        id: Number(source.id ?? 0),
        name: String(source.name ?? ''),
        type: String(source.type ?? 'contract'),
        currency: String(source.currency ?? 'USD').toUpperCase(),
        amountPerPeriod,
        period,
        billing: stringOrNull(source.billing),
        startDate,
        endDate: stringOrNull(source.end_date),
        confirmed,
        guaranteedMonths,
        notes: stringOrNull(source.notes),
        monthlyEquivalent,
        annualOrigConservative,
        annualOrigOptimistic,
        annualCadConservative: this.toCad(annualOrigConservative, String(source.currency ?? 'USD'), fxRate),
        annualCadOptimistic: this.toCad(annualOrigOptimistic, String(source.currency ?? 'USD'), fxRate),
        includedInConservative: confirmed || guaranteedMonths > 0,
        includedInOptimistic: true,
        monthsActive,
      };
    });
    return {
      fxRate,
      rows,
      conservativeProjection,
      optimisticProjection,
    };
  }

  getFxInfoData(): FinanceFxInfoData {
    const events: FinanceFxEventData[] = this.allRows<Record<string, unknown>>(
      'SELECT * FROM fx_events ORDER BY event_date DESC, id DESC',
    ).map((row) => ({
      id: Number(row.id ?? 0),
      eventDate: String(row.event_date ?? ''),
      amountFrom: Number(row.amount_from ?? 0),
      currencyFrom: String(row.currency_from ?? 'USD').toUpperCase(),
      amountTo: Number(row.amount_to ?? 0),
      currencyTo: String(row.currency_to ?? 'CAD').toUpperCase(),
      rate: Number(row.rate ?? 0),
      method: stringOrNull(row.method),
      notes: stringOrNull(row.notes),
      createdAt: stringOrNull(row.created_at),
    }));
    return {
      activeRate: this.getFxRate(),
      pair: 'USD/CAD',
      settingsKey: 'fx.usdcad',
      latestEvent: events[0] ?? null,
      events,
      note: 'Forecast planning uses settings.fx.usdcad; fx_events are a historical ledger and audit trail.',
    };
  }

  listImportRunsData(limit = 20): FinanceImportRunsData {
    const clampedLimit = clamp(limit, 1, 100);
    const rows = this.allRows<Record<string, unknown>>(
      'SELECT * FROM import_runs ORDER BY started_at DESC, id DESC LIMIT ?',
      clampedLimit,
    ).map((row) => this.mapImportRunRow(row));
    const bySource = this.allRows<Record<string, unknown>>(
      `SELECT source, COUNT(1) AS run_count, COALESCE(SUM(rows_seen), 0) AS rows_seen,
          COALESCE(SUM(rows_inserted), 0) AS rows_inserted, COALESCE(SUM(rows_updated), 0) AS rows_updated,
          COALESCE(SUM(CASE WHEN error IS NOT NULL AND error <> '' THEN 1 ELSE 0 END), 0) AS error_count
        FROM import_runs GROUP BY source ORDER BY source ASC`,
    ).map((row) => ({
      source: String(row.source ?? ''),
      runCount: Number(row.run_count ?? 0),
      rowsSeen: Number(row.rows_seen ?? 0),
      rowsInserted: Number(row.rows_inserted ?? 0),
      rowsUpdated: Number(row.rows_updated ?? 0),
      errorCount: Number(row.error_count ?? 0),
    }));
    return {
      limit: clampedLimit,
      rows,
      bySource,
    };
  }

  updateSettings(input: FinanceSettingsUpdateInput) {
    if (input.timezone != null) {
      this.setSetting("timezone", input.timezone.trim());
    }
    if (input.weeklyLimitCad != null) {
      this.setSetting("budget.weekly_limit_cad", String(input.weeklyLimitCad));
    }
    if (input.monthlyLimitCad != null) {
      this.setSetting("budget.monthly_limit_cad", String(input.monthlyLimitCad));
    }
    if (input.weeklyStartDate != null) {
      this.setSetting("budget.weekly_start_date", toIsoDate(input.weeklyStartDate));
    }
    if (input.fxUsdCad != null) {
      this.setSetting("fx.usdcad", String(input.fxUsdCad));
    }
    if (input.spreadsheetId != null) {
      this.setSetting("import.fintable.spreadsheet_id", input.spreadsheetId.trim());
    }
    if (input.accountsGid != null) {
      this.setSetting("import.fintable.accounts_gid", input.accountsGid.trim());
    }
    if (input.transactionsGid != null) {
      this.setSetting("import.fintable.transactions_gid", input.transactionsGid.trim());
    }

    return this.getMetadataData();
  }

  getMetadataData(): FinanceMetadataData {
    const config = this.loadForecastConfig();
    const tableNames = ['settings', 'accounts', 'account_balance_snapshots', 'transactions', 'categorization_rules', 'receivables', 'import_runs', 'recurring', 'payables', 'income_sources', 'fx_events'] as const;
    const tableCounts = tableNames.map((table) => ({
      table,
      count: Number(this.getRow<{ count: number }>(`SELECT COUNT(1) AS count FROM ${table}`)?.count ?? 0),
    }));
    const transactionSourceCounts = this.allRows<Record<string, unknown>>(
      'SELECT source, COUNT(1) AS count FROM transactions GROUP BY source ORDER BY source ASC',
    ).map((row) => ({
      source: String(row.source ?? ''),
      count: Number(row.count ?? 0),
    }));
    const finalBudgetCountBreakdown = this.allRows<Record<string, unknown>>(
      `SELECT ${FINAL_COUNTS} AS counts_final, COUNT(1) AS count FROM transactions GROUP BY ${FINAL_COUNTS} ORDER BY counts_final ASC`,
    ).map((row) => ({
      countsTowardBudget: Number(row.counts_final ?? 0) === 1,
      count: Number(row.count ?? 0),
    }));
    return {
      generatedAt: nowIso(),
      databasePath: this.dbPath,
      forecastConfigPath: this.forecastConfigPath,
      sheet: this.getSheetInfo(),
      settings: {
        timezone: this.getSettingOrDefault("timezone"),
        weeklyLimitCad: this.getNumericSettingOrDefault("budget.weekly_limit_cad"),
        monthlyLimitCad: this.getNumericSettingOrDefault("budget.monthly_limit_cad"),
        weeklyStartDate: this.getSettingOrDefault("budget.weekly_start_date"),
        fxUsdCad: this.getFxRate(),
      },
      reviewCount: Number(this.getRow<{ count: number }>('SELECT COUNT(1) AS count FROM transactions WHERE needs_review = 1')?.count ?? 0),
      forecastConfig: {
        version: Number(config.version ?? 0),
        year: Number(config.year ?? 0),
        province: String(config.tax.province ?? ''),
        filingStatus: String(config.tax.filing_status ?? ''),
        note: String(config.note ?? ''),
      },
      tableCounts,
      transactionSourceCounts,
      finalBudgetCountBreakdown,
      latestImportRun: this.listImportRunsData(1).rows[0] ?? null,
    };
  }

  simulatePurchaseImpact(input: FinanceWhatIfInput): FinanceWhatIfData {
    if (!Number.isFinite(input.purchaseAmountCad) || input.purchaseAmountCad <= 0) {
      throw new Error('purchaseAmountCad must be a positive number.');
    }
    const referenceDate = input.date ? toIsoDate(input.date) : dateKey(new Date());
    const countsTowardBudget = input.countsTowardBudget ?? true;
    const budget = this.resolveBudgetSnapshot(referenceDate);
    const summary = this.getForecastSummaryData();
    const afterRemainingCad = countsTowardBudget ? budget.remaining - input.purchaseAmountCad : budget.remaining;
    const afterPaceDeltaCad = countsTowardBudget ? budget.paceDelta + input.purchaseAmountCad : budget.paceDelta;
    return {
      referenceDate,
      purchaseAmountCad: input.purchaseAmountCad,
      countsTowardBudget,
      budget: {
        before: budget,
        afterRemainingCad,
        afterPaceDeltaCad,
        withinBudget: afterRemainingCad >= 0,
      },
      liquidity: {
        netLiquidBeforeCad: summary.standing.netLiquidCad,
        netLiquidAfterCad: summary.standing.netLiquidCad - input.purchaseAmountCad,
        netPositionConfirmedBeforeCad: summary.standing.netPositionConfirmedCad,
        netPositionConfirmedAfterCad: summary.standing.netPositionConfirmedCad - input.purchaseAmountCad,
        netPositionAllBeforeCad: summary.standing.netPositionAllCad,
        netPositionAllAfterCad: summary.standing.netPositionAllCad - input.purchaseAmountCad,
      },
      forecast: {
        conservativeAnnualSurplusBeforeCad: summary.scenarios.conservative.annualSurplusCad,
        conservativeAnnualSurplusAfterCad: summary.scenarios.conservative.annualSurplusCad - input.purchaseAmountCad,
        optimisticAnnualSurplusBeforeCad: summary.scenarios.optimistic.annualSurplusCad,
        optimisticAnnualSurplusAfterCad: summary.scenarios.optimistic.annualSurplusCad - input.purchaseAmountCad,
        conservativeRunwayMonthsBefore: summary.scenarios.conservative.runwayMonths,
        conservativeRunwayMonthsAfter: this.computeRunwayMonths(summary.standing.netLiquidCad - input.purchaseAmountCad, summary.scenarios.conservative.monthlyBurnCad),
        optimisticRunwayMonthsBefore: summary.scenarios.optimistic.runwayMonths,
        optimisticRunwayMonthsAfter: this.computeRunwayMonths(summary.standing.netLiquidCad - input.purchaseAmountCad, summary.scenarios.optimistic.monthlyBurnCad),
      },
    };
  }

  private resolveReferenceDate(reference: Date | string) {
    return typeof reference === 'string' ? toIsoDate(reference) : dateKey(reference);
  }

  private resolveBudgetSnapshot(dateIso: string, weeklyLimitOverride?: number): FinanceBudgetSnapshotData {
    const weeklyStart = toIsoDate(this.getSettingOrDefault("budget.weekly_start_date"));
    const weeklyLimit = weeklyLimitOverride ?? this.getNumericSettingOrDefault("budget.weekly_limit_cad");
    if (dateIso >= weeklyStart) {
      return this.computeWeeklyBudget(dateIso, weeklyLimit, weeklyStart);
    }
    return this.computeMonthlyBudget(
      dateIso.slice(0, 7),
      this.getNumericSettingOrDefault("budget.monthly_limit_cad"),
      dateIso,
    );
  }

  private describeBudgetPace(snapshot: FinanceBudgetSnapshotData) {
    if (snapshot.paceDelta <= 0) {
      return 'on_track';
    }
    const threshold = snapshot.mode === 'week' ? snapshot.available : snapshot.limitCad;
    if (snapshot.paceDelta <= 0.1 * threshold) {
      return 'slightly_ahead';
    }
    return 'ahead_red';
  }

  private buildTransactionFilters(options: FinanceHistoryOptions) {
    const where: string[] = [];
    const params: SqlValue[] = [];
    let fromDate: string | null = null;
    let toDate: string | null = null;
    if (options.month) {
      const month = toIsoMonth(options.month);
      const range = startEndForMonth(month);
      fromDate = range.from;
      toDate = range.toExclusive;
      where.push('posted_date >= ?');
      params.push(range.from);
      where.push('posted_date < ?');
      params.push(range.toExclusive);
    } else {
      if (options.fromDate) {
        fromDate = toIsoDate(options.fromDate);
        where.push('posted_date >= ?');
        params.push(fromDate);
      }
      if (options.toDate) {
        toDate = toIsoDate(options.toDate);
        where.push('posted_date < ?');
        params.push(toDate);
      }
    }
    if (options.account) {
      where.push('account_name LIKE ?');
      params.push(`%${options.account}%`);
    }
    if (options.category) {
      where.push(`${FINAL_CATEGORY} LIKE ?`);
      params.push(`%${options.category}%`);
    }
    if (options.search) {
      const pattern = `%${options.search}%`;
      where.push(`(
        COALESCE(description_clean, '') LIKE ?
        OR COALESCE(description_raw, '') LIKE ?
        OR COALESCE(merchant_name, '') LIKE ?
        OR COALESCE(note, '') LIKE ?
        OR COALESCE(account_name, '') LIKE ?
      )`);
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
    if (options.onlyBudget) {
      where.push(`${FINAL_COUNTS} = 1`);
    }
    if (options.onlyReview) {
      where.push('needs_review = 1');
    }
    return {
      where,
      params,
      filters: {
        month: options.month ? toIsoMonth(options.month) : null,
        fromDate,
        toDate,
        account: options.account ?? null,
        category: options.category ?? null,
        search: options.search ?? null,
        onlyBudget: options.onlyBudget === true,
        onlyReview: options.onlyReview === true,
      },
    };
  }

  private normalizeTransactionRow(row: Record<string, unknown>): FinanceNormalizedTransaction {
    const rawJson = this.parseJson(row.raw_json);
    const amount = Number(row.amount ?? 0);
    const currency = String(row.currency ?? 'CAD').toUpperCase();
    const amountCad = numberOrNull(row.amount_cad);
    return {
      id: Number(row.id ?? 0),
      externalId: stringOrNull(row.external_id),
      source: String(row.source ?? 'unknown'),
      accountExternalId: stringOrNull(row.account_external_id),
      accountName: stringOrNull(row.account_name),
      postedDate: String(row.posted_date ?? ''),
      authorizedDate: stringOrNull(row.authorized_date),
      amount,
      currency,
      amountCad,
      amountCadResolved: currency === 'CAD' ? amount : amountCad,
      direction: amount < 0 ? 'debit' : amount > 0 ? 'credit' : 'zero',
      descriptionRaw: stringOrNull(row.description_raw),
      descriptionClean: stringOrNull(row.description_clean),
      descriptionFinal: stringOrNull(row.description_clean ?? row.description_raw),
      merchantName: stringOrNull(row.merchant_name),
      category: {
        raw: rawCategoryFromJson(rawJson),
        auto: stringOrNull(row.category_auto),
        user: stringOrNull(row.category_user),
        final: String(row.category_final ?? 'Uncategorized'),
        autoConfidence: numberOrNull(row.category_auto_confidence),
      },
      countsTowardBudget: {
        raw: null,
        auto: booleanOrNull(row.counts_toward_budget_auto),
        user: booleanOrNull(row.counts_toward_budget_user),
        final: Number(row.counts_final ?? 0) === 1,
      },
      review: {
        needsReview: Number(row.needs_review ?? 0) === 1,
        reason: stringOrNull(row.review_reason),
        reasonParts: stringOrNull(row.review_reason)?.split(/;\s*/).filter(Boolean) ?? [],
      },
      flags: {
        isTransfer: Number(row.is_transfer ?? 0) === 1,
        isCcPayment: Number(row.is_cc_payment ?? 0) === 1,
      },
      note: stringOrNull(row.note),
      importedAt: stringOrNull(row.imported_at),
    };
  }

  private mapAccountRow(
    row: AccountBalanceRecord,
    fxRate: number,
    classification: 'liquid' | 'registered' | 'debt',
  ): FinanceAccountLiquidityRow {
    const balance = Number(row.balance ?? 0);
    return {
      id: Number(row.id ?? 0),
      externalId: stringOrNull(row.external_id),
      name: String(row.name ?? ''),
      institution: stringOrNull(row.institution),
      currency: String(row.currency ?? 'CAD').toUpperCase(),
      balance,
      balanceCad: this.toCad(balance, String(row.currency ?? 'CAD').toUpperCase(), fxRate),
      classification,
      lastUpdate: stringOrNull(row.last_update),
      updatedAt: stringOrNull(row.updated_at),
    };
  }

  private receivableNextAction(status: string) {
    return ({
      pending: 'Send invoice / confirm timeline',
      invoiced: 'Follow up receipt + date',
      chasing: 'Escalate / firm date',
    }[status] ?? 'Follow up');
  }

  private mapReceivableRow(row: ReceivableRecord, today: string, fxRate: number): FinanceReceivableItemData {
    const currency = String(row.currency ?? 'CAD').toUpperCase();
    return {
      id: Number(row.id ?? 0),
      counterparty: String(row.counterparty ?? ''),
      amount: numberOrNull(row.amount),
      currency,
      amountCad: numberOrNull(row.amount_cad),
      convertedCad: this.toCad(Number(row.amount ?? row.amount_cad ?? 0), currency, fxRate),
      earnedDate: String(row.earned_date ?? ''),
      expectedDate: String(row.expected_date ?? ''),
      status: String(row.status ?? ''),
      lastFollowupDate: stringOrNull(row.last_followup_date),
      notes: stringOrNull(row.notes),
      isOverdue: String(row.expected_date ?? '') < today,
      nextAction: this.receivableNextAction(String(row.status ?? '')),
    };
  }

  private mapPayableRow(row: PayableRecord, today: string, fxRate: number): FinancePayableItemData {
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
      convertedCad: this.toCad(Number(row.amount ?? 0), currency, fxRate),
      dueDate: String(row.due_date ?? ''),
      certainty,
      category: stringOrNull(row.category),
      status: String(row.status ?? 'pending'),
      notes: stringOrNull(row.notes),
      isOverdue: String(row.due_date ?? '') < today,
    };
  }

  private mapRecurringRow(row: RecurringRecord, today: string): FinanceRecurringItemData {
    const amountCad = Number(row.amount_cad ?? 0);
    const intervalKind = String(row.interval_kind ?? 'monthly');
    const monthlyCad = intervalKind === 'biweekly'
      ? amountCad * 26 / 12
      : intervalKind === 'weekly'
        ? amountCad * 52 / 12
        : intervalKind === 'yearly'
          ? amountCad / 12
          : amountCad;
    const graceDays = Number(row.grace_days ?? defaultGraceDays(intervalKind));
    const nextExpectedDate = stringOrNull(row.next_expected_date);
    return {
      id: Number(row.id ?? 0),
      name: String(row.name ?? ''),
      matchKind: String(row.match_kind ?? ''),
      matchValue: String(row.match_value ?? ''),
      intervalKind,
      intervalDays: numberOrNull(row.interval_days),
      amountCad,
      amountToleranceCad: Number(row.amount_tolerance_cad ?? 0),
      currency: String(row.currency ?? 'CAD').toUpperCase(),
      monthlyCad,
      nextExpectedDate,
      lastSeenDate: stringOrNull(row.last_seen_date),
      status: String(row.status ?? 'active'),
      graceDays,
      notes: stringOrNull(row.notes),
      isPastDue: isPastDue(today, nextExpectedDate, graceDays),
    };
  }

  private mapImportRunRow(row: Record<string, unknown>): FinanceImportRunRowData {
    const startedAt = String(row.started_at ?? '');
    const finishedAt = stringOrNull(row.finished_at);
    const startedMs = parseIsoToMs(startedAt);
    const finishedMs = parseIsoToMs(finishedAt);
    return {
      id: Number(row.id ?? 0),
      source: String(row.source ?? ''),
      startedAt,
      finishedAt,
      rowsSeen: Number(row.rows_seen ?? 0),
      rowsInserted: Number(row.rows_inserted ?? 0),
      rowsUpdated: Number(row.rows_updated ?? 0),
      error: stringOrNull(row.error),
      durationMs: startedMs != null && finishedMs != null ? finishedMs - startedMs : null,
    };
  }

  private computeRunwayMonths(netLiquidCad: number, monthlyBurnCad: number) {
    if (monthlyBurnCad <= 0) {
      return null;
    }
    return Math.max(0, netLiquidCad) / monthlyBurnCad;
  }

  private buildForecastScenario(
    label: 'conservative' | 'optimistic',
    income: FinanceIncomeProjectionData,
    totalMonthlyExpenses: number,
    monthlyDiscretionary: number,
    config: FinanceForecastConfig,
    netLiquidCad: number,
  ): FinanceForecastScenarioData {
    const tax = this.calcAnnualTax(income.totalCad, config);
    const annualExpensesCad = (totalMonthlyExpenses + monthlyDiscretionary) * 12;
    const annualSurplusCad = tax.netAfterTaxAndAlimony - annualExpensesCad;
    const monthlySurplusCad = annualSurplusCad / 12;
    const monthlyBurnCad = Math.max(0, -monthlySurplusCad);
    return {
      label,
      incomeCad: income.totalCad,
      tax,
      annualExpensesCad,
      monthlyExpensesCad: totalMonthlyExpenses + monthlyDiscretionary,
      annualSurplusCad,
      monthlySurplusCad,
      monthlyBurnCad,
      runwayMonths: this.computeRunwayMonths(netLiquidCad, monthlyBurnCad),
    };
  }

  private addCumulativeCashflow(startingLiquidCad: number, rows: Array<Omit<FinanceCashflowMonthData, 'cumulativeCad'>>): FinanceCashflowMonthData[] {
    let cumulativeCad = startingLiquidCad;
    return rows.map((row) => {
      cumulativeCad += row.net;
      return { ...row, cumulativeCad };
    });
  }

  private buildForecastSummaryData(config: FinanceForecastConfig): FinanceForecastSummaryData {
    const fxRate = this.getFxRate();
    const sources = this.loadIncomeSources();
    const expenses = this.loadRecurringExpenses();
    const payables = this.loadPayables();
    const receivables = this.loadReceivables();
    const balances = this.loadAccountBalances();
    const totalLiquid = balances.liquid.reduce((sum, row) => sum + this.toCad(Number(row.balance ?? 0), String(row.currency ?? 'CAD'), fxRate), 0);
    const totalDebt = balances.debt.reduce((sum, row) => sum + this.toCad(Math.abs(Number(row.balance ?? 0)), String(row.currency ?? 'CAD'), fxRate), 0);
    const totalRegistered = balances.registered.reduce((sum, row) => sum + this.toCad(Number(row.balance ?? 0), String(row.currency ?? 'CAD'), fxRate), 0);
    const confirmedAp = payables.filter((row) => row.certainty === 'confirmed');
    const totalConfirmedAp = confirmedAp.reduce((sum, row) => sum + this.toCad(Number(row.amount ?? 0), String(row.currency ?? 'CAD'), fxRate), 0);
    const totalAllAp = payables.reduce((sum, row) => sum + this.toCad(Number(row.amount ?? 0), String(row.currency ?? 'CAD'), fxRate), 0);
    const pendingAr = receivables.reduce((sum, row) => sum + this.toCad(Number(row.amount ?? row.amount_cad ?? 0), String(row.currency ?? 'CAD'), fxRate), 0);
    const netLiquidCad = totalLiquid - totalDebt;
    const incomeConservative = this.projectAnnualIncome(sources, fxRate, false);
    const incomeOptimistic = this.projectAnnualIncome(sources, fxRate, true);
    const recurringMonthlyCad = expenses.reduce((sum, row) => sum + row.monthlyCad, 0);
    const discretionaryMonthlyCad = this.getNumericSettingOrDefault("budget.weekly_limit_cad") * 52 / 12;
    const currentMonth = new Date().getUTCMonth() + 1;
    return {
      year: Number(config.year ?? 0),
      fxRate,
      standing: {
        liquidCad: totalLiquid,
        debtCad: totalDebt,
        registeredCad: totalRegistered,
        netLiquidCad,
        pendingReceivablesCad: pendingAr,
        confirmedPayablesCad: totalConfirmedAp,
        allPayablesCad: totalAllAp,
        netPositionConfirmedCad: netLiquidCad - totalConfirmedAp + pendingAr,
        netPositionAllCad: netLiquidCad - totalAllAp + pendingAr,
      },
      income: {
        conservative: incomeConservative,
        optimistic: incomeOptimistic,
      },
      expenses: {
        recurringMonthlyCad,
        discretionaryMonthlyCad,
        totalMonthlyCad: recurringMonthlyCad + discretionaryMonthlyCad,
        totalAnnualCad: (recurringMonthlyCad + discretionaryMonthlyCad) * 12,
      },
      scenarios: {
        conservative: this.buildForecastScenario('conservative', incomeConservative, recurringMonthlyCad, discretionaryMonthlyCad, config, netLiquidCad),
        optimistic: this.buildForecastScenario('optimistic', incomeOptimistic, recurringMonthlyCad, discretionaryMonthlyCad, config, netLiquidCad),
      },
      currentTaxRates: {
        monthNumber: currentMonth,
        conservative: this.calcTaxRateForMonth(currentMonth, 0, sources, fxRate, config, false),
        optimistic: this.calcTaxRateForMonth(currentMonth, 0, sources, fxRate, config, true),
      },
    };
  }

  private buildForecastCashflowData(config: FinanceForecastConfig): FinanceForecastCashflowData {
    const fxRate = this.getFxRate();
    const sources = this.loadIncomeSources();
    const expenses = this.loadRecurringExpenses();
    const confirmedPayables = this.loadPayables().filter((row) => row.certainty === 'confirmed');
    const allPayables = this.loadPayables();
    const receivables = this.loadReceivables();
    const balances = this.loadAccountBalances();
    const startingLiquidCad = balances.liquid.reduce((sum, row) => sum + this.toCad(Number(row.balance ?? 0), String(row.currency ?? 'CAD'), fxRate), 0)
      - balances.debt.reduce((sum, row) => sum + this.toCad(Math.abs(Number(row.balance ?? 0)), String(row.currency ?? 'CAD'), fxRate), 0);
    return {
      year: Number(config.year ?? 0),
      fxRate,
      startingLiquidCad,
      conservative: this.addCumulativeCashflow(startingLiquidCad, this.buildCashflow(sources, expenses, confirmedPayables, receivables, fxRate, config, false)),
      optimistic: this.addCumulativeCashflow(startingLiquidCad, this.buildCashflow(sources, expenses, allPayables, receivables, fxRate, config, true)),
    };
  }

  private buildTaxProjectionData(config: FinanceForecastConfig): FinanceTaxProjectionData {
    const summary = this.buildForecastSummaryData(config);
    return {
      year: summary.year,
      fxRate: summary.fxRate,
      conservative: {
        annual: summary.scenarios.conservative.tax,
        currentRate: summary.currentTaxRates.conservative,
      },
      optimistic: {
        annual: summary.scenarios.optimistic.tax,
        currentRate: summary.currentTaxRates.optimistic,
      },
    };
  }

  close() {
    if (this.closed) {
      return;
    }
    this.db.close(false);
    this.closed = true;
  }

  private allRows<T extends Record<string, unknown>>(sql: string, ...params: SqlValue[]) {
    return this.db.query(sql).all(...params) as T[];
  }

  private getRow<T extends Record<string, unknown>>(sql: string, ...params: SqlValue[]) {
    return (this.db.query(sql).get(...params) as T | null) ?? null;
  }

  private run(sql: string, ...params: SqlValue[]) {
    return this.db.query(sql).run(...params);
  }

  private migrateReceivables() {
    const columns = this.allRows<{ name: string }>("PRAGMA table_info(receivables)").map((row) => String(row.name));
    if (!columns.includes("currency")) {
      this.db.exec("ALTER TABLE receivables ADD COLUMN currency TEXT DEFAULT 'CAD';");
    }
    if (!columns.includes("amount")) {
      this.db.exec("ALTER TABLE receivables ADD COLUMN amount REAL;");
      this.db.exec("UPDATE receivables SET amount = amount_cad WHERE amount IS NULL AND currency = 'CAD';");
    }
  }

  private migrateRecurring() {
    const columns = this.allRows<{ name: string }>("PRAGMA table_info(recurring)").map((row) => String(row.name));
    if (!columns.includes("amount_tolerance_cad")) {
      this.db.exec("ALTER TABLE recurring ADD COLUMN amount_tolerance_cad REAL NOT NULL DEFAULT 0;");
    }
  }

  private seedDefaults() {
    for (const [key, value] of Object.entries(this.defaultSettings)) {
      this.run(
        "INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)",
        key,
        value,
      );
    }
    for (const [pattern, matchField, category, counts, confidence] of DEFAULT_RULES) {
      const existingRule = this.getRow<{ id: number }>(
        `SELECT id FROM categorization_rules
          WHERE pattern = ? AND match_field = ? AND category = ?
          LIMIT 1`,
        pattern,
        matchField,
        category,
      );
      if (existingRule) {
        continue;
      }
      this.run(
        `INSERT INTO categorization_rules(
           pattern, match_field, category, counts_toward_budget, confidence, created_at
         ) VALUES(?, ?, ?, ?, ?, ?)`,
        pattern,
        matchField,
        category,
        counts,
        confidence,
        nowIso(),
      );
    }
  }

  private ensureForecastConfig() {
    fs.mkdirSync(path.dirname(this.forecastConfigPath), { recursive: true });
    if (!fs.existsSync(this.forecastConfigPath)) {
      fs.writeFileSync(
        `${this.forecastConfigPath}`,
        `${JSON.stringify(this.defaultForecastConfig, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  }

  private loadForecastConfig() {
    const raw = JSON.parse(fs.readFileSync(this.forecastConfigPath, "utf8")) as FinanceForecastConfig;
    return raw;
  }

  private getSetting(key: string) {
    const row = this.getRow<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
    return row?.value ?? null;
  }

  private getSettingOrDefault(key: string) {
    return this.getSetting(key) ?? this.defaultSettings[key] ?? DEFAULT_FINANCE_SETTINGS[key] ?? "";
  }

  private getNumericSettingOrDefault(key: string) {
    const parsed = Number.parseFloat(this.getSettingOrDefault(key));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private setSetting(key: string, value: string) {
    this.run(
      `INSERT INTO settings(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  private detectIsCcPayment(descriptionRaw: string, rawJson: Record<string, unknown> | null) {
    const description = normText(descriptionRaw);
    if (description.includes("credit card payment") || description.includes("payment - thank you")) {
      return true;
    }
    const primary = String((rawJson?.personal_finance_category as Record<string, unknown> | undefined)?.primary ?? "");
    return primary.toUpperCase().includes("CREDIT_CARD");
  }

  private detectIsTransfer(descriptionRaw: string, rawJson: Record<string, unknown> | null) {
    const description = normText(descriptionRaw);
    const primary = normText(String((rawJson?.personal_finance_category as Record<string, unknown> | undefined)?.primary ?? ""));
    if (primary.includes("transfer")) {
      return true;
    }
    return ["transfer in", "transfer out", "etransfer", "e-transfer"].some((keyword) => description.includes(keyword))
      || description.startsWith("transfer");
  }

  private extractMerchant(descriptionRaw: string, rawJson: Record<string, unknown> | null) {
    const direct = typeof rawJson?.merchant_name === "string" ? rawJson.merchant_name : null;
    if (direct && direct.trim()) {
      return direct.trim();
    }
    const counterparties = Array.isArray(rawJson?.counterparties) ? rawJson?.counterparties as Array<Record<string, unknown>> : [];
    const counterparty = counterparties.find((entry) => typeof entry.name === "string" && entry.name.trim());
    if (counterparty?.name && typeof counterparty.name === "string") {
      return counterparty.name.trim();
    }
    const rawName = typeof rawJson?.name === "string" ? rawJson.name : null;
    if (rawName && rawName.trim()) {
      return rawName.trim();
    }
    const [first] = descriptionRaw.trim().split(/\s+-\s+/);
    return first && first.length <= 40 ? first.trim() : null;
  }

  private mapPlaidCategory(rawJson: Record<string, unknown> | null) {
    const financeCategory = rawJson?.personal_finance_category as Record<string, unknown> | undefined;
    const primary = normText(String(financeCategory?.primary ?? ""));
    const detailed = normText(String(financeCategory?.detailed ?? ""));
    const confidenceLevel = normText(String(financeCategory?.confidence_level ?? ""));
    const confidenceMap: Record<string, number> = {
      very_high: 0.95,
      high: 0.85,
      medium: 0.7,
      low: 0.55,
    };
    const confidence = confidenceMap[confidenceLevel] ?? 0.6;
    if (primary.includes("transfer")) {
      return { category: "Transfers/Internal", confidence };
    }
    if (primary.includes("income")) {
      return { category: "Income/Client", confidence };
    }
    if (primary.includes("food")) {
      if (detailed.includes("grocer")) {
        return { category: "Food/Groceries", confidence };
      }
      return { category: "Food/Restaurant", confidence: detailed.includes("fast_food") || detailed.includes("restaurant") ? confidence : clamp(confidence - 0.1, 0, 1) };
    }
    if (primary.includes("rent")) {
      return { category: detailed.includes("rent") ? "Housing/Rent" : "Bills/Utilities", confidence };
    }
    if (primary.includes("general_merchandise") || primary.includes("shopping")) {
      return { category: "Shopping/General", confidence: clamp(confidence - 0.1, 0, 1) };
    }
    if (primary.includes("entertainment")) {
      return { category: "Entertainment", confidence };
    }
    if (primary.includes("health") || primary.includes("medical")) {
      return { category: "Health/Medical", confidence: clamp(confidence - 0.1, 0, 1) };
    }
    if (primary.includes("travel") || primary.includes("transportation")) {
      return { category: "Transport", confidence };
    }
    return { category: null, confidence: 0 };
  }

  private getRules() {
    return this.allRows<CategorizationRuleRow>(
      `SELECT id, pattern, match_field, category, counts_toward_budget, confidence
        FROM categorization_rules
        ORDER BY confidence DESC, id ASC`,
    );
  }

  private applyRule(rules: CategorizationRuleRow[], merchantName: string | null, descriptionRaw: string, accountName: string | null) {
    const merchant = normText(merchantName);
    const description = normText(descriptionRaw);
    const account = normText(accountName);
    for (const rule of rules) {
      const pattern = String(rule.pattern ?? "");
      const haystack = rule.match_field === "merchant_name"
        ? merchant
        : rule.match_field === "account_name"
          ? account
          : description;
      if (!haystack) {
        continue;
      }
      const matched = pattern.startsWith("re:")
        ? (() => {
            try {
              return new RegExp(pattern.slice(3), "i").test(haystack);
            } catch {
              return false;
            }
          })()
        : haystack.includes(normText(pattern));
      if (matched) {
        return {
          category: rule.category,
          confidence: Number(rule.confidence ?? 0.6),
          counts: rule.counts_toward_budget == null ? null : Number(rule.counts_toward_budget),
        };
      }
    }
    return { category: null, confidence: 0, counts: null };
  }

  private decideCountsTowardBudget(
    category: string,
    isTransfer: boolean,
    isCcPayment: boolean,
    rawJson: Record<string, unknown> | null,
    descriptionRaw: string,
  ) {
    if (isTransfer || isCcPayment) {
      return { counts: 0, needsReview: false, reason: null as string | null };
    }
    const essentialFamilies = ["Housing", "Bills", "Transfers", "Income", "Taxes", "Tax", "Debt", "Insurance", "Non-Discretionary"];
    if (essentialFamilies.some((family) => category === family || category.startsWith(`${family}/`))) {
      return { counts: 0, needsReview: false, reason: null as string | null };
    }
    const discretionaryPrefixes = ["Food/Delivery", "Food/Restaurant", "Food/Coffee", "Entertainment", "Shopping/", "Travel/"];
    if (discretionaryPrefixes.some((prefix) => category.startsWith(prefix))) {
      return { counts: 1, needsReview: false, reason: null as string | null };
    }
    const merchant = normText(this.extractMerchant(descriptionRaw, rawJson) ?? "");
    const description = normText(descriptionRaw);
    const ambiguous = ["amazon", "walmart", "costco", "shoppers", "drug", "pharmacy", "rexall"];
    if (ambiguous.some((token) => merchant.includes(token) || description.includes(token))) {
      return {
        counts: 1,
        needsReview: true,
        reason: `Ambiguous merchant (${merchant || descriptionRaw || "unknown"})`,
      };
    }
    if (category === "Uncategorized") {
      return { counts: 1, needsReview: true, reason: "Uncategorized transaction" };
    }
    return {
      counts: 0,
      needsReview: true,
      reason: `Unclear whether category (${category}) counts toward discretionary budget`,
    };
  }

  private buildDashboardCategoryDeltas(
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

  private buildDashboardAlerts(input: {
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

  private buildDashboardReminders(input: {
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

  private findTaxAccountBalanceCad() {
    const taxAccount = this.getAccountsLiquidityData().accounts.find((row) => normText(row.name).includes("tax"));
    return taxAccount?.balanceCad ?? 0;
  }

  private isTaxCategory(category: string | null) {
    const normalized = normText(category ?? "");
    return normalized === "tax" || normalized.startsWith("tax/");
  }

  private computeIncomeImportSanity(referenceDate: string) {
    const currentMonth = referenceDate.slice(0, 7);
    const completedMonths = Math.max(0, Number.parseInt(currentMonth.slice(5, 7), 10) - 1);
    const fxRate = this.getFxRate();
    const yearStart = `${referenceDate.slice(0, 4)}-01-01`;
    const received = this.allRows<Record<string, unknown>>(
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

    const sources = this.loadIncomeSources().filter((row) => Number(row.confirmed ?? 0) === 1);
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

  private classifyTransaction(tx: Record<string, unknown>) {
    const rawJson = this.parseJson(tx.raw_json);
    const descriptionRaw = String(tx.description_raw ?? "");
    const isCcPayment = this.detectIsCcPayment(descriptionRaw, rawJson);
    const isTransfer = this.detectIsTransfer(descriptionRaw, rawJson);
    const merchantName = typeof tx.merchant_name === "string" && tx.merchant_name.trim()
      ? tx.merchant_name.trim()
      : this.extractMerchant(descriptionRaw, rawJson);
    const rules = this.getRules();
    const ruleMatch = this.applyRule(rules, merchantName, descriptionRaw, typeof tx.account_name === "string" ? tx.account_name : null);
    let categoryAuto = ruleMatch.category;
    let categoryConfidence = ruleMatch.confidence;
    const ruleCounts = ruleMatch.counts;
    let ambiguous = categoryAuto ? categoryConfidence < 0.7 : false;
    if (!categoryAuto) {
      const plaid = this.mapPlaidCategory(rawJson);
      if (plaid.category) {
        categoryAuto = plaid.category;
        categoryConfidence = plaid.confidence;
        ambiguous = plaid.confidence < 0.7;
      } else if (isTransfer) {
        categoryAuto = "Transfers/Internal";
        categoryConfidence = 0.8;
      } else {
        categoryAuto = "Uncategorized";
        categoryConfidence = 0;
        ambiguous = true;
      }
    }

    const reviewReasons: string[] = [];
    let countsTowardBudgetAuto = ruleCounts;
    let needsReview = false;
    if (countsTowardBudgetAuto == null) {
      const decision = this.decideCountsTowardBudget(
        categoryAuto,
        isTransfer,
        isCcPayment,
        rawJson,
        descriptionRaw,
      );
      countsTowardBudgetAuto = decision.counts;
      needsReview = decision.needsReview;
      if (decision.reason) {
        reviewReasons.push(decision.reason);
      }
    }

    const currency = String(tx.currency ?? "CAD").toUpperCase();
    if (currency !== "CAD" && tx.amount_cad == null) {
      needsReview = true;
      reviewReasons.push("Non-CAD currency without FX conversion (amount_cad is null)");
    }
    if (categoryConfidence < 0.7 || ambiguous) {
      needsReview = true;
      reviewReasons.push(
        categoryAuto === "Uncategorized"
          ? "No category match found"
          : `Low/ambiguous categorization confidence (${categoryConfidence.toFixed(2)})`,
      );
    }

    return {
      merchantName,
      descriptionClean: (merchantName ?? descriptionRaw).trim(),
      isTransfer,
      isCcPayment,
      categoryAuto,
      categoryAutoConfidence: categoryConfidence,
      countsTowardBudgetAuto: countsTowardBudgetAuto ?? 0,
      needsReview,
      reviewReason: reviewReasons.length > 0 ? reviewReasons.join("; ") : null,
    };
  }

  private computeSpendStats(fromDate: string, toExclusive: string) {
    const row = this.getRow<Record<string, unknown>>(
      `SELECT
         COALESCE(SUM(CASE WHEN amount < 0 AND ${FINAL_COUNTS} = 1 AND (currency = 'CAD' OR amount_cad IS NOT NULL)
           THEN -(COALESCE(amount_cad, amount)) ELSE 0 END), 0) AS spent_cad,
         COALESCE(SUM(CASE WHEN amount > 0 AND ${FINAL_COUNTS} = 1 AND (currency = 'CAD' OR amount_cad IS NOT NULL)
           THEN COALESCE(amount_cad, amount) ELSE 0 END), 0) AS income_cad,
         COALESCE(SUM(CASE WHEN amount < 0 AND ${FINAL_COUNTS} = 1 AND needs_review = 1
           AND (currency = 'CAD' OR amount_cad IS NOT NULL)
           THEN -(COALESCE(amount_cad, amount)) ELSE 0 END), 0) AS uncertain_spent_cad,
         COALESCE(SUM(CASE WHEN amount < 0 AND ${FINAL_COUNTS} = 1 AND currency <> 'CAD'
           AND amount_cad IS NULL THEN -amount ELSE 0 END), 0) AS unknown_fx_spend
       FROM transactions
       WHERE posted_date >= ? AND posted_date < ?`,
      fromDate,
      toExclusive,
    );
    const gross = Number(row?.spent_cad ?? 0);
    const income = Number(row?.income_cad ?? 0);
    return {
      spentCad: gross - income,
      grossSpentCad: gross,
      incomeCad: income,
      uncertainSpentCad: Number(row?.uncertain_spent_cad ?? 0),
      unknownFxSpend: Number(row?.unknown_fx_spend ?? 0),
    };
  }

  private computeWeeklyBudget(dateIso: string, weeklyLimitCad: number, weeklyStart: string): Extract<FinanceBudgetSnapshot, { mode: "week" }> {
    const epoch = toIsoDate(weeklyStart);
    const target = toIsoDate(dateIso);
    const diffDays = daysBetween(epoch, target);
    if (diffDays < 0) {
      throw new Error(`Weekly budget starts at ${epoch}; got ${target}`);
    }
    const weekIndex = Math.floor(diffDays / 7);
    const weekStart = addDays(epoch, weekIndex * 7);
    const weekEndExclusive = addDays(weekStart, 7);
    const before = this.computeSpendStats(epoch, weekStart);
    const carryIn = weekIndex * weeklyLimitCad - before.spentCad;
    const available = weeklyLimitCad + carryIn;
    const stats = this.computeSpendStats(weekStart, weekEndExclusive);
    const remaining = available - stats.spentCad;
    const dayOfWeek = clamp(diffDays - weekIndex * 7, 0, 6) + 1;
    const expectedToDate = available * clamp(dayOfWeek / 7, 0, 1);
    return {
      mode: "week",
      date: target,
      weekIndex,
      weekStart,
      weekEndExclusive,
      weeklyLimitCad,
      carryIn,
      available,
      spentCad: stats.spentCad,
      grossSpentCad: stats.grossSpentCad,
      incomeCad: stats.incomeCad,
      remaining,
      expectedToDate,
      paceDelta: stats.spentCad - expectedToDate,
      uncertainSpentCad: stats.uncertainSpentCad,
      unknownFxSpend: stats.unknownFxSpend,
    };
  }

  private computeMonthlyBudget(month: string, monthlyLimitCad: number, referenceDate?: string): Extract<FinanceBudgetSnapshot, { mode: "month" }> {
    const range = startEndForMonth(month);
    const stats = this.computeSpendStats(range.from, range.toExclusive);
    const remaining = monthlyLimitCad - stats.spentCad;
    const targetDate = referenceDate ? toIsoDate(referenceDate) : `${month}-01`;
    const day = Number.parseInt(targetDate.slice(8, 10), 10);
    const expectedToDate = monthlyLimitCad * clamp(day / daysInMonth(month), 0, 1);
    return {
      mode: "month",
      month,
      from: range.from,
      toExclusive: range.toExclusive,
      limitCad: monthlyLimitCad,
      spentCad: stats.spentCad,
      grossSpentCad: stats.grossSpentCad,
      incomeCad: stats.incomeCad,
      remaining,
      expectedToDate,
      paceDelta: stats.spentCad - expectedToDate,
      uncertainSpentCad: stats.uncertainSpentCad,
      unknownFxSpend: stats.unknownFxSpend,
    };
  }

  private renderBudgetBlock(snapshot: FinanceBudgetSnapshot) {
    if (snapshot.mode === "week") {
      const pace = snapshot.paceDelta <= 0
        ? "On track"
        : snapshot.paceDelta <= 0.1 * snapshot.available
          ? "Slightly ahead"
          : "Ahead (red)";
      const lines = [
        `Week: ${snapshot.weekStart} -> ${snapshot.weekEndExclusive} (exclusive)`,
        `Weekly limit: ${formatCad(snapshot.weeklyLimitCad)}`,
        `Carry-in: ${formatCad(snapshot.carryIn)}`,
        `Available: ${formatCad(snapshot.available)}`,
      ];
      if (snapshot.incomeCad > 0) {
        lines.push(
          `Gross spending: ${formatCad(snapshot.grossSpentCad)}`,
          `Credits/reimbursements: -${formatCad(snapshot.incomeCad)}`,
          `Net spent: ${formatCad(snapshot.spentCad)}`,
        );
      } else {
        lines.push(`Spent (counting toward budget): ${formatCad(snapshot.spentCad)}`);
      }
      lines.push(
        `Remaining: ${formatCad(snapshot.remaining)}`,
        `Expected-to-date: ${formatCad(snapshot.expectedToDate)}`,
        `Pace delta: ${formatCad(snapshot.paceDelta)} (${pace})`,
        `Rollover: unspent carries forward week-to-week since ${this.getSettingOrDefault("budget.weekly_start_date")}.`,
      );
      if (snapshot.uncertainSpentCad > 0) {
        lines.push(`Uncertain (needs review): ${formatCad(snapshot.uncertainSpentCad)}`);
      }
      if (snapshot.unknownFxSpend > 0) {
        lines.push(`Non-CAD missing FX (excluded): ~${formatCad(snapshot.unknownFxSpend)}`);
      }
      return lines.join("\n");
    }

    const pace = snapshot.paceDelta <= 0
      ? "On track"
      : snapshot.paceDelta <= 0.1 * snapshot.limitCad
        ? "Slightly ahead"
        : "Ahead (red)";
    const lines = [
      `Month: ${snapshot.month}`,
      `Limit: ${formatCad(snapshot.limitCad)}`,
    ];
    if (snapshot.incomeCad > 0) {
      lines.push(
        `Gross spending: ${formatCad(snapshot.grossSpentCad)}`,
        `Credits/reimbursements: -${formatCad(snapshot.incomeCad)}`,
        `Net spent: ${formatCad(snapshot.spentCad)}`,
      );
    } else {
      lines.push(`Spent: ${formatCad(snapshot.spentCad)}`);
    }
    lines.push(
      `Remaining: ${formatCad(snapshot.remaining)}`,
      `Expected-to-date: ${formatCad(snapshot.expectedToDate)}`,
      `Pace delta: ${formatCad(snapshot.paceDelta)} (${pace})`,
    );
    if (snapshot.uncertainSpentCad > 0) {
      lines.push(`Uncertain (needs review): ${formatCad(snapshot.uncertainSpentCad)}`);
    }
    if (snapshot.unknownFxSpend > 0) {
      lines.push(`Non-CAD missing FX (excluded): ~${formatCad(snapshot.unknownFxSpend)}`);
    }
    return lines.join("\n");
  }

  private normRecurringKey(value: string) {
    return normText(value).replace(/[^a-z0-9]+/g, " ").trim();
  }

  private detectIntervalFromGaps(gaps: number[]) {
    const usable = gaps.filter((gap) => gap > 0);
    if (usable.length < 2) {
      return null;
    }
    const candidates: Array<{ kind: string; target: number; tolerance: number; intervalDays: number | null }> = [
      { kind: "weekly", target: 7, tolerance: 1, intervalDays: 7 },
      { kind: "biweekly", target: 14, tolerance: 1, intervalDays: 14 },
      { kind: "monthly", target: 30, tolerance: 2, intervalDays: null },
      { kind: "yearly", target: 365, tolerance: 7, intervalDays: null },
    ];
    const matches = candidates
      .filter((candidate) => Math.max(...usable.map((gap) => Math.abs(gap - candidate.target))) <= candidate.tolerance)
      .map((candidate) => ({
        kind: candidate.kind,
        score: usable.reduce((sum, gap) => sum + Math.abs(gap - candidate.target), 0) / usable.length,
        intervalDays: candidate.intervalDays,
      }))
      .sort((left, right) => left.score - right.score);
    return matches[0] ?? null;
  }

  private detectRecurringCandidates(todayIso: string) {
    const rows = this.allRows<Record<string, unknown>>(
      `SELECT posted_date, amount, currency, amount_cad,
          merchant_name, description_clean, description_raw,
          is_transfer, is_cc_payment
        FROM transactions
        WHERE amount < 0 AND is_transfer = 0 AND is_cc_payment = 0
        ORDER BY posted_date ASC, id ASC`,
    );
    const groups = new Map<string, {
      nameRaw: string;
      amountCad: number;
      currency: string;
      matchKind: string;
      matchValue: string;
      dates: string[];
    }>();
    for (const row of rows) {
      const currency = String(row.currency ?? "CAD").toUpperCase();
      const amount = Number(row.amount ?? 0);
      const amountCad = currency === "CAD"
        ? Math.round(-amount * 100) / 100
        : row.amount_cad == null
          ? null
          : Math.round(-Number(row.amount_cad) * 100) / 100;
      if (amountCad == null || amountCad <= 0) {
        continue;
      }
      const nameRaw = String(row.merchant_name ?? row.description_clean ?? row.description_raw ?? "").trim();
      if (!nameRaw) {
        continue;
      }
      const normalizedName = this.normRecurringKey(nameRaw);
      if (!normalizedName || normalizedName.length < 3) {
        continue;
      }
      if (["transfer", "payment", "credit card"].some((token) => normalizedName.includes(token))) {
        continue;
      }
      const matchKind = row.merchant_name ? "merchant" : "description";
      const matchValue = this.normRecurringKey(matchKind === "merchant"
        ? String(row.merchant_name ?? "")
        : String(row.description_clean ?? row.description_raw ?? ""));
      if (!matchValue) {
        continue;
      }
      const key = `${matchKind}::${matchValue}::${currency}::${amountCad.toFixed(2)}`;
      const existing = groups.get(key);
      if (existing) {
        existing.dates.push(String(row.posted_date));
      } else {
        groups.set(key, {
          nameRaw,
          amountCad,
          currency,
          matchKind,
          matchValue,
          dates: [String(row.posted_date)],
        });
      }
    }
    const candidates: Array<Record<string, unknown>> = [];
    for (const group of groups.values()) {
      const dates = Array.from(new Set(group.dates)).sort();
      if (dates.length < 3) {
        continue;
      }
      const gaps = dates.slice(1).map((current, index) => daysBetween(dates[index] ?? current, current));
      const interval = this.detectIntervalFromGaps(gaps);
      if (!interval) {
        continue;
      }
      const span = daysBetween(dates[0] ?? todayIso, dates[dates.length - 1] ?? todayIso);
      if (interval.kind === "weekly" && (dates.length < 4 || span < 21)) {
        continue;
      }
      if (interval.kind === "biweekly" && (dates.length < 3 || span < 28)) {
        continue;
      }
      if (interval.kind === "monthly" && (dates.length < 3 || span < 60)) {
        continue;
      }
      const graceDays = defaultGraceDays(interval.kind);
      const nextExpected = computeNextExpected(dates[dates.length - 1] ?? todayIso, interval.kind, interval.intervalDays);
      const status = isPastDue(todayIso, nextExpected, graceDays) ? "halted" : "active";
      candidates.push({
        name: group.nameRaw.slice(0, 80),
        match_kind: group.matchKind,
        match_value: group.matchValue,
        interval_kind: interval.kind,
        interval_days: interval.intervalDays,
        amount_cad: group.amountCad,
        currency: group.currency,
        occurrences: dates.length,
        first_seen: dates[0],
        last_seen: dates[dates.length - 1],
        next_expected: nextExpected,
        status,
        grace_days: graceDays,
      });
    }
    return candidates.sort((left, right) =>
      String(left.status) === String(right.status)
        ? String(left.name).localeCompare(String(right.name))
        : String(left.status) === "active" ? -1 : 1,
    );
  }

  getRecurringCandidatesData(options?: { today?: string; includeKnown?: boolean; maxAgeDays?: number }): FinanceRecurringCandidateData[] {
    const today = options?.today ? toIsoDate(options.today) : dateKey(new Date());
    const includeKnown = options?.includeKnown ?? true;
    const maxAgeDays = options?.maxAgeDays ?? null;
    const existing = this.allRows<{ id: number; match_kind: string; match_value: string; currency: string; amount_cad: number }>(
      "SELECT id, match_kind, match_value, currency, amount_cad FROM recurring",
    );
    const existingByKey = new Map(
      existing.map((row) => [
        `${row.match_kind}::${row.match_value}::${String(row.currency ?? "CAD").toUpperCase()}::${Number(row.amount_cad ?? 0).toFixed(2)}`,
        Number(row.id ?? 0),
      ]),
    );
    return this.detectRecurringCandidates(today)
      .map((row) => {
        const key = `${String(row.match_kind ?? "")}::${String(row.match_value ?? "")}::${String(row.currency ?? "CAD").toUpperCase()}::${Number(row.amount_cad ?? 0).toFixed(2)}`;
        const existingRecurringId = existingByKey.get(key) ?? null;
        return {
          name: String(row.name ?? ""),
          matchKind: String(row.match_kind ?? ""),
          matchValue: String(row.match_value ?? ""),
          intervalKind: String(row.interval_kind ?? "monthly"),
          intervalDays: row.interval_days == null ? null : Number(row.interval_days),
          amountCad: Number(row.amount_cad ?? 0),
          currency: String(row.currency ?? "CAD").toUpperCase(),
          occurrences: Number(row.occurrences ?? 0),
          firstSeen: String(row.first_seen ?? ""),
          lastSeen: String(row.last_seen ?? ""),
          nextExpectedDate: String(row.next_expected ?? ""),
          status: String(row.status ?? "active"),
          graceDays: Number(row.grace_days ?? 2),
          existingRecurringId,
          alreadyTracked: existingRecurringId != null,
        } satisfies FinanceRecurringCandidateData;
      })
      .filter((row) => includeKnown || !row.alreadyTracked)
      .filter((row) => maxAgeDays == null || daysBetween(row.lastSeen, today) <= maxAgeDays)
      .sort((left, right) =>
        left.status === right.status
          ? right.occurrences - left.occurrences || left.name.localeCompare(right.name)
          : left.status === "active" ? -1 : 1,
      );
  }

  private refreshRecurringRules(todayIso: string, autoSeed: boolean, seedLimit: number) {
    const candidates = this.detectRecurringCandidates(todayIso);
    const existing = this.allRows<Record<string, unknown>>(
      "SELECT id, match_kind, match_value, amount_cad, currency FROM recurring",
    );
    const existingKeys = new Set(
      existing.map((row) => `${row.match_kind}::${row.match_value}::${row.currency}::${Number(row.amount_cad ?? 0).toFixed(2)}`),
    );
    const seeded: Record<string, unknown>[] = [];
    if (autoSeed) {
      const toSeed = candidates.filter((candidate) =>
        String(candidate.status) === "active"
        && !existingKeys.has(`${candidate.match_kind}::${candidate.match_value}::${candidate.currency}::${Number(candidate.amount_cad ?? 0).toFixed(2)}`),
      );
      for (const candidate of toSeed.slice(0, seedLimit)) {
        try {
          this.run(
            `INSERT INTO recurring(
               name, match_kind, match_value, interval_kind, interval_days,
               amount_cad, amount_tolerance_cad, currency, next_expected_date, last_seen_date, status, grace_days,
               notes, created_at, updated_at
             ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            String(candidate.name ?? ""),
            String(candidate.match_kind ?? ""),
            String(candidate.match_value ?? ""),
            String(candidate.interval_kind ?? ""),
            candidate.interval_days == null ? null : Number(candidate.interval_days),
            Number(candidate.amount_cad ?? 0),
            0,
            String(candidate.currency ?? "CAD"),
            String(candidate.next_expected ?? ""),
            String(candidate.last_seen ?? ""),
            String(candidate.status ?? "active"),
            Number(candidate.grace_days ?? 2),
            `Auto-seeded (${candidate.occurrences} occurrences; first ${candidate.first_seen})`,
            nowIso(),
            nowIso(),
          );
          seeded.push(candidate);
        } catch {
          continue;
        }
      }
    }

    const rules = this.allRows<Record<string, unknown>>(
      `SELECT id, name, match_kind, match_value, interval_kind, interval_days,
          amount_cad, amount_tolerance_cad, currency, next_expected_date, last_seen_date, status,
          grace_days, notes, created_at, updated_at
        FROM recurring ORDER BY id ASC`,
    );
    const refreshed = rules.map((rule) => {
      const storedLastSeenDate = stringOrNull(rule.last_seen_date);
      const storedNextExpectedDate = stringOrNull(rule.next_expected_date);
      const storedStatus = String(rule.status ?? "active").trim().toLowerCase() === "halted"
        ? "halted"
        : "active";
      const possible = this.allRows<Record<string, unknown>>(
        `SELECT posted_date, amount, currency, amount_cad, merchant_name,
            description_clean, description_raw
          FROM transactions
          WHERE amount < 0 AND is_cc_payment = 0 AND currency = ?
          ORDER BY posted_date ASC, id ASC`,
        String(rule.currency ?? "CAD"),
      );
      const matches = possible.filter((tx) => this.ruleMatchesTransaction(rule, tx) && this.recurringAmountMatches(rule, tx));
      const observedLastSeenDate = matches.length > 0 ? String(matches[matches.length - 1]?.posted_date ?? "") : null;
      const lastSeenDate = observedLastSeenDate ?? storedLastSeenDate;
      const graceDays = Number(rule.grace_days ?? defaultGraceDays(String(rule.interval_kind ?? "monthly")));
      const nextExpectedDate = lastSeenDate
        ? computeNextExpected(lastSeenDate, String(rule.interval_kind ?? "monthly"), rule.interval_days == null ? null : Number(rule.interval_days))
        : storedNextExpectedDate;
      const status = storedStatus;
      this.run(
        `UPDATE recurring
          SET next_expected_date = ?, last_seen_date = ?, status = ?, grace_days = COALESCE(grace_days, ?), updated_at = ?
          WHERE id = ?`,
        nextExpectedDate,
        lastSeenDate,
        status,
        graceDays,
        nowIso(),
        Number(rule.id ?? 0),
      );
      return {
        ...rule,
        last_seen_date: lastSeenDate,
        next_expected_date: nextExpectedDate,
        status,
        grace_days: graceDays,
      };
    });
    return {
      today: todayIso,
      seeded,
      active: refreshed.filter((row) => row.status === "active"),
      halted: refreshed.filter((row) => row.status === "halted"),
    };
  }

  private ruleMatchesTransaction(rule: Record<string, unknown>, tx: Record<string, unknown>) {
    const merchant = this.normRecurringKey(String(tx.merchant_name ?? ""));
    const description = this.normRecurringKey(String(tx.description_clean ?? tx.description_raw ?? ""));
    const value = this.normRecurringKey(String(rule.match_value ?? ""));
    if (rule.match_kind === "merchant") {
      return merchant !== "" && merchant === value;
    }
    if (rule.match_kind === "description") {
      return description !== "" && description === value;
    }
    try {
      const regex = new RegExp(String(rule.match_value ?? ""), "i");
      return regex.test(String(tx.merchant_name ?? ""))
        || regex.test(String(tx.description_clean ?? ""))
        || regex.test(String(tx.description_raw ?? ""));
    } catch {
      return false;
    }
  }

  private recurringAmountMatches(rule: Record<string, unknown>, tx: Record<string, unknown>) {
    const expected = Number(rule.amount_cad ?? 0);
    const tolerance = Math.max(0, Number(rule.amount_tolerance_cad ?? 0));
    const currency = String(tx.currency ?? "CAD").toUpperCase();
    const txAmountCad = currency === "CAD"
      ? Math.round(Math.abs(Number(tx.amount ?? 0)) * 100) / 100
      : tx.amount_cad == null
        ? null
        : Math.round(Math.abs(Number(tx.amount_cad)) * 100) / 100;
    if (txAmountCad == null) {
      return false;
    }
    return Math.abs(txAmountCad - expected) <= Math.max(0.01, tolerance);
  }

  private assertRecurringInput(input: {
    name?: unknown;
    match_kind?: unknown;
    match_value?: unknown;
    interval_kind?: unknown;
    interval_days?: unknown;
    amount_cad?: unknown;
    amount_tolerance_cad?: unknown;
    currency?: unknown;
    grace_days?: unknown;
  }) {
    if (!String(input.name ?? "").trim()) {
      throw new Error("Recurring name is required.");
    }
    if (!String(input.match_kind ?? "").trim()) {
      throw new Error("Recurring matchKind is required.");
    }
    if (!String(input.match_value ?? "").trim()) {
      throw new Error("Recurring matchValue is required.");
    }
    if (!String(input.interval_kind ?? "").trim()) {
      throw new Error("Recurring intervalKind is required.");
    }
    if (!Number.isFinite(Number(input.amount_cad)) || Number(input.amount_cad) <= 0) {
      throw new Error("Recurring amountCad must be greater than zero.");
    }
    if (input.amount_tolerance_cad != null && (!Number.isFinite(Number(input.amount_tolerance_cad)) || Number(input.amount_tolerance_cad) < 0)) {
      throw new Error("Recurring amountToleranceCad must be zero or positive.");
    }
    if (!String(input.currency ?? "CAD").trim()) {
      throw new Error("Recurring currency is required.");
    }
    if (input.grace_days != null && (!Number.isFinite(Number(input.grace_days)) || Number(input.grace_days) < 0)) {
      throw new Error("Recurring graceDays must be zero or positive.");
    }
  }

  private renderRecurringList(label: string, rows: Array<Record<string, unknown>>) {
    return `${heading(`${label} (${rows.length})`)}\n${
      rows.length === 0
        ? "(none)"
        : rows.map((row) => `- ${row.name}: ${formatCad(Number(row.amount_cad ?? 0))}${Number(row.amount_tolerance_cad ?? 0) > 0 ? ` +/- ${formatCad(Number(row.amount_tolerance_cad ?? 0))}` : ""} | ${row.interval_kind} | last ${row.last_seen ?? row.last_seen_date ?? "(never)"} | next ${row.next_expected ?? row.next_expected_date ?? "(unknown)"}${row.grace_days != null ? ` | grace ${row.grace_days}d` : ""}`).join("\n")
    }`;
  }

  private parseCsvText(csvText: string) {
    const rows: string[][] = [];
    let cell = "";
    let row: string[] = [];
    let quoted = false;
    for (let index = 0; index < csvText.length; index += 1) {
      const char = csvText[index];
      if (char === "\"") {
        if (quoted && csvText[index + 1] === "\"") {
          cell += "\"";
          index += 1;
        } else {
          quoted = !quoted;
        }
        continue;
      }
      if (char === "," && !quoted) {
        row.push(cell);
        cell = "";
        continue;
      }
      if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && csvText[index + 1] === "\n") {
          index += 1;
        }
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
        continue;
      }
      cell += char;
    }
    if (cell.length > 0 || row.length > 0) {
      row.push(cell);
      rows.push(row);
    }
    const [headerRow, ...dataRows] = rows;
    if (!headerRow) {
      return [];
    }
    const headers = headerRow.map((value) => value.replace(/⚡/g, "").replace(/\uFEFF/g, "").trim());
    return dataRows
      .filter((values) => values.some((value) => value.trim() !== ""))
      .map((values) =>
        Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  }

  private parseJson(value: unknown) {
    if (!value) {
      return null;
    }
    if (typeof value === "string") {
      try {
        return JSON.parse(value) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
  }

  private async fetchText(url: string) {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "OpenElinaro-Finance/1.0",
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    return response.text();
  }

  private sheetCsvUrl(spreadsheetId: string, gid: string) {
    return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
  }

  private upsertAccount(row: Record<string, string>, options?: FinanceUpsertAccountOptions) {
    const externalId = String(row["Account ID"] ?? row.account_id ?? "").trim();
    if (!externalId) {
      return;
    }
    const name = String(row["Account Name"] ?? row.name ?? "").trim() || null;
    const institution = String(row.Institution ?? row.institution ?? "").trim() || null;
    const currency = String(row.Currency ?? row.currency ?? "").trim().toUpperCase() || null;
    const balance = parseNumberLike(row.Balance ?? row.balance);
    const lastUpdate = String(row["Last Update"] ?? row.last_update ?? "").trim() || null;
    const rawJson = String(row["Raw Data"] ?? row.raw_json ?? "").trim() || null;
    const existing = this.getRow<Record<string, unknown>>(
      "SELECT balance, last_update, updated_at FROM accounts WHERE external_id = ?",
      externalId,
    );
    const previousBalance = this.getPreviousAccountBalance(externalId, existing);

    this.run(
      `INSERT INTO accounts(
         external_id, name, institution, currency, balance, last_update, raw_json, updated_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(external_id) DO UPDATE SET
         name = excluded.name,
         institution = excluded.institution,
         currency = excluded.currency,
         balance = excluded.balance,
         last_update = excluded.last_update,
         raw_json = excluded.raw_json,
         updated_at = excluded.updated_at`,
      externalId,
      name,
      institution,
      currency,
      balance,
      lastUpdate,
      rawJson,
      nowIso(),
    );

    if (options?.importRunId != null) {
      this.recordAccountBalanceSnapshot({
        importRunId: options.importRunId,
        source: options.source ?? "fintable_gsheet",
        externalId,
        name,
        currency,
        balance,
        capturedAt: lastUpdate,
        rawJson,
      });
      this.maybeRecordInferredIncomeFromBalanceDelta({
        externalId,
        accountName: name,
        currency,
        balance,
        capturedAt: lastUpdate,
        previousBalance,
      });
    }
  }

  private getPreviousAccountBalance(externalId: string, existing: Record<string, unknown> | null) {
    const snapshot = this.getRow<Record<string, unknown>>(
      `SELECT balance
        FROM account_balance_snapshots
        WHERE account_external_id = ?
        ORDER BY COALESCE(captured_at, created_at) DESC, id DESC
        LIMIT 1`,
      externalId,
    );
    if (snapshot?.balance != null) {
      return Number(snapshot.balance);
    }
    if (existing?.balance != null) {
      return Number(existing.balance);
    }
    return null;
  }

  private recordAccountBalanceSnapshot(input: {
    importRunId: number;
    source: string;
    externalId: string;
    name: string | null;
    currency: string | null;
    balance: number | null;
    capturedAt: string | null;
    rawJson: string | null;
  }) {
    this.run(
      `INSERT INTO account_balance_snapshots(
         import_run_id, source, account_external_id, account_name, currency, balance, captured_at, raw_json, created_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(import_run_id, account_external_id) DO UPDATE SET
         source = excluded.source,
         account_name = excluded.account_name,
         currency = excluded.currency,
         balance = excluded.balance,
         captured_at = excluded.captured_at,
         raw_json = excluded.raw_json`,
      input.importRunId,
      input.source,
      input.externalId,
      input.name,
      input.currency,
      input.balance,
      input.capturedAt,
      input.rawJson,
      nowIso(),
    );
  }

  private maybeRecordInferredIncomeFromBalanceDelta(input: {
    externalId: string;
    accountName: string | null;
    currency: string | null;
    balance: number | null;
    capturedAt: string | null;
    previousBalance: number | null;
  }) {
    if (!this.isInferredIncomeAccount(input.accountName, input.currency)) {
      return;
    }
    if (input.balance == null || input.previousBalance == null) {
      return;
    }
    const delta = Number((input.balance - input.previousBalance).toFixed(2));
    if (delta <= INFERRED_ACCOUNT_INCOME_MIN_DELTA_CAD) {
      return;
    }
    const postedDate = toIsoDate((input.capturedAt ?? dateKey(new Date())).slice(0, 10));
    const description = `${INFERRED_ACCOUNT_INCOME_COUNTERPARTY} inferred from ${input.accountName ?? "brokerage account"} balance increase`;
    const result = this.recordInferredIncome({
      externalId: `inferred-income:${input.externalId}:${postedDate}:${Math.round(delta * 100)}`,
      accountExternalId: input.externalId,
      accountName: input.accountName,
      postedDate,
      amountCad: delta,
      description,
      merchantName: INFERRED_ACCOUNT_INCOME_COUNTERPARTY,
      note: `Auto-inferred from account balance delta: ${formatCad(input.previousBalance)} -> ${formatCad(input.balance)}.`,
      rawJson: {
        kind: "account_balance_inference",
        previousBalanceCad: input.previousBalance,
        currentBalanceCad: input.balance,
      },
      clearPendingReceivablesForCounterparty: INFERRED_ACCOUNT_INCOME_RECEIVABLE_HINT,
    });
    if (result.id > 0) {
      return;
    }
  }

  private isInferredIncomeAccount(accountName: string | null, currency: string | null) {
    return normText(accountName).includes(INFERRED_ACCOUNT_INCOME_ACCOUNT_HINT) && (currency ?? "CAD").toUpperCase() === "CAD";
  }

  private clearMatchingPendingReceivables(counterparty: string, amountCad: number, receivedDate: string, note: string) {
    const pending = this.allRows<Record<string, unknown>>(
      `SELECT id, counterparty, amount_cad
        FROM receivables
        WHERE status <> 'received' AND lower(counterparty) LIKE ?
        ORDER BY expected_date ASC, id ASC`,
      `%${normText(counterparty)}%`,
    );
    let remaining = amountCad;
    const clearedIds: number[] = [];
    for (const row of pending) {
      const receivableAmount = Number(row.amount_cad ?? 0);
      if (receivableAmount <= 0) {
        continue;
      }
      if (remaining + RECEIVABLE_CLEAR_TOLERANCE_CAD < receivableAmount) {
        continue;
      }
      const id = Number(row.id ?? 0);
      this.markReceivableReceived(id, { receivedDate, note });
      clearedIds.push(id);
      remaining -= receivableAmount;
    }
    return clearedIds;
  }

  private upsertSyntheticIncomeTransaction(input: FinanceSyntheticIncomeInput) {
    const externalId = input.externalId
      ?? `synthetic-income:${crypto.createHash("sha1").update(JSON.stringify({
        accountExternalId: input.accountExternalId ?? null,
        accountName: input.accountName ?? null,
        postedDate: toIsoDate(input.postedDate),
        amountCad: input.amountCad,
        description: input.description,
      })).digest("hex")}`;
    const existing = this.getRow<{ id: number }>(
      "SELECT id FROM transactions WHERE external_id = ?",
      externalId,
    );
    if (existing) {
      return { status: "updated" as const, id: Number(existing.id ?? 0), externalId };
    }
    const currency = (input.currency ?? "CAD").toUpperCase();
    const amount = input.amount ?? input.amountCad;
    this.run(
      `INSERT INTO transactions(
         external_id, source, account_external_id, account_name, posted_date, authorized_date,
         amount, currency, amount_cad, description_raw, merchant_name, description_clean,
         category_auto, category_auto_confidence, category_user,
         counts_toward_budget_auto, counts_toward_budget_user,
         needs_review, review_reason, is_transfer, is_cc_payment, note, raw_json, imported_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, 0, ?, ?, ?)`,
      externalId,
      input.source ?? "account_balance_inference",
      input.accountExternalId ?? null,
      input.accountName ?? null,
      toIsoDate(input.postedDate),
      null,
      amount,
      currency,
      input.amountCad,
      input.description,
      input.merchantName ?? input.description,
      input.merchantName ?? input.description,
      input.category ?? "Income/Client",
      1,
      input.category ?? "Income/Client",
      0,
      0,
      input.note ?? null,
      input.rawJson ? JSON.stringify(input.rawJson) : null,
      nowIso(),
    );
    const row = this.getRow<{ id: number }>("SELECT last_insert_rowid() AS id");
    return { status: "added" as const, id: Number(row?.id ?? 0), externalId };
  }

  private upsertTransaction(row: Record<string, string>, source: string) {
    const externalId = String(row["Transaction ID"] ?? row.transaction_id ?? "").trim();
    if (!externalId) {
      return { inserted: false, updated: false };
    }
    const postedDate = toIsoDate(String(row.Date ?? row.posted_date ?? ""));
    const amount = parseNumberLike(row.Amount ?? row.amount);
    if (amount == null) {
      throw new Error(`Invalid amount for transaction ${externalId}: ${row.Amount ?? row.amount}`);
    }
    const currency = String(row.Currency ?? row.currency ?? "CAD").trim().toUpperCase();
    const amountCad = parseNumberLike(row["Amount CAD"] ?? row.amount_cad);
    const descriptionRaw = String(row.Description ?? row.description_raw ?? "");
    const accountName = String(row.Account ?? row.account_name ?? "").trim() || null;
    const rawJson = String(row["Raw Data"] ?? row.raw_json ?? "").trim() || null;
    const existing = this.getRow<Record<string, unknown>>(
      "SELECT id, category_user, counts_toward_budget_user, description_clean, note FROM transactions WHERE external_id = ?",
      externalId,
    );
    const auto = this.classifyTransaction({
      external_id: externalId,
      source,
      account_name: accountName,
      posted_date: postedDate,
      amount,
      currency,
      amount_cad: amountCad,
      description_raw: descriptionRaw,
      merchant_name: null,
      raw_json: rawJson,
    });
    const categoryUser = typeof existing?.category_user === "string" ? existing.category_user : null;
    const countsTowardBudgetUser = typeof existing?.counts_toward_budget_user === "number"
      ? existing.counts_toward_budget_user
      : existing?.counts_toward_budget_user == null
        ? null
        : Number(existing.counts_toward_budget_user);
    const note = typeof existing?.note === "string" ? existing.note : null;
    const needsReview = existing && (categoryUser != null || countsTowardBudgetUser != null)
      ? 0
      : auto.needsReview ? 1 : 0;
    const reviewReason = existing && (categoryUser != null || countsTowardBudgetUser != null)
      ? null
      : auto.reviewReason;

    if (!existing) {
      this.run(
        `INSERT INTO transactions(
           external_id, source, account_external_id, account_name, posted_date, authorized_date,
           amount, currency, amount_cad, description_raw, merchant_name, description_clean,
           category_auto, category_auto_confidence, category_user,
           counts_toward_budget_auto, counts_toward_budget_user,
           needs_review, review_reason, is_transfer, is_cc_payment, note, raw_json, imported_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        externalId,
        source,
        null,
        accountName,
        postedDate,
        null,
        amount,
        currency,
        amountCad,
        descriptionRaw,
        auto.merchantName,
        auto.descriptionClean,
        auto.categoryAuto,
        auto.categoryAutoConfidence,
        categoryUser,
        auto.countsTowardBudgetAuto,
        countsTowardBudgetUser,
        needsReview,
        reviewReason,
        auto.isTransfer ? 1 : 0,
        auto.isCcPayment ? 1 : 0,
        note,
        rawJson,
        nowIso(),
      );
      return { inserted: true, updated: false };
    }

    this.run(
      `UPDATE transactions SET
         source = ?, account_name = ?, posted_date = ?, amount = ?, currency = ?, amount_cad = ?,
         description_raw = ?, merchant_name = ?, description_clean = COALESCE(description_clean, ?),
         category_auto = ?, category_auto_confidence = ?, counts_toward_budget_auto = ?,
         needs_review = ?, review_reason = ?, is_transfer = ?, is_cc_payment = ?, raw_json = ?, imported_at = ?
       WHERE external_id = ?`,
      source,
      accountName,
      postedDate,
      amount,
      currency,
      amountCad,
      descriptionRaw,
      auto.merchantName,
      auto.descriptionClean,
      auto.categoryAuto,
      auto.categoryAutoConfidence,
      auto.countsTowardBudgetAuto,
      needsReview,
      reviewReason,
      auto.isTransfer ? 1 : 0,
      auto.isCcPayment ? 1 : 0,
      rawJson,
      nowIso(),
      externalId,
    );
    return { inserted: false, updated: true };
  }

  private getFxRate() {
    return this.getNumericSettingOrDefault("fx.usdcad");
  }

  private toCad(amount: number, currency: string, fxRate: number) {
    if (currency === "CAD") {
      return amount;
    }
    if (currency === "USD") {
      return amount * fxRate;
    }
    return amount;
  }

  private calcProgressiveTax(taxable: number, brackets: Array<[number | null, number]>, personalAmount: number) {
    let income = Math.max(0, taxable - personalAmount);
    let tax = 0;
    for (const [bracketSize, rate] of brackets) {
      if (income <= 0) {
        break;
      }
      if (bracketSize == null) {
        tax += income * rate;
        income = 0;
        continue;
      }
      const taxed = Math.min(income, bracketSize);
      tax += taxed * rate;
      income -= taxed;
    }
    return tax;
  }

  private calcContributions(grossCad: number, tax: TaxConfig): FinanceAnnualTaxProjectionData["contributions"] {
    const qpp = (Math.min(grossCad, tax.qpp_max_pensionable) - tax.qpp_exemption) * tax.qpp_rate;
    const qpp2 = Math.max(0, Math.min(grossCad, tax.qpp2_ceiling) - tax.qpp_max_pensionable) * tax.qpp2_rate;
    const qpip = Math.min(grossCad * tax.qpip_rate, tax.qpip_max_insurable * tax.qpip_rate);
    const fss = grossCad * tax.fss_rate;
    return {
      QPP: Math.max(0, qpp),
      QPP2: Math.max(0, qpp2),
      QPIP: Math.max(0, qpip),
      FSS: fss,
      total: Math.max(0, qpp) + Math.max(0, qpp2) + Math.max(0, qpip) + fss,
    };
  }

  private calcAnnualTax(grossCad: number, config: FinanceForecastConfig): FinanceAnnualTaxProjectionData {
    const contributions = this.calcContributions(grossCad, config.tax);
    const qppDeduction = contributions.QPP / 2;
    const alimonyAnnual = config.deductions.alimony_monthly_cad * 12;
    const mortgageAnnual = config.deductions.mortgage_biweekly_cad * 26;
    const homeOffice = mortgageAnnual * config.deductions.home_office_pct;
    const taxable = grossCad - qppDeduction - alimonyAnnual - homeOffice;
    const federalTax = this.calcProgressiveTax(
      taxable,
      config.tax.federal_brackets_2025.map((entry) => [entry[0], entry[1]] as [number | null, number]),
      config.tax.federal_personal_amount,
    ) * (1 - config.tax.qc_federal_abatement);
    const quebecTax = this.calcProgressiveTax(
      taxable,
      config.tax.qc_brackets_2025.map((entry) => [entry[0], entry[1]] as [number | null, number]),
      config.tax.qc_personal_amount,
    );
    const totalTax = federalTax + quebecTax;
    return {
      grossCad,
      taxable,
      federalTax,
      quebecTax,
      totalTax,
      contributions,
      effectiveRate: grossCad > 0 ? totalTax / grossCad : 0,
      effectiveRateWithContribs: grossCad > 0 ? (totalTax + contributions.total) / grossCad : 0,
      alimonyAnnual,
      netAfterTax: grossCad - totalTax - contributions.total,
      netAfterTaxAndAlimony: grossCad - totalTax - contributions.total - alimonyAnnual,
    };
  }

  private loadIncomeSources() {
    return this.allRows<IncomeSourceRecord>(
      "SELECT * FROM income_sources ORDER BY confirmed DESC, start_date",
    );
  }

  private loadRecurringExpenses(): Array<RecurringRecord & { monthlyCad: number }> {
    const rows = this.allRows<RecurringRecord>(
      "SELECT * FROM recurring WHERE status = 'active' ORDER BY name",
    );
    return rows.map((row) => {
      const amountCad = Number(row.amount_cad ?? 0);
      const interval = String(row.interval_kind ?? "monthly");
      const monthlyCad = interval === "biweekly"
        ? amountCad * 26 / 12
        : interval === "weekly"
          ? amountCad * 52 / 12
          : interval === "yearly"
            ? amountCad / 12
            : amountCad;
      return {
        ...row,
        monthlyCad,
      } as RecurringRecord & { monthlyCad: number };
    });
  }

  private loadPayables(status = "pending") {
    return this.allRows<PayableRecord>(
      "SELECT * FROM payables WHERE status = ? ORDER BY due_date",
      status,
    );
  }

  private loadReceivables(status?: string) {
    return status
      ? this.allRows<ReceivableRecord>(
          "SELECT * FROM receivables WHERE status = ? ORDER BY expected_date",
          status,
        )
      : this.allRows<ReceivableRecord>(
          "SELECT * FROM receivables WHERE status <> 'received' ORDER BY expected_date",
        );
  }

  private loadAccountBalances() {
    const rows = this.allRows<AccountBalanceRecord>(
      "SELECT id, external_id, name, institution, currency, balance, last_update, updated_at FROM accounts ORDER BY balance DESC",
    );
    const liquid: AccountBalanceRecord[] = [];
    const registered: AccountBalanceRecord[] = [];
    const debt: AccountBalanceRecord[] = [];
    for (const row of rows) {
      const name = String(row.name ?? "");
      const balance = Number(row.balance ?? 0);
      if (["rrsp", "tfsa"].some((token) => name.toLowerCase().includes(token))) {
        registered.push(row);
      } else if (balance < 0) {
        debt.push(row);
      } else {
        liquid.push(row);
      }
    }
    return { liquid, registered, debt };
  }

  private buildDashboardHorizonPlan(input: {
    referenceDate: string;
    horizonDays: number;
    startingCashCad: number;
    taxReserveCad: number;
    currentTaxBackpayCad: number;
    taxAccountBalanceCad: number;
    receivables: FinanceReceivablesData;
    payables: FinancePayablesData;
    recurring: FinanceRecurringData;
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
      .reduce((sum, row) => sum + this.sumRecurringOutflowsWithinHorizon(row, input.referenceDate, horizonEndExclusive), 0);
    const knownOutflowsCad = finiteNumber(payableOutflowsCad + recurringOutflowsCad);
    const expectedReceivablesCad = input.receivables.rows
      .filter((row) => {
        const delta = daysBetween(input.referenceDate, row.expectedDate);
        return delta >= 0 && delta <= input.horizonDays;
      })
      .reduce((sum, row) => sum + finiteNumber(row.convertedCad), 0);
    const forecastIncomeCad = input.forecastMonths.reduce((sum, row) => {
      return sum + this.proratedForecastMonthValue(row.month, finiteNumber(row.incomeCad), input.referenceDate, horizonEndExclusive);
    }, 0);
    const forecastTaxReserveCad = input.forecastMonths.reduce((sum, row) => {
      return sum + this.proratedForecastMonthValue(row.month, finiteNumber(row.taxSetAside), input.referenceDate, horizonEndExclusive);
    }, 0);
    const budgetedSpendCad = input.forecastMonths.reduce((sum, row) => {
      return sum + this.proratedForecastMonthValue(row.month, finiteNumber(row.discretionaryCad), input.referenceDate, horizonEndExclusive);
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

  private proratedForecastMonthValue(month: string, monthValue: number, referenceDate: string, horizonEndExclusive: string) {
    const monthRange = startEndForMonth(month);
    const overlapStart = referenceDate > monthRange.from ? referenceDate : monthRange.from;
    const overlapEnd = horizonEndExclusive < monthRange.toExclusive ? horizonEndExclusive : monthRange.toExclusive;
    const overlapDays = Math.max(0, daysBetween(overlapStart, overlapEnd));
    if (overlapDays === 0) {
      return 0;
    }
    const totalMonthDays = Math.max(1, daysBetween(monthRange.from, monthRange.toExclusive));
    return finiteNumber(monthValue) * (overlapDays / totalMonthDays);
  }

  private sumRecurringOutflowsWithinHorizon(
    row: Pick<FinanceRecurringItemData, "amountCad" | "intervalKind" | "intervalDays" | "nextExpectedDate" | "lastSeenDate" | "status">,
    referenceDate: string,
    horizonEndExclusive: string,
  ) {
    if (row.status !== "active") {
      return 0;
    }
    let nextExpected = row.nextExpectedDate;
    if (!nextExpected && row.lastSeenDate) {
      nextExpected = computeNextExpected(row.lastSeenDate, row.intervalKind, row.intervalDays);
    }
    if (!nextExpected) {
      nextExpected = referenceDate;
    }
    let total = 0;
    let cursor = nextExpected;
    let overdueIncluded = false;
    for (let iteration = 0; iteration < 48; iteration += 1) {
      if (cursor < referenceDate) {
        if (!overdueIncluded) {
          total += finiteNumber(row.amountCad);
          overdueIncluded = true;
        }
        const advanced = computeNextExpected(cursor, row.intervalKind, row.intervalDays);
        if (advanced <= cursor) {
          break;
        }
        cursor = advanced;
        continue;
      }
      if (cursor >= horizonEndExclusive) {
        break;
      }
      total += finiteNumber(row.amountCad);
      const advanced = computeNextExpected(cursor, row.intervalKind, row.intervalDays);
      if (advanced <= cursor) {
        break;
      }
      cursor = advanced;
    }
    return total;
  }

  private projectAnnualIncome(sources: IncomeSourceRecord[], fxRate: number, includeUnconfirmed: boolean): FinanceIncomeProjectionData {
    const today = new Date();
    const currentYear = today.getUTCFullYear();
    let totalCad = 0;
    const items: FinanceIncomeProjectionData["items"] = [];
    for (const source of sources) {
      const confirmed = Number(source.confirmed ?? 1) === 1;
      if (!confirmed && !includeUnconfirmed) {
        const guaranteedMonths = Number(source.guaranteed_months ?? 0);
        const monthly = String(source.period ?? "monthly") === "monthly"
          ? Number(source.amount_per_period ?? 0)
          : Number(source.amount_per_period ?? 0) * 26 / 12;
        const annual = monthly * guaranteedMonths;
        const annualCad = this.toCad(annual, String(source.currency ?? "USD"), fxRate);
        items.push({
          name: String(source.name ?? ""),
          annualOrig: annual,
          currency: String(source.currency ?? "USD"),
          annualCad,
          confirmed: false,
          note: `${guaranteedMonths} guaranteed month(s)`,
        });
        totalCad += annualCad;
        continue;
      }
      const startDate = new Date(`${String(source.start_date)}T00:00:00Z`);
      const effectiveStartMonth = Math.max(startDate.getUTCMonth() + 1, 1);
      const monthsRemaining = Math.max(0, 12 - effectiveStartMonth + 1);
      const annual = String(source.period ?? "monthly") === "biweekly"
        ? Number(source.amount_per_period ?? 0) * Math.floor(26 * monthsRemaining / 12)
        : Number(source.amount_per_period ?? 0) * monthsRemaining;
      const annualCad = this.toCad(annual, String(source.currency ?? "USD"), fxRate);
      items.push({
        name: String(source.name ?? ""),
        annualOrig: annual,
        currency: String(source.currency ?? "USD"),
        annualCad,
        confirmed: confirmed,
        monthsActive: currentYear === 2026 ? monthsRemaining : 12,
      });
      totalCad += annualCad;
    }
    return { items, totalCad };
  }

  private calcTaxRateForMonth(
    monthNumber: number,
    monthlyIncomeCad: number,
    sources: IncomeSourceRecord[],
    fxRate: number,
    config: FinanceForecastConfig,
    includeUnconfirmed: boolean,
  ): FinanceMonthlyTaxRateProjectionData {
    let ytdIncome = 0;
    for (let month = 1; month <= monthNumber; month += 1) {
      const monthStart = new Date(Date.UTC(2026, month - 1, 1));
      const monthEnd = month === 12
        ? new Date(Date.UTC(2027, 0, 1))
        : new Date(Date.UTC(2026, month, 1));
      for (const source of sources) {
        const confirmed = Number(source.confirmed ?? 1) === 1;
        if (!confirmed && !includeUnconfirmed) {
          continue;
        }
        if (!confirmed) {
          const guaranteedMonths = Number(source.guaranteed_months ?? 0);
          const sourceStart = new Date(`${String(source.start_date)}T00:00:00Z`);
          const monthsSinceStart = (month - (sourceStart.getUTCMonth() + 1)) + (2026 - sourceStart.getUTCFullYear()) * 12;
          if (monthsSinceStart >= guaranteedMonths) {
            continue;
          }
        }
        const sourceStart = new Date(`${String(source.start_date)}T00:00:00Z`);
        const sourceEnd = source.end_date
          ? new Date(`${String(source.end_date)}T00:00:00Z`)
          : new Date(Date.UTC(2099, 0, 1));
        if (monthStart >= sourceEnd || monthEnd <= sourceStart) {
          continue;
        }
        ytdIncome += this.toCad(
          String(source.period ?? "monthly") === "biweekly"
            ? Number(source.amount_per_period ?? 0) * 26 / 12
            : Number(source.amount_per_period ?? 0),
          String(source.currency ?? "USD"),
          fxRate,
        );
      }
    }
    const annualized = monthNumber > 0 ? ytdIncome * (12 / monthNumber) : 0;
    const tax = this.calcAnnualTax(annualized, config);
    return {
      ytdIncome,
      annualized,
      rate: tax.effectiveRateWithContribs,
      monthlySetAside: monthlyIncomeCad * tax.effectiveRateWithContribs,
    };
  }

  private buildCashflow(
    sources: IncomeSourceRecord[],
    expenses: Array<RecurringRecord & { monthlyCad: number }>,
    payables: PayableRecord[],
    receivables: ReceivableRecord[],
    fxRate: number,
    config: FinanceForecastConfig,
    includeUnconfirmed: boolean,
  ): Array<Omit<FinanceCashflowMonthData, "cumulativeCad">> {
    const weeklyBudget = this.getNumericSettingOrDefault("budget.weekly_limit_cad");
    const activeSources = sources.filter((source) => includeUnconfirmed || Number(source.confirmed ?? 1) === 1);
    const months: Array<Omit<FinanceCashflowMonthData, "cumulativeCad">> = [];
    for (let month = 3; month <= 12; month += 1) {
      const monthKey = `2026-${month.toString().padStart(2, "0")}`;
      const monthStart = new Date(Date.UTC(2026, month - 1, 1));
      const monthEnd = month === 12 ? new Date(Date.UTC(2027, 0, 1)) : new Date(Date.UTC(2026, month, 1));
      let incomeCad = 0;
      for (const source of activeSources) {
        const sourceStart = new Date(`${String(source.start_date)}T00:00:00Z`);
        const sourceEnd = source.end_date ? new Date(`${String(source.end_date)}T00:00:00Z`) : new Date(Date.UTC(2099, 0, 1));
        if (monthStart >= sourceEnd || monthEnd <= sourceStart) {
          continue;
        }
        const confirmed = Number(source.confirmed ?? 1) === 1;
        if (!confirmed) {
          const guaranteedMonths = Number(source.guaranteed_months ?? 0);
          const monthsSinceStart = (month - (sourceStart.getUTCMonth() + 1)) + (2026 - sourceStart.getUTCFullYear()) * 12;
          if (monthsSinceStart >= guaranteedMonths) {
            continue;
          }
        }
        incomeCad += this.toCad(
          String(source.period ?? "monthly") === "biweekly"
            ? Number(source.amount_per_period ?? 0) * 26 / 12
            : Number(source.amount_per_period ?? 0),
          String(source.currency ?? "USD"),
          fxRate,
        );
      }
      const expensesCad = expenses.reduce((sum, expense) => sum + expense.monthlyCad, 0);
      const monthDays = Math.round((monthEnd.getTime() - monthStart.getTime()) / 86_400_000);
      const discretionaryCad = weeklyBudget * (monthDays / 7);
      const tax = this.calcTaxRateForMonth(month, incomeCad, sources, fxRate, config, includeUnconfirmed);
      const apDue = payables
        .filter((payable) => String(payable.due_date ?? "").slice(0, 7) === monthKey)
        .reduce((sum, payable) => sum + this.toCad(Number(payable.amount ?? 0), String(payable.currency ?? "CAD"), fxRate), 0);
      const arExpected = receivables
        .filter((receivable) => String(receivable.expected_date ?? "").slice(0, 7) === monthKey)
        .reduce((sum, receivable) => sum + this.toCad(Number(receivable.amount ?? receivable.amount_cad ?? 0), String(receivable.currency ?? "CAD"), fxRate), 0);
      const totalOut = expensesCad + discretionaryCad + tax.monthlySetAside + apDue;
      months.push({
        month: monthKey,
        incomeCad,
        expensesCad,
        discretionaryCad,
        taxSetAside: tax.monthlySetAside,
        apDue,
        arExpected,
        totalOut,
        net: incomeCad + arExpected - totalOut,
      });
    }
    return months;
  }

  private renderForecastSummary(config: FinanceForecastConfig) {
    const fxRate = this.getFxRate();
    const sources = this.loadIncomeSources();
    const expenses = this.loadRecurringExpenses();
    const payables = this.loadPayables();
    const receivables = this.loadReceivables();
    const balances = this.loadAccountBalances();
    const totalLiquid = balances.liquid.reduce((sum, row) => sum + this.toCad(Number(row.balance ?? 0), String(row.currency ?? "CAD"), fxRate), 0);
    const totalDebt = balances.debt.reduce((sum, row) => sum + this.toCad(Math.abs(Number(row.balance ?? 0)), String(row.currency ?? "CAD"), fxRate), 0);
    const totalRegistered = balances.registered.reduce((sum, row) => sum + this.toCad(Number(row.balance ?? 0), String(row.currency ?? "CAD"), fxRate), 0);
    const confirmedAp = payables.filter((row) => row.certainty === "confirmed");
    const totalConfirmedAp = confirmedAp.reduce((sum, row) => sum + this.toCad(Number(row.amount ?? 0), String(row.currency ?? "CAD"), fxRate), 0);
    const totalAllAp = payables.reduce((sum, row) => sum + this.toCad(Number(row.amount ?? 0), String(row.currency ?? "CAD"), fxRate), 0);
    const pendingAr = receivables.reduce((sum, row) => sum + this.toCad(Number(row.amount ?? row.amount_cad ?? 0), String(row.currency ?? "CAD"), fxRate), 0);
    const netLiquid = totalLiquid - totalDebt;
    const incomeConservative = this.projectAnnualIncome(sources, fxRate, false);
    const incomeOptimistic = this.projectAnnualIncome(sources, fxRate, true);
    const totalMonthlyExpenses = expenses.reduce((sum, row) => sum + row.monthlyCad, 0);
    const monthlyDiscretionary = this.getNumericSettingOrDefault("budget.weekly_limit_cad") * 52 / 12;

    const formatIncomeLine = (item: FinanceIncomeProjectionData["items"][number]) =>
      `    ${item.confirmed ? "x" : "!"} ${String(item.name).padEnd(25)} ${formatMoney(Number(item.annualOrig ?? 0), String(item.currency ?? "USD"), 0).padStart(16)}  ${formatCad(Number(item.annualCad ?? 0)).padStart(16)}  (${item.note ?? `${item.monthsActive ?? "?"} months`})`;

    const scenarioBlock = (label: string, income: { totalCad: number }) => {
      const tax = this.calcAnnualTax(income.totalCad, config);
      const net = tax.netAfterTaxAndAlimony;
      const annualExpenses = (totalMonthlyExpenses + monthlyDiscretionary) * 12;
      const surplus = net - annualExpenses;
      return [
        `  -- ${label} --`,
        `    Gross CAD:              ${formatCad(income.totalCad).padStart(16)}`,
        `    Tax (fed+QC):          -${formatCad(tax.totalTax).padStart(16)}  (${(tax.effectiveRate * 100).toFixed(1)}%)`,
        `    Contributions:         -${formatCad(tax.contributions.total).padStart(16)}`,
        `    Combined rate:           ${(tax.effectiveRateWithContribs * 100).toFixed(1)}%`,
        `    Alimony:               -${formatCad(tax.alimonyAnnual).padStart(16)}`,
        `    Net:                    ${formatCad(net).padStart(16)}  (${formatCad(net / 12)}/mo)`,
        `    Expenses:              -${formatCad(annualExpenses).padStart(16)}  (${formatCad(annualExpenses / 12)}/mo)`,
        "    ========================================",
        `    SURPLUS:                ${formatCad(surplus).padStart(16)}  (${formatCad(surplus / 12)}/mo)`,
      ].join("\n");
    };

    const currentMonth = new Date().getUTCMonth() + 1;
    const taxCon = this.calcTaxRateForMonth(currentMonth, 0, sources, fxRate, config, false);
    const taxOpt = this.calcTaxRateForMonth(currentMonth, 0, sources, fxRate, config, true);

    return [
      "================================================================",
      "  2026 FINANCIAL FORECAST - SUMMARY",
      "================================================================",
      "",
      `  FX Rate: ${fxRate} USD/CAD`,
      "",
      "  CURRENT STANDING:",
      ...balances.liquid.filter((row) => Number(row.balance ?? 0) !== 0).map((row) =>
        `    ${String(row.name ?? "").padEnd(35)} ${formatMoney(Number(row.balance ?? 0), String(row.currency ?? "CAD")).padStart(16)}`),
      ...balances.debt.map((row) =>
        `    ${String(row.name ?? "").padEnd(35)} ${formatMoney(Number(row.balance ?? 0), String(row.currency ?? "CAD")).padStart(16)}`),
      `    ${"-".repeat(53)}`,
      `    ${"Net liquid".padEnd(35)} ${formatCad(netLiquid).padStart(16)}`,
      `    ${"+ Pending AR".padEnd(35)} ${formatCad(pendingAr).padStart(16)}`,
      `    ${"- Confirmed AP".padEnd(35)} ${formatCad(totalConfirmedAp).padStart(16)}`,
      `    ${"=".repeat(53)}`,
      `    ${"NET POSITION (confirmed AP)".padEnd(35)} ${formatCad(netLiquid - totalConfirmedAp + pendingAr).padStart(16)}`,
      totalAllAp !== totalConfirmedAp
        ? `    ${"NET POSITION (all AP)".padEnd(35)} ${formatCad(netLiquid - totalAllAp + pendingAr).padStart(16)}`
        : "",
      totalRegistered > 0
        ? `    ${"(Registered accounts, not liquid)".padEnd(35)} ${formatCad(totalRegistered).padStart(16)}`
        : "",
      "",
      "  INCOME (remaining 2026):",
      ...incomeOptimistic.items.map(formatIncomeLine),
      "",
      `    Conservative (confirmed):  ${formatCad(incomeConservative.totalCad).padStart(16)}`,
      `    Optimistic (all sources): ${formatCad(incomeOptimistic.totalCad).padStart(16)}`,
      "",
      "  MONTHLY EXPENSES (from recurring):",
      ...expenses
        .slice()
        .sort((left, right) => right.monthlyCad - left.monthlyCad)
        .map((expense) => `    ${String(expense.name ?? "").padEnd(30)} ${formatCad(expense.monthlyCad).padStart(12)}${String(expense.interval_kind ?? "monthly") !== "monthly" ? ` (${Number(expense.amount_cad ?? 0).toFixed(2)}/${expense.interval_kind})` : ""}`),
      `    ${"Discretionary".padEnd(30)} ${formatCad(monthlyDiscretionary).padStart(12)}  ($${this.getNumericSettingOrDefault("budget.weekly_limit_cad").toFixed(0)}/week)`,
      `    ${"-".repeat(44)}`,
      `    ${"TOTAL".padEnd(30)} ${formatCad(totalMonthlyExpenses + monthlyDiscretionary).padStart(12)}/mo`,
      `    ${"TOTAL ANNUAL".padEnd(30)} ${formatCad((totalMonthlyExpenses + monthlyDiscretionary) * 12).padStart(12)}`,
      "",
      scenarioBlock("CONSERVATIVE", incomeConservative),
      "",
      scenarioBlock("OPTIMISTIC", incomeOptimistic),
      "",
      `  2026 TAX RATE (annualized from ${currentMonth}-month YTD):`,
      `    YTD income (con):   ${formatCad(taxCon.ytdIncome)}  -> annualized ${formatCad(taxCon.annualized)}`,
      `    YTD income (opt):   ${formatCad(taxOpt.ytdIncome)}  -> annualized ${formatCad(taxOpt.annualized)}`,
      `    Effective rate (con): ${(taxCon.rate * 100).toFixed(1)}%`,
      `    Effective rate (opt): ${(taxOpt.rate * 100).toFixed(1)}%`,
    ].filter(Boolean).join("\n");
  }

  private renderCashflow(config: FinanceForecastConfig) {
    const fxRate = this.getFxRate();
    const sources = this.loadIncomeSources();
    const expenses = this.loadRecurringExpenses();
    const confirmedPayables = this.loadPayables().filter((row) => row.certainty === "confirmed");
    const allPayables = this.loadPayables();
    const receivables = this.loadReceivables();
    const balances = this.loadAccountBalances();
    const starting = balances.liquid.reduce((sum, row) => sum + this.toCad(Number(row.balance ?? 0), String(row.currency ?? "CAD"), fxRate), 0)
      - balances.debt.reduce((sum, row) => sum + this.toCad(Math.abs(Number(row.balance ?? 0)), String(row.currency ?? "CAD"), fxRate), 0);
    const conservative = this.buildCashflow(sources, expenses, confirmedPayables, receivables, fxRate, config, false);
    const optimistic = this.buildCashflow(sources, expenses, allPayables, receivables, fxRate, config, true);
    let cumulativeConservative = starting;
    let cumulativeOptimistic = starting;
    const lines = [
      "================================================================",
      "  2026 MONTHLY CASH FLOW WATERFALL",
      "================================================================",
      `  Starting liquid: ${formatCad(starting)}`,
      `  FX Rate: ${fxRate}`,
      "  Tax rates computed per-month via annualized YTD income",
      "",
    ];
    for (let index = 0; index < conservative.length; index += 1) {
      const con = conservative[index]!;
      const opt = optimistic[index]!;
      cumulativeConservative += Number(con.net ?? 0);
      cumulativeOptimistic += Number(opt.net ?? 0);
      lines.push(
        `  -- ${con.month} --`,
        `    Income:         ${formatCad(Number(con.incomeCad ?? 0)).padStart(14)}  (con)    ${formatCad(Number(opt.incomeCad ?? 0)).padStart(14)}  (opt)`,
      );
      if (Number(opt.arExpected ?? 0) > 0) {
        lines.push(`    AR received:   +${formatCad(Number(opt.arExpected ?? 0)).padStart(14)}`);
      }
      lines.push(
        `    Expenses:      -${formatCad(Number(opt.expensesCad ?? 0)).padStart(14)}`,
        `    Discretionary: -${formatCad(Number(opt.discretionaryCad ?? 0)).padStart(14)}`,
        `    Tax set-aside: -${formatCad(Number(con.taxSetAside ?? 0)).padStart(14)}  (con)   -${formatCad(Number(opt.taxSetAside ?? 0)).padStart(14)}  (opt)`,
      );
      if (Number(opt.apDue ?? 0) > 0) {
        lines.push(`    AP due:        -${formatCad(Number(opt.apDue ?? 0)).padStart(14)}`);
      }
      lines.push(
        "    ------------------------------------------------",
        `    Net:           ${formatCad(Number(con.net ?? 0)).padStart(14)}  (con)   ${formatCad(Number(opt.net ?? 0)).padStart(14)}  (opt)`,
        `    Cumulative:    ${formatCad(cumulativeConservative).padStart(14)}  (con)   ${formatCad(cumulativeOptimistic).padStart(14)}  (opt)`,
        "",
      );
    }
    return lines.join("\n");
  }

  private renderAr() {
    const fxRate = this.getFxRate();
    const receivables = this.loadReceivables();
    const today = dateKey(new Date());
    const overdue = receivables.filter((row) => String(row.expected_date ?? "") < today);
    const upcoming = receivables.filter((row) => String(row.expected_date ?? "") >= today);
    const lines = [
      "================================================================",
      "  ACCOUNTS RECEIVABLE",
      "================================================================",
    ];
    if (overdue.length > 0) {
      lines.push("", "  OVERDUE:");
      for (const row of overdue) {
        const amount = Number(row.amount ?? row.amount_cad ?? 0);
        const currency = String(row.currency ?? "CAD");
        const cad = this.toCad(amount, currency, fxRate);
        lines.push(`    ! ${String(row.counterparty ?? "").padEnd(20)} ${formatMoney(amount, currency).padStart(16)}${currency !== "CAD" ? ` (~${formatCad(cad)})` : ""}  expected ${row.expected_date}${row.notes ? ` | ${row.notes}` : ""} [id:${row.id}]`);
      }
    }
    if (upcoming.length > 0) {
      lines.push("", "  UPCOMING:");
      for (const row of upcoming) {
        const amount = Number(row.amount ?? row.amount_cad ?? 0);
        const currency = String(row.currency ?? "CAD");
        const cad = this.toCad(amount, currency, fxRate);
        lines.push(`    > ${String(row.counterparty ?? "").padEnd(20)} ${formatMoney(amount, currency).padStart(16)}${currency !== "CAD" ? ` (~${formatCad(cad)})` : ""}  expected ${row.expected_date}${row.notes ? ` | ${row.notes}` : ""} [id:${row.id}]`);
      }
    }
    if (overdue.length === 0 && upcoming.length === 0) {
      lines.push("", "  (no pending receivables)");
    }
    const total = receivables.reduce((sum, row) => sum + this.toCad(Number(row.amount ?? row.amount_cad ?? 0), String(row.currency ?? "CAD"), fxRate), 0);
    lines.push("", `  TOTAL PENDING: ${formatCad(total)}`);
    return lines.join("\n");
  }

  private renderAp() {
    const fxRate = this.getFxRate();
    const payables = this.loadPayables();
    const today = dateKey(new Date());
    const lines = [
      "================================================================",
      "  ACCOUNTS PAYABLE",
      "================================================================",
    ];
    for (const certainty of ["confirmed", "expected", "speculative"] as const) {
      const items = payables.filter((row) => row.certainty === certainty);
      if (items.length === 0) {
        continue;
      }
      lines.push("", `  ${certainty.toUpperCase()}:`);
      for (const row of items) {
        const amount = Number(row.amount ?? 0);
        const currency = String(row.currency ?? "CAD");
        const cad = this.toCad(amount, currency, fxRate);
        lines.push(`    [${certainty === "confirmed" ? "x" : certainty === "expected" ? "~" : "?"}] ${String(row.counterparty ?? "").padEnd(25)} ${formatMoney(amount, currency).padStart(16)}${currency !== "CAD" ? ` (~${formatCad(cad)})` : ""}  due ${row.due_date}  [${row.category ?? "-"}]${String(row.due_date ?? "") < today ? " OVERDUE" : ""}`);
        if (row.description) {
          lines.push(`        ${row.description}`);
        }
      }
      const subtotal = items.reduce((sum, row) => sum + this.toCad(Number(row.amount ?? 0), String(row.currency ?? "CAD"), fxRate), 0);
      lines.push(`    ${"SUBTOTAL".padEnd(25)} ${formatCad(subtotal).padStart(16)}`);
    }
    const confirmed = payables.filter((row) => row.certainty === "confirmed").reduce((sum, row) => sum + this.toCad(Number(row.amount ?? 0), String(row.currency ?? "CAD"), fxRate), 0);
    const grandTotal = payables.reduce((sum, row) => sum + this.toCad(Number(row.amount ?? 0), String(row.currency ?? "CAD"), fxRate), 0);
    lines.push("", `  CONFIRMED TOTAL: ${formatCad(confirmed)}`, `  FULL TOTAL (incl speculative): ${formatCad(grandTotal)}`);
    return lines.join("\n");
  }
}
