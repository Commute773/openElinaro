import type { Database } from "bun:sqlite";
import type { FinanceBudgetSnapshot } from "./finance-types";
import {
  clamp,
  formatCad,
  toIsoDate,
  daysBetween,
  addDays,
  daysInMonth,
  startEndForMonth,
} from "./finance-helpers";
import {
  allRows,
  getRow,
  getSettingOrDefault,
  getNumericSettingOrDefault,
  FINAL_COUNTS,
} from "./finance-database";

export function computeSpendStats(db: Database, fromDate: string, toExclusive: string) {
  const row = getRow<Record<string, unknown>>(
    db,
    `SELECT
       COALESCE(SUM(CASE WHEN amount < 0 AND ${FINAL_COUNTS} = 1 AND (currency = 'CAD' OR amount_cad IS NOT NULL)
         THEN -(COALESCE(amount_cad, amount)) ELSE 0 END), 0) AS spent_cad,
       COALESCE(SUM(CASE WHEN amount > 0 AND ${FINAL_COUNTS} = 1 AND (currency = 'CAD' OR amount_cad IS NOT NULL)
         THEN COALESCE(amount_cad, amount) ELSE 0 END), 0) AS income_cad,
       COALESCE(SUM(CASE WHEN amount < 0 AND ${FINAL_COUNTS} = 1 AND needs_review = 1
         AND (currency = 'CAD' OR amount_cad IS NOT NULL)
         THEN -(COALESCE(amount_cad, amount)) ELSE 0 END), 0) AS uncertain_spent_cad,
       COALESCE(SUM(CASE WHEN amount < 0 AND ${FINAL_COUNTS} = 1 AND currency <> 'CAD'
         AND amount_cad IS NULL THEN -amount ELSE 0 END), 0) AS unknown_fx_spend
     FROM transactions
     WHERE posted_date >= ? AND posted_date < ?`,
    fromDate,
    toExclusive,
  );
  const gross = Number(row?.spent_cad ?? 0);
  const income = Number(row?.income_cad ?? 0);
  return {
    spentCad: gross - income,
    grossSpentCad: gross,
    incomeCad: income,
    uncertainSpentCad: Number(row?.uncertain_spent_cad ?? 0),
    unknownFxSpend: Number(row?.unknown_fx_spend ?? 0),
  };
}

export function computeWeeklyBudget(
  db: Database,
  dateIso: string,
  weeklyLimitCad: number,
  weeklyStart: string,
): Extract<FinanceBudgetSnapshot, { mode: "week" }> {
  const epoch = toIsoDate(weeklyStart);
  const target = toIsoDate(dateIso);
  const diffDays = daysBetween(epoch, target);
  if (diffDays < 0) {
    throw new Error(`Weekly budget starts at ${epoch}; got ${target}`);
  }
  const weekIndex = Math.floor(diffDays / 7);
  const weekStart = addDays(epoch, weekIndex * 7);
  const weekEndExclusive = addDays(weekStart, 7);
  const before = computeSpendStats(db, epoch, weekStart);
  const carryIn = weekIndex * weeklyLimitCad - before.spentCad;
  const available = weeklyLimitCad + carryIn;
  const stats = computeSpendStats(db, weekStart, weekEndExclusive);
  const remaining = available - stats.spentCad;
  const dayOfWeek = clamp(diffDays - weekIndex * 7, 0, 6) + 1;
  const expectedToDate = available * clamp(dayOfWeek / 7, 0, 1);
  return {
    mode: "week",
    date: target,
    weekIndex,
    weekStart,
    weekEndExclusive,
    weeklyLimitCad,
    carryIn,
    available,
    spentCad: stats.spentCad,
    grossSpentCad: stats.grossSpentCad,
    incomeCad: stats.incomeCad,
    remaining,
    expectedToDate,
    paceDelta: stats.spentCad - expectedToDate,
    uncertainSpentCad: stats.uncertainSpentCad,
    unknownFxSpend: stats.unknownFxSpend,
  };
}

export function computeMonthlyBudget(
  db: Database,
  month: string,
  monthlyLimitCad: number,
  referenceDate?: string,
): Extract<FinanceBudgetSnapshot, { mode: "month" }> {
  const range = startEndForMonth(month);
  const stats = computeSpendStats(db, range.from, range.toExclusive);
  const remaining = monthlyLimitCad - stats.spentCad;
  const targetDate = referenceDate ? toIsoDate(referenceDate) : `${month}-01`;
  const day = Number.parseInt(targetDate.slice(8, 10), 10);
  const expectedToDate = monthlyLimitCad * clamp(day / daysInMonth(month), 0, 1);
  return {
    mode: "month",
    month,
    from: range.from,
    toExclusive: range.toExclusive,
    limitCad: monthlyLimitCad,
    spentCad: stats.spentCad,
    grossSpentCad: stats.grossSpentCad,
    incomeCad: stats.incomeCad,
    remaining,
    expectedToDate,
    paceDelta: stats.spentCad - expectedToDate,
    uncertainSpentCad: stats.uncertainSpentCad,
    unknownFxSpend: stats.unknownFxSpend,
  };
}

