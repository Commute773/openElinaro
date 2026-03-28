import type { CalendarHintEvent } from "../domain/routines";
import { getRuntimeConfig } from "../config/runtime-config";
import { RoutinesService } from "./scheduling/routines-service";
import { telemetry } from "./telemetry";
import { createTraceSpan } from "../utils/telemetry-helpers";
import { CalendarSyncStateService } from "./calendar-sync-state-service";
import { toIso, addDaysUtc as addDays, addMonthsUtc as addMonths, startOfUtcDay } from "../utils/time-helpers";

const DEFAULT_SYNC_INTERVAL_MS = 15 * 60_000;
const DEFAULT_LOOKAHEAD_DAYS = 45;
const DEFAULT_INITIAL_BACKOFF_MS = 60_000;
const MAX_CONSECUTIVE_BACKOFF_MS = 6 * 60 * 60_000;
const calendarTelemetry = telemetry.child({ component: "calendar" });

type CalendarOccurrence = {
  uid: string;
  title: string;
  start: Date;
  end?: Date;
  location?: string;
  requiresTransit: boolean;
};

type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

type ParsedProperty = {
  name: string;
  params: Record<string, string>;
  value: string;
};

type ParsedEvent = {
  uid?: string;
  summary?: string;
  location?: string;
  dtstart?: ParsedProperty;
  dtend?: ParsedProperty;
  recurrenceId?: ParsedProperty;
  rrule?: string;
  exdates: ParsedProperty[];
};

type RecurrenceRule = {
  freq?: string;
  interval: number;
  count?: number;
  until?: Date;
  byDay?: string[];
  byMonthDay?: number[];
};

const traceSpan = createTraceSpan(calendarTelemetry);

function weekdayToken(date: Date) {
  return ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][date.getUTCDay()]!;
}

function inferRequiresTransit(location: string | undefined) {
  if (!location?.trim()) {
    return false;
  }
  const normalized = location.toLowerCase();
  if (
    normalized.includes("zoom")
    || normalized.includes("meet.google")
    || normalized.includes("google meet")
    || normalized.includes("teams.microsoft")
    || normalized.includes("microsoft teams")
    || normalized.includes("webex")
    || normalized.includes("jitsi")
    || normalized.includes("discord")
    || normalized.includes("http://")
    || normalized.includes("https://")
  ) {
    return false;
  }
  return true;
}

function unfoldIcsLines(text: string) {
  const input = text.replace(/\r\n/g, "\n").split("\n");
  const lines: string[] = [];
  for (const rawLine of input) {
    if ((rawLine.startsWith(" ") || rawLine.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] = `${lines[lines.length - 1]}${rawLine.slice(1)}`;
      continue;
    }
    lines.push(rawLine);
  }
  return lines;
}

function parseProperty(line: string): ParsedProperty | null {
  const separator = line.indexOf(":");
  if (separator === -1) {
    return null;
  }
  const left = line.slice(0, separator);
  const value = line.slice(separator + 1);
  const [nameRaw, ...paramParts] = left.split(";");
  const name = nameRaw?.trim().toUpperCase();
  if (!name) {
    return null;
  }
  const params = Object.fromEntries(
    paramParts.map((part) => {
      const [keyRaw, valueRaw = ""] = part.split("=");
      return [(keyRaw ?? "").trim().toUpperCase(), valueRaw.trim()];
    }),
  );
  return { name, params, value };
}

