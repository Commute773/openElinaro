import type { Weekday } from "../domain/calendar";

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

/** Get the current time interpreted in a named timezone. */
export function nowInTimezone(timezone: string, reference: Date = new Date()): Date {
  return new Date(reference.toLocaleString("en-US", { timeZone: timezone }));
}

// ---------------------------------------------------------------------------
// Local date helpers
// ---------------------------------------------------------------------------

/** YYYY-MM-DD from a Date using **local** time components. */
export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Midnight (local) of the given date. */
export function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

/** True when both dates fall on the same local calendar day. */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return localDateKey(a) === localDateKey(b);
}

// ---------------------------------------------------------------------------
// UTC date helpers
// ---------------------------------------------------------------------------

/** YYYY-MM-DD from a Date using **UTC** components. */
export function utcDateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${`${date.getUTCMonth() + 1}`.padStart(2, "0")}-${`${date.getUTCDate()}`.padStart(2, "0")}`;
}

/** Midnight (UTC) of the given date. */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

// ---------------------------------------------------------------------------
// Date arithmetic (local)
// ---------------------------------------------------------------------------

/** Add (or subtract) calendar days using local time. */
export function addDaysLocal(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Add (or subtract) calendar months using local time. */
export function addMonthsLocal(date: Date, months: number): Date {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

/** Set the day-of-month, clamping to the last day if needed. */
export function setDayOfMonth(date: Date, dayOfMonth: number): Date {
  const next = new Date(date);
  const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(dayOfMonth, maxDay));
  return next;
}

// ---------------------------------------------------------------------------
// Date arithmetic (UTC)
// ---------------------------------------------------------------------------

/** Add (or subtract) calendar days using UTC. */
export function addDaysUtc(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** Add (or subtract) calendar months using UTC. */
export function addMonthsUtc(date: Date, months: number): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

// ---------------------------------------------------------------------------
// Time-of-day helpers
// ---------------------------------------------------------------------------

/** Parse an "HH:MM" string into hours and minutes. */
export function parseTime(time: string): { hours: number; minutes: number } {
  const [hoursRaw, minutesRaw] = time.split(":");
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    throw new Error(`Invalid time value: ${time}`);
  }
  return { hours, minutes };
}

/** Return a copy of `date` with the clock set to `time` ("HH:MM"). */
export function setTime(date: Date, time: string): Date {
  const next = new Date(date);
  const { hours, minutes } = parseTime(time);
  next.setHours(hours, minutes, 0, 0);
  return next;
}

// ---------------------------------------------------------------------------
// Weekday helpers
// ---------------------------------------------------------------------------

const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** The lowercase weekday abbreviation for a date. */
export function weekdayKey(date: Date): Weekday {
  return WEEKDAYS[date.getDay()] as Weekday;
}

// ---------------------------------------------------------------------------
// ISO helpers
// ---------------------------------------------------------------------------

/** Parse an ISO string to Date, returning null for falsy input. */
export function parseIso(value?: string): Date | null {
  return value ? new Date(value) : null;
}

/** Shorthand for `date.toISOString()`. */
export function toIso(date: Date): string {
  return date.toISOString();
}
