import crypto from "node:crypto";
import type { Database } from "bun:sqlite";
import type {
  FinanceNormalizedTransaction,
  FinanceCategoryAggregateData,
  FinanceCategoryAggregatesData,
  FinanceAccountsLiquidityData,
  FinanceTransactionsData,
  FinanceReviewQueueData,
  FinanceFxEventData,
  FinanceFxInfoData,
  FinanceCategorizeDecision,
  FinanceAddExpenseInput,
} from "./finance-types";
import type {
  SqlValue,
  CategorizationRuleRow,
  FinanceHistoryOptions,
} from "./finance-types";
import {
  clamp,
  normText,
  formatCad,
  formatMoney,
  heading,
  toIsoDate,
  toIsoMonth,
  startEndForMonth,
  stringOrNull,
  numberOrNull,
  booleanOrNull,
  rawCategoryFromJson,
  toCad,
} from "./finance-helpers";
import {
  allRows,
  getRow,
  run,
  getFxRate,
  FINAL_COUNTS,
  FINAL_CATEGORY,
} from "./finance-database";
import { loadAccountBalances } from "./finance-forecasting";
import { timestamp as nowIso } from "../../utils/timestamp";

export function detectIsCcPayment(descriptionRaw: string, rawJson: Record<string, unknown> | null) {
  const description = normText(descriptionRaw);
  if (description.includes("credit card payment") || description.includes("payment - thank you")) {
    return true;
  }
  const primary = String((rawJson?.personal_finance_category as Record<string, unknown> | undefined)?.primary ?? "");
  return primary.toUpperCase().includes("CREDIT_CARD");
}

export function detectIsTransfer(descriptionRaw: string, rawJson: Record<string, unknown> | null) {
  const description = normText(descriptionRaw);
  const primary = normText(String((rawJson?.personal_finance_category as Record<string, unknown> | undefined)?.primary ?? ""));
  if (primary.includes("transfer")) {
    return true;
  }
  return ["transfer in", "transfer out", "etransfer", "e-transfer"].some((keyword) => description.includes(keyword))
    || description.startsWith("transfer");
}

