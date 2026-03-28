import type {
  HeartbeatReminderCandidate,
  QuietHoursSettings,
  ReminderPolicy,
  RoutineAssessment,
  RoutineContext,
  RoutineItem,
  RoutineItemKind,
  RoutinePriority,
  RoutineSchedule,
  RoutineState,
  RoutineStoreData,
  Weekday,
} from "../../domain/routines";
import {
  parseIso,
  toIso,
  localDateKey,
  parseTime,
  setTime,
  addDaysLocal as addDays,
  setDayOfMonth,
  weekdayKey,
  startOfDay,
} from "../../utils/time-helpers";

export function trimHistory(values: string[], limit: number) {
  return values.slice(Math.max(0, values.length - limit));
}

export function defaultReminderPolicy(kind: RoutineItemKind): ReminderPolicy {
  if (kind === "med" || kind === "precommitment") {
    return { followUpMinutes: 60, maxReminders: 3, escalate: true };
  }
  if (kind === "deadline") {
    return { followUpMinutes: 120, maxReminders: 3, escalate: true };
  }
  return { followUpMinutes: 180, maxReminders: 2, escalate: false };
}

export function isTodoKind(kind: RoutineItemKind) {
  return kind.startsWith("todo");
}

export function createInitialState(): RoutineState {
  return {
    completionHistory: [],
    skippedOccurrenceKeys: [],
    reminderCountForOccurrence: 0,
  };
}

export function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function makeRoutineId(kind: RoutineItemKind, title: string) {
  return `${kind}_${slugify(title)}_${Date.now().toString(36)}`;
}

export function computePriorityScore(priority: RoutinePriority) {
  switch (priority) {
    case "urgent":
      return 100;
    case "high":
      return 70;
    case "medium":
      return 40;
    default:
      return 10;
  }
}

export function isWorkScopedItem(item: Pick<RoutineItem, "jobId" | "projectId">) {
  return Boolean(item.jobId);
}

export function computeRoutineContext(data: RoutineStoreData, now: Date, effectiveTimezone?: string): RoutineContext {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const inBlock = (block: { days: Weekday[]; start: string; end: string }) => {
    if (!block.days.includes(weekdayKey(now))) {
      return false;
    }
    const start = parseTime(block.start);
    const end = parseTime(block.end);
    const startMinutes = start.hours * 60 + start.minutes;
    const endMinutes = end.hours * 60 + end.minutes;
    if (startMinutes < endMinutes) {
      return nowMinutes >= startMinutes && nowMinutes < endMinutes;
    }
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
  };

  const transitEvent = data.calendarEvents.find((event) => {
    const start = parseIso(event.start);
    if (!start) {
      return false;
    }
    const deltaMinutes = Math.floor((start.getTime() - now.getTime()) / 60000);
    return deltaMinutes >= 0 && deltaMinutes <= 30 && event.requiresTransit;
  });

  return {
    timezone: effectiveTimezone ?? data.settings.timezone,
    now: toIso(now),
    mode: inBlock(data.settings.sleepBlock)
      ? "sleep"
      : inBlock(data.settings.workBlock)
        ? "work"
        : "personal",
    transitEventTitle: transitEvent?.title,
  };
}

export function minutesSinceMidnight(date: Date) {
  return date.getHours() * 60 + date.getMinutes();
}

export function isWithinTimeWindow(date: Date, window: Pick<QuietHoursSettings, "start" | "end">) {
  const nowMinutes = minutesSinceMidnight(date);
  const start = parseTime(window.start);
  const end = parseTime(window.end);
  const startMinutes = start.hours * 60 + start.minutes;
  const endMinutes = end.hours * 60 + end.minutes;

  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }

  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

export function nextWindowBoundary(
  date: Date,
  window: Pick<QuietHoursSettings, "start" | "end">,
) {
  const { end } = window;
  const endToday = setTime(date, end);
  if (isWithinTimeWindow(date, window)) {
    if (endToday.getTime() > date.getTime()) {
      return endToday;
    }
    return addDays(endToday, 1);
  }
  return date;
}

