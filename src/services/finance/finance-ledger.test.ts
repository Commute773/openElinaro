import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA } from "./finance-database";
import {
  detectIsCcPayment,
  detectIsTransfer,
  extractMerchant,
  mapPlaidCategory,
  getRules,
  applyRule,
  decideCountsTowardBudget,
  classifyTransaction,
  normalizeTransactionRow,
  buildTransactionFilters,
  mapAccountRow,
  parseJson,
} from "./finance-ledger";

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return db;
}

describe("parseJson", () => {
  test("parses valid JSON string", () => {
    const result = parseJson('{"key": "value"}');
    expect(result).toEqual({ key: "value" });
  });

  test("returns null for invalid JSON", () => {
    expect(parseJson("not json")).toBeNull();
  });

  test("returns null for null input", () => {
    expect(parseJson(null)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseJson("")).toBeNull();
  });

  test("returns object as-is", () => {
    const obj = { test: 1 };
    expect(parseJson(obj)).toBe(obj);
  });

  test("returns null for non-object types", () => {
    expect(parseJson(42)).toBeNull();
  });
});

describe("detectIsCcPayment", () => {
  test("detects credit card payment from description", () => {
    expect(detectIsCcPayment("CREDIT CARD PAYMENT", null)).toBe(true);
  });

  test("detects payment - thank you", () => {
    expect(detectIsCcPayment("Payment - Thank You", null)).toBe(true);
  });

  test("detects from rawJson personal_finance_category", () => {
    const raw = { personal_finance_category: { primary: "CREDIT_CARD" } };
    expect(detectIsCcPayment("some description", raw)).toBe(true);
  });

  test("returns false for regular transaction", () => {
    expect(detectIsCcPayment("Grocery Store Purchase", null)).toBe(false);
  });
});

describe("detectIsTransfer", () => {
  test("detects transfer from description", () => {
    expect(detectIsTransfer("Transfer In from Savings", null)).toBe(true);
  });

  test("detects e-transfer", () => {
    expect(detectIsTransfer("Interac e-Transfer", null)).toBe(true);
  });

  test("detects transfer starting with 'transfer'", () => {
    expect(detectIsTransfer("Transfer to checking", null)).toBe(true);
  });

  test("detects from rawJson category", () => {
    const raw = { personal_finance_category: { primary: "TRANSFER_OUT" } };
    expect(detectIsTransfer("some description", raw)).toBe(true);
  });

  test("returns false for regular transaction", () => {
    expect(detectIsTransfer("Amazon Purchase", null)).toBe(false);
  });
});

describe("extractMerchant", () => {
  test("extracts from rawJson merchant_name", () => {
    const raw = { merchant_name: "Starbucks" };
    expect(extractMerchant("STARBUCKS #12345 - purchase", raw)).toBe("Starbucks");
  });

  test("extracts from counterparties array", () => {
    const raw = { counterparties: [{ name: "Amazon" }] };
    expect(extractMerchant("AMZN Purchase", raw)).toBe("Amazon");
  });

  test("extracts from rawJson name field", () => {
    const raw = { name: "Netflix" };
    expect(extractMerchant("NFLX charge", raw)).toBe("Netflix");
  });

  test("falls back to description before dash", () => {
    expect(extractMerchant("Tim Hortons - Toronto ON", null)).toBe("Tim Hortons");
  });

  test("returns null for long description without dash", () => {
    const longDesc = "A".repeat(50);
    expect(extractMerchant(longDesc, null)).toBeNull();
  });

  test("returns description if under 40 chars and no dash", () => {
    expect(extractMerchant("Short Merchant Name", null)).toBe("Short Merchant Name");
  });
});

