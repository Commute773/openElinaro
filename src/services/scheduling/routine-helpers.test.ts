import { test, expect, describe } from "bun:test";
import type {
  RoutineAssessment,
  RoutineContext,
  RoutineItem,
  RoutineSchedule,
  RoutineStoreData,
} from "../../domain/routines";
import {
  minutesSinceMidnight,
  makeRoutineId,
  slugify,
  createInitialState,
  trimHistory,
  defaultReminderPolicy,
  isTodoKind,
  isWorkScopedItem,
  computePriorityScore,
  computeRoutineContext,
  findCurrentOccurrence,
  isWithinTimeWindow,
  nextWindowBoundary,
  countsAsCompleted,
  countsAsSkipped,
  currentReminderCount,
  reminderStage,
  attentionLevelFromAssessment,
  shouldSuppressForContext,
  sortAssessments,
  formatSchedule,
  toHeartbeatReminderCandidate,
} from "./routine-helpers";

// ---------------------------------------------------------------------------
// Helpers to build test fixtures
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<RoutineItem> = {}): RoutineItem {
  return {
    id: "test-item",
    profileId: "root",
    title: "Test Item",
    kind: "routine",
    priority: "medium",
    status: "active",
    enabled: true,
    schedule: { kind: "daily", time: "09:00" },
    reminder: { followUpMinutes: 180, maxReminders: 2, escalate: false },
    state: createInitialState(),
    ...overrides,
  };
}

function makeAssessment(overrides: Partial<RoutineAssessment> = {}): RoutineAssessment {
  return {
    item: makeItem(),
    occurrenceKey: "2026-03-30",
    dueAt: "2026-03-30T09:00:00.000Z",
    state: "due",
    priorityScore: 40,
    overdueMinutes: 0,
    minutesUntilDue: 0,
    reminderStage: "initial",
    shouldRemindNow: false,
    attentionLevel: "none",
    isManualBacklog: false,
    reason: "test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// minutesSinceMidnight
// ---------------------------------------------------------------------------

describe("minutesSinceMidnight", () => {
  test("midnight is 0", () => {
    const d = new Date(2026, 2, 30, 0, 0, 0);
    expect(minutesSinceMidnight(d)).toBe(0);
  });

  test("1:30 AM is 90 minutes", () => {
    const d = new Date(2026, 2, 30, 1, 30, 0);
    expect(minutesSinceMidnight(d)).toBe(90);
  });

  test("noon is 720 minutes", () => {
    const d = new Date(2026, 2, 30, 12, 0, 0);
    expect(minutesSinceMidnight(d)).toBe(720);
  });

  test("11:59 PM is 1439 minutes", () => {
    const d = new Date(2026, 2, 30, 23, 59, 0);
    expect(minutesSinceMidnight(d)).toBe(1439);
  });

  test("6:15 AM is 375 minutes", () => {
    const d = new Date(2026, 2, 30, 6, 15, 0);
    expect(minutesSinceMidnight(d)).toBe(375);
  });
});

// ---------------------------------------------------------------------------
// slugify / makeRoutineId
// ---------------------------------------------------------------------------

describe("slugify", () => {
  test("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Morning Run")).toBe("morning-run");
  });

  test("strips non-alphanumeric characters", () => {
    expect(slugify("Take Meds! (daily)")).toBe("take-meds-daily");
  });

  test("trims leading/trailing whitespace and hyphens", () => {
    expect(slugify("  --hello--  ")).toBe("hello");
  });

  test("truncates at 48 characters", () => {
    const long = "a".repeat(60);
    expect(slugify(long).length).toBe(48);
  });

  test("handles empty-ish strings", () => {
    expect(slugify("   ")).toBe("");
  });

  test("collapses multiple special chars into single hyphen", () => {
    expect(slugify("foo   bar---baz")).toBe("foo-bar-baz");
  });
});

