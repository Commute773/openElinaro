import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  SCHEMA,
  DEFAULT_RULES,
  FINAL_COUNTS,
  FINAL_CATEGORY,
  allRows,
  getRow,
  run,
  migrateReceivables,
  migrateRecurring,
  seedDefaults,
  ensureForecastConfig,
  loadForecastConfig,
  getSetting,
  getSettingOrDefault,
  getNumericSettingOrDefault,
  setSetting,
  getFxRate,
} from "./finance-database";
import { DEFAULT_FINANCE_SETTINGS } from "../../config/finance-config";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA);
});

afterEach(() => {
  db.close();
});

describe("SCHEMA", () => {
  test("creates all expected tables", () => {
    const tables = allRows<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).map((r) => r.name);
    expect(tables).toContain("settings");
    expect(tables).toContain("accounts");
    expect(tables).toContain("account_balance_snapshots");
    expect(tables).toContain("transactions");
    expect(tables).toContain("categorization_rules");
    expect(tables).toContain("receivables");
    expect(tables).toContain("import_runs");
    expect(tables).toContain("recurring");
    expect(tables).toContain("payables");
    expect(tables).toContain("income_sources");
    expect(tables).toContain("fx_events");
  });

  test("creates expected indexes", () => {
    const indexes = allRows<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).map((r) => r.name);
    expect(indexes).toContain("transactions_posted_date");
    expect(indexes).toContain("transactions_needs_review");
    expect(indexes).toContain("recurring_unique");
    expect(indexes).toContain("recurring_status");
    expect(indexes).toContain("payables_due_date");
    expect(indexes).toContain("payables_status");
  });
});

describe("allRows", () => {
  test("returns empty array for no results", () => {
    const rows = allRows<{ key: string }>(db, "SELECT * FROM settings");
    expect(rows).toEqual([]);
  });

  test("returns matching rows", () => {
    run(db, "INSERT INTO settings(key, value) VALUES(?, ?)", "a", "1");
    run(db, "INSERT INTO settings(key, value) VALUES(?, ?)", "b", "2");
    const rows = allRows<{ key: string; value: string }>(db, "SELECT * FROM settings ORDER BY key");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.key).toBe("a");
    expect(rows[1]?.key).toBe("b");
  });
});

describe("getRow", () => {
  test("returns null for no match", () => {
    const row = getRow<{ value: string }>(db, "SELECT value FROM settings WHERE key = ?", "missing");
    expect(row).toBeNull();
  });

  test("returns matching row", () => {
    run(db, "INSERT INTO settings(key, value) VALUES(?, ?)", "test", "42");
    const row = getRow<{ value: string }>(db, "SELECT value FROM settings WHERE key = ?", "test");
    expect(row?.value).toBe("42");
  });
});

describe("run", () => {
  test("inserts rows", () => {
    run(db, "INSERT INTO settings(key, value) VALUES(?, ?)", "k", "v");
    const row = getRow<{ value: string }>(db, "SELECT value FROM settings WHERE key = ?", "k");
    expect(row?.value).toBe("v");
  });

  test("updates rows", () => {
    run(db, "INSERT INTO settings(key, value) VALUES(?, ?)", "k", "v1");
    run(db, "UPDATE settings SET value = ? WHERE key = ?", "v2", "k");
    const row = getRow<{ value: string }>(db, "SELECT value FROM settings WHERE key = ?", "k");
    expect(row?.value).toBe("v2");
  });
});

describe("seedDefaults", () => {
  test("inserts default settings", () => {
    seedDefaults(db, { "budget.monthly_limit_cad": "500" });
    const row = getRow<{ value: string }>(db, "SELECT value FROM settings WHERE key = ?", "budget.monthly_limit_cad");
    expect(row?.value).toBe("500");
  });

  test("does not overwrite existing settings", () => {
    run(db, "INSERT INTO settings(key, value) VALUES(?, ?)", "budget.monthly_limit_cad", "999");
    seedDefaults(db, { "budget.monthly_limit_cad": "500" });
    const row = getRow<{ value: string }>(db, "SELECT value FROM settings WHERE key = ?", "budget.monthly_limit_cad");
    expect(row?.value).toBe("999");
  });

  test("inserts default categorization rules", () => {
    seedDefaults(db, {});
    const rules = allRows<{ pattern: string; category: string }>(
      db,
      "SELECT pattern, category FROM categorization_rules",
    );
    expect(rules.length).toBe(DEFAULT_RULES.length);
    expect(rules.some((r) => r.pattern === "doordash")).toBe(true);
    expect(rules.some((r) => r.category === "Food/Delivery")).toBe(true);
  });

  test("does not duplicate rules on re-seed", () => {
    seedDefaults(db, {});
    seedDefaults(db, {});
    const rules = allRows<{ id: number }>(db, "SELECT id FROM categorization_rules");
    expect(rules.length).toBe(DEFAULT_RULES.length);
  });
});

describe("getSetting / setSetting", () => {
  test("getSetting returns null for missing key", () => {
    expect(getSetting(db, "nope")).toBeNull();
  });

  test("setSetting inserts and getSetting retrieves", () => {
    setSetting(db, "myKey", "myValue");
    expect(getSetting(db, "myKey")).toBe("myValue");
  });

  test("setSetting upserts on conflict", () => {
    setSetting(db, "k", "v1");
    setSetting(db, "k", "v2");
    expect(getSetting(db, "k")).toBe("v2");
  });
});