function parseIcsDateValue(value: string, params: Record<string, string>) {
  const trimmed = value.trim();
  const isDateOnly = params.VALUE?.toUpperCase() === "DATE";
  if (isDateOnly && /^\d{8}$/.test(trimmed)) {
    const year = Number(trimmed.slice(0, 4));
    const month = Number(trimmed.slice(4, 6));
    const day = Number(trimmed.slice(6, 8));
    return new Date(Date.UTC(year, month - 1, day));
  }
  if (/^\d{8}T\d{6}Z$/.test(trimmed)) {
    const year = Number(trimmed.slice(0, 4));
    const month = Number(trimmed.slice(4, 6));
    const day = Number(trimmed.slice(6, 8));
    const hours = Number(trimmed.slice(9, 11));
    const minutes = Number(trimmed.slice(11, 13));
    const seconds = Number(trimmed.slice(13, 15));
    return new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
  }
  if (/^\d{8}T\d{6}$/.test(trimmed)) {
    const year = Number(trimmed.slice(0, 4));
    const month = Number(trimmed.slice(4, 6));
    const day = Number(trimmed.slice(6, 8));
    const hours = Number(trimmed.slice(9, 11));
    const minutes = Number(trimmed.slice(11, 13));
    const seconds = Number(trimmed.slice(13, 15));
    const tzid = params.TZID?.trim();
    if (tzid) {
      return parseDateInTimeZone({ year, month, day, hours, minutes, seconds }, tzid);
    }
    return new Date(year, month - 1, day, hours, minutes, seconds);
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseDateInTimeZone(
  parts: { year: number; month: number; day: number; hours: number; minutes: number; seconds: number },
  timeZone: string,
) {
  let guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hours, parts.minutes, parts.seconds);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const zoned = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(guess));
    const map = Object.fromEntries(
      zoned
        .filter((entry) => entry.type !== "literal")
        .map((entry) => [entry.type, entry.value]),
    );
    const zonedUtc = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour),
      Number(map.minute),
      Number(map.second),
    );
    const desiredUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hours,
      parts.minutes,
      parts.seconds,
    );
    guess += desiredUtc - zonedUtc;
  }
  return new Date(guess);
}

function parseRRule(raw: string | undefined): RecurrenceRule | null {
  if (!raw?.trim()) {
    return null;
  }
  const fields = Object.fromEntries(
    raw.split(";").map((part) => {
      const [keyRaw, valueRaw = ""] = part.split("=");
      return [(keyRaw ?? "").trim().toUpperCase(), valueRaw.trim()];
    }),
  );
  return {
    freq: fields.FREQ?.toUpperCase(),
    interval: Math.max(1, Number(fields.INTERVAL || "1") || 1),
    count: fields.COUNT ? Math.max(1, Number(fields.COUNT) || 1) : undefined,
    until: fields.UNTIL ? parseIcsDateValue(fields.UNTIL, {}) ?? undefined : undefined,
    byDay: fields.BYDAY ? fields.BYDAY.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean) : undefined,
    byMonthDay: fields.BYMONTHDAY
      ? fields.BYMONTHDAY.split(",").map((value) => Number(value.trim())).filter((value) => Number.isFinite(value))
      : undefined,
  };
}

function parseEvents(icsText: string) {
  const lines = unfoldIcsLines(icsText);
  const events: ParsedEvent[] = [];
  let current: ParsedEvent | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "BEGIN:VEVENT") {
      current = { exdates: [] };
      continue;
    }
    if (trimmed === "END:VEVENT") {
      if (current) {
        events.push(current);
      }
      current = null;
      continue;
    }
    if (!current) {
      continue;
    }

    const property = parseProperty(trimmed);
    if (!property) {
      continue;
    }

    switch (property.name) {
      case "UID":
        current.uid = property.value.trim();
        break;
      case "SUMMARY":
        current.summary = property.value.trim();
        break;
      case "LOCATION":
        current.location = property.value.trim();
        break;
      case "DTSTART":
        current.dtstart = property;
        break;
      case "DTEND":
        current.dtend = property;
        break;
      case "RRULE":
        current.rrule = property.value.trim();
        break;
      case "EXDATE":
        current.exdates.push(property);
        break;
      case "RECURRENCE-ID":
        current.recurrenceId = property;
        break;
      default:
        break;
    }
  }
  return events;
}

function parseExdates(properties: ParsedProperty[]) {
  const values = new Set<string>();
  for (const property of properties) {
    for (const rawValue of property.value.split(",")) {
      const parsed = parseIcsDateValue(rawValue, property.params);
      if (parsed) {
        values.add(toIso(parsed));
      }
    }
  }
  return values;
}

function overlapsWindow(start: Date, end: Date | undefined, windowStart: Date, windowEnd: Date) {
  const effectiveEnd = end ?? start;
  return start.getTime() <= windowEnd.getTime() && effectiveEnd.getTime() >= windowStart.getTime();
}

function durationMs(start: Date, end?: Date) {
  if (!end) {
    return undefined;
  }
  return Math.max(0, end.getTime() - start.getTime());
}