describe("mapPlaidCategory", () => {
  test("maps food/grocery category", () => {
    const raw = { personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "FOOD_AND_DRINK_GROCERIES", confidence_level: "HIGH" } };
    const result = mapPlaidCategory(raw);
    expect(result.category).toBe("Food/Groceries");
    expect(result.confidence).toBe(0.85);
  });

  test("maps food/restaurant category", () => {
    const raw = { personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "RESTAURANT", confidence_level: "VERY_HIGH" } };
    const result = mapPlaidCategory(raw);
    expect(result.category).toBe("Food/Restaurant");
  });

  test("maps transfer category", () => {
    const raw = { personal_finance_category: { primary: "TRANSFER_OUT", detailed: "", confidence_level: "HIGH" } };
    const result = mapPlaidCategory(raw);
    expect(result.category).toBe("Transfers/Internal");
  });

  test("maps income category", () => {
    const raw = { personal_finance_category: { primary: "INCOME", detailed: "", confidence_level: "HIGH" } };
    const result = mapPlaidCategory(raw);
    expect(result.category).toBe("Income/Client");
  });

  test("maps entertainment category", () => {
    const raw = { personal_finance_category: { primary: "ENTERTAINMENT", detailed: "", confidence_level: "MEDIUM" } };
    const result = mapPlaidCategory(raw);
    expect(result.category).toBe("Entertainment");
  });

  test("maps rent category", () => {
    const raw = { personal_finance_category: { primary: "RENT_AND_UTILITIES", detailed: "RENT", confidence_level: "HIGH" } };
    const result = mapPlaidCategory(raw);
    expect(result.category).toBe("Housing/Rent");
  });

  test("returns null category for unknown primary", () => {
    const raw = { personal_finance_category: { primary: "UNKNOWN", detailed: "", confidence_level: "LOW" } };
    const result = mapPlaidCategory(raw);
    expect(result.category).toBeNull();
    expect(result.confidence).toBe(0);
  });

  test("handles null rawJson", () => {
    const result = mapPlaidCategory(null);
    expect(result.category).toBeNull();
  });
});

describe("getRules and applyRule", () => {
  test("returns empty array for db without rules", () => {
    const db = createTestDb();
    const rules = getRules(db);
    expect(rules).toHaveLength(0);
    db.close();
  });

  test("applies substring match rule", () => {
    const rules = [
      { id: 1, pattern: "doordash", match_field: "description_raw", category: "Food/Delivery", counts_toward_budget: 1, confidence: 0.95 },
    ];
    const result = applyRule(rules, null, "DOORDASH Order #123", null);
    expect(result.category).toBe("Food/Delivery");
    expect(result.confidence).toBe(0.95);
  });

  test("applies regex match rule", () => {
    const rules = [
      { id: 1, pattern: "re:tim\\s*hortons", match_field: "description_raw", category: "Food/Coffee", counts_toward_budget: 1, confidence: 0.85 },
    ];
    const result = applyRule(rules, null, "Tim Hortons #55", null);
    expect(result.category).toBe("Food/Coffee");
  });

  test("matches against merchant_name field", () => {
    const rules = [
      { id: 1, pattern: "netflix", match_field: "merchant_name", category: "Bills/Subscriptions", counts_toward_budget: 0, confidence: 0.9 },
    ];
    const result = applyRule(rules, "Netflix Inc", "NFLX charge", null);
    expect(result.category).toBe("Bills/Subscriptions");
  });

  test("matches against account_name field", () => {
    const rules = [
      { id: 1, pattern: "savings", match_field: "account_name", category: "Transfers/Internal", counts_toward_budget: null, confidence: 0.8 },
    ];
    const result = applyRule(rules, null, "Transfer", "Savings Account");
    expect(result.category).toBe("Transfers/Internal");
  });

  test("returns null category when no rule matches", () => {
    const rules = [
      { id: 1, pattern: "netflix", match_field: "description_raw", category: "Bills/Subscriptions", counts_toward_budget: 0, confidence: 0.9 },
    ];
    const result = applyRule(rules, null, "Amazon Purchase", null);
    expect(result.category).toBeNull();
    expect(result.confidence).toBe(0);
  });
});