describe("makeRoutineId", () => {
  test("starts with kind prefix", () => {
    const id = makeRoutineId("med", "Blood Pressure Meds");
    expect(id.startsWith("med_")).toBe(true);
  });

  test("contains slugified title", () => {
    const id = makeRoutineId("routine", "Morning Run");
    expect(id).toContain("morning-run");
  });

  test("ends with a base36 timestamp", () => {
    const id = makeRoutineId("habit", "Read");
    const parts = id.split("_");
    const ts = parts[parts.length - 1];
    // base36 timestamp should be parseable
    expect(parseInt(ts, 36)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// createInitialState
// ---------------------------------------------------------------------------

describe("createInitialState", () => {
  test("returns correct default shape", () => {
    const state = createInitialState();
    expect(state).toEqual({
      completionHistory: [],
      skippedOccurrenceKeys: [],
      reminderCountForOccurrence: 0,
    });
  });

  test("arrays are independent across calls", () => {
    const a = createInitialState();
    const b = createInitialState();
    a.completionHistory.push("2026-03-30");
    expect(b.completionHistory).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// trimHistory
// ---------------------------------------------------------------------------

describe("trimHistory", () => {
  test("keeps all when under limit", () => {
    expect(trimHistory(["a", "b"], 5)).toEqual(["a", "b"]);
  });

  test("trims oldest entries beyond limit", () => {
    expect(trimHistory(["a", "b", "c", "d", "e"], 3)).toEqual(["c", "d", "e"]);
  });

  test("returns empty for empty input", () => {
    expect(trimHistory([], 3)).toEqual([]);
  });

  test("limit of 0 returns empty", () => {
    expect(trimHistory(["a", "b"], 0)).toEqual([]);
  });

  test("keeps exactly limit entries", () => {
    expect(trimHistory(["a", "b", "c"], 3)).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// defaultReminderPolicy
// ---------------------------------------------------------------------------

describe("defaultReminderPolicy", () => {
  test("med kind gets 60-minute follow-up with escalation", () => {
    const policy = defaultReminderPolicy("med");
    expect(policy.followUpMinutes).toBe(60);
    expect(policy.maxReminders).toBe(3);
    expect(policy.escalate).toBe(true);
  });

  test("precommitment kind gets same as med", () => {
    const policy = defaultReminderPolicy("precommitment");
    expect(policy.followUpMinutes).toBe(60);
    expect(policy.escalate).toBe(true);
  });

  test("deadline kind gets 120-minute follow-up with escalation", () => {
    const policy = defaultReminderPolicy("deadline");
    expect(policy.followUpMinutes).toBe(120);
    expect(policy.maxReminders).toBe(3);
    expect(policy.escalate).toBe(true);
  });

  test("routine kind gets 180-minute follow-up without escalation", () => {
    const policy = defaultReminderPolicy("routine");
    expect(policy.followUpMinutes).toBe(180);
    expect(policy.maxReminders).toBe(2);
    expect(policy.escalate).toBe(false);
  });

  test("todo kind gets default policy", () => {
    const policy = defaultReminderPolicy("todo");
    expect(policy.followUpMinutes).toBe(180);
    expect(policy.escalate).toBe(false);
  });

  test("habit kind gets default policy", () => {
    const policy = defaultReminderPolicy("habit");
    expect(policy.followUpMinutes).toBe(180);
    expect(policy.escalate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTodoKind
// ---------------------------------------------------------------------------

describe("isTodoKind", () => {
  test("todo returns true", () => {
    expect(isTodoKind("todo")).toBe(true);
  });

  test("routine returns false", () => {
    expect(isTodoKind("routine")).toBe(false);
  });

  test("med returns false", () => {
    expect(isTodoKind("med")).toBe(false);
  });

  test("habit returns false", () => {
    expect(isTodoKind("habit")).toBe(false);
  });

  test("deadline returns false", () => {
    expect(isTodoKind("deadline")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isWorkScopedItem
// ---------------------------------------------------------------------------

describe("isWorkScopedItem", () => {
  test("returns true when jobId is set", () => {
    expect(isWorkScopedItem({ jobId: "job-123" })).toBe(true);
  });

  test("returns false when jobId is undefined", () => {
    expect(isWorkScopedItem({})).toBe(false);
  });

  test("returns false when jobId is empty string", () => {
    expect(isWorkScopedItem({ jobId: "" })).toBe(false);
  });

  test("projectId alone is not work-scoped", () => {
    expect(isWorkScopedItem({ projectId: "proj-1" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computePriorityScore
// ---------------------------------------------------------------------------

describe("computePriorityScore", () => {
  test("urgent = 100", () => {
    expect(computePriorityScore("urgent")).toBe(100);
  });

  test("high = 70", () => {
    expect(computePriorityScore("high")).toBe(70);
  });

  test("medium = 40", () => {
    expect(computePriorityScore("medium")).toBe(40);
  });

  test("low = 10", () => {
    expect(computePriorityScore("low")).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// computeRoutineContext
// ---------------------------------------------------------------------------

describe("computeRoutineContext", () => {
  const baseData: RoutineStoreData = {
    settings: {
      timezone: "America/New_York",
      workBlock: { days: ["mon", "tue", "wed", "thu", "fri"], start: "09:00", end: "17:00" },
      sleepBlock: { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "23:00", end: "07:00" },
      quietHours: { enabled: true, timezone: "America/New_York", start: "22:00", end: "08:00" },
    },
    calendarEvents: [],
    items: {},
  };

  test("returns personal mode outside work/sleep blocks", () => {
    // Saturday at 10:00 — not in work block (which is mon-fri)
    const sat = new Date(2026, 2, 28, 10, 0, 0); // Sat March 28 2026
    const ctx = computeRoutineContext(baseData, sat);
    expect(ctx.mode).toBe("personal");
    expect(ctx.timezone).toBe("America/New_York");
  });

  test("returns work mode during work hours on a weekday", () => {
    // Monday at 10:00
    const mon = new Date(2026, 2, 30, 10, 0, 0); // Mon March 30 2026
    const ctx = computeRoutineContext(baseData, mon);
    expect(ctx.mode).toBe("work");
  });

  test("returns sleep mode during sleep hours", () => {
    // Any day at 23:30
    const late = new Date(2026, 2, 30, 23, 30, 0); // Mon 11:30 PM
    const ctx = computeRoutineContext(baseData, late);
    expect(ctx.mode).toBe("sleep");
  });

  test("detects transit events within 30 minutes", () => {
    const now = new Date(2026, 2, 28, 10, 0, 0); // Saturday
    const data: RoutineStoreData = {
      ...baseData,
      calendarEvents: [
        {
          title: "Dentist Appointment",
          start: new Date(2026, 2, 28, 10, 20, 0).toISOString(),
          requiresTransit: true,
        },
      ],
    };
    const ctx = computeRoutineContext(data, now);
    expect(ctx.transitEventTitle).toBe("Dentist Appointment");
  });

  test("ignores transit events more than 30 minutes away", () => {
    const now = new Date(2026, 2, 28, 10, 0, 0);
    const data: RoutineStoreData = {
      ...baseData,
      calendarEvents: [
        {
          title: "Far Away",
          start: new Date(2026, 2, 28, 11, 0, 0).toISOString(),
          requiresTransit: true,
        },
      ],
    };
    const ctx = computeRoutineContext(data, now);
    expect(ctx.transitEventTitle).toBeUndefined();
  });

  test("uses effectiveTimezone override", () => {
    const now = new Date(2026, 2, 28, 10, 0, 0);
    const ctx = computeRoutineContext(baseData, now, "Europe/London");
    expect(ctx.timezone).toBe("Europe/London");
  });
});

// ---------------------------------------------------------------------------
// findCurrentOccurrence — daily schedules
// ---------------------------------------------------------------------------

describe("findCurrentOccurrence — daily", () => {
  test("daily item before due time is upcoming", () => {
    const item = makeItem({
      schedule: { kind: "daily", time: "14:00" },
    });
    const now = new Date(2026, 2, 30, 10, 0, 0); // 10 AM
    const occ = findCurrentOccurrence(item, now);
    expect(occ).not.toBeNull();
    expect(occ!.state).toBe("upcoming");
  });

  test("daily item after due time is due", () => {
    const item = makeItem({
      schedule: { kind: "daily", time: "09:00" },
    });
    const now = new Date(2026, 2, 30, 10, 0, 0); // 10 AM, past 9 AM
    const occ = findCurrentOccurrence(item, now);
    expect(occ).not.toBeNull();
    expect(occ!.state).toBe("due");
  });

  test("respects dayResetHour — 4 AM reset shifts the anchor day", () => {
    const item = makeItem({
      schedule: { kind: "daily", time: "09:00" },
    });
    // At 2 AM, with a 4-hour reset, the anchor is still the previous day
    const now = new Date(2026, 2, 31, 2, 0, 0); // March 31 at 2 AM
    const occ = findCurrentOccurrence(item, now, 4);
    expect(occ).not.toBeNull();
    // The occurrence key should reflect the previous day (March 30)
    expect(occ!.occurrenceKey).toBe("2026-03-30");
  });

  test("daily with specific days skips non-matching days", () => {
    const item = makeItem({
      schedule: { kind: "daily", time: "09:00", days: ["mon", "wed", "fri"] },
    });
    // Tuesday — not in the list
    const tue = new Date(2026, 2, 31, 10, 0, 0); // Tue March 31 2026
    const occ = findCurrentOccurrence(item, tue);
    expect(occ).not.toBeNull();
    // Should find the next matching day (Wednesday)
    expect(occ!.state).toBe("upcoming");
  });

  test("daily with specific days matches on the correct day", () => {
    const item = makeItem({
      schedule: { kind: "daily", time: "09:00", days: ["mon", "wed", "fri"] },
    });
    // Monday
    const mon = new Date(2026, 2, 30, 10, 0, 0); // Mon March 30 2026
    const occ = findCurrentOccurrence(item, mon);
    expect(occ).not.toBeNull();
    expect(occ!.state).toBe("due"); // 10 AM past 9 AM
  });
});

// ---------------------------------------------------------------------------
// findCurrentOccurrence — weekly schedules
// ---------------------------------------------------------------------------

describe("findCurrentOccurrence — weekly", () => {
  test("finds the nearest matching weekday", () => {
    const item = makeItem({
      schedule: { kind: "weekly", time: "10:00", days: ["wed"] },
    });
    // Monday
    const mon = new Date(2026, 2, 30, 8, 0, 0);
    const occ = findCurrentOccurrence(item, mon);
    expect(occ).not.toBeNull();
    expect(occ!.state).toBe("upcoming");
    // Wednesday is April 1 2026
    expect(occ!.dueAt.getDay()).toBe(3); // Wednesday
  });

  test("returns upcoming for next week when time has passed on match day", () => {
    // Weekly with only Monday: at 10 AM Monday (past 09:00), the function
    // prefers the upcoming occurrence (next Monday) over the past one.
    const item = makeItem({
      schedule: { kind: "weekly", time: "09:00", days: ["mon"] },
    });
    const mon = new Date(2026, 2, 30, 10, 0, 0); // 10 AM Monday
    const occ = findCurrentOccurrence(item, mon);
    expect(occ).not.toBeNull();
    expect(occ!.state).toBe("upcoming");
    // Should point to next Monday (April 6)
    expect(occ!.dueAt.getDay()).toBe(1); // Monday
  });

  test("returns due when before schedule time on matching day", () => {
    const item = makeItem({
      schedule: { kind: "weekly", time: "14:00", days: ["mon"] },
    });
    const mon = new Date(2026, 2, 30, 10, 0, 0); // 10 AM Monday, before 14:00
    const occ = findCurrentOccurrence(item, mon);
    expect(occ).not.toBeNull();
    // 14:00 today is upcoming (later today)
    expect(occ!.state).toBe("upcoming");
    expect(occ!.dueAt.getDate()).toBe(30); // Today
  });

  test("multiple days finds the closest upcoming", () => {
    const item = makeItem({
      schedule: { kind: "weekly", time: "08:00", days: ["tue", "thu"] },
    });
    // Monday evening
    const mon = new Date(2026, 2, 30, 20, 0, 0);
    const occ = findCurrentOccurrence(item, mon);
    expect(occ).not.toBeNull();
    // Should find Tuesday (next day)
    expect(occ!.dueAt.getDay()).toBe(2); // Tuesday
    expect(occ!.state).toBe("upcoming");
  });
});

// ---------------------------------------------------------------------------
// findCurrentOccurrence — monthly schedules
// ---------------------------------------------------------------------------

describe("findCurrentOccurrence — monthly", () => {
  test("day-of-month occurrence in the future is upcoming", () => {
    const item = makeItem({
      schedule: { kind: "monthly", time: "12:00", dayOfMonth: 15 },
    });
    const now = new Date(2026, 2, 10, 8, 0, 0); // March 10
    const occ = findCurrentOccurrence(item, now);
    expect(occ).not.toBeNull();
    expect(occ!.state).toBe("upcoming");
    expect(occ!.dueAt.getDate()).toBe(15);
  });

  test("day-of-month already passed is due", () => {
    const item = makeItem({
      schedule: { kind: "monthly", time: "08:00", dayOfMonth: 5 },
    });
    const now = new Date(2026, 2, 10, 9, 0, 0); // March 10, past the 5th
    const occ = findCurrentOccurrence(item, now);
    expect(occ).not.toBeNull();
    expect(occ!.state).toBe("due");
  });

  test("occurrence key is YYYY-MM format", () => {
    const item = makeItem({
      schedule: { kind: "monthly", time: "10:00", dayOfMonth: 20 },
    });
    const now = new Date(2026, 2, 30, 10, 0, 0);
    const occ = findCurrentOccurrence(item, now);
    expect(occ).not.toBeNull();
    expect(occ!.occurrenceKey).toBe("2026-03");
  });
});

// ---------------------------------------------------------------------------
// findCurrentOccurrence — manual / once
// ---------------------------------------------------------------------------

describe("findCurrentOccurrence — manual and once", () => {
  test("manual schedule returns null", () => {
    const item = makeItem({ schedule: { kind: "manual" } });
    const occ = findCurrentOccurrence(item, new Date());
    expect(occ).toBeNull();
  });

  test("once schedule returns due after dueAt passes", () => {
    const item = makeItem({
      schedule: { kind: "once", dueAt: "2026-03-30T09:00:00.000Z" },
    });
    const now = new Date("2026-03-30T10:00:00.000Z");
    const occ = findCurrentOccurrence(item, now);
    expect(occ).not.toBeNull();
    expect(occ!.state).toBe("due");
  });

  test("once schedule returns upcoming before dueAt", () => {
    const item = makeItem({
      schedule: { kind: "once", dueAt: "2026-03-30T12:00:00.000Z" },
    });
    const now = new Date("2026-03-30T08:00:00.000Z");
    const occ = findCurrentOccurrence(item, now);
    expect(occ).not.toBeNull();
    expect(occ!.state).toBe("upcoming");
  });
});

// ---------------------------------------------------------------------------
// isWithinTimeWindow
// ---------------------------------------------------------------------------

describe("isWithinTimeWindow", () => {
  test("inside a normal window (start < end)", () => {
    const d = new Date(2026, 2, 30, 10, 0, 0); // 10:00
    expect(isWithinTimeWindow(d, { start: "09:00", end: "17:00" })).toBe(true);
  });

  test("outside a normal window", () => {
    const d = new Date(2026, 2, 30, 18, 0, 0); // 18:00
    expect(isWithinTimeWindow(d, { start: "09:00", end: "17:00" })).toBe(false);
  });

  test("at exact start time is inside", () => {
    const d = new Date(2026, 2, 30, 9, 0, 0);
    expect(isWithinTimeWindow(d, { start: "09:00", end: "17:00" })).toBe(true);
  });

  test("at exact end time is outside", () => {
    const d = new Date(2026, 2, 30, 17, 0, 0);
    expect(isWithinTimeWindow(d, { start: "09:00", end: "17:00" })).toBe(false);
  });

  test("overnight window — late night is inside", () => {
    const d = new Date(2026, 2, 30, 23, 30, 0); // 23:30
    expect(isWithinTimeWindow(d, { start: "22:00", end: "06:00" })).toBe(true);
  });

  test("overnight window — early morning is inside", () => {
    const d = new Date(2026, 2, 31, 3, 0, 0); // 03:00
    expect(isWithinTimeWindow(d, { start: "22:00", end: "06:00" })).toBe(true);
  });

  test("overnight window — midday is outside", () => {
    const d = new Date(2026, 2, 30, 12, 0, 0);
    expect(isWithinTimeWindow(d, { start: "22:00", end: "06:00" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nextWindowBoundary
// ---------------------------------------------------------------------------

describe("nextWindowBoundary", () => {
  test("when inside window, returns end time", () => {
    const d = new Date(2026, 2, 30, 10, 0, 0); // 10 AM
    const boundary = nextWindowBoundary(d, { start: "09:00", end: "17:00" });
    expect(boundary.getHours()).toBe(17);
    expect(boundary.getMinutes()).toBe(0);
  });

  test("when outside window, returns the date itself", () => {
    const d = new Date(2026, 2, 30, 20, 0, 0); // 8 PM
    const boundary = nextWindowBoundary(d, { start: "09:00", end: "17:00" });
    expect(boundary.getTime()).toBe(d.getTime());
  });

  test("overnight window at 23:30 returns next-day end time", () => {
    const d = new Date(2026, 2, 30, 23, 30, 0); // 11:30 PM
    const boundary = nextWindowBoundary(d, { start: "22:00", end: "06:00" });
    // End is 06:00, which is before 23:30 today, so should be tomorrow
    expect(boundary.getDate()).toBe(31);
    expect(boundary.getHours()).toBe(6);
  });

  test("overnight window at 03:00 returns same-day end time", () => {
    const d = new Date(2026, 2, 31, 3, 0, 0); // 3 AM
    const boundary = nextWindowBoundary(d, { start: "22:00", end: "06:00" });
    expect(boundary.getDate()).toBe(31);
    expect(boundary.getHours()).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// countsAsCompleted
// ---------------------------------------------------------------------------

describe("countsAsCompleted", () => {
  test("returns false when no lastCompletedAt", () => {
    const item = makeItem();
    expect(countsAsCompleted(item, { dueAt: new Date() })).toBe(false);
  });

  test("returns true when completed on the same local day for daily schedule", () => {
    const item = makeItem({
      schedule: { kind: "daily", time: "09:00" },
      state: {
        ...createInitialState(),
        lastCompletedAt: new Date(2026, 2, 30, 10, 0, 0).toISOString(),
      },
    });
    const dueAt = new Date(2026, 2, 30, 9, 0, 0);
    expect(countsAsCompleted(item, { dueAt })).toBe(true);
  });

  test("returns false when completed on a different day for daily schedule", () => {
    const item = makeItem({
      schedule: { kind: "daily", time: "09:00" },
      state: {
        ...createInitialState(),
        lastCompletedAt: new Date(2026, 2, 29, 10, 0, 0).toISOString(),
      },
    });
    const dueAt = new Date(2026, 2, 30, 9, 0, 0);
    expect(countsAsCompleted(item, { dueAt })).toBe(false);
  });

  test("once schedule: completed after dueAt counts", () => {
    const item = makeItem({
      schedule: { kind: "once", dueAt: "2026-03-30T09:00:00.000Z" },
      state: {
        ...createInitialState(),
        lastCompletedAt: "2026-03-30T10:00:00.000Z",
      },
    });
    const dueAt = new Date("2026-03-30T09:00:00.000Z");
    expect(countsAsCompleted(item, { dueAt })).toBe(true);
  });

  test("once schedule: completed before dueAt does not count", () => {
    const item = makeItem({
      schedule: { kind: "once", dueAt: "2026-03-30T09:00:00.000Z" },
      state: {
        ...createInitialState(),
        lastCompletedAt: "2026-03-29T10:00:00.000Z",
      },
    });
    const dueAt = new Date("2026-03-30T09:00:00.000Z");
    expect(countsAsCompleted(item, { dueAt })).toBe(false);
  });

  test("respects dayResetHour for daily schedule", () => {
    // With a 4-hour reset, completion at 2 AM on March 31 belongs to March 30
    const item = makeItem({
      schedule: { kind: "daily", time: "09:00" },
      state: {
        ...createInitialState(),
        lastCompletedAt: new Date(2026, 2, 31, 2, 0, 0).toISOString(),
      },
    });
    // Due at 9 AM March 30 (shifted by 4 hours, so anchor is March 30)
    const dueAt = new Date(2026, 2, 30, 9, 0, 0);
    expect(countsAsCompleted(item, { dueAt }, 4)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// countsAsSkipped
// ---------------------------------------------------------------------------

describe("countsAsSkipped", () => {
  test("returns true when occurrence key is in skipped list", () => {
    const item = makeItem({
      state: {
        ...createInitialState(),
        skippedOccurrenceKeys: ["2026-03-30"],
      },
    });
    expect(countsAsSkipped(item, "2026-03-30")).toBe(true);
  });

  test("returns false when occurrence key is not skipped", () => {
    const item = makeItem();
    expect(countsAsSkipped(item, "2026-03-30")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// currentReminderCount
// ---------------------------------------------------------------------------

describe("currentReminderCount", () => {
  test("returns count when activeOccurrenceKey matches", () => {
    const item = makeItem({
      state: {
        ...createInitialState(),
        activeOccurrenceKey: "2026-03-30",
        reminderCountForOccurrence: 3,
      },
    });
    expect(currentReminderCount(item, "2026-03-30")).toBe(3);
  });

  test("returns 0 when activeOccurrenceKey does not match", () => {
    const item = makeItem({
      state: {
        ...createInitialState(),
        activeOccurrenceKey: "2026-03-29",
        reminderCountForOccurrence: 3,
      },
    });
    expect(currentReminderCount(item, "2026-03-30")).toBe(0);
  });

  test("returns 0 when no activeOccurrenceKey", () => {
    const item = makeItem();
    expect(currentReminderCount(item, "2026-03-30")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reminderStage
// ---------------------------------------------------------------------------

describe("reminderStage", () => {
  test("returns initial when count is 0", () => {
    const item = makeItem();
    expect(reminderStage(item, "2026-03-30")).toBe("initial");
  });

  test("returns follow_up when count is 1", () => {
    const item = makeItem({
      state: {
        ...createInitialState(),
        activeOccurrenceKey: "2026-03-30",
        reminderCountForOccurrence: 1,
      },
    });
    expect(reminderStage(item, "2026-03-30")).toBe("follow_up");
  });

  test("returns escalated when count > 1 and escalate is true", () => {
    const item = makeItem({
      reminder: { followUpMinutes: 60, maxReminders: 3, escalate: true },
      state: {
        ...createInitialState(),
        activeOccurrenceKey: "2026-03-30",
        reminderCountForOccurrence: 2,
      },
    });
    expect(reminderStage(item, "2026-03-30")).toBe("escalated");
  });

  test("returns follow_up when count > 1 but escalate is false", () => {
    const item = makeItem({
      reminder: { followUpMinutes: 180, maxReminders: 2, escalate: false },
      state: {
        ...createInitialState(),
        activeOccurrenceKey: "2026-03-30",
        reminderCountForOccurrence: 2,
      },
    });
    expect(reminderStage(item, "2026-03-30")).toBe("follow_up");
  });
});

// ---------------------------------------------------------------------------
// attentionLevelFromAssessment
// ---------------------------------------------------------------------------

describe("attentionLevelFromAssessment", () => {
  test("returns required when shouldRemindNow is true", () => {
    const item = makeItem();
    expect(attentionLevelFromAssessment(item, { state: "due" }, true, false)).toBe("required");
  });

  test("returns none when isManualBacklog is true", () => {
    const item = makeItem();
    expect(attentionLevelFromAssessment(item, { state: "due" }, false, true)).toBe("none");
  });

  test("returns optional for high-priority upcoming item", () => {
    const item = makeItem({ priority: "high" });
    expect(attentionLevelFromAssessment(item, { state: "upcoming" }, false, false)).toBe("optional");
  });

  test("returns optional for urgent upcoming item", () => {
    const item = makeItem({ priority: "urgent" });
    expect(attentionLevelFromAssessment(item, { state: "upcoming" }, false, false)).toBe("optional");
  });

  test("returns optional for med kind upcoming item", () => {
    const item = makeItem({ kind: "med" });
    expect(attentionLevelFromAssessment(item, { state: "upcoming" }, false, false)).toBe("optional");
  });

  test("returns none for medium-priority upcoming item", () => {
    const item = makeItem({ priority: "medium" });
    expect(attentionLevelFromAssessment(item, { state: "upcoming" }, false, false)).toBe("none");
  });

  test("returns none for due item without remind now", () => {
    const item = makeItem();
    expect(attentionLevelFromAssessment(item, { state: "due" }, false, false)).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// shouldSuppressForContext
// ---------------------------------------------------------------------------

describe("shouldSuppressForContext", () => {
  const sleepCtx: RoutineContext = {
    timezone: "America/New_York",
    now: "2026-03-30T03:00:00.000Z",
    mode: "sleep",
  };

  const workCtx: RoutineContext = {
    timezone: "America/New_York",
    now: "2026-03-30T14:00:00.000Z",
    mode: "work",
  };

  test("never suppresses outside sleep mode", () => {
    const item = makeItem({ priority: "low" });
    expect(shouldSuppressForContext(item, workCtx, "upcoming")).toBe(false);
  });

  test("suppresses low-priority due items during sleep", () => {
    const item = makeItem({ priority: "low" });
    expect(shouldSuppressForContext(item, sleepCtx, "due")).toBe(true);
  });

  test("suppresses upcoming items during sleep", () => {
    const item = makeItem({ priority: "medium" });
    expect(shouldSuppressForContext(item, sleepCtx, "upcoming")).toBe(true);
  });

  test("does not suppress med kind during sleep", () => {
    const item = makeItem({ kind: "med" });
    expect(shouldSuppressForContext(item, sleepCtx, "upcoming")).toBe(false);
  });

  test("does not suppress precommitment kind during sleep", () => {
    const item = makeItem({ kind: "precommitment" });
    expect(shouldSuppressForContext(item, sleepCtx, "upcoming")).toBe(false);
  });

  test("does not suppress urgent priority during sleep", () => {
    const item = makeItem({ priority: "urgent" });
    expect(shouldSuppressForContext(item, sleepCtx, "upcoming")).toBe(false);
  });

  test("does not suppress medium-priority due items during sleep", () => {
    const item = makeItem({ priority: "medium" });
    expect(shouldSuppressForContext(item, sleepCtx, "due")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sortAssessments
// ---------------------------------------------------------------------------

describe("sortAssessments", () => {
  test("shouldRemindNow items come first", () => {
    const a = makeAssessment({ shouldRemindNow: true, priorityScore: 10 });
    const b = makeAssessment({ shouldRemindNow: false, priorityScore: 100 });
    const sorted = sortAssessments([b, a]);
    expect(sorted[0].shouldRemindNow).toBe(true);
  });

  test("higher priority scores come first among same shouldRemindNow", () => {
    const a = makeAssessment({ shouldRemindNow: false, priorityScore: 70 });
    const b = makeAssessment({ shouldRemindNow: false, priorityScore: 40 });
    const sorted = sortAssessments([b, a]);
    expect(sorted[0].priorityScore).toBe(70);
  });

  test("earlier due items come first when priority and shouldRemindNow are equal", () => {
    const a = makeAssessment({ shouldRemindNow: false, priorityScore: 40, minutesUntilDue: 10 });
    const b = makeAssessment({ shouldRemindNow: false, priorityScore: 40, minutesUntilDue: 60 });
    const sorted = sortAssessments([b, a]);
    expect(sorted[0].minutesUntilDue).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// formatSchedule
// ---------------------------------------------------------------------------

describe("formatSchedule", () => {
  test("manual", () => {
    expect(formatSchedule({ kind: "manual" })).toBe("manual");
  });

  test("once", () => {
    expect(formatSchedule({ kind: "once", dueAt: "2026-03-30T09:00:00Z" })).toBe(
      "once @ 2026-03-30T09:00:00Z",
    );
  });

  test("daily without specific days", () => {
    expect(formatSchedule({ kind: "daily", time: "09:00" })).toBe("daily @ 09:00");
  });

  test("daily with specific days", () => {
    expect(formatSchedule({ kind: "daily", time: "09:00", days: ["mon", "wed", "fri"] })).toBe(
      "daily mon,wed,fri @ 09:00",
    );
  });

  test("weekly", () => {
    expect(formatSchedule({ kind: "weekly", time: "10:00", days: ["tue", "thu"] })).toBe(
      "weekly tue,thu @ 10:00",
    );
  });

  test("interval", () => {
    expect(
      formatSchedule({ kind: "interval", time: "08:00", everyDays: 3 }),
    ).toBe("every 3d @ 08:00");
  });

  test("monthly", () => {
    expect(formatSchedule({ kind: "monthly", time: "12:00", dayOfMonth: 15 })).toBe(
      "monthly day 15 @ 12:00",
    );
  });
});

// ---------------------------------------------------------------------------
// toHeartbeatReminderCandidate
// ---------------------------------------------------------------------------

describe("toHeartbeatReminderCandidate", () => {
  test("maps all fields correctly", () => {
    const assessment = makeAssessment({
      item: makeItem({ id: "item-1", profileId: "root", title: "Morning Meds", kind: "med", priority: "high" }),
      occurrenceKey: "2026-03-30",
      dueAt: "2026-03-30T09:00:00.000Z",
      state: "due",
      minutesUntilDue: -30,
      overdueMinutes: 30,
      reminderStage: "follow_up",
      reason: "overdue by 30 minutes",
      isManualBacklog: false,
    });

    const candidate = toHeartbeatReminderCandidate(assessment);
    expect(candidate.itemId).toBe("item-1");
    expect(candidate.profileId).toBe("root");
    expect(candidate.title).toBe("Morning Meds");
    expect(candidate.kind).toBe("med");
    expect(candidate.priority).toBe("high");
    expect(candidate.state).toBe("due");
    expect(candidate.dueAt).toBe("2026-03-30T09:00:00.000Z");
    expect(candidate.occurrenceKey).toBe("2026-03-30");
    expect(candidate.minutesUntilDue).toBe(-30);
    expect(candidate.overdueMinutes).toBe(30);
    expect(candidate.reminderStage).toBe("follow_up");
    expect(candidate.reason).toBe("overdue by 30 minutes");
    expect(candidate.isManualBacklog).toBe(false);
  });

  test("handles missing optional dueAt", () => {
    const assessment = makeAssessment({ dueAt: undefined });
    const candidate = toHeartbeatReminderCandidate(assessment);
    expect(candidate.dueAt).toBeUndefined();
  });
});
