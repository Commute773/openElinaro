import crypto from "node:crypto";
import type { Database } from "bun:sqlite";
import { getRuntimeConfig } from "../../config/runtime-config";
import {
  DEFAULT_FINANCE,
  DEFAULT_FINANCE_SETTINGS,
  type FinanceForecastConfig,
} from "../../config/finance-config";
import type {
  FinanceAccountsLiquidityData,
  FinanceBudgetHistoryData,
  FinanceBudgetSnapshotData,
  FinanceCashflowMonthData,
  FinanceCategoryAggregateData,
  FinanceCategoryAggregatesData,
  FinanceDashboardHorizonPlanData,
  FinanceDashboardSignalsData,
  FinanceForecastCashflowData,
  FinanceForecastSummaryData,
  FinanceFxEventData,
  FinanceFxInfoData,
  FinanceImportRunsData,
  FinanceIncomeSourceRowData,
  FinanceIncomeSourcesData,
  FinanceMetadataData,
  FinanceNormalizedTransaction,
  FinanceOverviewData,
  FinancePayablesData,
  FinanceReceivablesData,
  FinanceRecurringData,
  FinanceReviewQueueData,
  FinanceSheetInfoData,
  FinanceTaxProjectionData,
  FinanceTimelineAggregateData,
  FinanceTransactionsData,
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
  RecurringRecord,
} from "./finance-types";

import {
  clamp,
  finiteNumber,
  formatCad,
  formatMoney,
  heading,
  dateKey,
  toIsoDate,
  toIsoMonth,
  addDays,
  daysBetween,
  addMonths,
  startEndForMonth,
  defaultGraceDays,
  stringOrNull,
  numberOrNull,
  resolveConfiguredFinancePath,
  toCad,
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
  FINAL_COUNTS,
  FINAL_CATEGORY,
} from "./finance-database";

import {
  classifyTransaction,
  normalizeTransactionRow,
  buildTransactionFilters,
  mapAccountRow,
} from "./finance-ledger";

import {
  calcAnnualTax,
  buildForecastSummaryData,
  buildForecastCashflowData,
  buildTaxProjectionData,
  buildForecastScenario,
  addCumulativeCashflow,
  buildCashflow,
  computeRunwayMonths,
  proratedForecastMonthValue,
  projectAnnualIncome,
  calcTaxRateForMonth,
  renderForecastSummary,
  renderCashflow,
  renderAr,
  renderAp,
  loadIncomeSources,
  loadRecurringExpenses,
  loadPayables,
  loadReceivables,
  loadAccountBalances,
} from "./finance-forecasting";

import {
  computeSpendStats,
  computeWeeklyBudget,
  computeMonthlyBudget,
  renderBudgetBlock,
  resolveBudgetSnapshot,
  describeBudgetPace,
} from "./finance-budget";

import {
  detectRecurringCandidates,
  refreshRecurringRules,
  getRecurringCandidatesData,
  assertRecurringInput,
  renderRecurringList,
  mapRecurringRow,
  mapImportRunRow,
  sumRecurringOutflowsWithinHorizon,
} from "./finance-recurring";

import {
  parseCsvText,
  fetchText,
  sheetCsvUrl,
  upsertAccount,
  upsertTransaction,
  upsertSyntheticIncomeTransaction,
  clearMatchingPendingReceivables,
} from "./finance-import";