describe("decideCountsTowardBudget", () => {
  test("excludes transfers", () => {
    const result = decideCountsTowardBudget("Transfers/Internal", true, false, null, "Transfer");
    expect(result.counts).toBe(0);
    expect(result.needsReview).toBe(false);
  });

  test("excludes CC payments", () => {
    const result = decideCountsTowardBudget("Uncategorized", false, true, null, "CC Payment");
    expect(result.counts).toBe(0);
  });

  test("excludes essential categories", () => {
    const result = decideCountsTowardBudget("Housing/Rent", false, false, null, "Monthly Rent");
    expect(result.counts).toBe(0);
    expect(result.needsReview).toBe(false);
  });

  test("includes discretionary food", () => {
    const result = decideCountsTowardBudget("Food/Restaurant", false, false, null, "Restaurant meal");
    expect(result.counts).toBe(1);
    expect(result.needsReview).toBe(false);
  });

  test("flags ambiguous merchants for review with non-discretionary category", () => {
    const raw = { merchant_name: "Amazon" };
    // Use a category that is NOT in discretionary prefixes so ambiguous logic is reached
    const result = decideCountsTowardBudget("Health/Pharmacy", false, false, raw, "Amazon purchase");
    expect(result.counts).toBe(1);
    expect(result.needsReview).toBe(true);
    expect(result.reason).toContain("Ambiguous");
  });

  test("flags uncategorized for review", () => {
    const result = decideCountsTowardBudget("Uncategorized", false, false, null, "Unknown charge");
    expect(result.counts).toBe(1);
    expect(result.needsReview).toBe(true);
    expect(result.reason).toContain("Uncategorized");
  });
});

describe("classifyTransaction", () => {
  test("classifies a regular transaction", () => {
    const db = createTestDb();
    const tx = {
      description_raw: "Some Random Store",
      amount: -25,
      currency: "CAD",
    };
    const result = classifyTransaction(db, tx);
    expect(result.categoryAuto).toBeDefined();
    expect(typeof result.needsReview).toBe("boolean");
    db.close();
  });

  test("classifies a transfer", () => {
    const db = createTestDb();
    const tx = {
      description_raw: "Transfer Out to Savings",
      amount: -500,
      currency: "CAD",
    };
    const result = classifyTransaction(db, tx);
    expect(result.isTransfer).toBe(true);
    expect(result.categoryAuto).toBe("Transfers/Internal");
    db.close();
  });

  test("classifies a CC payment", () => {
    const db = createTestDb();
    const tx = {
      description_raw: "Credit Card Payment",
      amount: -1000,
      currency: "CAD",
    };
    const result = classifyTransaction(db, tx);
    expect(result.isCcPayment).toBe(true);
    db.close();
  });

  test("flags non-CAD without amount_cad for review", () => {
    const db = createTestDb();
    const tx = {
      description_raw: "Foreign Purchase",
      amount: -50,
      currency: "USD",
    };
    const result = classifyTransaction(db, tx);
    expect(result.needsReview).toBe(true);
    expect(result.reviewReason).toContain("Non-CAD");
    db.close();
  });

  test("uses categorization rules from db", () => {
    const db = createTestDb();
    db.query(
      `INSERT INTO categorization_rules(pattern, match_field, category, counts_toward_budget, confidence, created_at)
       VALUES(?, ?, ?, ?, ?, ?)`,
    ).run("spotify", "description_raw", "Bills/Subscriptions", 0, 0.95, new Date().toISOString());

    const tx = {
      description_raw: "Spotify Premium",
      amount: -12.99,
      currency: "CAD",
    };
    const result = classifyTransaction(db, tx);
    expect(result.categoryAuto).toBe("Bills/Subscriptions");
    expect(result.countsTowardBudgetAuto).toBe(0);
    db.close();
  });
});