describe("getSettingOrDefault", () => {
  test("returns DB value when present", () => {
    setSetting(db, "key1", "fromDb");
    expect(getSettingOrDefault(db, "key1", {})).toBe("fromDb");
  });

  test("falls back to provided defaults", () => {
    expect(getSettingOrDefault(db, "key1", { key1: "fromDefaults" })).toBe("fromDefaults");
  });

  test("falls back to DEFAULT_FINANCE_SETTINGS", () => {
    expect(getSettingOrDefault(db, "fx.usdcad", {})).toBe(DEFAULT_FINANCE_SETTINGS["fx.usdcad"]!);
  });

  test("returns empty string as last resort", () => {
    expect(getSettingOrDefault(db, "nonexistent", {})).toBe("");
  });
});

describe("getNumericSettingOrDefault", () => {
  test("returns parsed number from setting", () => {
    setSetting(db, "limit", "123.45");
    expect(getNumericSettingOrDefault(db, "limit", {})).toBeCloseTo(123.45);
  });

  test("returns 0 for non-numeric values", () => {
    setSetting(db, "bad", "abc");
    expect(getNumericSettingOrDefault(db, "bad", {})).toBe(0);
  });

  test("uses default when key missing", () => {
    expect(getNumericSettingOrDefault(db, "fx.usdcad", {})).toBeCloseTo(1.365);
  });
});

describe("getFxRate", () => {
  test("returns rate from settings", () => {
    setSetting(db, "fx.usdcad", "1.40");
    expect(getFxRate(db, {})).toBeCloseTo(1.4);
  });

  test("falls back to default", () => {
    expect(getFxRate(db, DEFAULT_FINANCE_SETTINGS)).toBeCloseTo(1.365);
  });
});

describe("migrateReceivables", () => {
  test("adds missing columns idempotently", () => {
    // Schema already has these columns; run migration anyway to verify no error
    migrateReceivables(db);
    migrateReceivables(db);
    const columns = allRows<{ name: string }>(db, "PRAGMA table_info(receivables)").map((r) => r.name);
    expect(columns).toContain("currency");
    expect(columns).toContain("amount");
  });
});

describe("migrateRecurring", () => {
  test("runs idempotently without error", () => {
    migrateRecurring(db);
    migrateRecurring(db);
    const columns = allRows<{ name: string }>(db, "PRAGMA table_info(recurring)").map((r) => r.name);
    expect(columns).toContain("amount_tolerance_cad");
  });
});

describe("FINAL_COUNTS and FINAL_CATEGORY expressions", () => {
  test("FINAL_COUNTS resolves in SQL context", () => {
    run(
      db,
      `INSERT INTO transactions(external_id, source, posted_date, amount, currency, imported_at, counts_toward_budget_user)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
      "tx1", "test", "2026-03-01", -50, "CAD", "2026-03-01T00:00:00Z", 1,
    );
    const row = getRow<{ counts: number }>(
      db,
      `SELECT ${FINAL_COUNTS} AS counts FROM transactions WHERE external_id = ?`,
      "tx1",
    );
    expect(row?.counts).toBe(1);
  });

  test("FINAL_CATEGORY resolves in SQL context", () => {
    run(
      db,
      `INSERT INTO transactions(external_id, source, posted_date, amount, currency, imported_at, category_auto)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
      "tx2", "test", "2026-03-01", -10, "CAD", "2026-03-01T00:00:00Z", "Food/Coffee",
    );
    const row = getRow<{ cat: string }>(
      db,
      `SELECT ${FINAL_CATEGORY} AS cat FROM transactions WHERE external_id = ?`,
      "tx2",
    );
    expect(row?.cat).toBe("Food/Coffee");
  });

  test("FINAL_CATEGORY defaults to Uncategorized", () => {
    run(
      db,
      `INSERT INTO transactions(external_id, source, posted_date, amount, currency, imported_at)
       VALUES(?, ?, ?, ?, ?, ?)`,
      "tx3", "test", "2026-03-01", -10, "CAD", "2026-03-01T00:00:00Z",
    );
    const row = getRow<{ cat: string }>(
      db,
      `SELECT ${FINAL_CATEGORY} AS cat FROM transactions WHERE external_id = ?`,
      "tx3",
    );
    expect(row?.cat).toBe("Uncategorized");
  });
});

describe("ensureForecastConfig / loadForecastConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "finance-db-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates config file when missing and loads it back", () => {
    const configPath = path.join(tmpDir, "sub", "forecast.json");
    const defaultConfig = { version: 1, year: 2026 };
    ensureForecastConfig(configPath, defaultConfig as any);
    expect(fs.existsSync(configPath)).toBe(true);
    const loaded = loadForecastConfig(configPath);
    expect(loaded.version).toBe(1);
    expect(loaded.year).toBe(2026);
  });

  test("does not overwrite existing config", () => {
    const configPath = path.join(tmpDir, "forecast.json");
    fs.writeFileSync(configPath, JSON.stringify({ version: 99, year: 2099 }));
    ensureForecastConfig(configPath, { version: 1, year: 2026 } as any);
    const loaded = loadForecastConfig(configPath);
    expect(loaded.version).toBe(99);
  });
});
