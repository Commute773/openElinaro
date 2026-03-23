import type { Database } from "bun:sqlite";
import { getLocalTimezone } from "./local-time-service";
import { openDatabase, withSqliteRetry } from "../utils/sqlite-helpers";
import { resolveRuntimePath } from "./runtime-root";
import { telemetry as rootTelemetry, type TelemetryService } from "./telemetry";

export type AlarmKind = "alarm" | "timer";
export type AlarmState = "pending" | "delivered" | "cancelled" | "all";

export interface ScheduledAlarm {
  id: string;
  kind: AlarmKind;
  name: string;
  triggerAt: string;
  timezone: string;
  createdAt: string;
  originalSpec: string;
  deliveredAt?: string;
  cancelledAt?: string;
}

type AlarmScheduleChangeListener = () => void;

type StoredAlarmRow = {
  id: string;
  kind: AlarmKind;
  name: string;
  trigger_at: string;
  timezone: string;
  created_at: string;
  original_spec: string;
  delivered_at: string | null;
  cancelled_at: string | null;
};

const CLOCK_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DURATION_PATTERN = /^(\d+)(s|m|h|d)$/i;

function getDbPath() {
  return resolveRuntimePath("alarms.sqlite");
}

function timestamp(reference = new Date()) {
  return reference.toISOString();
}

function mapRow(row: StoredAlarmRow): ScheduledAlarm {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    triggerAt: row.trigger_at,
    timezone: row.timezone,
    createdAt: row.created_at,
    originalSpec: row.original_spec,
    deliveredAt: row.delivered_at ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
  };
}

function localDateParts(reference: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(reference);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error(`Unable to resolve local date in timezone ${timezone}.`);
  }
  return { year, month, day };
}

function resolveTimezoneOffsetMinutes(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const token = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
  const match = token.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!match) {
    return 0;
  }
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number.parseInt(match[2] ?? "0", 10);
  const minutes = Number.parseInt(match[3] ?? "0", 10);
  return sign * (hours * 60 + minutes);
}

function buildLocalClockOccurrence(time: string, timezone: string, reference = new Date()) {
  const match = time.match(CLOCK_TIME_PATTERN);
  if (!match) {
    throw new Error("Alarm time must be an ISO timestamp or local HH:MM.");
  }

  const hours = Number.parseInt(match[1] ?? "0", 10);
  const minutes = Number.parseInt(match[2] ?? "0", 10);
  const dateParts = localDateParts(reference, timezone);
  const baseUtc = Date.UTC(
    Number.parseInt(dateParts.year, 10),
    Number.parseInt(dateParts.month, 10) - 1,
    Number.parseInt(dateParts.day, 10),
    hours,
    minutes,
    0,
    0,
  );
  const sameDay = new Date(baseUtc - resolveTimezoneOffsetMinutes(reference, timezone) * 60_000);
  if (sameDay.getTime() > reference.getTime()) {
    return sameDay;
  }

  const nextDayReference = new Date(reference.getTime() + 24 * 60 * 60 * 1000);
  const nextDateParts = localDateParts(nextDayReference, timezone);
  const nextUtc = Date.UTC(
    Number.parseInt(nextDateParts.year, 10),
    Number.parseInt(nextDateParts.month, 10) - 1,
    Number.parseInt(nextDateParts.day, 10),
    hours,
    minutes,
    0,
    0,
  );
  return new Date(nextUtc - resolveTimezoneOffsetMinutes(nextDayReference, timezone) * 60_000);
}

function parseAlarmTime(input: string, timezone: string, reference = new Date()) {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Alarm time is required.");
  }

  if (CLOCK_TIME_PATTERN.test(trimmed)) {
    return buildLocalClockOccurrence(trimmed, timezone, reference);
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Alarm time must be an ISO timestamp or local HH:MM.");
  }
  if (parsed.getTime() <= reference.getTime()) {
    throw new Error("Alarm time must be in the future.");
  }
  return parsed;
}

function parseDuration(duration: string) {
  const trimmed = duration.trim();
  const match = trimmed.match(DURATION_PATTERN);
  if (!match) {
    throw new Error("Timer duration must use s, m, h, or d suffixes such as 10m, 2h, or 1d.");
  }
  const value = Number.parseInt(match[1] ?? "0", 10);
  const unit = (match[2] ?? "").toLowerCase();
  const multiplier = unit === "s"
    ? 1_000
    : unit === "m"
      ? 60_000
      : unit === "h"
        ? 3_600_000
        : 86_400_000;
  return value * multiplier;
}

export class AlarmService {
  private readonly db: Database;
  private readonly telemetry: TelemetryService;
  private readonly scheduleChangeListeners = new Set<AlarmScheduleChangeListener>();