export function findDailyWithDaysOccurrence(
  schedule: Extract<RoutineSchedule, { kind: "daily" }>,
  days: Weekday[],
  now: Date,
  dayResetHour = 0,
) {
  const dayAnchor = new Date(now.getTime() - dayResetHour * 3600000);

  // If the anchor day is a matching day, behave like a plain daily schedule.
  if (days.includes(weekdayKey(dayAnchor))) {
    const dueAt = setTime(dayAnchor, schedule.time);
    return {
      occurrenceKey: localDateKey(dayAnchor),
      dueAt,
      state: dueAt.getTime() <= now.getTime() ? ("due" as const) : ("upcoming" as const),
    };
  }

  // Anchor day is not a matching day — find the nearest upcoming matching day.
  const today = startOfDay(dayAnchor);
  let bestUpcoming: Date | null = null;

  for (let offset = 1; offset <= 7; offset += 1) {
    const candidateDay = addDays(today, offset);
    if (!days.includes(weekdayKey(candidateDay))) {
      continue;
    }
    bestUpcoming = setTime(candidateDay, schedule.time);
    break;
  }

  if (!bestUpcoming) {
    return null;
  }

  return {
    occurrenceKey: localDateKey(bestUpcoming),
    dueAt: bestUpcoming,
    state: "upcoming" as const,
  };
}

export function findWeeklyOccurrence(
  schedule: Extract<RoutineSchedule, { kind: "weekly" }>,
  now: Date,
) {
  const today = startOfDay(now);
  let bestUpcoming: Date | null = null;
  let bestPast: Date | null = null;

  for (let offset = -7; offset <= 7; offset += 1) {
    const candidateDay = addDays(today, offset);
    if (!schedule.days.includes(weekdayKey(candidateDay))) {
      continue;
    }
    const dueAt = setTime(candidateDay, schedule.time);
    if (dueAt.getTime() >= now.getTime()) {
      if (!bestUpcoming || dueAt.getTime() < bestUpcoming.getTime()) {
        bestUpcoming = dueAt;
      }
    } else if (!bestPast || dueAt.getTime() > bestPast.getTime()) {
      bestPast = dueAt;
    }
  }

  const dueAt = bestUpcoming ?? bestPast;
  if (!dueAt) {
    return null;
  }

  return {
    occurrenceKey: localDateKey(dueAt),
    dueAt,
    state: dueAt.getTime() <= now.getTime() ? ("due" as const) : ("upcoming" as const),
  };
}

export function findMonthlyOccurrence(
  schedule: Extract<RoutineSchedule, { kind: "monthly" }>,
  now: Date,
) {
  const dueAt = setTime(setDayOfMonth(startOfDay(now), schedule.dayOfMonth), schedule.time);
  return {
    occurrenceKey: `${dueAt.getFullYear()}-${`${dueAt.getMonth() + 1}`.padStart(2, "0")}`,
    dueAt,
    state: dueAt.getTime() <= now.getTime() ? ("due" as const) : ("upcoming" as const),
  };
}

export function findCurrentOccurrence(
  item: RoutineItem,
  now: Date,
  dayResetHour = 0,
): { occurrenceKey: string; dueAt: Date; state: "due" | "upcoming" } | null {
  const schedule = item.schedule;
  if (schedule.kind === "manual") {
    return null;
  }

  if (schedule.kind === "once") {
    const dueAt = parseIso(schedule.dueAt);
    if (!dueAt) {
      return null;
    }
    return {
      occurrenceKey: dueAt.toISOString(),
      dueAt,
      state: dueAt.getTime() <= now.getTime() ? "due" : "upcoming",
    };
  }

  if (schedule.kind === "daily") {
    if (schedule.days && schedule.days.length > 0) {
      return findDailyWithDaysOccurrence(schedule, schedule.days, now, dayResetHour);
    }
    const dayAnchor = new Date(now.getTime() - dayResetHour * 3600000);
    const dueAt = setTime(dayAnchor, schedule.time);
    return {
      occurrenceKey: localDateKey(dayAnchor),
      dueAt,
      state: dueAt.getTime() <= now.getTime() ? "due" : "upcoming",
    };
  }

  if (schedule.kind === "weekly") {
    return findWeeklyOccurrence(schedule, now);
  }

  if (schedule.kind === "monthly") {
    return findMonthlyOccurrence(schedule, now);
  }

  const lastCompleted = parseIso(item.state.lastCompletedAt);
  const base = lastCompleted
    ? new Date(lastCompleted)
    : schedule.anchorAt
      ? new Date(schedule.anchorAt)
      : startOfDay(now);
  const dueAt = setTime(addDays(base, lastCompleted ? schedule.everyDays : 0), schedule.time);
  return {
    occurrenceKey: dueAt.toISOString(),
    dueAt,
    state: dueAt.getTime() <= now.getTime() ? "due" : "upcoming",
  };
}

