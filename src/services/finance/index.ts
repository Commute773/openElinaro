import type { Database } from "bun:sqlite";
import { getRuntimeConfig } from "../../config/runtime-config";
import {
  DEFAULT_FINANCE,
  type FinanceForecastConfig,
} from "../../config/finance-config";
import type {
  FinanceAccountsLiquidityData,
  FinanceBudgetHistoryData,
  FinanceBudgetSnapshotData,
  FinanceCategoryAggregatesData,
  FinanceFxInfoData,
  FinanceImportRunsData,
  FinancePayablesData,
  FinanceReceivablesData,
  FinanceRecurringData,
  FinanceReviewQueueData,
  FinanceSheetInfoData,
  FinanceTransactionsData,
} from "./finance-types";
import type {
  FinanceForecastCashflowData,
  FinanceForecastSummaryData,
  FinanceIncomeSourcesData,
  FinanceTaxProjectionData,
} from "./finance-forecasting-types";
import type {
  FinanceDashboardSignalsData,
  FinanceMetadataData,
  FinanceOverviewData,
  FinanceWhatIfData,
  FinanceWhatIfInput,
} from "../finance-dashboard-types";
import { openDatabase } from "../../utils/sqlite-helpers";
import { timestamp as nowIso } from "../../utils/timestamp";

// Re-export types so consumers can import from the same path
export type {
  FinanceHistoryOptions,
  FinanceCategorizeDecision,
  FinanceImportOptions,
  FinanceSettingsUpdateInput,
  FinanceAddExpenseInput,
  FinanceAddReceivableInput,
  FinanceAddRecurringInput,
  FinanceSetRecurringInput,
  FinanceAddPayableInput,
  FinanceAddIncomeSourceInput,
  FinanceAddFxEventInput,
} from "./finance-types";

import type {
  FinanceHistoryOptions,
  FinanceCategorizeDecision,
  FinanceImportOptions,
  FinanceSettingsUpdateInput,
  FinanceAddExpenseInput,
  FinanceAddReceivableInput,
  FinanceAddRecurringInput,
  FinanceSetRecurringInput,
  FinanceAddPayableInput,
  FinanceAddIncomeSourceInput,
  FinanceAddFxEventInput,
  FinanceSyntheticIncomeInput,
} from "./finance-types";

import {
  formatCad,
  formatMoney,
  heading,
  dateKey,
  toIsoDate,
  addDays,
  resolveConfiguredFinancePath,
} from "./finance-helpers";

import {
  SCHEMA,
  allRows,
  getRow,
  run,
  migrateReceivables,
  migrateRecurring,
  seedDefaults,
  ensureForecastConfig,
  loadForecastConfig,
  getSettingOrDefault,
  getNumericSettingOrDefault,
  setSetting,
  getFxRate,
  buildMetadataData,
} from "./finance-database";

import {
  categorizeTransactions,
  addExpenseTransaction,
  renderHistoryText,
  renderReviewQueueText,
  buildCategoryAggregatesData,
  buildAccountsLiquidityData,
  buildTransactionsData,
  buildReviewQueueData,
  buildFxInfoData,
} from "./finance-ledger";

import {
  buildForecastSummaryData,
  buildForecastCashflowData,
  buildTaxProjectionData,
  renderForecastSummary,
  renderCashflow,
  renderAr,
  renderAp,
  buildIncomeSourcesData,
} from "./finance-forecasting";

import {
  resolveBudgetSnapshot,
  renderBudgetBlock,
  buildBudgetHistoryData,
  buildSimulatePurchaseImpact,
} from "./finance-budget";

import {
  getRecurringCandidatesData,
  renderRecurringList,
  refreshRecurringRules,
  addRecurringRule,
  setRecurringRule,
} from "./finance-recurring";

import {
  upsertSyntheticIncomeTransaction,
  clearMatchingPendingReceivables,
  executeImportTransactions,
  buildImportRunsData,
} from "./finance-import";