export function renderBudgetBlock(
  db: Database,
  snapshot: FinanceBudgetSnapshot,
  defaultSettings: Record<string, string>,
) {
  if (snapshot.mode === "week") {
    const pace = snapshot.paceDelta <= 0
      ? "On track"
      : snapshot.paceDelta <= 0.1 * snapshot.available
        ? "Slightly ahead"
        : "Ahead (red)";
    const lines = [
      `Week: ${snapshot.weekStart} -> ${snapshot.weekEndExclusive} (exclusive)`,
      `Weekly limit: ${formatCad(snapshot.weeklyLimitCad)}`,
      `Carry-in: ${formatCad(snapshot.carryIn)}`,
      `Available: ${formatCad(snapshot.available)}`,
    ];
    if (snapshot.incomeCad > 0) {
      lines.push(
        `Gross spending: ${formatCad(snapshot.grossSpentCad)}`,
        `Credits/reimbursements: -${formatCad(snapshot.incomeCad)}`,
        `Net spent: ${formatCad(snapshot.spentCad)}`,
      );
    } else {
      lines.push(`Spent (counting toward budget): ${formatCad(snapshot.spentCad)}`);
    }
    lines.push(
      `Remaining: ${formatCad(snapshot.remaining)}`,
      `Expected-to-date: ${formatCad(snapshot.expectedToDate)}`,
      `Pace delta: ${formatCad(snapshot.paceDelta)} (${pace})`,
      `Rollover: unspent carries forward week-to-week since ${getSettingOrDefault(db, "budget.weekly_start_date", defaultSettings)}.`,
    );
    if (snapshot.uncertainSpentCad > 0) {
      lines.push(`Uncertain (needs review): ${formatCad(snapshot.uncertainSpentCad)}`);
    }
    if (snapshot.unknownFxSpend > 0) {
      lines.push(`Non-CAD missing FX (excluded): ~${formatCad(snapshot.unknownFxSpend)}`);
    }
    return lines.join("\n");
  }

  const pace = snapshot.paceDelta <= 0
    ? "On track"
    : snapshot.paceDelta <= 0.1 * snapshot.limitCad
      ? "Slightly ahead"
      : "Ahead (red)";
  const lines = [
    `Month: ${snapshot.month}`,
    `Limit: ${formatCad(snapshot.limitCad)}`,
  ];
  if (snapshot.incomeCad > 0) {
    lines.push(
      `Gross spending: ${formatCad(snapshot.grossSpentCad)}`,
      `Credits/reimbursements: -${formatCad(snapshot.incomeCad)}`,
      `Net spent: ${formatCad(snapshot.spentCad)}`,
    );
  } else {
    lines.push(`Spent: ${formatCad(snapshot.spentCad)}`);
  }
  lines.push(
    `Remaining: ${formatCad(snapshot.remaining)}`,
    `Expected-to-date: ${formatCad(snapshot.expectedToDate)}`,
    `Pace delta: ${formatCad(snapshot.paceDelta)} (${pace})`,
  );
  if (snapshot.uncertainSpentCad > 0) {
    lines.push(`Uncertain (needs review): ${formatCad(snapshot.uncertainSpentCad)}`);
  }
  if (snapshot.unknownFxSpend > 0) {
    lines.push(`Non-CAD missing FX (excluded): ~${formatCad(snapshot.unknownFxSpend)}`);
  }
  return lines.join("\n");
}

export function resolveBudgetSnapshot(
  db: Database,
  dateIso: string,
  defaultSettings: Record<string, string>,
  weeklyLimitOverride?: number,
) {
  const weeklyStart = toIsoDate(getSettingOrDefault(db, "budget.weekly_start_date", defaultSettings));
  const weeklyLimit = weeklyLimitOverride ?? getNumericSettingOrDefault(db, "budget.weekly_limit_cad", defaultSettings);
  if (dateIso >= weeklyStart) {
    return computeWeeklyBudget(db, dateIso, weeklyLimit, weeklyStart);
  }
  return computeMonthlyBudget(
    db,
    dateIso.slice(0, 7),
    getNumericSettingOrDefault(db, "budget.monthly_limit_cad", defaultSettings),
    dateIso,
  );
}

export function describeBudgetPace(snapshot: FinanceBudgetSnapshot) {
  if (snapshot.paceDelta <= 0) {
    return 'on_track';
  }
  const threshold = snapshot.mode === 'week' ? snapshot.available : snapshot.limitCad;
  if (snapshot.paceDelta <= 0.1 * threshold) {
    return 'slightly_ahead';
  }
  return 'ahead_red';
}