export function countsAsCompleted(item: RoutineItem, occurrence: { dueAt: Date }, dayResetHour = 0) {
  const lastCompleted = parseIso(item.state.lastCompletedAt);
  if (!lastCompleted) {
    return false;
  }

  if (
    item.schedule.kind === "once" ||
    item.schedule.kind === "interval" ||
    item.schedule.kind === "monthly"
  ) {
    return lastCompleted.getTime() >= occurrence.dueAt.getTime();
  }

  const shiftMs = dayResetHour * 3600000;
  return localDateKey(new Date(lastCompleted.getTime() - shiftMs)) === localDateKey(new Date(occurrence.dueAt.getTime() - shiftMs));
}

export function countsAsSkipped(item: RoutineItem, occurrenceKey: string) {
  return item.state.skippedOccurrenceKeys.includes(occurrenceKey);
}

export function currentReminderCount(item: RoutineItem, occurrenceKey: string) {
  return item.state.activeOccurrenceKey === occurrenceKey ? item.state.reminderCountForOccurrence : 0;
}

export function reminderStage(item: RoutineItem, occurrenceKey: string): RoutineAssessment["reminderStage"] {
  const count = currentReminderCount(item, occurrenceKey);
  if (count <= 0) {
    return "initial";
  }
  if (!item.reminder.escalate || count === 1) {
    return "follow_up";
  }
  return "escalated";
}

export function attentionLevelFromAssessment(
  item: RoutineItem,
  occurrence: { dueAt?: Date; state: RoutineAssessment["state"] },
  shouldRemindNow: boolean,
  isManualBacklog: boolean,
) {
  if (shouldRemindNow) {
    return "required" as const;
  }
  if (isManualBacklog) {
    return "none" as const;
  }
  if (
    occurrence.state === "upcoming"
    && (item.priority === "high" || item.priority === "urgent" || item.kind === "med")
  ) {
    return "optional" as const;
  }
  return "none" as const;
}

export function shouldSuppressForContext(
  item: RoutineItem,
  context: RoutineContext,
  state: "due" | "upcoming",
) {
  if (context.mode !== "sleep") {
    return false;
  }
  if (item.kind === "med" || item.kind === "precommitment" || item.priority === "urgent") {
    return false;
  }
  return state === "upcoming" || item.priority === "low";
}

export function sortAssessments(items: RoutineAssessment[]) {
  return items.sort((a, b) => {
    if (a.shouldRemindNow !== b.shouldRemindNow) {
      return a.shouldRemindNow ? -1 : 1;
    }
    if (a.priorityScore !== b.priorityScore) {
      return b.priorityScore - a.priorityScore;
    }
    return a.minutesUntilDue - b.minutesUntilDue;
  });
}

export function toHeartbeatReminderCandidate(assessment: RoutineAssessment): HeartbeatReminderCandidate {
  return {
    itemId: assessment.item.id,
    profileId: assessment.item.profileId,
    title: assessment.item.title,
    kind: assessment.item.kind,
    priority: assessment.item.priority,
    state: assessment.state,
    dueAt: assessment.dueAt,
    occurrenceKey: assessment.occurrenceKey,
    minutesUntilDue: assessment.minutesUntilDue,
    overdueMinutes: assessment.overdueMinutes,
    reminderStage: assessment.reminderStage,
    reason: assessment.reason,
    isManualBacklog: assessment.isManualBacklog,
  };
}

export function formatSchedule(schedule: RoutineSchedule) {
  switch (schedule.kind) {
    case "manual":
      return "manual";
    case "once":
      return `once @ ${schedule.dueAt}`;
    case "daily":
      return schedule.days && schedule.days.length > 0
        ? `daily ${schedule.days.join(",")} @ ${schedule.time}`
        : `daily @ ${schedule.time}`;
    case "weekly":
      return `weekly ${schedule.days.join(",")} @ ${schedule.time}`;
    case "interval":
      return `every ${schedule.everyDays}d @ ${schedule.time}`;
    case "monthly":
      return `monthly day ${schedule.dayOfMonth} @ ${schedule.time}`;
  }
}
