import type {
  CalendarHintEvent,
  HeartbeatReminderCandidate,
  HeartbeatReminderSnapshot,
  QuietHoursSettings,
  ReminderPolicy,
  RoutineAssessment,
  RoutineContext,
  RoutineItem,
  RoutineItemKind,
  RoutinePriority,
  RoutineSchedule,
  RoutineState,
  RoutineStatus,
  RoutineStoreData,
  Weekday,
} from "../domain/routines";
import { ProfileService } from "./profile-service";
import { ProjectsService } from "./projects-service";
import { RoutinesStore } from "./routines-store";
import { formatLocalTime } from "./local-time-service";
import { telemetry } from "./telemetry";
import { nowInTimezone, parseIso, toIso, localDateKey, parseTime, setTime, addDaysLocal as addDays, addMonthsLocal as addMonths, setDayOfMonth, weekdayKey, startOfDay, isSameLocalDay } from "../utils/time-helpers";

function trimHistory(values: string[], limit: number) {
  return values.slice(Math.max(0, values.length - limit));
}

function defaultReminderPolicy(kind: RoutineItemKind): ReminderPolicy {
  if (kind === "med" || kind === "precommitment") {
    return { followUpMinutes: 60, maxReminders: 3, escalate: true };
  }
  if (kind === "deadline") {
    return { followUpMinutes: 120, maxReminders: 3, escalate: true };
  }
  return { followUpMinutes: 180, maxReminders: 2, escalate: false };
}

function isTodoKind(kind: RoutineItemKind) {
  return kind.startsWith("todo");
}