function buildOccurrence(event: ParsedEvent, start: Date, end: Date | undefined): CalendarOccurrence | null {
  const title = event.summary?.trim();
  const uid = event.uid?.trim();
  if (!uid || !title) {
    return null;
  }
  return {
    uid,
    title,
    start,
    end,
    location: event.location?.trim() || undefined,
    requiresTransit: inferRequiresTransit(event.location),
  };
}

function expandDailyOccurrences(
  event: ParsedEvent,
  start: Date,
  end: Date | undefined,
  rule: RecurrenceRule,
  exdates: Set<string>,
  windowStart: Date,
  windowEnd: Date,
) {
  const results: CalendarOccurrence[] = [];
  const duration = durationMs(start, end);
  let candidate = new Date(start);
  let emittedCount = 0;
  const hardStop = addDays(windowEnd, 2);
  while (candidate.getTime() <= hardStop.getTime()) {
    emittedCount += 1;
    const candidateEnd = duration === undefined ? undefined : new Date(candidate.getTime() + duration);
    if (
      !exdates.has(toIso(candidate))
      && overlapsWindow(candidate, candidateEnd, windowStart, windowEnd)
    ) {
      const occurrence = buildOccurrence(event, new Date(candidate), candidateEnd);
      if (occurrence) {
        results.push(occurrence);
      }
    }
    if (rule.count && emittedCount >= rule.count) {
      break;
    }
    candidate = addDays(candidate, rule.interval);
    if (rule.until && candidate.getTime() > rule.until.getTime()) {
      break;
    }
  }
  return results;
}

function expandWeeklyOccurrences(
  event: ParsedEvent,
  start: Date,
  end: Date | undefined,
  rule: RecurrenceRule,
  exdates: Set<string>,
  windowStart: Date,
  windowEnd: Date,
) {
  const results: CalendarOccurrence[] = [];
  const duration = durationMs(start, end);
  const byDays = rule.byDay && rule.byDay.length > 0 ? rule.byDay : [weekdayToken(start)];
  const timeSeed = {
    hours: start.getUTCHours(),
    minutes: start.getUTCMinutes(),
    seconds: start.getUTCSeconds(),
    milliseconds: start.getUTCMilliseconds(),
  };
  let emittedCount = 0;
  for (let day = startOfUtcDay(start); day.getTime() <= windowEnd.getTime(); day = addDays(day, 1)) {
    if (day.getTime() < startOfUtcDay(start).getTime()) {
      continue;
    }
    const candidate = new Date(Date.UTC(
      day.getUTCFullYear(),
      day.getUTCMonth(),
      day.getUTCDate(),
      timeSeed.hours,
      timeSeed.minutes,
      timeSeed.seconds,
      timeSeed.milliseconds,
    ));
    if (candidate.getTime() < start.getTime()) {
      continue;
    }
    if (!byDays.includes(weekdayToken(candidate))) {
      continue;
    }
    const weeksSinceStart = Math.floor((startOfUtcDay(candidate).getTime() - startOfUtcDay(start).getTime()) / (7 * 86_400_000));
    if (weeksSinceStart % rule.interval !== 0) {
      continue;
    }
    if (rule.until && candidate.getTime() > rule.until.getTime()) {
      break;
    }
    emittedCount += 1;
    const candidateEnd = duration === undefined ? undefined : new Date(candidate.getTime() + duration);
    if (
      !exdates.has(toIso(candidate))
      && overlapsWindow(candidate, candidateEnd, windowStart, windowEnd)
    ) {
      const occurrence = buildOccurrence(event, candidate, candidateEnd);
      if (occurrence) {
        results.push(occurrence);
      }
    }
    if (rule.count && emittedCount >= rule.count) {
      break;
    }
  }
  return results;
}