  constructor(
    private readonly dbPath = getDbPath(),
    telemetry: TelemetryService = rootTelemetry.child({ component: "alarm" }),
  ) {
    this.telemetry = telemetry;
    this.db = openDatabase(this.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alarms (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        trigger_at TEXT NOT NULL,
        timezone TEXT NOT NULL,
        created_at TEXT NOT NULL,
        original_spec TEXT NOT NULL,
        delivered_at TEXT,
        cancelled_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_alarms_pending_trigger_at
      ON alarms(trigger_at)
      WHERE delivered_at IS NULL AND cancelled_at IS NULL;
    `);
  }

  setAlarm(name: string, time: string, reference = new Date()) {
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error("Alarm name is required.");
    }
    const timezone = getLocalTimezone();
    const triggerAt = parseAlarmTime(time, timezone, reference);
    const alarm = {
      id: `alarm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: "alarm" as const,
      name: trimmedName,
      triggerAt: timestamp(triggerAt),
      timezone,
      createdAt: timestamp(reference),
      originalSpec: time.trim(),
    };
    this.telemetry.instrumentStoreWrite({
      operation: "alarm.create",
      entityType: "alarm",
      entityId: alarm.id,
      attributes: alarm,
    }, () => {
      withSqliteRetry(() => {
        this.db.query(
          `INSERT INTO alarms (id, kind, name, trigger_at, timezone, created_at, original_spec)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        ).run(
          alarm.id,
          alarm.kind,
          alarm.name,
          alarm.triggerAt,
          alarm.timezone,
          alarm.createdAt,
          alarm.originalSpec,
        );
      }, { label: "alarm-service" });
    });
    this.notifyScheduleChanged();
    return alarm;
  }

  setTimer(name: string, duration: string, reference = new Date()) {
    const trimmedName = name.trim();
    if (!trimmedName) {
      throw new Error("Timer name is required.");
    }
    const durationMs = parseDuration(duration);
    const timezone = getLocalTimezone();
    const triggerAt = new Date(reference.getTime() + durationMs);
    const timer = {
      id: `timer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: "timer" as const,
      name: trimmedName,
      triggerAt: timestamp(triggerAt),
      timezone,
      createdAt: timestamp(reference),
      originalSpec: duration.trim(),
    };
    this.telemetry.instrumentStoreWrite({
      operation: "alarm.create",
      entityType: "alarm",
      entityId: timer.id,
      attributes: timer,
    }, () => {
      withSqliteRetry(() => {
        this.db.query(
          `INSERT INTO alarms (id, kind, name, trigger_at, timezone, created_at, original_spec)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        ).run(
          timer.id,
          timer.kind,
          timer.name,
          timer.triggerAt,
          timer.timezone,
          timer.createdAt,
          timer.originalSpec,
        );
      }, { label: "alarm-service" });
    });
    this.notifyScheduleChanged();
    return timer;
  }

  listAlarms(options?: {
    state?: AlarmState;
    limit?: number;
  }) {
    const state = options?.state ?? "pending";
    const limit = options?.limit ?? 20;
    const clauses: string[] = [];
    if (state === "pending") {
      clauses.push("delivered_at IS NULL", "cancelled_at IS NULL");
    } else if (state === "delivered") {
      clauses.push("delivered_at IS NOT NULL");
    } else if (state === "cancelled") {
      clauses.push("cancelled_at IS NOT NULL");
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db.query(
      `SELECT id, kind, name, trigger_at, timezone, created_at, original_spec, delivered_at, cancelled_at
       FROM alarms
       ${whereClause}
       ORDER BY trigger_at ASC
       LIMIT ?1`,
    ).all(limit).map((row) => mapRow(row as StoredAlarmRow));
  }

  getNextDueAt() {
    const row = this.db.query(
      `SELECT trigger_at
       FROM alarms
       WHERE delivered_at IS NULL AND cancelled_at IS NULL
       ORDER BY trigger_at ASC
       LIMIT 1`,
    ).get() as { trigger_at?: string } | null;
    return row?.trigger_at ?? null;
  }

  listDueAlarms(reference = new Date(), limit = 20) {
    return this.db.query(
      `SELECT id, kind, name, trigger_at, timezone, created_at, original_spec, delivered_at, cancelled_at
       FROM alarms
       WHERE delivered_at IS NULL AND cancelled_at IS NULL AND trigger_at <= ?1
       ORDER BY trigger_at ASC
       LIMIT ?2`,
    ).all(timestamp(reference), limit).map((row) => mapRow(row as StoredAlarmRow));
  }

  cancelAlarm(id: string, reference = new Date()) {
    const row = this.db.query(
      `SELECT id, kind, name, trigger_at, timezone, created_at, original_spec, delivered_at, cancelled_at
       FROM alarms
       WHERE id = ?1`,
    ).get(id) as StoredAlarmRow | null;
    if (!row) {
      throw new Error(`Alarm or timer not found: ${id}`);
    }
    if (!row.cancelled_at) {
      this.telemetry.instrumentStoreWrite({
        operation: "alarm.cancel",
        entityType: "alarm",
        entityId: id,
      }, () => {
        withSqliteRetry(() => {
          this.db.query("UPDATE alarms SET cancelled_at = ?2 WHERE id = ?1").run(id, timestamp(reference));
        }, { label: "alarm-service" });
      });
      this.notifyScheduleChanged();
    }
    return mapRow({
      ...row,
      cancelled_at: row.cancelled_at ?? timestamp(reference),
    });
  }

  markDelivered(id: string, reference = new Date()) {
    this.telemetry.instrumentStoreWrite({
      operation: "alarm.deliver",
      entityType: "alarm",
      entityId: id,
    }, () => {
      withSqliteRetry(() => {
        this.db.query("UPDATE alarms SET delivered_at = ?2 WHERE id = ?1").run(id, timestamp(reference));
      }, { label: "alarm-service" });
    });
    this.notifyScheduleChanged();
  }

  onScheduleChanged(listener: AlarmScheduleChangeListener) {
    this.scheduleChangeListeners.add(listener);
    return () => {
      this.scheduleChangeListeners.delete(listener);
    };
  }

  private notifyScheduleChanged() {
    for (const listener of this.scheduleChangeListeners) {
      listener();
    }
  }
}