function createInitialState(): RoutineState {
  return {
    completionHistory: [],
    skippedOccurrenceKeys: [],
    reminderCountForOccurrence: 0,
    streak: 0,
  };
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function makeRoutineId(kind: RoutineItemKind, title: string) {
  return `${kind}_${slugify(title)}_${Date.now().toString(36)}`;
}

function computePriorityScore(priority: RoutinePriority) {
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

function isWorkScopedItem(item: Pick<RoutineItem, "jobId" | "projectId">) {
  return Boolean(item.jobId);
}

function computeRoutineContext(data: RoutineStoreData, now: Date, effectiveTimezone?: string): RoutineContext {
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

function minutesSinceMidnight(date: Date) {
  return date.getHours() * 60 + date.getMinutes();
}

function isWithinTimeWindow(date: Date, window: Pick<QuietHoursSettings, "start" | "end">) {
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

function nextWindowBoundary(
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

function findDailyWithDaysOccurrence(
  schedule: Extract<RoutineSchedule, { kind: "daily" }>,
  days: Weekday[],
  now: Date,
) {
  // If today is a matching day, behave like a plain daily schedule.
  if (days.includes(weekdayKey(now))) {
    const dueAt = setTime(now, schedule.time);
    return {
      occurrenceKey: localDateKey(dueAt),
      dueAt,
      state: dueAt.getTime() <= now.getTime() ? ("due" as const) : ("upcoming" as const),
    };
  }

  // Today is not a matching day — find the nearest upcoming matching day.
  const today = startOfDay(now);
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

function findWeeklyOccurrence(
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

function findMonthlyOccurrence(
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

function findCurrentOccurrence(
  item: RoutineItem,
  now: Date,
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
      return findDailyWithDaysOccurrence(schedule, schedule.days, now);
    }
    const dueAt = setTime(now, schedule.time);
    return {
      occurrenceKey: localDateKey(dueAt),
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

function countsAsCompleted(item: RoutineItem, occurrence: { dueAt: Date }) {
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

  return isSameLocalDay(lastCompleted, occurrence.dueAt);
}

function countsAsSkipped(item: RoutineItem, occurrenceKey: string) {
  return item.state.skippedOccurrenceKeys.includes(occurrenceKey);
}

function currentReminderCount(item: RoutineItem, occurrenceKey: string) {
  return item.state.activeOccurrenceKey === occurrenceKey ? item.state.reminderCountForOccurrence : 0;
}

function reminderStage(item: RoutineItem, occurrenceKey: string): RoutineAssessment["reminderStage"] {
  const count = currentReminderCount(item, occurrenceKey);
  if (count <= 0) {
    return "initial";
  }
  if (!item.reminder.escalate || count === 1) {
    return "follow_up";
  }
  return "escalated";
}

function attentionLevelFromAssessment(
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

function shouldSuppressForContext(
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

function updateStreak(item: RoutineItem, completedAt: Date) {
  const lastCompleted = parseIso(item.state.lastCompletedAt);
  if (!lastCompleted) {
    return 1;
  }

  const deltaDays = Math.floor(
    (startOfDay(completedAt).getTime() - startOfDay(lastCompleted).getTime()) / 86400000,
  );
  if (item.schedule.kind === "daily") {
    const maxGap = item.schedule.days && item.schedule.days.length > 0 ? 7 : 1;
    if (deltaDays <= maxGap) {
      return item.state.streak + 1;
    }
    return 1;
  }
  if (item.schedule.kind === "weekly" && deltaDays <= 7) {
    return item.state.streak + 1;
  }
  if (item.schedule.kind === "interval" && deltaDays <= item.schedule.everyDays + 1) {
    return item.state.streak + 1;
  }
  if (item.schedule.kind === "monthly" && deltaDays <= 35) {
    return item.state.streak + 1;
  }
  return 1;
}

function isStreakContinuation(item: RoutineItem, previous: Date, next: Date) {
  const deltaDays = Math.floor(
    (startOfDay(next).getTime() - startOfDay(previous).getTime()) / 86400000,
  );
  if (item.schedule.kind === "daily") {
    const maxGap = item.schedule.days && item.schedule.days.length > 0 ? 7 : 1;
    return deltaDays <= maxGap;
  }
  if (item.schedule.kind === "weekly") {
    return deltaDays <= 7;
  }
  if (item.schedule.kind === "interval") {
    return deltaDays <= item.schedule.everyDays + 1;
  }
  if (item.schedule.kind === "monthly") {
    return deltaDays <= 35;
  }
  return false;
}

function computeStreakFromHistory(item: RoutineItem) {
  const completionDates = item.state.completionHistory
    .map((value) => parseIso(value))
    .filter((value): value is Date => value instanceof Date && !Number.isNaN(value.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());

  if (completionDates.length === 0) {
    return 0;
  }

  if (
    item.schedule.kind === "manual" ||
    item.schedule.kind === "once" ||
    completionDates.length === 1
  ) {
    return 1;
  }

  let streak = 1;
  for (let index = completionDates.length - 1; index > 0; index -= 1) {
    if (!isStreakContinuation(item, completionDates[index - 1]!, completionDates[index]!)) {
      break;
    }
    streak += 1;
  }
  return streak;
}

function sortAssessments(items: RoutineAssessment[]) {
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

function toHeartbeatReminderCandidate(assessment: RoutineAssessment): HeartbeatReminderCandidate {
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

function formatSchedule(schedule: RoutineSchedule) {
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

export class RoutinesService {
  private readonly store = new RoutinesStore();
  private readonly profiles = new ProfileService();
  private readonly activeProfile = this.profiles.getActiveProfile();
  private cachedProjects?: ProjectsService;
  private readonly scheduleChangeListeners = new Set<() => void>();

  constructor(private readonly projects?: ProjectsService) {}

  onScheduleChanged(listener: () => void) {
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

  getTimezone(): string {
    return this.store.load().settings.timezone;
  }

  private isQuietHours(reference: Date = new Date()) {
    const { quietHours } = this.store.load().settings;
    if (!quietHours.enabled) {
      return false;
    }

    const now = nowInTimezone(quietHours.timezone, reference);
    return isWithinTimeWindow(now, quietHours);
  }

  noteNotificationTargetUserId(userId: string) {
    const data = this.store.load();
    if (data.settings.notificationTargetUserId === userId) {
      return;
    }
    data.settings.notificationTargetUserId = userId;
    this.store.save(data);
    telemetry.event("routine.notification_target_updated", {
      entityType: "routine_settings",
      entityId: "global",
      userId,
    });
  }

  getNotificationTargetUserId() {
    return this.store.load().settings.notificationTargetUserId;
  }

  loadData() {
    return this.store.load();
  }

  saveData(data: RoutineStoreData) {
    return this.store.save(data);
  }

  replaceCalendarEvents(events: CalendarHintEvent[]) {
    const data = this.store.load();
    data.calendarEvents = [...events].sort((left, right) => {
      const leftTime = parseIso(left.start)?.getTime() ?? 0;
      const rightTime = parseIso(right.start)?.getTime() ?? 0;
      return leftTime - rightTime;
    });
    this.store.save(data);
    return data.calendarEvents;
  }

  addItem(input: {
    id?: string;
    profileId?: string;
    title: string;
    kind: RoutineItemKind;
    priority?: RoutinePriority;
    status?: RoutineStatus;
    enabled?: boolean;
    description?: string;
    dose?: string;
    labels?: string[];
    jobId?: string;
    projectId?: string;
    blockedBy?: string[];
    alarm?: boolean;
    schedule: RoutineSchedule;
    reminder?: Partial<ReminderPolicy>;
    state?: Partial<RoutineState>;
  }) {
    const data = this.store.load();
    const id = input.id ?? makeRoutineId(input.kind, input.title);
    const status = input.status ?? "active";
    if (status === "completed" && !isTodoKind(input.kind)) {
      throw new Error("Only todo items can use completed status.");
    }
    const reminderDefaults = defaultReminderPolicy(input.kind);
    const existingState = createInitialState();
    const scope = this.resolveWorkScope(input);
    const profileId = this.resolveItemProfileId({
      profileId: input.profileId,
      jobId: scope.jobId,
    });
    const item: RoutineItem = {
      id,
      profileId,
      title: input.title,
      kind: input.kind,
      priority: input.priority ?? "medium",
      status,
      enabled: input.enabled ?? (status !== "paused" && status !== "archived" && status !== "completed"),
      description: input.description,
      dose: input.dose,
      labels: input.labels,
      jobId: scope.jobId,
      projectId: scope.projectId,
      blockedBy: input.blockedBy,
      alarm: input.alarm,
      schedule: input.schedule,
      reminder: {
        followUpMinutes:
          input.reminder?.followUpMinutes ?? reminderDefaults.followUpMinutes,
        maxReminders: input.reminder?.maxReminders ?? reminderDefaults.maxReminders,
        escalate: input.reminder?.escalate ?? reminderDefaults.escalate,
      },
      state: {
        ...existingState,
        ...input.state,
        completionHistory: input.state?.completionHistory ?? existingState.completionHistory,
        skippedOccurrenceKeys:
          input.state?.skippedOccurrenceKeys ?? existingState.skippedOccurrenceKeys,
      },
    };
    data.items[id] = item;
    this.store.save(data);
    telemetry.event("routine.item_added", {
      entityType: "routine",
      entityId: item.id,
      kind: item.kind,
      status: item.status,
    });
    if (item.alarm) {
      this.notifyScheduleChanged();
    }
    return item;
  }

  listItems(filters?: {
    status?: RoutineStatus | "all";
    kind?: RoutineItemKind | "all";
    limit?: number;
    projectId?: string;
    jobId?: string;
    profileId?: string | "all";
    scope?: "work" | "personal" | "all";
    all?: boolean;
  }) {
    const items = this.filterVisibleItems(
      Object.values(this.store.load().items),
      filters?.profileId,
    );
    const filteredItems = filters?.all
      ? items.filter((item) => item.status !== "completed")
      : items
      .filter((item) => {
        if (!filters?.status) {
          return item.status !== "completed";
        }
        return filters.status === "all" || item.status === filters.status;
      })
      .filter((item) => !filters?.kind || filters.kind === "all" || item.kind === filters.kind)
      .filter((item) => !filters?.projectId || item.projectId === filters.projectId)
      .filter((item) => !filters?.jobId || item.jobId === filters.jobId)
      .filter((item) => {
        const scope = filters?.scope ?? "all";
        if (scope === "all") {
          return true;
        }
        return scope === "work" ? isWorkScopedItem(item) : !isWorkScopedItem(item);
      })
      .sort((a, b) => a.title.localeCompare(b.title));
    if (filters?.all) {
      return filteredItems.sort((a, b) => a.title.localeCompare(b.title));
    }
    return typeof filters?.limit === "number" ? filteredItems.slice(0, filters.limit) : filteredItems;
  }

  getItem(id: string) {
    const item = this.store.load().items[id];
    return item && this.canAccessProfile(item.profileId) ? item : undefined;
  }

  updateItem(
    id: string,
    updates: {
      profileId?: string;
      title?: string;
      description?: string;
      priority?: RoutinePriority;
      kind?: RoutineItemKind;
      labels?: string[];
      jobId?: string;
      projectId?: string;
      blockedBy?: string[];
      alarm?: boolean;
      schedule?: RoutineSchedule;
    },
  ) {
    const data = this.store.load();
    const item = this.requireAccessibleItem(data, id);
    if (!item) {
      throw new Error(`Routine item not found: ${id}`);
    }

    const nextKind = updates.kind ?? item.kind;
    if (item.status === "completed" && !isTodoKind(nextKind)) {
      throw new Error("Completed items must remain todo items until they are reopened.");
    }

    const scope = this.resolveWorkScope({
      jobId: updates.jobId ?? item.jobId,
      projectId: updates.projectId ?? item.projectId,
    });
    const profileId = this.resolveItemProfileId({
      profileId: updates.profileId ?? item.profileId,
      jobId: scope.jobId,
    });
    item.title = updates.title ?? item.title;
    item.profileId = profileId;
    item.description = updates.description ?? item.description;
    item.priority = updates.priority ?? item.priority;
    item.kind = nextKind;
    item.labels = updates.labels ?? item.labels;
    item.jobId = scope.jobId;
    item.projectId = scope.projectId;
    item.blockedBy = updates.blockedBy ?? item.blockedBy;
    item.alarm = updates.alarm ?? item.alarm;
    item.schedule = updates.schedule ?? item.schedule;

    this.store.save(data);
    telemetry.event("routine.item_updated", {
      entityType: "routine",
      entityId: item.id,
      kind: item.kind,
      status: item.status,
    });
    if (item.alarm) {
      this.notifyScheduleChanged();
    }
    return item;
  }

  deleteItem(id: string) {
    const data = this.store.load();
    const item = this.requireAccessibleItem(data, id);
    if (!item) {
      throw new Error(`Routine item not found: ${id}`);
    }

    delete data.items[id];
    this.store.save(data);
    telemetry.event("routine.item_deleted", {
      entityType: "routine",
      entityId: item.id,
      kind: item.kind,
    });
    if (item.alarm) {
      this.notifyScheduleChanged();
    }
    return item;
  }

  formatItem(item: RoutineItem) {
    const blocked = item.blockedBy?.length ? ` blocked-by:${item.blockedBy.join(",")}` : "";
    const streak = item.state.streak > 0 ? ` streak:${item.state.streak}` : "";
    const alarmTag = item.alarm ? " alarm" : "";
    const scope = item.projectId
      ? ` profile:${item.profileId} project:${item.projectId}${item.jobId ? ` job:${item.jobId}` : ""}`
      : item.jobId
        ? ` profile:${item.profileId} job:${item.jobId}`
        : ` profile:${item.profileId}`;
    return [
      item.id,
      item.title,
      `${item.kind}/${item.priority}`,
      item.status,
      formatSchedule(item.schedule),
      scope + blocked + streak + alarmTag,
    ]
      .filter(Boolean)
      .join(" | ");
  }

  private resolveWorkScope(scope: {
    jobId?: string;
    projectId?: string;
  }) {
    const projectId = scope.projectId?.trim() || undefined;
    const jobId = scope.jobId?.trim() || undefined;

    if (!projectId && !jobId) {
      return {
        projectId: undefined,
        jobId: undefined,
      };
    }

    const projects = this.getProjectsService();
    const project = projectId ? projects.getProject(projectId) : undefined;
    if (projectId && !project) {
      throw new Error(`Unknown project for routine item: ${projectId}`);
    }

    const resolvedJobId = project?.jobId ?? jobId;
    if (!resolvedJobId) {
      return {
        projectId,
        jobId: undefined,
      };
    }

    const job = projects.getJob(resolvedJobId);
    if (!job) {
      throw new Error(`Unknown job for routine item: ${resolvedJobId}`);
    }

    if (jobId && project?.jobId && jobId !== project.jobId) {
      throw new Error(
        `Routine job ${jobId} does not match project ${projectId} job ${project.jobId}.`,
      );
    }

    return {
      projectId,
      jobId: job.id,
    };
  }

  private resolveItemProfileId(scope: {
    profileId?: string;
    jobId?: string;
  }) {
    const explicitProfileId = scope.profileId?.trim() || undefined;
    const inferredProfileId = this.inferProfileIdFromJob(scope.jobId);

    if (explicitProfileId) {
      const normalizedProfileId = this.requireKnownProfileId(explicitProfileId);
      if (inferredProfileId && inferredProfileId !== normalizedProfileId) {
        throw new Error(
          `Routine profile ${normalizedProfileId} does not match job-scoped profile ${inferredProfileId}.`,
        );
      }
      this.assertProfileAccess(normalizedProfileId);
      return normalizedProfileId;
    }

    const profileId = inferredProfileId ?? this.activeProfile.id;
    this.assertProfileAccess(profileId);
    return profileId;
  }

  private inferProfileIdFromJob(jobId?: string) {
    const normalizedJobId = jobId?.trim();
    if (!normalizedJobId) {
      return undefined;
    }

    try {
      return this.profiles.getProfile(normalizedJobId).id;
    } catch {
      return undefined;
    }
  }

  private requireKnownProfileId(profileId: string) {
    return this.profiles.getProfile(profileId).id;
  }

  private isRootProfile() {
    return this.profiles.isRootProfile(this.activeProfile);
  }

  private canAccessProfile(profileId: string) {
    return this.isRootProfile() || profileId === this.activeProfile.id;
  }

  private assertProfileAccess(profileId: string) {
    if (!this.canAccessProfile(profileId)) {
      throw new Error(`Profile not accessible for routine item: ${profileId}`);
    }
  }

  private filterVisibleItems(items: RoutineItem[], requestedProfileId?: string | "all") {
    if (this.isRootProfile()) {
      if (!requestedProfileId || requestedProfileId === "all") {
        return items;
      }
      const normalizedProfileId = this.requireKnownProfileId(requestedProfileId);
      return items.filter((item) => item.profileId === normalizedProfileId);
    }

    if (requestedProfileId && requestedProfileId !== this.activeProfile.id) {
      throw new Error(`Profile not accessible for routine items: ${requestedProfileId}`);
    }

    return items.filter((item) => item.profileId === this.activeProfile.id);
  }

  private requireAccessibleItem(data: RoutineStoreData, id: string) {
    const item = data.items[id];
    if (!item || !this.canAccessProfile(item.profileId)) {
      throw new Error(`Routine item not found: ${id}`);
    }
    return item;
  }

  private getProjectsService() {
    if (this.projects) {
      return this.projects;
    }
    if (this.cachedProjects) {
      return this.cachedProjects;
    }

    const profiles = new ProfileService();
    const profile = profiles.getActiveProfile();
    this.cachedProjects = new ProjectsService(profile, profiles);
    return this.cachedProjects;
  }

  assessNow(reference: Date = new Date()) {
    const data = this.store.load();
    const effectiveTimezone = data.settings.quietHours?.timezone ?? data.settings.timezone;
    const now = nowInTimezone(effectiveTimezone, reference);
    const context = computeRoutineContext(data, now, effectiveTimezone);

    const assessments: RoutineAssessment[] = [];
    for (const item of this.filterVisibleItems(Object.values(data.items))) {
      if (!item.enabled || item.status !== "active") {
        continue;
      }
      if (item.blockedBy?.some((blockerId) => !data.items[blockerId]?.state.lastCompletedAt)) {
        continue;
      }

      const occurrence = findCurrentOccurrence(item, now);
      const isManualBacklog = item.schedule.kind === "manual"
        && (isTodoKind(item.kind) || item.kind === "deadline" || item.kind === "precommitment");
      if (!occurrence && !isManualBacklog) {
        continue;
      }

      if (
        occurrence
        && (countsAsCompleted(item, occurrence) || countsAsSkipped(item, occurrence.occurrenceKey))
      ) {
        continue;
      }

      const snoozedUntil = parseIso(item.state.snoozedUntil);
      if (snoozedUntil && snoozedUntil.getTime() > now.getTime()) {
        continue;
      }

      const occurrenceKey = occurrence?.occurrenceKey ?? `manual:${item.id}`;
      const minutesUntilDue = occurrence
        ? Math.floor((occurrence.dueAt.getTime() - now.getTime()) / 60000)
        : 0;
      const overdueMinutes = occurrence
        ? Math.max(0, -minutesUntilDue)
        : 0;
      const count = currentReminderCount(item, occurrenceKey);
      const lastReminded = parseIso(item.state.lastRemindedAt);

      let shouldRemindNow = false;
      let reason = "not salient right now";
      let nextAttentionAt: Date | undefined;
      let state: RoutineAssessment["state"] = occurrence?.state ?? "backlog";
      if (!occurrence && isManualBacklog) {
        if (!lastReminded) {
          shouldRemindNow = true;
          reason = "unseen manual backlog item";
          nextAttentionAt = now;
        } else if (
          count < item.reminder.maxReminders &&
          item.reminder.followUpMinutes >= 0 &&
          now.getTime() - lastReminded.getTime() >= item.reminder.followUpMinutes * 60000
        ) {
          shouldRemindNow = true;
          reason = "manual backlog follow-up reminder";
          nextAttentionAt = now;
        } else if (
          count < item.reminder.maxReminders &&
          item.reminder.followUpMinutes >= 0
        ) {
          nextAttentionAt = new Date(lastReminded.getTime() + item.reminder.followUpMinutes * 60000);
        }
      } else if (occurrence?.state === "due") {
        if (count === 0) {
          shouldRemindNow = true;
          reason = "first due reminder";
          nextAttentionAt = now;
        } else if (
          count < item.reminder.maxReminders &&
          item.reminder.followUpMinutes >= 0 &&
          lastReminded &&
          now.getTime() - lastReminded.getTime() >= item.reminder.followUpMinutes * 60000
        ) {
          shouldRemindNow = true;
          reason = "follow-up reminder due";
          nextAttentionAt = now;
        } else if (
          count < item.reminder.maxReminders &&
          item.reminder.followUpMinutes >= 0 &&
          lastReminded
        ) {
          nextAttentionAt = new Date(lastReminded.getTime() + item.reminder.followUpMinutes * 60000);
        }
      } else if (
        occurrence?.state === "upcoming" &&
        minutesUntilDue <= 60 &&
        count < item.reminder.maxReminders &&
        (item.priority === "high" || item.priority === "urgent" || item.kind === "med")
      ) {
        shouldRemindNow = true;
        reason = "upcoming high-salience item";
        nextAttentionAt = now;
      } else if (
        occurrence?.state === "upcoming"
        && (item.priority === "high" || item.priority === "urgent" || item.kind === "med")
      ) {
        nextAttentionAt = new Date(occurrence.dueAt.getTime() - (60 * 60000));
      }

      if (item.alarm && occurrence?.state === "upcoming" && !nextAttentionAt) {
        nextAttentionAt = occurrence.dueAt;
      }

      if (occurrence && shouldSuppressForContext(item, context, occurrence.state)) {
        shouldRemindNow = false;
        reason = "suppressed by current context";
      }

      const attentionLevel = attentionLevelFromAssessment(
        item,
        {
          dueAt: occurrence?.dueAt,
          state,
        },
        shouldRemindNow,
        isManualBacklog,
      );

      assessments.push({
        item,
        occurrenceKey,
        dueAt: occurrence ? toIso(occurrence.dueAt) : undefined,
        state,
        priorityScore: computePriorityScore(item.priority) + overdueMinutes,
        overdueMinutes,
        minutesUntilDue,
        reminderStage: reminderStage(item, occurrenceKey),
        shouldRemindNow,
        attentionLevel,
        nextAttentionAt: nextAttentionAt ? toIso(nextAttentionAt) : undefined,
        isManualBacklog,
        reason,
      });
    }

    return {
      context,
      items: sortAssessments(assessments),
    };
  }

  markDone(id: string, reference: Date = new Date()) {
    const data = this.store.load();
    const item = this.requireAccessibleItem(data, id);
    if (!item) {
      throw new Error(`Routine item not found: ${id}`);
    }

    const now = nowInTimezone(data.settings.timezone, reference);
    item.state.lastCompletedAt = toIso(now);
    item.state.completionHistory = trimHistory(
      item.state.completionHistory.concat(item.state.lastCompletedAt),
      50,
    );
    item.state.snoozedUntil = undefined;
    item.state.lastSkippedAt = undefined;
    item.state.reminderCountForOccurrence = 0;
    item.state.activeOccurrenceKey = undefined;
    if (isTodoKind(item.kind)) {
      item.status = "completed";
      item.enabled = false;
      item.state.streak = 0;
    } else {
      item.state.streak = updateStreak(item, now);
    }
    if (item.schedule.kind === "once" && !isTodoKind(item.kind)) {
      item.status = "archived";
      item.enabled = false;
    }
    this.store.save(data);
    telemetry.event("routine.item_done", {
      entityType: "routine",
      entityId: item.id,
      kind: item.kind,
      status: item.status,
    });
    return item;
  }

  undoDone(id: string) {
    const data = this.store.load();
    const item = this.requireAccessibleItem(data, id);
    if (!item) {
      throw new Error(`Routine item not found: ${id}`);
    }
    if (!item.state.lastCompletedAt) {
      throw new Error(`Routine item is not marked done: ${id}`);
    }

    const lastCompletedAt = item.state.lastCompletedAt;
    const historyIndex = item.state.completionHistory.lastIndexOf(lastCompletedAt);
    if (historyIndex >= 0) {
      item.state.completionHistory.splice(historyIndex, 1);
    } else {
      item.state.completionHistory.pop();
    }

    item.state.lastCompletedAt =
      item.state.completionHistory[item.state.completionHistory.length - 1];
    item.state.streak = computeStreakFromHistory(item);
    item.state.reminderCountForOccurrence = 0;
    item.state.activeOccurrenceKey = undefined;

    if (item.status === "completed" && isTodoKind(item.kind)) {
      item.status = "active";
      item.enabled = true;
    } else if (item.schedule.kind === "once" && item.status === "archived" && !item.enabled) {
      item.status = "active";
      item.enabled = true;
    }

    this.store.save(data);
    telemetry.event("routine.item_undo_done", {
      entityType: "routine",
      entityId: item.id,
      kind: item.kind,
      status: item.status,
    });
    return item;
  }

  snooze(id: string, minutes: number, reference: Date = new Date()) {
    const data = this.store.load();
    const item = this.requireAccessibleItem(data, id);
    if (!item) {
      throw new Error(`Routine item not found: ${id}`);
    }

    const now = nowInTimezone(data.settings.timezone, reference);
    item.state.snoozedUntil = toIso(new Date(now.getTime() + minutes * 60000));
    this.store.save(data);
    telemetry.event("routine.item_snoozed", {
      entityType: "routine",
      entityId: item.id,
      kind: item.kind,
      minutes,
    });
    return item;
  }

  skip(id: string, reference: Date = new Date()) {
    const data = this.store.load();
    const item = this.requireAccessibleItem(data, id);
    if (!item) {
      throw new Error(`Routine item not found: ${id}`);
    }

    const now = nowInTimezone(data.settings.timezone, reference);
    const occurrence = findCurrentOccurrence(item, now);
    if (occurrence) {
      item.state.skippedOccurrenceKeys = trimHistory(
        item.state.skippedOccurrenceKeys.concat(occurrence.occurrenceKey),
        30,
      );
    }
    item.state.lastSkippedAt = toIso(now);
    item.state.snoozedUntil = undefined;
    item.state.reminderCountForOccurrence = 0;
    item.state.activeOccurrenceKey = undefined;
    this.store.save(data);
    telemetry.event("routine.item_skipped", {
      entityType: "routine",
      entityId: item.id,
      kind: item.kind,
    });
    return item;
  }

  pause(id: string) {
    const data = this.store.load();
    const item = this.requireAccessibleItem(data, id);
    if (!item) {
      throw new Error(`Routine item not found: ${id}`);
    }
    item.status = "paused";
    item.enabled = false;
    this.store.save(data);
    telemetry.event("routine.item_paused", {
      entityType: "routine",
      entityId: item.id,
      kind: item.kind,
    });
    return item;
  }

  resume(id: string) {
    const data = this.store.load();
    const item = this.requireAccessibleItem(data, id);
    if (!item) {
      throw new Error(`Routine item not found: ${id}`);
    }
    item.status = "active";
    item.enabled = true;
    this.store.save(data);
    telemetry.event("routine.item_resumed", {
      entityType: "routine",
      entityId: item.id,
      kind: item.kind,
    });
    return item;
  }

  buildCheckSummary(reference: Date = new Date()) {
    const assessment = this.assessNow(reference);
    const actionable = assessment.items.filter((item) => item.shouldRemindNow);
    if (actionable.length === 0) {
      return `Nothing needs active attention right now. Context: ${assessment.context.mode}.`;
    }

    const lines = actionable.slice(0, 6).map((entry) => {
      const timing =
        entry.state === "backlog"
          ? "not yet reminded"
          : entry.state === "upcoming"
          ? `due in ${entry.minutesUntilDue}m`
          : entry.overdueMinutes > 0
            ? `${entry.overdueMinutes}m overdue`
            : "due now";
      return `- ${entry.item.id}: [${entry.item.profileId}] ${entry.item.title} (${entry.item.kind}, ${timing}, ${entry.reminderStage})`;
    });
    return [`Context: ${assessment.context.mode}`, ...lines].join("\n");
  }

  buildAssistantContext(reference: Date = new Date()) {
    const assessment = this.assessNow(reference);
    const top = assessment.items.slice(0, 5);
    const transitLine = assessment.context.transitEventTitle
      ? `Upcoming transit-required event: ${assessment.context.transitEventTitle}.`
      : "";
    if (top.length === 0) {
      return [
        `Routine context: no active items need attention right now. Current mode: ${assessment.context.mode}.`,
        transitLine,
      ].filter(Boolean).join(" ");
    }

    return [
      `Routine context mode: ${assessment.context.mode}.`,
      transitLine,
      ...top.map((entry) => {
        const stateText =
          entry.state === "backlog"
            ? "manual backlog item not yet reminded"
            : entry.state === "due"
            ? entry.overdueMinutes > 0
              ? `${entry.overdueMinutes} minutes overdue`
              : "due now"
            : `due in ${entry.minutesUntilDue} minutes`;
        return `- [${entry.item.profileId}] ${entry.item.title} [${entry.item.kind}/${entry.item.priority}] ${stateText}`;
      }),
    ].join("\n");
  }

  shouldRunHeartbeat(reference: Date = new Date()) {
    return !this.isQuietHours(reference);
  }

  prepareProactiveReminder(reference: Date = new Date()) {
    if (this.isQuietHours(reference)) {
      return null;
    }

    const assessment = this.assessNow(reference);
    const actionable = assessment.items.filter((item) => item.attentionLevel === "required").slice(0, 4);
    if (actionable.length === 0) {
      return null;
    }

    const lines = actionable.map((entry) => {
      const title = `[${entry.item.profileId}] ${entry.item.title}`;
      if (entry.reminderStage === "escalated") {
        return `- ${title}: this still needs attention.`;
      }
      if (entry.reminderStage === "follow_up") {
        return `- ${title}: following up.`;
      }
      if (entry.state === "backlog") {
        return `- ${title}: this is still open and has not been surfaced yet.`;
      }
      return `- ${title}: ${
        entry.state === "upcoming" ? `due in ${entry.minutesUntilDue}m.` : "due now."
      }`;
    });

    return {
      context: assessment.context,
      message: [`Hourly check-in (${assessment.context.mode} mode).`, ...lines].join("\n"),
      itemIds: actionable.map((entry) => entry.item.id),
      occurrenceKeys: actionable.map((entry) => entry.occurrenceKey),
    };
  }

  markReminded(
    itemIds: string[],
    occurrenceKeys: string[],
    reference: Date = new Date(),
  ) {
    const data = this.store.load();
    const now = nowInTimezone(data.settings.timezone, reference);

    itemIds.forEach((id, index) => {
      const item = data.items[id];
      if (!item || !this.canAccessProfile(item.profileId)) {
        return;
      }
      const occurrenceKey = occurrenceKeys[index];
      if (item.state.activeOccurrenceKey !== occurrenceKey) {
        item.state.activeOccurrenceKey = occurrenceKey;
        item.state.reminderCountForOccurrence = 0;
      }
      item.state.lastRemindedAt = toIso(now);
      item.state.reminderCountForOccurrence += 1;
    });

    this.store.save(data);
    telemetry.event("routine.items_reminded", {
      entityType: "routine_settings",
      entityId: "global",
      itemIds,
      occurrenceKeys,
    });
  }

  getHeartbeatReminderSnapshot(reference: Date = new Date()): HeartbeatReminderSnapshot {
    const data = this.store.load();
    const assessment = this.assessNow(reference);
    const requiredCandidates = assessment.items
      .filter((item) => item.attentionLevel === "required")
      .slice(0, 4)
      .map(toHeartbeatReminderCandidate);
    const optionalCandidates = assessment.items
      .filter((item) => item.attentionLevel === "optional")
      .slice(0, 4)
      .map(toHeartbeatReminderCandidate);

    return {
      context: assessment.context,
      currentLocalTime: formatLocalTime(reference, data.settings.timezone),
      timezone: data.settings.timezone,
      requiredCandidates,
      optionalCandidates,
      itemIds: requiredCandidates.map((item) => item.itemId),
      occurrenceKeys: requiredCandidates.map((item) => item.occurrenceKey),
    };
  }

  buildHeartbeatRequiredReminderMessage(snapshot: HeartbeatReminderSnapshot) {
    if (snapshot.requiredCandidates.length === 0) {
      return "";
    }

    const lines = snapshot.requiredCandidates.map((entry) => {
      const title = `[${entry.profileId}] ${entry.title}`;
      if (entry.state === "backlog") {
        return `- ${title}: this is still open and hasn't been surfaced yet.`;
      }
      if (entry.state === "upcoming") {
        return `- ${title}: due in ${entry.minutesUntilDue}m.`;
      }
      return `- ${title}: ${entry.overdueMinutes > 0 ? `${entry.overdueMinutes}m overdue.` : "due now."}`;
    });
    return [
      `Heartbeat follow-up (${snapshot.context.mode} mode, ${snapshot.currentLocalTime}).`,
      ...lines,
    ].join("\n");
  }

  hasAlarmRoutinesDueNow(reference: Date = new Date()) {
    const data = this.store.load();
    const now = nowInTimezone(data.settings.timezone, reference);
    for (const item of this.filterVisibleItems(Object.values(data.items))) {
      if (!item.alarm || !item.enabled || item.status !== "active") {
        continue;
      }
      const occurrence = findCurrentOccurrence(item, now);
      if (!occurrence || occurrence.state !== "due") {
        continue;
      }
      if (countsAsCompleted(item, occurrence) || countsAsSkipped(item, occurrence.occurrenceKey)) {
        continue;
      }
      if (currentReminderCount(item, occurrence.occurrenceKey) >= item.reminder.maxReminders) {
        continue;
      }
      const snoozedUntil = parseIso(item.state.snoozedUntil);
      if (snoozedUntil && snoozedUntil.getTime() > now.getTime()) {
        continue;
      }
      return true;
    }
    return false;
  }

  getNextRoutineAttentionAt(reference: Date = new Date()) {
    const data = this.store.load();
    const effectiveTimezone = data.settings.quietHours?.timezone ?? data.settings.timezone;
    const fakeLocal = nowInTimezone(effectiveTimezone, reference);
    // assessNow computes nextAttentionAt in fake-local-as-UTC time (via nowInTimezone).
    // Convert back to real UTC so the caller (scheduleNextRun) can compare against Date.now().
    const fakeToRealOffset = reference.getTime() - fakeLocal.getTime();
    const assessment = this.assessNow(reference);
    const nextAttention = assessment.items
      .map((item) => item.nextAttentionAt)
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((value) => new Date(value))
      .filter((value) => Number.isFinite(value.getTime()))
      .sort((left, right) => left.getTime() - right.getTime())[0];

    if (!nextAttention) {
      return null;
    }

    // Shift from fake-local-as-UTC back to real UTC
    const nextAttentionReal = new Date(nextAttention.getTime() + fakeToRealOffset);

    const { quietHours } = data.settings;
    if (!quietHours.enabled) {
      return nextAttentionReal.toISOString();
    }

    const quietNow = nowInTimezone(quietHours.timezone, reference);
    if (!isWithinTimeWindow(quietNow, quietHours)) {
      return nextAttentionReal.toISOString();
    }

    const nextAllowed = nextWindowBoundary(quietNow, quietHours);
    // nextAllowed is also in fake-local-as-UTC; convert it too
    const nextAllowedReal = new Date(nextAllowed.getTime() + fakeToRealOffset);
    if (nextAllowedReal.getTime() > nextAttentionReal.getTime()) {
      return nextAllowedReal.toISOString();
    }
    return nextAttentionReal.toISOString();
  }
}
