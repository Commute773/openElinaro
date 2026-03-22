import { test, expect, describe, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { SCHEMA } from "./finance-database";
import {
  parseCsvText,
  sheetCsvUrl,
  fetchText,
  upsertAccount,
  getPreviousAccountBalance,
  recordAccountBalanceSnapshot,
  isInferredIncomeAccount,
  clearMatchingPendingReceivables,
  upsertSyntheticIncomeTransaction,
  upsertTransaction,
} from "./finance-import";

function createTestDb() {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  // Seed a basic categorization rule so classifyTransaction works
  db.query(
    `INSERT INTO categorization_rules(pattern, match_field, category, counts_toward_budget, confidence, created_at)
     VALUES(?, ?, ?, ?, ?, ?)`,
  ).run("grocery", "description_raw", "Food/Groceries", 1, 0.9, new Date().toISOString());
  return db;
}

describe("parseCsvText", () => {
  test("parses simple CSV", () => {
    const result = parseCsvText("Name,Amount\nAlice,100\nBob,200");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ Name: "Alice", Amount: "100" });
    expect(result[1]).toEqual({ Name: "Bob", Amount: "200" });
  });

  test("handles quoted fields with commas", () => {
    const result = parseCsvText('Name,Description\nAlice,"Hello, World"');
    expect(result).toHaveLength(1);
    expect(result[0]!.Description).toBe("Hello, World");
  });

  test("handles escaped quotes", () => {
    const result = parseCsvText('Name,Description\nAlice,"She said ""hello"""');
    expect(result).toHaveLength(1);
    expect(result[0]!.Description).toBe('She said "hello"');
  });

  test("handles CRLF line endings", () => {
    const result = parseCsvText("Name,Value\r\nRow1,10\r\nRow2,20");
    expect(result).toHaveLength(2);
  });

  test("handles BOM and special characters in headers", () => {
    const result = parseCsvText("\uFEFFName,Amount\nAlice,100");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ Name: "Alice", Amount: "100" });
  });

  test("strips lightning bolt from headers", () => {
    const result = parseCsvText("\u26A1Name\u26A1,Amount\nAlice,100");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ Name: "Alice", Amount: "100" });
  });

  test("returns empty for header-only CSV", () => {
    const result = parseCsvText("Name,Amount");
    expect(result).toHaveLength(0);
  });

  test("returns empty for empty string", () => {
    const result = parseCsvText("");
    expect(result).toHaveLength(0);
  });

  test("skips blank rows", () => {
    const result = parseCsvText("Name,Amount\nAlice,100\n,\nBob,200");
    expect(result).toHaveLength(2);
  });

  test("handles missing trailing values", () => {
    const result = parseCsvText("A,B,C\n1,2");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ A: "1", B: "2", C: "" });
  });
});

describe("sheetCsvUrl", () => {
  test("constructs correct Google Sheets CSV URL", () => {
    const url = sheetCsvUrl("abc123", "456");
    expect(url).toBe("https://docs.google.com/spreadsheets/d/abc123/export?format=csv&gid=456");
  });
});