function expandMonthlyOccurrences(
  event: ParsedEvent,
  start: Date,
  end: Date | undefined,
  rule: RecurrenceRule,
  exdates: Set<string>,
  windowStart: Date,
  windowEnd: Date,
) {
  const results: CalendarOccurrence[] = [];
  const duration = durationMs(start, end);
  const byMonthDays = rule.byMonthDay && rule.byMonthDay.length > 0 ? rule.byMonthDay : [start.getUTCDate()];
  let emittedCount = 0;
  for (let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)); cursor.getTime() <= windowEnd.getTime(); cursor = addMonths(cursor, rule.interval)) {
    for (const monthDay of byMonthDays) {
      const candidate = new Date(Date.UTC(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth(),
        monthDay,
        start.getUTCHours(),
        start.getUTCMinutes(),
        start.getUTCSeconds(),
        start.getUTCMilliseconds(),
      ));
      if (candidate.getUTCMonth() !== cursor.getUTCMonth() || candidate.getTime() < start.getTime()) {
        continue;
      }
      if (rule.until && candidate.getTime() > rule.until.getTime()) {
        return results;
      }
      emittedCount += 1;
      const candidateEnd = duration === undefined ? undefined : new Date(candidate.getTime() + duration);
      if (
        !exdates.has(toIso(candidate))
        && overlapsWindow(candidate, candidateEnd, windowStart, windowEnd)
      ) {
        const occurrence = buildOccurrence(event, candidate, candidateEnd);
        if (occurrence) {
          results.push(occurrence);
        }
      }
      if (rule.count && emittedCount >= rule.count) {
        return results;
      }
    }
  }
  return results;
}

function parseCalendarOccurrences(icsText: string, reference: Date, lookaheadDays = DEFAULT_LOOKAHEAD_DAYS) {
  const events = parseEvents(icsText);
  const overrides = new Map<string, ParsedEvent>();
  const baseEvents: ParsedEvent[] = [];

  for (const event of events) {
    if (event.recurrenceId?.value) {
      const recurrenceId = parseIcsDateValue(event.recurrenceId.value, event.recurrenceId.params);
      if (event.uid && recurrenceId) {
        overrides.set(`${event.uid}::${toIso(recurrenceId)}`, event);
      }
      continue;
    }
    baseEvents.push(event);
  }

  const windowStart = addDays(reference, -1);
  const windowEnd = addDays(reference, lookaheadDays);
  const occurrences: CalendarOccurrence[] = [];

  for (const event of baseEvents) {
    const start = event.dtstart ? parseIcsDateValue(event.dtstart.value, event.dtstart.params) : null;
    if (!start) {
      continue;
    }
    const end = event.dtend ? parseIcsDateValue(event.dtend.value, event.dtend.params) ?? undefined : undefined;
    const exdates = parseExdates(event.exdates);
    const rule = parseRRule(event.rrule);
    const generated = !rule
      ? (() => {
          if (!overlapsWindow(start, end, windowStart, windowEnd)) {
            return [];
          }
          const occurrence = buildOccurrence(event, start, end);
          return occurrence ? [occurrence] : [];
        })()
      : rule.freq === "DAILY"
        ? expandDailyOccurrences(event, start, end, rule, exdates, windowStart, windowEnd)
        : rule.freq === "WEEKLY"
          ? expandWeeklyOccurrences(event, start, end, rule, exdates, windowStart, windowEnd)
          : rule.freq === "MONTHLY"
            ? expandMonthlyOccurrences(event, start, end, rule, exdates, windowStart, windowEnd)
            : [];

    for (const occurrence of generated) {
      const override = overrides.get(`${occurrence.uid}::${toIso(occurrence.start)}`);
      if (!override) {
        occurrences.push(occurrence);
        continue;
      }
      const overrideStart = override.dtstart
        ? parseIcsDateValue(override.dtstart.value, override.dtstart.params)
        : occurrence.start;
      const overrideEnd = override.dtend
        ? parseIcsDateValue(override.dtend.value, override.dtend.params) ?? occurrence.end
        : occurrence.end;
      const replaced = buildOccurrence(
        {
          ...event,
          ...override,
          exdates: [],
        },
        overrideStart ?? occurrence.start,
        overrideEnd,
      );
      if (replaced) {
        occurrences.push(replaced);
      }
    }
  }

  return occurrences
    .sort((left, right) => left.start.getTime() - right.start.getTime())
    .map((entry) => ({
      title: entry.title,
      start: toIso(entry.start),
      end: entry.end ? toIso(entry.end) : undefined,
      location: entry.location,
      requiresTransit: entry.requiresTransit,
    } satisfies CalendarHintEvent));
}

function clampBackoffMs(consecutiveFailures: number) {
  return Math.min(DEFAULT_INITIAL_BACKOFF_MS * (2 ** Math.max(0, consecutiveFailures - 1)), MAX_CONSECUTIVE_BACKOFF_MS);
}