describe("normalizeTransactionRow", () => {
  test("normalizes a basic transaction row", () => {
    const row = {
      id: 1,
      external_id: "ext-1",
      source: "csv",
      account_name: "Chequing",
      posted_date: "2026-03-15",
      amount: -50,
      currency: "CAD",
      amount_cad: -50,
      description_raw: "Store Purchase",
      description_clean: "Store",
      merchant_name: "Store",
      category_auto: "Shopping/General",
      category_auto_confidence: 0.8,
      category_user: null,
      category_final: "Shopping/General",
      counts_toward_budget_auto: 1,
      counts_toward_budget_user: null,
      counts_final: 1,
      needs_review: 0,
      review_reason: null,
      is_transfer: 0,
      is_cc_payment: 0,
      note: null,
      imported_at: "2026-03-15T10:00:00Z",
    };
    const result = normalizeTransactionRow(row);
    expect(result.id).toBe(1);
    expect(result.direction).toBe("debit");
    expect(result.amountCadResolved).toBe(-50);
    expect(result.category.final).toBe("Shopping/General");
    expect(result.countsTowardBudget.final).toBe(true);
    expect(result.review.needsReview).toBe(false);
    expect(result.flags.isTransfer).toBe(false);
  });

  test("sets direction to credit for positive amount", () => {
    const row = {
      id: 2,
      amount: 100,
      currency: "CAD",
      posted_date: "2026-03-15",
      source: "csv",
    };
    const result = normalizeTransactionRow(row);
    expect(result.direction).toBe("credit");
  });

  test("sets direction to zero for zero amount", () => {
    const row = {
      id: 3,
      amount: 0,
      currency: "CAD",
      posted_date: "2026-03-15",
      source: "csv",
    };
    const result = normalizeTransactionRow(row);
    expect(result.direction).toBe("zero");
  });

  test("uses amount_cad for non-CAD resolution", () => {
    const row = {
      id: 4,
      amount: -75,
      currency: "USD",
      amount_cad: -100,
      posted_date: "2026-03-15",
      source: "csv",
    };
    const result = normalizeTransactionRow(row);
    expect(result.amountCadResolved).toBe(-100);
  });

  test("splits review reason into parts", () => {
    const row = {
      id: 5,
      amount: -10,
      currency: "CAD",
      posted_date: "2026-03-15",
      source: "csv",
      needs_review: 1,
      review_reason: "Reason A; Reason B",
    };
    const result = normalizeTransactionRow(row);
    expect(result.review.needsReview).toBe(true);
    expect(result.review.reasonParts).toEqual(["Reason A", "Reason B"]);
  });
});

describe("buildTransactionFilters", () => {
  test("builds filters for month", () => {
    const result = buildTransactionFilters({ month: "2026-03" });
    expect(result.where).toHaveLength(2);
    expect(result.params).toContain("2026-03-01");
    expect(result.params).toContain("2026-04-01");
    expect(result.filters.month).toBe("2026-03");
  });

  test("builds filters for date range", () => {
    const result = buildTransactionFilters({ fromDate: "2026-01-01", toDate: "2026-03-31" });
    expect(result.where).toHaveLength(2);
    expect(result.filters.fromDate).toBe("2026-01-01");
  });

  test("builds filter for account", () => {
    const result = buildTransactionFilters({ account: "Chequing" });
    expect(result.where).toHaveLength(1);
    expect(result.params).toContain("%Chequing%");
  });

  test("builds filter for search", () => {
    const result = buildTransactionFilters({ search: "grocery" });
    expect(result.where).toHaveLength(1);
    // Search produces 5 LIKE params
    expect(result.params).toHaveLength(5);
  });

  test("builds filter for onlyBudget", () => {
    const result = buildTransactionFilters({ onlyBudget: true });
    expect(result.where.length).toBeGreaterThanOrEqual(1);
    expect(result.filters.onlyBudget).toBe(true);
  });

  test("builds filter for onlyReview", () => {
    const result = buildTransactionFilters({ onlyReview: true });
    expect(result.where).toContain("needs_review = 1");
    expect(result.filters.onlyReview).toBe(true);
  });

  test("returns empty filters for no options", () => {
    const result = buildTransactionFilters({});
    expect(result.where).toHaveLength(0);
    expect(result.params).toHaveLength(0);
  });
});

describe("mapAccountRow", () => {
  test("maps account row with CAD balance", () => {
    const row = {
      id: 1,
      external_id: "acc-1",
      name: "Chequing",
      institution: "MyBank",
      currency: "CAD",
      balance: 5000,
      last_update: "2026-03-15",
      updated_at: "2026-03-15T10:00:00Z",
    };
    const result = mapAccountRow(row, 1.365, "liquid");
    expect(result.id).toBe(1);
    expect(result.balance).toBe(5000);
    expect(result.balanceCad).toBe(5000); // CAD so no conversion
    expect(result.classification).toBe("liquid");
  });

  test("converts USD balance to CAD", () => {
    const row = {
      id: 2,
      external_id: "acc-usd",
      name: "US Account",
      currency: "USD",
      balance: 1000,
    };
    const result = mapAccountRow(row, 1.40, "liquid");
    expect(result.balanceCad).toBeCloseTo(1400, 2);
  });

  test("sets classification", () => {
    const row = { id: 3, balance: -1500, currency: "CAD" };
    const result = mapAccountRow(row, 1.365, "debt");
    expect(result.classification).toBe("debt");
  });
});
