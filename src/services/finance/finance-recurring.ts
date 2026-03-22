import type { Database } from "bun:sqlite";
import type {
  FinanceRecurringCandidateData,
  FinanceRecurringItemData,
  FinanceImportRunRowData,
} from "../finance-dashboard-types";
import type { RecurringRecord } from "./finance-types";
import {
  normText,
  heading,
  formatCad,
  finiteNumber,
  dateKey,
  toIsoDate,
  daysBetween,
  defaultGraceDays,
  computeNextExpected,
  isPastDue,
  stringOrNull,
  numberOrNull,
  parseIsoToMs,
} from "./finance-helpers";
import {
  allRows,
  run,
} from "./finance-database";
import { timestamp as nowIso } from "../../utils/timestamp";

export function normRecurringKey(value: string) {
  return normText(value).replace(/[^a-z0-9]+/g, " ").trim();
}

export function detectIntervalFromGaps(gaps: number[]) {
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

export function ruleMatchesTransaction(rule: Record<string, unknown>, tx: Record<string, unknown>) {
  const merchant = normRecurringKey(String(tx.merchant_name ?? ""));
  const description = normRecurringKey(String(tx.description_clean ?? tx.description_raw ?? ""));
  const value = normRecurringKey(String(rule.match_value ?? ""));
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

export function recurringAmountMatches(rule: Record<string, unknown>, tx: Record<string, unknown>) {
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

export function assertRecurringInput(input: {
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

export function renderRecurringList(label: string, rows: Array<Record<string, unknown>>) {
  return `${heading(`${label} (${rows.length})`)}\n${
    rows.length === 0
      ? "(none)"
      : rows.map((row) => `- ${row.name}: ${formatCad(Number(row.amount_cad ?? 0))}${Number(row.amount_tolerance_cad ?? 0) > 0 ? ` +/- ${formatCad(Number(row.amount_tolerance_cad ?? 0))}` : ""} | ${row.interval_kind} | last ${row.last_seen ?? row.last_seen_date ?? "(never)"} | next ${row.next_expected ?? row.next_expected_date ?? "(unknown)"}${row.grace_days != null ? ` | grace ${row.grace_days}d` : ""}`).join("\n")
  }`;
}

export function mapRecurringRow(row: RecurringRecord, today: string): FinanceRecurringItemData {
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

export function mapImportRunRow(row: Record<string, unknown>): FinanceImportRunRowData {
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

export function detectRecurringCandidates(db: Database, todayIso: string) {
  const rows = allRows<Record<string, unknown>>(
    db,
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
    const normalizedName = normRecurringKey(nameRaw);
    if (!normalizedName || normalizedName.length < 3) {
      continue;
    }
    if (["transfer", "payment", "credit card"].some((token) => normalizedName.includes(token))) {
      continue;
    }
    const matchKind = row.merchant_name ? "merchant" : "description";
    const matchValue = normRecurringKey(matchKind === "merchant"
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
    const interval = detectIntervalFromGaps(gaps);
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
    const graceDaysVal = defaultGraceDays(interval.kind);
    const nextExpected = computeNextExpected(dates[dates.length - 1] ?? todayIso, interval.kind, interval.intervalDays);
    const status = isPastDue(todayIso, nextExpected, graceDaysVal) ? "halted" : "active";
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
      grace_days: graceDaysVal,
    });
  }
  return candidates.sort((left, right) =>
    String(left.status) === String(right.status)
      ? String(left.name).localeCompare(String(right.name))
      : String(left.status) === "active" ? -1 : 1,
  );
}

export function getRecurringCandidatesData(
  db: Database,
  options?: { today?: string; includeKnown?: boolean; maxAgeDays?: number },
): FinanceRecurringCandidateData[] {
  const today = options?.today ? toIsoDate(options.today) : dateKey(new Date());
  const includeKnown = options?.includeKnown ?? true;
  const maxAgeDays = options?.maxAgeDays ?? null;
  const existing = allRows<{ id: number; match_kind: string; match_value: string; currency: string; amount_cad: number }>(
    db,
    "SELECT id, match_kind, match_value, currency, amount_cad FROM recurring",
  );
  const existingByKey = new Map(
    existing.map((row) => [
      `${row.match_kind}::${row.match_value}::${String(row.currency ?? "CAD").toUpperCase()}::${Number(row.amount_cad ?? 0).toFixed(2)}`,
      Number(row.id ?? 0),
    ]),
  );
  return detectRecurringCandidates(db, today)
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

export function refreshRecurringRules(
  db: Database,
  todayIso: string,
  autoSeed: boolean,
  seedLimit: number,
) {
  const candidates = detectRecurringCandidates(db, todayIso);
  const existing = allRows<Record<string, unknown>>(
    db,
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
        run(
          db,
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

  const rules = allRows<Record<string, unknown>>(
    db,
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
    const possible = allRows<Record<string, unknown>>(
      db,
      `SELECT posted_date, amount, currency, amount_cad, merchant_name,
          description_clean, description_raw
        FROM transactions
        WHERE amount < 0 AND is_cc_payment = 0 AND currency = ?
        ORDER BY posted_date ASC, id ASC`,
      String(rule.currency ?? "CAD"),
    );
    const matches = possible.filter((tx) => ruleMatchesTransaction(rule, tx) && recurringAmountMatches(rule, tx));
    const observedLastSeenDate = matches.length > 0 ? String(matches[matches.length - 1]?.posted_date ?? "") : null;
    const lastSeenDate = observedLastSeenDate ?? storedLastSeenDate;
    const graceDaysVal = Number(rule.grace_days ?? defaultGraceDays(String(rule.interval_kind ?? "monthly")));
    const nextExpectedDate = lastSeenDate
      ? computeNextExpected(lastSeenDate, String(rule.interval_kind ?? "monthly"), rule.interval_days == null ? null : Number(rule.interval_days))
      : storedNextExpectedDate;
    const status = storedStatus;
    run(
      db,
      `UPDATE recurring
        SET next_expected_date = ?, last_seen_date = ?, status = ?, grace_days = COALESCE(grace_days, ?), updated_at = ?
        WHERE id = ?`,
      nextExpectedDate,
      lastSeenDate,
      status,
      graceDaysVal,
      nowIso(),
      Number(rule.id ?? 0),
    );
    return {
      ...rule,
      last_seen_date: lastSeenDate,
      next_expected_date: nextExpectedDate,
      status,
      grace_days: graceDaysVal,
    };
  });
  return {
    today: todayIso,
    seeded,
    active: refreshed.filter((row) => row.status === "active"),
    halted: refreshed.filter((row) => row.status === "halted"),
  };
}

export function sumRecurringOutflowsWithinHorizon(
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

