import fs from "node:fs";
import path from "node:path";
import type { Database } from "bun:sqlite";
import type { FinanceForecastConfig } from "../../config/finance-config";
import { DEFAULT_FINANCE_SETTINGS } from "../../config/finance-config";
import { timestamp as nowIso } from "../../utils/timestamp";
import type { SqlValue } from "./finance-types";

export const SCHEMA = `
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

export const DEFAULT_RULES: Array<[string, string, string, number, number]> = [
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

export const FINAL_COUNTS =
  "COALESCE(counts_toward_budget_user, counts_toward_budget_auto, 0)";
export const FINAL_CATEGORY =
  "COALESCE(category_user, category_auto, 'Uncategorized')";

export function allRows<T extends Record<string, unknown>>(db: Database, sql: string, ...params: SqlValue[]) {
  return db.query(sql).all(...params) as T[];
}

export function getRow<T extends Record<string, unknown>>(db: Database, sql: string, ...params: SqlValue[]) {
  return (db.query(sql).get(...params) as T | null) ?? null;
}

export function run(db: Database, sql: string, ...params: SqlValue[]) {
  return db.query(sql).run(...params);
}

export function migrateReceivables(db: Database) {
  const columns = allRows<{ name: string }>(db, "PRAGMA table_info(receivables)").map((row) => String(row.name));
  if (!columns.includes("currency")) {
    db.exec("ALTER TABLE receivables ADD COLUMN currency TEXT DEFAULT 'CAD';");
  }
  if (!columns.includes("amount")) {
    db.exec("ALTER TABLE receivables ADD COLUMN amount REAL;");
    db.exec("UPDATE receivables SET amount = amount_cad WHERE amount IS NULL AND currency = 'CAD';");
  }
}

export function migrateRecurring(db: Database) {
  const columns = allRows<{ name: string }>(db, "PRAGMA table_info(recurring)").map((row) => String(row.name));
  if (!columns.includes("amount_tolerance_cad")) {
    db.exec("ALTER TABLE recurring ADD COLUMN amount_tolerance_cad REAL NOT NULL DEFAULT 0;");
  }
}

export function seedDefaults(
  db: Database,
  defaultSettings: Record<string, string>,
) {
  for (const [key, value] of Object.entries(defaultSettings)) {
    run(
      db,
      "INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)",
      key,
      value,
    );
  }
  for (const [pattern, matchField, category, counts, confidence] of DEFAULT_RULES) {
    const existingRule = getRow<{ id: number }>(
      db,
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
    run(
      db,
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

export function ensureForecastConfig(
  forecastConfigPath: string,
  defaultForecastConfig: FinanceForecastConfig,
) {
  fs.mkdirSync(path.dirname(forecastConfigPath), { recursive: true });
  if (!fs.existsSync(forecastConfigPath)) {
    fs.writeFileSync(
      `${forecastConfigPath}`,
      `${JSON.stringify(defaultForecastConfig, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
}

export function loadForecastConfig(forecastConfigPath: string) {
  const raw = JSON.parse(fs.readFileSync(forecastConfigPath, "utf8")) as FinanceForecastConfig;
  return raw;
}

export function getSetting(db: Database, key: string) {
  const row = getRow<{ value: string }>(db, "SELECT value FROM settings WHERE key = ?", key);
  return row?.value ?? null;
}

export function getSettingOrDefault(
  db: Database,
  key: string,
  defaultSettings: Record<string, string>,
) {
  return getSetting(db, key) ?? defaultSettings[key] ?? DEFAULT_FINANCE_SETTINGS[key] ?? "";
}

export function getNumericSettingOrDefault(
  db: Database,
  key: string,
  defaultSettings: Record<string, string>,
) {
  const parsed = Number.parseFloat(getSettingOrDefault(db, key, defaultSettings));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function setSetting(db: Database, key: string, value: string) {
  run(
    db,
    `INSERT INTO settings(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    value,
  );
}

export function getFxRate(
  db: Database,
  defaultSettings: Record<string, string>,
) {
  return getNumericSettingOrDefault(db, "fx.usdcad", defaultSettings);
}
