import path from "node:path";
import { resolveRuntimePath } from "../runtime-root";

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function finiteNumber(value: number | null | undefined, fallback = 0) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

export function formatCad(value: number) {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)} CAD`;
}

export function formatSignedCad(value: number) {
  const sign = value < 0 ? "-" : "+";
  return `${sign}$${Math.abs(value).toFixed(2)} CAD`;
}

export function formatMoney(value: number, currency = "CAD", precision = 2) {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-CA", {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  })} ${currency}`;
}

export function normText(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function heading(title: string) {
  return `\n${title}\n${"-".repeat(Math.min(60, title.length))}`;
}

export function dateKey(date: Date) {
  return `${date.getUTCFullYear()}-${`${date.getUTCMonth() + 1}`.padStart(2, "0")}-${`${date.getUTCDate()}`.padStart(2, "0")}`;
}

export function parseNumberLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const negative = /^\(.*\)$/.test(trimmed);
  const normalized = trimmed
    .replace(/^\(/, "")
    .replace(/\)$/, "")
    .replace(/[$,\s]/g, "")
    .replace(/[A-Za-z]/g, "");
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return negative ? -parsed : parsed;
}

export function toIsoDate(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Missing date.");
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  const isoLike = /^\d{4}-\d{2}-\d{2}T/.exec(trimmed);
  if (isoLike) {
    return trimmed.slice(0, 10);
  }
  const slash = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (slash) {
    const month = Number.parseInt(slash[1] ?? "0", 10);
    const day = Number.parseInt(slash[2] ?? "0", 10);
    const year = Number.parseInt(slash[3] ?? "0", 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
    }
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return dateKey(parsed);
}

export function toIsoMonth(value: string) {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed.slice(0, 7);
  }
  throw new Error(`Invalid month: ${value}`);
}

export function daysInMonth(month: string) {
  const year = Number.parseInt(month.slice(0, 4), 10);
  const monthIndex = Number.parseInt(month.slice(5, 7), 10);
  return new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
}

export function startEndForMonth(month: string) {
  const year = Number.parseInt(month.slice(0, 4), 10);
  const monthIndex = Number.parseInt(month.slice(5, 7), 10);
  const from = `${year.toString().padStart(4, "0")}-${monthIndex.toString().padStart(2, "0")}-01`;
  const nextMonth = monthIndex === 12
    ? `${(year + 1).toString().padStart(4, "0")}-01-01`
    : `${year.toString().padStart(4, "0")}-${(monthIndex + 1).toString().padStart(2, "0")}-01`;
  return { from, toExclusive: nextMonth };
}

export function addDays(dateIso: string, days: number) {
  const next = new Date(`${dateIso}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return dateKey(next);
}

export function daysBetween(startIso: string, endIso: string) {
  const start = new Date(`${startIso}T00:00:00Z`).getTime();
  const end = new Date(`${endIso}T00:00:00Z`).getTime();
  return Math.floor((end - start) / 86_400_000);
}

export function addMonths(dateIso: string, months: number) {
  const [yearRaw, monthRaw, dayRaw] = dateIso.split("-");
  const year = Number.parseInt(yearRaw ?? "0", 10);
  const month = Number.parseInt(monthRaw ?? "0", 10);
  const day = Number.parseInt(dayRaw ?? "0", 10);
  const totalMonths = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(totalMonths / 12);
  const nextMonth = totalMonths % 12 + 1;
  const maxDay = daysInMonth(`${nextYear.toString().padStart(4, "0")}-${nextMonth.toString().padStart(2, "0")}`);
  return `${nextYear.toString().padStart(4, "0")}-${nextMonth.toString().padStart(2, "0")}-${Math.min(day, maxDay).toString().padStart(2, "0")}`;
}

export function addYears(dateIso: string, years: number) {
  const [yearRaw, monthRaw, dayRaw] = dateIso.split("-");
  const year = Number.parseInt(yearRaw ?? "0", 10) + years;
  const month = Number.parseInt(monthRaw ?? "0", 10);
  const day = Number.parseInt(dayRaw ?? "0", 10);
  const maxDay = daysInMonth(`${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}`);
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${Math.min(day, maxDay).toString().padStart(2, "0")}`;
}

export function computeNextExpected(lastSeen: string, intervalKind: string, intervalDays?: number | null) {
  if (intervalDays && intervalDays > 0) {
    return addDays(lastSeen, intervalDays);
  }
  switch (intervalKind) {
    case "weekly":
      return addDays(lastSeen, 7);
    case "biweekly":
      return addDays(lastSeen, 14);
    case "monthly":
      return addMonths(lastSeen, 1);
    default:
      return addYears(lastSeen, 1);
  }
}

export function isPastDue(todayIso: string, nextExpected: string | null, graceDays: number) {
  if (!nextExpected) {
    return true;
  }
  return toIsoDate(todayIso) > addDays(nextExpected, graceDays);
}

export function defaultGraceDays(intervalKind: string) {
  return intervalKind === "monthly" || intervalKind === "yearly" ? 2 : 1;
}

export function stringOrNull(value: unknown) {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

export function numberOrNull(value: unknown) {
  if (value == null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function booleanOrNull(value: unknown) {
  if (value == null) {
    return null;
  }
  return Number(value) === 1;
}

export function rawCategoryFromJson(rawJson: Record<string, unknown> | null) {
  const category = rawJson?.personal_finance_category as Record<string, unknown> | undefined;
  return stringOrNull(category?.detailed) ?? stringOrNull(category?.primary);
}

export function parseIsoToMs(value: string | null) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveConfiguredFinancePath(configuredPath: string | undefined, fallback: string) {
  const targetPath = configuredPath?.trim() || fallback;
  return path.isAbsolute(targetPath) ? path.normalize(targetPath) : resolveRuntimePath(targetPath);
}

export function toCad(amount: number, currency: string, fxRate: number) {
  if (currency === "CAD") {
    return amount;
  }
  if (currency === "USD") {
    return amount * fxRate;
  }
  return amount;
}