export function extractMerchant(descriptionRaw: string, rawJson: Record<string, unknown> | null) {
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

export function mapPlaidCategory(rawJson: Record<string, unknown> | null) {
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

export function getRules(db: Database) {
  return allRows<CategorizationRuleRow>(
    db,
    `SELECT id, pattern, match_field, category, counts_toward_budget, confidence
      FROM categorization_rules
      ORDER BY confidence DESC, id ASC`,
  );
}

export function applyRule(rules: CategorizationRuleRow[], merchantName: string | null, descriptionRaw: string, accountName: string | null) {
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

export function decideCountsTowardBudget(
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
  const merchant = normText(extractMerchant(descriptionRaw, rawJson) ?? "");
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

export function classifyTransaction(db: Database, tx: Record<string, unknown>) {
  const rawJson = parseJson(tx.raw_json);
  const descriptionRaw = String(tx.description_raw ?? "");
  const isCcPayment = detectIsCcPayment(descriptionRaw, rawJson);
  const isTransfer = detectIsTransfer(descriptionRaw, rawJson);
  const merchantName = typeof tx.merchant_name === "string" && tx.merchant_name.trim()
    ? tx.merchant_name.trim()
    : extractMerchant(descriptionRaw, rawJson);
  const rules = getRules(db);
  const ruleMatch = applyRule(rules, merchantName, descriptionRaw, typeof tx.account_name === "string" ? tx.account_name : null);
  let categoryAuto = ruleMatch.category;
  let categoryConfidence = ruleMatch.confidence;
  const ruleCounts = ruleMatch.counts;
  let ambiguous = categoryAuto ? categoryConfidence < 0.7 : false;
  if (!categoryAuto) {
    const plaid = mapPlaidCategory(rawJson);
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
    const decision = decideCountsTowardBudget(
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

export function normalizeTransactionRow(row: Record<string, unknown>): FinanceNormalizedTransaction {
  const rawJson = parseJson(row.raw_json);
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

export function buildTransactionFilters(options: FinanceHistoryOptions) {
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

export function mapAccountRow(
  row: Record<string, unknown>,
  fxRate: number,
  classification: 'liquid' | 'registered' | 'debt',
) {
  const balance = Number(row.balance ?? 0);
  return {
    id: Number(row.id ?? 0),
    externalId: stringOrNull(row.external_id),
    name: String(row.name ?? ''),
    institution: stringOrNull(row.institution),
    currency: String(row.currency ?? 'CAD').toUpperCase(),
    balance,
    balanceCad: toCad(balance, String(row.currency ?? 'CAD').toUpperCase(), fxRate),
    classification,
    lastUpdate: stringOrNull(row.last_update),
    updatedAt: stringOrNull(row.updated_at),
  };
}

export function parseJson(value: unknown) {
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

export function buildCategoryAggregatesData(db: Database, options: FinanceHistoryOptions = {}): FinanceCategoryAggregatesData {
  const { where, params, filters } = buildTransactionFilters(options);
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const groups = allRows<Record<string, unknown>>(
    db,
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
    db,
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
    db,
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
  }));
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

export function buildAccountsLiquidityData(db: Database, defaultSettings: Record<string, string>): FinanceAccountsLiquidityData {
  const fxRate = getFxRate(db, defaultSettings);
  const balances = loadAccountBalances(db);
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

export function buildTransactionsData(db: Database, options: FinanceHistoryOptions = {}): FinanceTransactionsData {
  const limit = clamp(options.limit ?? 50, 1, 250);
  const { where, params, filters } = buildTransactionFilters(options);
  const total = Number(getRow<{ count: number }>(
    db,
    `SELECT COUNT(1) AS count FROM transactions ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}`,
    ...params,
  )?.count ?? 0);
  const rows = allRows<Record<string, unknown>>(
    db,
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

export function buildReviewQueueData(db: Database, limit = 10): FinanceReviewQueueData {
  const structured = buildTransactionsData(db, { onlyReview: true, limit });
  const reasonBreakdown = allRows<Record<string, unknown>>(
    db,
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
    db,
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

export function categorizeTransactions(db: Database, decisions: FinanceCategorizeDecision[]) {
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
        db,
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
        db,
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
  const remaining = Number(getRow<{ count: number }>(db, "SELECT COUNT(1) AS count FROM transactions WHERE needs_review = 1")?.count ?? 0);
  return { updated, remainingReview: remaining };
}

export function addExpenseTransaction(db: Database, input: FinanceAddExpenseInput) {
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
  const auto = classifyTransaction(db, base);
  run(
    db,
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
  const row = getRow<{ id: number }>(db, "SELECT last_insert_rowid() AS id");
  return { status: "added" as const, id: Number(row?.id ?? 0), externalId };
}

export function renderHistoryText(db: Database, options: FinanceHistoryOptions = {}) {
  const limit = clamp(options.limit ?? 50, 1, 200);
  const { where, params } = buildTransactionFilters(options);
  const rows = allRows<Record<string, unknown>>(
    db,
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

export function renderReviewQueueText(db: Database, limit = 10) {
  const rows = allRows<Record<string, unknown>>(
    db,
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

export function buildFxInfoData(db: Database, defaultSettings: Record<string, string>): FinanceFxInfoData {
  const events: FinanceFxEventData[] = allRows<Record<string, unknown>>(
    db,
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
    activeRate: getFxRate(db, defaultSettings),
    pair: 'USD/CAD',
    settingsKey: 'fx.usdcad',
    latestEvent: events[0] ?? null,
    events,
    note: 'Forecast planning uses settings.fx.usdcad; fx_events are a historical ledger and audit trail.',
  };
}
