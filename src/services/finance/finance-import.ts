import crypto from "node:crypto";
import type { Database } from "bun:sqlite";
import type { FinanceSyntheticIncomeInput, FinanceUpsertAccountOptions } from "./finance-types";
import {
  normText,
  formatCad,
  dateKey,
  toIsoDate,
  parseNumberLike,
} from "./finance-helpers";
import {
  allRows,
  getRow,
  run,
} from "./finance-database";
import { classifyTransaction, parseJson } from "./finance-ledger";
import { timestamp as nowIso } from "../../utils/timestamp";

const INFERRED_ACCOUNT_INCOME_MIN_DELTA_CAD = 1000;
const INFERRED_ACCOUNT_INCOME_ACCOUNT_HINT = "non-registered";
const INFERRED_ACCOUNT_INCOME_COUNTERPARTY = "Client Payment";
const INFERRED_ACCOUNT_INCOME_RECEIVABLE_HINT = "client";
const RECEIVABLE_CLEAR_TOLERANCE_CAD = 25;

export function parseCsvText(csvText: string) {
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

export async function fetchText(url: string) {
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

export function sheetCsvUrl(spreadsheetId: string, gid: string) {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
}

export function upsertAccount(
  db: Database,
  row: Record<string, string>,
  options?: FinanceUpsertAccountOptions,
  markReceivableReceivedFn?: (id: number, options?: { receivedDate?: string; note?: string }) => void,
) {
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
  const existing = getRow<Record<string, unknown>>(
    db,
    "SELECT balance, last_update, updated_at FROM accounts WHERE external_id = ?",
    externalId,
  );
  const previousBalance = getPreviousAccountBalance(db, externalId, existing);

  run(
    db,
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
    recordAccountBalanceSnapshot(db, {
      importRunId: options.importRunId,
      source: options.source ?? "fintable_gsheet",
      externalId,
      name,
      currency,
      balance,
      capturedAt: lastUpdate,
      rawJson,
    });
    maybeRecordInferredIncomeFromBalanceDelta(db, {
      externalId,
      accountName: name,
      currency,
      balance,
      capturedAt: lastUpdate,
      previousBalance,
    }, markReceivableReceivedFn);
  }
}

export function getPreviousAccountBalance(db: Database, externalId: string, existing: Record<string, unknown> | null) {
  const snapshot = getRow<Record<string, unknown>>(
    db,
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

export function recordAccountBalanceSnapshot(db: Database, input: {
  importRunId: number;
  source: string;
  externalId: string;
  name: string | null;
  currency: string | null;
  balance: number | null;
  capturedAt: string | null;
  rawJson: string | null;
}) {
  run(
    db,
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

export function maybeRecordInferredIncomeFromBalanceDelta(
  db: Database,
  input: {
    externalId: string;
    accountName: string | null;
    currency: string | null;
    balance: number | null;
    capturedAt: string | null;
    previousBalance: number | null;
  },
  markReceivableReceivedFn?: (id: number, options?: { receivedDate?: string; note?: string }) => void,
) {
  if (!isInferredIncomeAccount(input.accountName, input.currency)) {
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
  const result = upsertSyntheticIncomeTransaction(db, {
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
  });

  if (result.id > 0 && result.status === "added" && markReceivableReceivedFn) {
    clearMatchingPendingReceivables(
      db,
      INFERRED_ACCOUNT_INCOME_RECEIVABLE_HINT,
      delta,
      postedDate,
      `Auto-cleared from inferred income transaction ${result.externalId}`,
      markReceivableReceivedFn,
    );
  }
}

export function isInferredIncomeAccount(accountName: string | null, currency: string | null) {
  return normText(accountName).includes(INFERRED_ACCOUNT_INCOME_ACCOUNT_HINT) && (currency ?? "CAD").toUpperCase() === "CAD";
}

export function clearMatchingPendingReceivables(
  db: Database,
  counterparty: string,
  amountCad: number,
  receivedDate: string,
  note: string,
  markReceivableReceivedFn: (id: number, options?: { receivedDate?: string; note?: string }) => void,
) {
  const pending = allRows<Record<string, unknown>>(
    db,
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
    markReceivableReceivedFn(id, { receivedDate, note });
    clearedIds.push(id);
    remaining -= receivableAmount;
  }
  return clearedIds;
}

export function upsertSyntheticIncomeTransaction(db: Database, input: FinanceSyntheticIncomeInput) {
  const externalId = input.externalId
    ?? `synthetic-income:${crypto.createHash("sha1").update(JSON.stringify({
      accountExternalId: input.accountExternalId ?? null,
      accountName: input.accountName ?? null,
      postedDate: toIsoDate(input.postedDate),
      amountCad: input.amountCad,
      description: input.description,
    })).digest("hex")}`;
  const existing = getRow<{ id: number }>(
    db,
    "SELECT id FROM transactions WHERE external_id = ?",
    externalId,
  );
  if (existing) {
    return { status: "updated" as const, id: Number(existing.id ?? 0), externalId };
  }
  const currency = (input.currency ?? "CAD").toUpperCase();
  const amount = input.amount ?? input.amountCad;
  run(
    db,
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
  const resultRow = getRow<{ id: number }>(db, "SELECT last_insert_rowid() AS id");
  return { status: "added" as const, id: Number(resultRow?.id ?? 0), externalId };
}

export function upsertTransaction(db: Database, row: Record<string, string>, source: string) {
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
  const existing = getRow<Record<string, unknown>>(
    db,
    "SELECT id, category_user, counts_toward_budget_user, description_clean, note FROM transactions WHERE external_id = ?",
    externalId,
  );
  const auto = classifyTransaction(db, {
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
  const noteVal = typeof existing?.note === "string" ? existing.note : null;
  const needsReview = existing && (categoryUser != null || countsTowardBudgetUser != null)
    ? 0
    : auto.needsReview ? 1 : 0;
  const reviewReason = existing && (categoryUser != null || countsTowardBudgetUser != null)
    ? null
    : auto.reviewReason;

  if (!existing) {
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
      noteVal,
      rawJson,
      nowIso(),
    );
    return { inserted: true, updated: false };
  }

  run(
    db,
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