import {
  buildReceivablesData,
  buildPayablesData,
  buildRecurringData,
  buildOverviewData,
  buildSheetInfo,
  renderSummaryText,
  buildDashboardSignalsData,
} from "./finance-dashboard";


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
    this.db = openDatabase(this.dbPath);

    try {
      this.db.exec(SCHEMA);
      migrateReceivables(this.db);
      migrateRecurring(this.db);
      seedDefaults(this.db, this.defaultSettings);
      ensureForecastConfig(this.forecastConfigPath, this.defaultForecastConfig);
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
    return buildSheetInfo(this.db, this.defaultSettings);
  }

  buildAssistantContext(reference: Date = new Date()) {
    const today = dateKey(reference);
    const budget = resolveBudgetSnapshot(this.db, today, this.defaultSettings);
    const reviewCount = Number(getRow<{ count: number }>(this.db, "SELECT COUNT(1) AS count FROM transactions WHERE needs_review = 1")?.count ?? 0);
    const upcomingReceivable = getRow<{ counterparty: string; amount_cad: number; expected_date: string }>(
      this.db,
      "SELECT counterparty, amount_cad, expected_date FROM receivables WHERE status <> 'received' ORDER BY expected_date ASC LIMIT 1",
    );
    const nextPayable = getRow<{ counterparty: string; amount: number; currency: string; due_date: string }>(
      this.db,
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
    return renderSummaryText(this.db, this.defaultSettings, reference);
  }

  budget(options?: { date?: string; weeklyLimit?: number }) {
    if (options?.weeklyLimit !== undefined) {
      setSetting(this.db, "budget.weekly_limit_cad", String(options.weeklyLimit));
    }
    const today = options?.date ? toIsoDate(options.date) : dateKey(new Date());
    const budget = resolveBudgetSnapshot(this.db, today, this.defaultSettings);
    return renderBudgetBlock(this.db, budget, this.defaultSettings);
  }

  history(options: FinanceHistoryOptions = {}) {
    return renderHistoryText(this.db, options);
  }

  reviewQueue(limit = 10) {
    return renderReviewQueueText(this.db, limit);
  }

  categorize(decisions: FinanceCategorizeDecision[]) {
    return categorizeTransactions(this.db, decisions);
  }

  addExpense(input: FinanceAddExpenseInput) {
    return addExpenseTransaction(this.db, input);
  }

  async importTransactions(options: FinanceImportOptions = {}) {
    const result = await executeImportTransactions(
      this.db,
      this.defaultSettings,
      options,
      (id, opts) => this.markReceivableReceived(id, opts),
    );
    return {
      ...result,
      sheet: (options.source ?? "fintable_gsheet") === "fintable_gsheet" ? this.getSheetInfo() : undefined,
    };
  }

  addReceivable(input: FinanceAddReceivableInput) {
    const currency = (input.currency ?? "CAD").toUpperCase();
    const amount = input.amount ?? null;
    const amountCad = input.amountCad ?? (currency === "CAD" ? amount : null);
    run(
      this.db,
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
    const row = getRow<{ id: number }>(this.db, "SELECT last_insert_rowid() AS id");
    return { status: "added", id: Number(row?.id ?? 0) };
  }

  listReceivables(status?: string) {
    const rows = status
      ? allRows<Record<string, unknown>>(this.db, "SELECT * FROM receivables WHERE status = ? ORDER BY expected_date", status)
      : allRows<Record<string, unknown>>(this.db, "SELECT * FROM receivables WHERE status <> 'received' ORDER BY expected_date");
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
    const overdue = allRows<Record<string, unknown>>(
      this.db,
      "SELECT * FROM receivables WHERE status <> 'received' AND expected_date < ? ORDER BY expected_date",
      today,
    );
    const dueSoon = allRows<Record<string, unknown>>(
      this.db,
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
    return addRecurringRule(this.db, input);
  }

  setRecurring(input: FinanceSetRecurringInput) {
    return setRecurringRule(this.db, input);
  }

  deleteRecurring(id: number) {
    const result = run(this.db, "DELETE FROM recurring WHERE id = ?", id);
    if (Number(result.changes ?? 0) === 0) {
      throw new Error(`Recurring rule ${id} not found.`);
    }
    return { status: "deleted", id, deleted: Number(result.changes ?? 0) };
  }

  listRecurring() {
    const rows = allRows<Record<string, unknown>>(
      this.db,
      "SELECT * FROM recurring ORDER BY status ASC, next_expected_date ASC, id ASC",
    );
    const active = rows.filter((row) => row.status === "active");
    const halted = rows.filter((row) => row.status === "halted");
    return `${renderRecurringList("Active recurring", active)}\n\n${renderRecurringList("Halted recurring", halted)}`;
  }

  refreshRecurring(options?: { today?: string; noAutoSeed?: boolean; seedLimit?: number }) {
    const today = options?.today ? toIsoDate(options.today) : dateKey(new Date());
    const result = refreshRecurringRules(this.db, today, !(options?.noAutoSeed ?? false), options?.seedLimit ?? 12);
    let output = `Recurring refresh (today: ${result.today})\n`;
    if (result.seeded.length > 0) {
      output += `\n${renderRecurringList("Auto-seeded new rules", result.seeded)}\n`;
    }
    output += `\n${renderRecurringList("ACTIVE", result.active)}`;
    output += `\n\n${renderRecurringList("HALTED", result.halted)}`;
    return output;
  }

  listRecurringCandidates(options?: { today?: string; includeKnown?: boolean; maxAgeDays?: number }) {
    const rows = getRecurringCandidatesData(this.db, options);
    return `${heading(`Recurring candidates (${rows.length})`)}\n${
      rows.length === 0
        ? "(none)"
        : rows.map((row) =>
          `- ${row.name}: ${formatCad(row.amountCad)} | ${row.intervalKind} | occurrences ${row.occurrences} | last ${row.lastSeen} | next ${row.nextExpectedDate}${row.alreadyTracked ? ` | tracked id:${row.existingRecurringId}` : ""}`
        ).join("\n")
    }`;
  }

  getRecurringCandidatesData(options?: { today?: string; includeKnown?: boolean; maxAgeDays?: number }) {
    return getRecurringCandidatesData(this.db, options);
  }

  addPayable(input: FinanceAddPayableInput) {
    const result = run(
      this.db,
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
    const params: (string | number | bigint | boolean | null)[] = [];
    if (options?.status) {
      params.push(options.status);
    }
    if (options?.certainty) {
      where.push("certainty = ?");
      params.push(options.certainty);
    }
    const rows = allRows<Record<string, unknown>>(
      this.db,
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
    run(
      this.db,
      "UPDATE payables SET status = 'paid', updated_at = ? WHERE id = ?",
      nowIso(),
      id,
    );
    return { status: "paid", id };
  }

  markReceivableReceived(id: number, options?: { receivedDate?: string; note?: string }) {
    const existing = getRow<Record<string, unknown>>(
      this.db,
      "SELECT notes FROM receivables WHERE id = ?",
      id,
    );
    const receivedDate = toIsoDate(options?.receivedDate ?? dateKey(new Date()));
    const noteParts = [
      typeof existing?.notes === "string" && existing.notes.trim() ? existing.notes.trim() : null,
      options?.note?.trim() ? `${options.note.trim()} (${receivedDate})` : null,
    ].filter((value): value is string => Boolean(value));
    run(
      this.db,
      "UPDATE receivables SET status = 'received', last_followup_date = ?, notes = ?, updated_at = ? WHERE id = ?",
      receivedDate,
      noteParts.length > 0 ? noteParts.join(" | ") : null,
      nowIso(),
      id,
    );
    return { status: "received", id, receivedDate };
  }

  recordInferredIncome(input: FinanceSyntheticIncomeInput & { clearPendingReceivablesForCounterparty?: string | null }) {
    const result = upsertSyntheticIncomeTransaction(this.db, {
      ...input,
      source: input.source ?? "account_balance_inference",
      category: input.category ?? "Income/Client",
    });
    const clearedReceivableIds = input.clearPendingReceivablesForCounterparty
      ? clearMatchingPendingReceivables(
          this.db,
          input.clearPendingReceivablesForCounterparty,
          input.amountCad,
          toIsoDate(input.postedDate),
          `Auto-cleared from inferred income transaction ${result.externalId}`,
          (id, opts) => this.markReceivableReceived(id, opts),
        )
      : [];
    return {
      ...result,
      clearedReceivableIds,
    };
  }

  addIncomeSource(input: FinanceAddIncomeSourceInput) {
    const result = run(
      this.db,
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
    const rows = allRows<Record<string, unknown>>(
      this.db,
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
    const result = run(
      this.db,
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
    const rows = allRows<Record<string, unknown>>(
      this.db,
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
    const config = loadForecastConfig(this.forecastConfigPath);
    if (view === "cashflow") {
      return renderCashflow(this.db, config, this.defaultSettings);
    }
    if (view === "ar") {
      return renderAr(this.db, this.defaultSettings);
    }
    if (view === "ap") {
      return renderAp(this.db, this.defaultSettings);
    }
    return renderForecastSummary(this.db, config, this.defaultSettings);
  }

  getBudgetSnapshot(options?: { date?: string; weeklyLimit?: number }): FinanceBudgetSnapshotData {
    const dateIso = options?.date ? toIsoDate(options.date) : dateKey(new Date());
    return resolveBudgetSnapshot(this.db, dateIso, this.defaultSettings, options?.weeklyLimit);
  }

  getBudgetHistoryData(options?: { date?: string; periods?: number }): FinanceBudgetHistoryData {
    return buildBudgetHistoryData(this.db, this.defaultSettings, options);
  }

  getOverviewData(reference: Date | string = new Date()): FinanceOverviewData {
    return buildOverviewData(this.db, this.defaultSettings, reference);
  }

  getDashboardSignalsData(reference: Date | string = new Date()): FinanceDashboardSignalsData {
    return buildDashboardSignalsData(this.db, this.defaultSettings, this.forecastConfigPath, reference);
  }

  listTransactionsStructured(options: FinanceHistoryOptions = {}): FinanceTransactionsData {
    return buildTransactionsData(this.db, options);
  }

  getReviewQueueData(limit = 10): FinanceReviewQueueData {
    return buildReviewQueueData(this.db, limit);
  }

  getCategoryAggregates(options: FinanceHistoryOptions = {}): FinanceCategoryAggregatesData {
    return buildCategoryAggregatesData(this.db, options);
  }

  getAccountsLiquidityData(): FinanceAccountsLiquidityData {
    return buildAccountsLiquidityData(this.db, this.defaultSettings);
  }

  getReceivablesData(options?: { today?: string; horizonDays?: number; status?: string }): FinanceReceivablesData {
    return buildReceivablesData(this.db, this.defaultSettings, options);
  }

  getPayablesData(options?: { today?: string; status?: string }): FinancePayablesData {
    return buildPayablesData(this.db, this.defaultSettings, options);
  }

  getRecurringData(options?: { today?: string; refresh?: boolean; noAutoSeed?: boolean; seedLimit?: number }): FinanceRecurringData {
    return buildRecurringData(this.db, options);
  }

  getForecastSummaryData(): FinanceForecastSummaryData {
    return buildForecastSummaryData(this.db, loadForecastConfig(this.forecastConfigPath), this.defaultSettings);
  }

  getForecastCashflowData(): FinanceForecastCashflowData {
    return buildForecastCashflowData(this.db, loadForecastConfig(this.forecastConfigPath), this.defaultSettings);
  }

  getTaxProjectionData(): FinanceTaxProjectionData {
    return buildTaxProjectionData(this.db, loadForecastConfig(this.forecastConfigPath), this.defaultSettings);
  }

  getIncomeSourcesData(): FinanceIncomeSourcesData {
    return buildIncomeSourcesData(this.db, this.defaultSettings);
  }

  getFxInfoData(): FinanceFxInfoData {
    return buildFxInfoData(this.db, this.defaultSettings);
  }

  listImportRunsData(limit = 20): FinanceImportRunsData {
    return buildImportRunsData(this.db, limit);
  }

  updateSettings(input: FinanceSettingsUpdateInput) {
    if (input.timezone != null) setSetting(this.db, "timezone", input.timezone.trim());
    if (input.weeklyLimitCad != null) setSetting(this.db, "budget.weekly_limit_cad", String(input.weeklyLimitCad));
    if (input.monthlyLimitCad != null) setSetting(this.db, "budget.monthly_limit_cad", String(input.monthlyLimitCad));
    if (input.weeklyStartDate != null) setSetting(this.db, "budget.weekly_start_date", toIsoDate(input.weeklyStartDate));
    if (input.fxUsdCad != null) setSetting(this.db, "fx.usdcad", String(input.fxUsdCad));
    if (input.spreadsheetId != null) setSetting(this.db, "import.fintable.spreadsheet_id", input.spreadsheetId.trim());
    if (input.accountsGid != null) setSetting(this.db, "import.fintable.accounts_gid", input.accountsGid.trim());
    if (input.transactionsGid != null) setSetting(this.db, "import.fintable.transactions_gid", input.transactionsGid.trim());
    return this.getMetadataData();
  }

  getMetadataData(): FinanceMetadataData {
    return buildMetadataData(
      this.db,
      this.dbPath,
      this.forecastConfigPath,
      this.defaultSettings,
      () => this.getSheetInfo(),
      (limit) => this.listImportRunsData(limit),
    );
  }

  simulatePurchaseImpact(input: FinanceWhatIfInput): FinanceWhatIfData {
    return buildSimulatePurchaseImpact(
      this.db,
      this.defaultSettings,
      input,
      () => this.getForecastSummaryData(),
    );
  }

  close() {
    if (this.closed) {
      return;
    }
    this.db.close(false);
    this.closed = true;
  }
}
