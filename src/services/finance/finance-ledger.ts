import type { Database } from "bun:sqlite";
import type {
  FinanceNormalizedTransaction,
} from "./finance-types";
import type {
  SqlValue,
  CategorizationRuleRow,
  FinanceHistoryOptions,
} from "./finance-types";
import {
  clamp,
  normText,
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
  FINAL_COUNTS,
  FINAL_CATEGORY,
} from "./finance-database";

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