describe("fetchText", () => {
  test("throws on non-ok response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Not Found", { status: 404, statusText: "Not Found" })),
    ) as unknown as typeof fetch;
    try {
      await expect(fetchText("https://example.com/bad")).rejects.toThrow("Failed to fetch");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns text on success", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("hello world", { status: 200 })),
    ) as unknown as typeof fetch;
    try {
      const result = await fetchText("https://example.com/good");
      expect(result).toBe("hello world");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("upsertAccount", () => {
  test("inserts a new account", () => {
    const db = createTestDb();
    const row = {
      "Account ID": "acc-1",
      "Account Name": "Chequing",
      Institution: "MyBank",
      Currency: "CAD",
      Balance: "5000.00",
      "Last Update": "2026-03-01",
      "Raw Data": "",
    };
    upsertAccount(db, row);
    const result = db.query("SELECT * FROM accounts WHERE external_id = ?").get("acc-1") as Record<string, unknown>;
    expect(result).not.toBeNull();
    expect(result!.name).toBe("Chequing");
    expect(result!.balance).toBe(5000);
    db.close();
  });

  test("updates existing account on conflict", () => {
    const db = createTestDb();
    const row1 = { "Account ID": "acc-1", "Account Name": "Old Name", Currency: "CAD", Balance: "1000" };
    upsertAccount(db, row1);
    const row2 = { "Account ID": "acc-1", "Account Name": "New Name", Currency: "CAD", Balance: "2000" };
    upsertAccount(db, row2);
    const result = db.query("SELECT * FROM accounts WHERE external_id = ?").get("acc-1") as Record<string, unknown>;
    expect(result!.name).toBe("New Name");
    expect(result!.balance).toBe(2000);
    db.close();
  });

  test("skips row without account ID", () => {
    const db = createTestDb();
    upsertAccount(db, { "Account Name": "No ID" });
    const count = db.query("SELECT count(*) as c FROM accounts").get() as { c: number };
    expect(count.c).toBe(0);
    db.close();
  });

  test("records balance snapshot when importRunId is provided", () => {
    const db = createTestDb();
    db.query("INSERT INTO import_runs(source, started_at) VALUES(?, ?)").run("test", new Date().toISOString());
    const row = { "Account ID": "acc-1", "Account Name": "Test", Currency: "CAD", Balance: "3000" };
    upsertAccount(db, row, { importRunId: 1, source: "test" });
    const snapshot = db.query("SELECT * FROM account_balance_snapshots WHERE account_external_id = ?").get("acc-1") as Record<string, unknown>;
    expect(snapshot).not.toBeNull();
    expect(snapshot!.balance).toBe(3000);
    db.close();
  });
});

describe("getPreviousAccountBalance", () => {
  test("returns balance from snapshot if available", () => {
    const db = createTestDb();
    db.query(
      `INSERT INTO account_balance_snapshots(import_run_id, source, account_external_id, balance, created_at)
       VALUES(?, ?, ?, ?, ?)`,
    ).run(1, "test", "acc-1", 4000, new Date().toISOString());
    const result = getPreviousAccountBalance(db, "acc-1", null);
    expect(result).toBe(4000);
    db.close();
  });

  test("falls back to existing balance if no snapshot", () => {
    const db = createTestDb();
    const result = getPreviousAccountBalance(db, "acc-1", { balance: 2500 });
    expect(result).toBe(2500);
    db.close();
  });

  test("returns null when no data available", () => {
    const db = createTestDb();
    const result = getPreviousAccountBalance(db, "acc-1", null);
    expect(result).toBeNull();
    db.close();
  });
});

describe("isInferredIncomeAccount", () => {
  test("returns true for non-registered CAD account", () => {
    expect(isInferredIncomeAccount("Non-Registered Account", "CAD")).toBe(true);
  });

  test("returns false for registered account", () => {
    expect(isInferredIncomeAccount("RRSP Account", "CAD")).toBe(false);
  });

  test("returns false for non-CAD currency", () => {
    expect(isInferredIncomeAccount("Non-Registered Account", "USD")).toBe(false);
  });

  test("defaults currency to CAD", () => {
    expect(isInferredIncomeAccount("Non-Registered Account", null)).toBe(true);
  });
});

describe("clearMatchingPendingReceivables", () => {
  test("clears matching pending receivables", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    db.query(
      `INSERT INTO receivables(counterparty, amount_cad, earned_date, expected_date, status, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run("Client Payment", 5000, "2026-02-01", "2026-03-01", "pending", now, now);

    const cleared: number[] = [];
    const markFn = (id: number) => cleared.push(id);

    const result = clearMatchingPendingReceivables(db, "client", 5000, "2026-03-15", "test", markFn);
    expect(result).toHaveLength(1);
    expect(cleared).toHaveLength(1);
    db.close();
  });

  test("skips receivables with amount exceeding remaining plus tolerance", () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    db.query(
      `INSERT INTO receivables(counterparty, amount_cad, earned_date, expected_date, status, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run("Client Payment", 10000, "2026-02-01", "2026-03-01", "pending", now, now);

    const cleared: number[] = [];
    const markFn = (id: number) => cleared.push(id);

    const result = clearMatchingPendingReceivables(db, "client", 100, "2026-03-15", "test", markFn);
    expect(result).toHaveLength(0);
    db.close();
  });
});

describe("upsertSyntheticIncomeTransaction", () => {
  test("inserts a new synthetic income transaction", () => {
    const db = createTestDb();
    const result = upsertSyntheticIncomeTransaction(db, {
      externalId: "synth-1",
      postedDate: "2026-03-15",
      amountCad: 5000,
      description: "Client payment inferred",
    });
    expect(result.status).toBe("added");
    expect(result.id).toBeGreaterThan(0);
    expect(result.externalId).toBe("synth-1");
    db.close();
  });

  test("returns updated status for existing transaction", () => {
    const db = createTestDb();
    upsertSyntheticIncomeTransaction(db, {
      externalId: "synth-dup",
      postedDate: "2026-03-15",
      amountCad: 5000,
      description: "First insert",
    });
    const result = upsertSyntheticIncomeTransaction(db, {
      externalId: "synth-dup",
      postedDate: "2026-03-15",
      amountCad: 5000,
      description: "Second insert",
    });
    expect(result.status).toBe("updated");
    db.close();
  });

  test("generates external ID when not provided", () => {
    const db = createTestDb();
    const result = upsertSyntheticIncomeTransaction(db, {
      postedDate: "2026-03-15",
      amountCad: 3000,
      description: "Auto-generated ID",
    });
    expect(result.status).toBe("added");
    expect(result.externalId).toContain("synthetic-income:");
    db.close();
  });
});

describe("upsertTransaction", () => {
  test("inserts a new transaction", () => {
    const db = createTestDb();
    const row = {
      "Transaction ID": "tx-1",
      Date: "2026-03-10",
      Amount: "-50.00",
      Currency: "CAD",
      Description: "Grocery Store",
      Account: "Chequing",
    };
    const result = upsertTransaction(db, row, "csv");
    expect(result.inserted).toBe(true);
    expect(result.updated).toBe(false);
    db.close();
  });

  test("updates existing transaction", () => {
    const db = createTestDb();
    const row = {
      "Transaction ID": "tx-2",
      Date: "2026-03-10",
      Amount: "-50.00",
      Currency: "CAD",
      Description: "Store A",
    };
    upsertTransaction(db, row, "csv");
    const row2 = {
      "Transaction ID": "tx-2",
      Date: "2026-03-11",
      Amount: "-60.00",
      Currency: "CAD",
      Description: "Store A updated",
    };
    const result = upsertTransaction(db, row2, "csv");
    expect(result.inserted).toBe(false);
    expect(result.updated).toBe(true);
    db.close();
  });

  test("skips row without transaction ID", () => {
    const db = createTestDb();
    const result = upsertTransaction(db, { Date: "2026-03-10", Amount: "-10" }, "csv");
    expect(result.inserted).toBe(false);
    expect(result.updated).toBe(false);
    db.close();
  });

  test("throws for invalid amount", () => {
    const db = createTestDb();
    const row = {
      "Transaction ID": "tx-bad",
      Date: "2026-03-10",
      Amount: "not-a-number",
      Currency: "CAD",
    };
    expect(() => upsertTransaction(db, row, "csv")).toThrow("Invalid amount");
    db.close();
  });
});

describe("recordAccountBalanceSnapshot", () => {
  test("inserts a balance snapshot", () => {
    const db = createTestDb();
    recordAccountBalanceSnapshot(db, {
      importRunId: 1,
      source: "test",
      externalId: "acc-snap",
      name: "Test Account",
      currency: "CAD",
      balance: 7500,
      capturedAt: "2026-03-15",
      rawJson: null,
    });
    const row = db.query("SELECT * FROM account_balance_snapshots WHERE account_external_id = ?").get("acc-snap") as Record<string, unknown>;
    expect(row).not.toBeNull();
    expect(row!.balance).toBe(7500);
    db.close();
  });

  test("updates snapshot on conflict with same import_run_id and account", () => {
    const db = createTestDb();
    recordAccountBalanceSnapshot(db, {
      importRunId: 1,
      source: "test",
      externalId: "acc-snap2",
      name: "Test",
      currency: "CAD",
      balance: 1000,
      capturedAt: "2026-03-15",
      rawJson: null,
    });
    recordAccountBalanceSnapshot(db, {
      importRunId: 1,
      source: "test",
      externalId: "acc-snap2",
      name: "Test Updated",
      currency: "CAD",
      balance: 2000,
      capturedAt: "2026-03-16",
      rawJson: null,
    });
    const rows = db.query("SELECT * FROM account_balance_snapshots WHERE account_external_id = ?").all("acc-snap2") as unknown[];
    expect(rows).toHaveLength(1);
    db.close();
  });
});