export class CalendarSyncService {
  constructor(
    private readonly routines: RoutinesService,
    private readonly state = new CalendarSyncStateService(),
    private readonly fetchImpl: FetchLike = fetch,
    private readonly urlOverride?: string,
  ) {}

  getConfiguredSourceUrl() {
    return this.urlOverride?.trim() || getRuntimeConfig().calendar.icsUrl.trim() || "";
  }

  async syncIfNeeded(params?: {
    reference?: Date;
    force?: boolean;
    maxAgeMs?: number;
    lookaheadDays?: number;
  }) {
    return traceSpan(
      "calendar.sync",
      async () => {
        const sourceUrl = this.getConfiguredSourceUrl();
        if (!sourceUrl) {
          return { ok: false as const, reason: "no_config" as const };
        }

        const reference = params?.reference ?? new Date();
        const current = this.state.load();
        if (!params?.force) {
          const nextAttemptAt = current.nextAttemptAt ? new Date(current.nextAttemptAt) : null;
          if (nextAttemptAt && nextAttemptAt.getTime() > reference.getTime()) {
            return { ok: false as const, reason: "backoff" as const, nextAttemptAt: current.nextAttemptAt };
          }

          const lastCompletedAt = current.lastCompletedAt ? new Date(current.lastCompletedAt) : null;
          const maxAgeMs = params?.maxAgeMs ?? DEFAULT_SYNC_INTERVAL_MS;
          if (lastCompletedAt && reference.getTime() - lastCompletedAt.getTime() < maxAgeMs) {
            return { ok: true as const, reason: "fresh" as const, eventCount: this.routines.loadData().calendarEvents.length };
          }
        }

        const headers: Record<string, string> = {
          Accept: "text/calendar,text/plain;q=0.9,*/*;q=0.1",
        };
        if (current.etag) {
          headers["If-None-Match"] = current.etag;
        }
        if (current.lastModified) {
          headers["If-Modified-Since"] = current.lastModified;
        }

        const response = await this.fetchImpl(sourceUrl, {
          method: "GET",
          headers,
        });

        const attemptedAt = toIso(reference);
        if (response.status === 304) {
          const retryAfter = response.headers.get("retry-after");
          this.state.save({
            ...current,
            lastAttemptAt: attemptedAt,
            lastCompletedAt: attemptedAt,
            nextAttemptAt: retryAfter
              ? new Date(reference.getTime() + Number(retryAfter) * 1000).toISOString()
              : undefined,
            consecutiveFailures: 0,
            etag: response.headers.get("etag") ?? current.etag,
            lastModified: response.headers.get("last-modified") ?? current.lastModified,
          });
          return { ok: true as const, reason: "not_modified" as const, eventCount: this.routines.loadData().calendarEvents.length };
        }

        if (!response.ok) {
          const retryAfterSeconds = Number(response.headers.get("retry-after") ?? "");
          const consecutiveFailures = (current.consecutiveFailures ?? 0) + 1;
          const backoffMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : clampBackoffMs(consecutiveFailures);
          this.state.save({
            ...current,
            lastAttemptAt: attemptedAt,
            lastFailureAt: attemptedAt,
            nextAttemptAt: new Date(reference.getTime() + backoffMs).toISOString(),
            consecutiveFailures,
          });
          return { ok: false as const, reason: "http_error" as const, status: response.status };
        }

        const icsText = await response.text();
        const events = parseCalendarOccurrences(
          icsText,
          reference,
          params?.lookaheadDays ?? DEFAULT_LOOKAHEAD_DAYS,
        );
        this.routines.replaceCalendarEvents(events);
        this.state.save({
          lastAttemptAt: attemptedAt,
          lastCompletedAt: attemptedAt,
          consecutiveFailures: 0,
          nextAttemptAt: undefined,
          lastFailureAt: undefined,
          etag: response.headers.get("etag") ?? current.etag,
          lastModified: response.headers.get("last-modified") ?? current.lastModified,
        });
        return { ok: true as const, reason: "updated" as const, eventCount: events.length };
      },
      {
        attributes: {
          configured: Boolean(this.getConfiguredSourceUrl()),
          force: Boolean(params?.force),
        },
      },
    );
  }
}

export { parseCalendarOccurrences };