import {
  buildDashboardCategoryDeltas,
  buildDashboardAlerts,
  buildDashboardReminders,
  findTaxAccountBalanceCad,
  isTaxCategory,
  computeIncomeImportSanity,
  receivableNextAction,
  mapReceivableRow,
  mapPayableRow,
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
    const spreadsheetId = getSettingOrDefault(this.db, "import.fintable.spreadsheet_id", this.defaultSettings);
    const accountsGid = getSettingOrDefault(this.db, "import.fintable.accounts_gid", this.defaultSettings);
    const transactionsGid = getSettingOrDefault(this.db, "import.fintable.transactions_gid", this.defaultSettings);
    return {
      spreadsheetId,
      accountsGid,
      transactionsGid,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${transactionsGid}`,
      accountsCsvUrl: sheetCsvUrl(spreadsheetId, accountsGid),
      transactionsCsvUrl: sheetCsvUrl(spreadsheetId, transactionsGid),
    };
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
    const today = dateKey(reference);
    const weeklyStart = toIsoDate(getSettingOrDefault(this.db, "budget.weekly_start_date", this.defaultSettings));
    const weeklyLimit = getNumericSettingOrDefault(this.db, "budget.weekly_limit_cad", this.defaultSettings);
    let output = "";

    if (today >= weeklyStart) {
      const budget = computeWeeklyBudget(this.db, today, weeklyLimit, weeklyStart);
      output += `${heading("Budget")}\n${renderBudgetBlock(this.db, budget, this.defaultSettings)}\n`;
      const recent = allRows<Record<string, unknown>>(
        this.db,
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

    const reviewCount = Number(getRow<{ count: number }>(this.db, "SELECT COUNT(1) AS count FROM transactions WHERE needs_review = 1")?.count ?? 0);
    const reviewRows = allRows<Record<string, unknown>>(
      this.db,
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
      this.db,
      "SELECT counterparty, amount_cad, expected_date, status FROM receivables WHERE status <> 'received' AND expected_date < ? ORDER BY expected_date",
      today,
    );
    const dueSoon = allRows<Record<string, unknown>>(
      this.db,
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
      setSetting(this.db, "budget.weekly_limit_cad", String(options.weeklyLimit));
    }
    const today = options?.date ? toIsoDate(options.date) : dateKey(new Date());
    const budget = resolveBudgetSnapshot(this.db, today, this.defaultSettings);
    return renderBudgetBlock(this.db, budget, this.defaultSettings);
  }

  history(options: FinanceHistoryOptions = {}) {
    const limit = clamp(options.limit ?? 50, 1, 200);
    const { where, params } = buildTransactionFilters(options);
    const rows = allRows<Record<string, unknown>>(
      this.db,
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
    const rows = allRows<Record<string, unknown>>(
      this.db,
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
        const result = run(
          this.db,
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
        const result = run(
          this.db,
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
    const remaining = Number(getRow<{ count: number }>(this.db, "SELECT COUNT(1) AS count FROM transactions WHERE needs_review = 1")?.count ?? 0);
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
    const auto = classifyTransaction(this.db, base);
    run(
      this.db,
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
    const row = getRow<{ id: number }>(this.db, "SELECT last_insert_rowid() AS id");
    return { status: "added", id: Number(row?.id ?? 0), externalId };
  }

  async importTransactions(options: FinanceImportOptions = {}) {
    const source = options.source ?? "fintable_gsheet";
    const dryRun = options.dryRun === true;
    const importRun = run(
      this.db,
      "INSERT INTO import_runs(source, started_at, rows_seen, rows_inserted, rows_updated) VALUES(?, ?, 0, 0, 0)",
      source,
      nowIso(),
    );
    const runId = Number(importRun.lastInsertRowid ?? getRow<{ id: number }>(this.db, "SELECT last_insert_rowid() AS id")?.id ?? 0);
    let rowsSeen = 0;
    let rowsInserted = 0;
    let rowsUpdated = 0;

    try {
      if (source === "fintable_gsheet") {
        const spreadsheetId = options.spreadsheetId ?? getSettingOrDefault(this.db, "import.fintable.spreadsheet_id", this.defaultSettings);
        const accountsGid = options.accountsGid ?? getSettingOrDefault(this.db, "import.fintable.accounts_gid", this.defaultSettings);
        const transactionsGid = options.transactionsGid ?? getSettingOrDefault(this.db, "import.fintable.transactions_gid", this.defaultSettings);
        if (!spreadsheetId || !accountsGid || !transactionsGid) {
          throw new Error("Missing Fintable sheet settings.");
        }
        const [accountsCsv, transactionsCsv] = await Promise.all([
          this.fetchText(sheetCsvUrl(spreadsheetId, accountsGid)),
          this.fetchText(sheetCsvUrl(spreadsheetId, transactionsGid)),
        ]);
        const accounts = parseCsvText(accountsCsv);
        const transactions = parseCsvText(transactionsCsv);
        rowsSeen = transactions.length;
        if (!dryRun) {
          for (const account of accounts) {
            upsertAccount(this.db, account, { importRunId: runId, source }, (id, opts) => this.markReceivableReceived(id, opts));
          }
          for (const row of transactions) {
            const result = upsertTransaction(this.db, row, "fintable_gsheet");
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
        const rows = parseCsvText(csvText);
        rowsSeen = rows.length;
        if (!dryRun) {
          for (const row of rows) {
            const result = upsertTransaction(this.db, row, "csv_upload");
            if (result.inserted) {
              rowsInserted += 1;
            }
            if (result.updated) {
              rowsUpdated += 1;
            }
          }
        }
      }

      run(
        this.db,
        "UPDATE import_runs SET finished_at = ?, rows_seen = ?, rows_inserted = ?, rows_updated = ? WHERE id = ?",
        nowIso(),
        rowsSeen,
        rowsInserted,
        rowsUpdated,
        runId,
      );
      const reviewTop = allRows<Record<string, unknown>>(
        this.db,
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
      run(
        this.db,
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
    assertRecurringInput({
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
    const result = run(
      this.db,
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
      input.graceDays ?? defaultGraceDays(input.intervalKind ?? "monthly"),
      input.notes ?? null,
      nowIso(),
      nowIso(),
    );
    return { status: "added", id: Number(result.lastInsertRowid ?? 0) };
  }

  setRecurring(input: FinanceSetRecurringInput) {
    if (input.id != null) {
      const existing = getRow<RecurringRecord>(this.db, "SELECT * FROM recurring WHERE id = ?", input.id);
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
      assertRecurringInput({
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
      run(
        this.db,
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
    const dateIso = options?.date ? toIsoDate(options.date) : dateKey(new Date());
    const periods = clamp(options?.periods ?? 12, 1, 104);
    const current = resolveBudgetSnapshot(this.db, dateIso, this.defaultSettings);
    if (current.mode === 'week') {
      const weeklyStart = toIsoDate(getSettingOrDefault(this.db, "budget.weekly_start_date", this.defaultSettings));
      const rows = [] as FinanceBudgetHistoryData['rows'];
      for (let offset = periods - 1; offset >= 0; offset -= 1) {
        const weekDate = addDays(current.weekStart, -7 * offset);
        if (weekDate < weeklyStart) {
          continue;
        }
        const snapshot = resolveBudgetSnapshot(this.db, weekDate, this.defaultSettings);
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
      const snapshot = resolveBudgetSnapshot(this.db, addDays(startEndForMonth(monthDate.slice(0, 7)).toExclusive, -1), this.defaultSettings);
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
    const budget = resolveBudgetSnapshot(this.db, referenceDate, this.defaultSettings);
    const accounts = this.getAccountsLiquidityData();
    const receivables = this.getReceivablesData({ today: referenceDate });
    const payables = this.getPayablesData({ today: referenceDate });
    const reviewCount = Number(getRow<{ count: number }>(this.db, "SELECT COUNT(1) AS count FROM transactions WHERE needs_review = 1")?.count ?? 0);
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
    const taxAccountBalanceCadVal = finiteNumber(findTaxAccountBalanceCad(this.db, this.defaultSettings, () => this.getAccountsLiquidityData()));
    const dueNowCad = payables.rows
      .filter((row) => row.status !== "paid" && isTaxCategory(row.category))
      .reduce((sum, row) => sum + finiteNumber(row.convertedCad), 0);
    const fxRate = getFxRate(this.db, this.defaultSettings);
    const incomeSanity = computeIncomeImportSanity(this.db, referenceDate, fxRate, () => loadIncomeSources(this.db));
    const taxProjection = this.getTaxProjectionData();
    const estimatedTaxRateOnReceivedIncome = finiteNumber(taxProjection.conservative.currentRate.rate);
    const estimatedTaxOnReceivedIncomeCad = finiteNumber(
      finiteNumber(incomeSanity.clientIncomeReceivedYtdCad) * estimatedTaxRateOnReceivedIncome,
    );
    const estimatedTaxShortfallCad = finiteNumber(Math.max(estimatedTaxOnReceivedIncomeCad - taxAccountBalanceCadVal, 0));
    const cashflow = this.getForecastCashflowData();
    const next30Days = this.buildDashboardHorizonPlanInternal({
      referenceDate,
      horizonDays: 30,
      startingCashCad: overview.netLiquidCad,
      taxReserveCad: estimatedTaxOnReceivedIncomeCad,
      currentTaxBackpayCad: estimatedTaxShortfallCad,
      taxAccountBalanceCad: taxAccountBalanceCadVal,
      receivables,
      payables,
      recurring,
      forecastMonths: cashflow.conservative,
    });
    const next60Days = this.buildDashboardHorizonPlanInternal({
      referenceDate,
      horizonDays: 60,
      startingCashCad: overview.netLiquidCad,
      taxReserveCad: estimatedTaxOnReceivedIncomeCad,
      currentTaxBackpayCad: estimatedTaxShortfallCad,
      taxAccountBalanceCad: taxAccountBalanceCadVal,
      receivables,
      payables,
      recurring,
      forecastMonths: cashflow.conservative,
    });
    const yearEnd = `${referenceDate.slice(0, 4)}-12-31`;
    const endOfYear = this.buildDashboardHorizonPlanInternal({
      referenceDate,
      horizonDays: Math.max(0, daysBetween(referenceDate, yearEnd)),
      startingCashCad: overview.netLiquidCad,
      taxReserveCad: estimatedTaxOnReceivedIncomeCad,
      currentTaxBackpayCad: estimatedTaxShortfallCad,
      taxAccountBalanceCad: taxAccountBalanceCadVal,
      receivables,
      payables,
      recurring,
      forecastMonths: cashflow.conservative,
    });
    const endOfYearOptimistic = this.buildDashboardHorizonPlanInternal({
      referenceDate,
      horizonDays: Math.max(0, daysBetween(referenceDate, yearEnd)),
      startingCashCad: overview.netLiquidCad,
      taxReserveCad: estimatedTaxOnReceivedIncomeCad,
      currentTaxBackpayCad: estimatedTaxShortfallCad,
      taxAccountBalanceCad: taxAccountBalanceCadVal,
      receivables,
      payables,
      recurring,
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

  listTransactionsStructured(options: FinanceHistoryOptions = {}): FinanceTransactionsData {
    const limit = clamp(options.limit ?? 50, 1, 250);
    const { where, params, filters } = buildTransactionFilters(options);
    const total = Number(getRow<{ count: number }>(
      this.db,
      `SELECT COUNT(1) AS count FROM transactions ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}`,
      ...params,
    )?.count ?? 0);
    const rows = allRows<Record<string, unknown>>(
      this.db,
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
      rows: rows.map((row) => normalizeTransactionRow(row)),
    };
  }

  getReviewQueueData(limit = 10): FinanceReviewQueueData {
    const structured = this.listTransactionsStructured({ onlyReview: true, limit });
    const reasonBreakdown = allRows<Record<string, unknown>>(
      this.db,
      `SELECT COALESCE(review_reason, 'Unknown') AS reason, COUNT(1) AS count
        FROM transactions
        WHERE needs_review = 1
        GROUP BY COALESCE(review_reason, 'Unknown')
        ORDER BY count DESC, reason ASC`,
    ).map((row) => ({
      reason: String(row.reason ?? 'Unknown'),
      count: Number(row.count ?? 0),
    }));
    const categoryBreakdown = allRows<Record<string, unknown>>(
      this.db,
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
    const { where, params, filters } = buildTransactionFilters(options);
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const groups = allRows<Record<string, unknown>>(
      this.db,
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
    const merchants = allRows<Record<string, unknown>>(
      this.db,
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
    const timeline = allRows<Record<string, unknown>>(
      this.db,
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
    const fxRate = getFxRate(this.db, this.defaultSettings);
    const balances = loadAccountBalances(this.db);
    const accounts = [
      ...balances.liquid.map((row) => mapAccountRow(row, fxRate, 'liquid')),
      ...balances.registered.map((row) => mapAccountRow(row, fxRate, 'registered')),
      ...balances.debt.map((row) => mapAccountRow(row, fxRate, 'debt')),
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
    const fxRate = getFxRate(this.db, this.defaultSettings);
    const rows = loadReceivables(this.db, options?.status).map((row) => mapReceivableRow(row, today, fxRate));
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
    const fxRate = getFxRate(this.db, this.defaultSettings);
    const rows = loadPayables(this.db, options?.status ?? 'pending').map((row) => mapPayableRow(row, today, fxRate));
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
      ? refreshRecurringRules(this.db, today, !(options?.noAutoSeed ?? false), options?.seedLimit ?? 12)
      : null;
    const rows = allRows<RecurringRecord>(
      this.db,
      'SELECT * FROM recurring ORDER BY status ASC, next_expected_date ASC, id ASC',
    ).map((row) => mapRecurringRow(row, today));
    return {
      today,
      totalMonthlyCad: rows.filter((row) => row.status === 'active').reduce((sum, row) => sum + row.monthlyCad, 0),
      active: rows.filter((row) => row.status === 'active'),
      halted: rows.filter((row) => row.status === 'halted'),
      rows,
      candidates: getRecurringCandidatesData(this.db, { today, includeKnown: false, maxAgeDays: 365 }),
      refresh: refreshResult
        ? {
            seeded: refreshResult.seeded.map((row) => mapRecurringRow(row, today)),
            active: refreshResult.active.map((row) => mapRecurringRow(row, today)),
            halted: refreshResult.halted.map((row) => mapRecurringRow(row, today)),
          }
        : null,
    };
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
    const fxRate = getFxRate(this.db, this.defaultSettings);
    const sources = loadIncomeSources(this.db);
    const conservativeProjection = projectAnnualIncome(sources, fxRate, false);
    const optimisticProjection = projectAnnualIncome(sources, fxRate, true);
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
        annualCadConservative: toCad(annualOrigConservative, String(source.currency ?? 'USD'), fxRate),
        annualCadOptimistic: toCad(annualOrigOptimistic, String(source.currency ?? 'USD'), fxRate),
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
    const events = allRows<Record<string, unknown>>(
      this.db,
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
      activeRate: getFxRate(this.db, this.defaultSettings),
      pair: 'USD/CAD',
      settingsKey: 'fx.usdcad',
      latestEvent: events[0] ?? null,
      events,
      note: 'Forecast planning uses settings.fx.usdcad; fx_events are a historical ledger and audit trail.',
    };
  }

  listImportRunsData(limit = 20): FinanceImportRunsData {
    const clampedLimit = clamp(limit, 1, 100);
    const rows = allRows<Record<string, unknown>>(
      this.db,
      'SELECT * FROM import_runs ORDER BY started_at DESC, id DESC LIMIT ?',
      clampedLimit,
    ).map((row) => mapImportRunRow(row));
    const bySource = allRows<Record<string, unknown>>(
      this.db,
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
    const config = loadForecastConfig(this.forecastConfigPath);
    const tableNames = ['settings', 'accounts', 'account_balance_snapshots', 'transactions', 'categorization_rules', 'receivables', 'import_runs', 'recurring', 'payables', 'income_sources', 'fx_events'] as const;
    const tableCounts = tableNames.map((table) => ({
      table,
      count: Number(getRow<{ count: number }>(this.db, `SELECT COUNT(1) AS count FROM ${table}`)?.count ?? 0),
    }));
    const transactionSourceCounts = allRows<Record<string, unknown>>(
      this.db,
      'SELECT source, COUNT(1) AS count FROM transactions GROUP BY source ORDER BY source ASC',
    ).map((row) => ({
      source: String(row.source ?? ''),
      count: Number(row.count ?? 0),
    }));
    const finalBudgetCountBreakdown = allRows<Record<string, unknown>>(
      this.db,
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
        timezone: getSettingOrDefault(this.db, "timezone", this.defaultSettings),
        weeklyLimitCad: getNumericSettingOrDefault(this.db, "budget.weekly_limit_cad", this.defaultSettings),
        monthlyLimitCad: getNumericSettingOrDefault(this.db, "budget.monthly_limit_cad", this.defaultSettings),
        weeklyStartDate: getSettingOrDefault(this.db, "budget.weekly_start_date", this.defaultSettings),
        fxUsdCad: getFxRate(this.db, this.defaultSettings),
      },
      reviewCount: Number(getRow<{ count: number }>(this.db, 'SELECT COUNT(1) AS count FROM transactions WHERE needs_review = 1')?.count ?? 0),
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
    const budget = resolveBudgetSnapshot(this.db, referenceDate, this.defaultSettings);
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
        conservativeRunwayMonthsAfter: computeRunwayMonths(summary.standing.netLiquidCad - input.purchaseAmountCad, summary.scenarios.conservative.monthlyBurnCad),
        optimisticRunwayMonthsBefore: summary.scenarios.optimistic.runwayMonths,
        optimisticRunwayMonthsAfter: computeRunwayMonths(summary.standing.netLiquidCad - input.purchaseAmountCad, summary.scenarios.optimistic.monthlyBurnCad),
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

  private async fetchText(url: string) {
    return fetchText(url);
  }

  private resolveReferenceDate(reference: Date | string) {
    return typeof reference === 'string' ? toIsoDate(reference) : dateKey(reference);
  }

  private buildDashboardHorizonPlanInternal(input: {
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
}
