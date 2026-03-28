import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { updateTestRuntimeConfig } from "../test/runtime-config-test-helpers";
import { ProfileService } from "./profiles";
import { ProjectsService } from "./projects-service";
import { RoutinesService } from "./routines-service";

let runtimeRoot = "";
let previousRootDirEnv: string | undefined;

function writeProfileRegistry(rootDir: string) {
  fs.mkdirSync(path.join(rootDir, ".openelinarotest", "profiles"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, ".openelinarotest", "profiles/registry.json"),
    `${JSON.stringify({
      version: 1,
      profiles: [
        {
          id: "root",
          name: "Root",
          roles: ["root"],
          memoryNamespace: "root",
        },
        {
          id: "restricted",
          name: "Restricted",
          roles: ["restricted"],
          memoryNamespace: "restricted",
        },
        {
          id: "remote",
          name: "Remote",
          roles: ["remote"],
          memoryNamespace: "remote",
        },
      ],
    }, null, 2)}\n`,
  );
}

function writeProjectsRegistry(rootDir: string) {
  fs.mkdirSync(path.join(rootDir, ".openelinarotest", "projects"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, ".openelinarotest", "projects/registry.json"),
    `${JSON.stringify({
      version: 1,
      jobs: [
        {
          id: "restricted",
          name: "Restricted",
          status: "active",
          priority: "high",
          summary: "Client work.",
        },
      ],
      projects: [
        {
          id: "telecorder",
          name: "Telecorder",
          status: "active",
          jobId: "restricted",
          priority: "high",
          allowedRoles: ["restricted"],
          workspacePath: path.join(rootDir, ".openelinarotest", "projects/telecorder/workspace"),
          summary: "Telecorder work.",
          currentState: "Active.",
          state: "Telecorder is active and needs demo-proofing work.",
          future: "Telecorder should become the unified operator shell for remote robot operations and recordings.",
          nextFocus: ["Ship demo."],
          structure: ["README.md", "projects/registry.json: embedded state/future"],
          tags: ["restricted"],
          docs: {
            readme: "projects/telecorder/README.md",
          },
        },
        {
          id: "open-even",
          name: "openEven",
          status: "active",
          priority: "low",
          allowedRoles: [],
          workspacePath: path.join(rootDir, ".openelinarotest", "projects/open-even/workspace"),
          summary: "Personal wearables project.",
          currentState: "Research phase.",
          state: "openEven is a personal project and should not be treated as client work.",
          future: "Explore custom integrations for the devices.",
          nextFocus: ["Research SDK options."],
          structure: ["README.md", "projects/registry.json: embedded state/future"],
          tags: ["personal"],
          docs: {
            readme: "projects/open-even/README.md",
          },
        },
      ],
    }, null, 2)}\n`,
  );
}

beforeEach(() => {
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-routines-"));
  process.env.OPENELINARO_ROOT_DIR = runtimeRoot;
  writeProfileRegistry(runtimeRoot);
});

afterEach(() => {
  if (previousRootDirEnv === undefined) {
    delete process.env.OPENELINARO_ROOT_DIR;
  } else {
    process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
  }
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  runtimeRoot = "";
});

describe("RoutinesService", () => {
  test("marks todos as completed instead of tracking streaks and excludes them by default", () => {
    const service = new RoutinesService();
    const todo = service.addItem({
      title: "Ship patch",
      kind: "todo",
      schedule: { kind: "once", dueAt: "2026-03-15T10:00:00.000Z" },
    });
    const habit = service.addItem({
      title: "Workout",
      kind: "habit",
      schedule: { kind: "daily", time: "09:00" },
    });

    const completedTodo = service.markDone(todo.id, new Date("2026-03-15T10:01:00.000Z"));
    const completedHabit = service.markDone(habit.id, new Date("2026-03-15T10:02:00.000Z"));

    expect(completedTodo.status).toBe("completed");
    expect(completedTodo.enabled).toBe(false);
    expect(completedTodo.state.streak).toBe(0);
    expect(completedHabit.status).toBe("active");
    expect(completedHabit.state.streak).toBe(1);
    expect(service.listItems().map((item) => item.id)).toEqual([habit.id]);
    expect(service.listItems({ status: "all" }).map((item) => item.id)).toContain(todo.id);

    const reopenedTodo = service.undoDone(todo.id);
    expect(reopenedTodo.status).toBe("active");
    expect(reopenedTodo.enabled).toBe(true);
  });

  test("updates and deletes routine items", () => {
    const service = new RoutinesService();
    const item = service.addItem({
      title: "Old title",
      kind: "todo",
      description: "old",
      schedule: { kind: "manual" },
    });

    const updated = service.updateItem(item.id, {
      title: "New title",
      description: "new",
      kind: "deadline",
      schedule: { kind: "weekly", time: "14:00", days: ["mon", "wed"] },
    });
    expect(updated.title).toBe("New title");
    expect(updated.description).toBe("new");
    expect(updated.kind).toBe("deadline");
    expect(updated.schedule).toEqual({ kind: "weekly", time: "14:00", days: ["mon", "wed"] });

    const deleted = service.deleteItem(item.id);
    expect(deleted.id).toBe(item.id);
    expect(service.getItem(item.id)).toBeUndefined();
  });

  test("updates todo blocking dependencies and suppresses blocked reminder candidates", () => {
    const service = new RoutinesService();
    const blocker = service.addItem({
      title: "Finish prerequisite",
      kind: "todo",
      schedule: { kind: "manual" },
    });
    const blocked = service.addItem({
      title: "Do blocked task",
      kind: "todo",
      schedule: { kind: "manual" },
    });

    const updated = service.updateItem(blocked.id, {
      blockedBy: [blocker.id],
    });
    expect(updated.blockedBy).toEqual([blocker.id]);
    expect(service.formatItem(updated)).toContain(`blocked-by:${blocker.id}`);

    const beforeCompletion = service.getHeartbeatReminderSnapshot(new Date("2026-03-17T18:05:00.000-04:00"));
    expect(beforeCompletion.requiredCandidates.some((entry) => entry.itemId === blocked.id)).toBe(false);

    service.markDone(blocker.id);

    const afterCompletion = service.getHeartbeatReminderSnapshot(new Date("2026-03-17T18:06:00.000-04:00"));
    expect(afterCompletion.requiredCandidates.some((entry) => entry.itemId === blocked.id)).toBe(true);
  });

  test("validates and filters work-scoped routine links", () => {
    writeProjectsRegistry(runtimeRoot);
    const profiles = new ProfileService("root");
    const profile = profiles.getActiveProfile();
    const projects = new ProjectsService(profile, profiles);
    const service = new RoutinesService(projects);

    const item = service.addItem({
      title: "Prepare telecorder video",
      kind: "todo",
      projectId: "telecorder",
      schedule: { kind: "manual" },
    });

    expect(item.jobId).toBe("restricted");
    expect(item.profileId).toBe("restricted");
    expect(service.listItems({ scope: "work" }).map((entry) => entry.id)).toEqual([item.id]);
    expect(service.listItems({ scope: "personal" })).toEqual([]);
    expect(service.listItems({ projectId: "telecorder" }).map((entry) => entry.id)).toEqual([item.id]);
    expect(service.listItems({ profileId: "restricted" }).map((entry) => entry.id)).toEqual([item.id]);

    const personalProjectItem = service.addItem({
      title: "Research Even SDK",
      kind: "todo",
      projectId: "open-even",
      schedule: { kind: "manual" },
    });

    expect(personalProjectItem.jobId).toBeUndefined();
    expect(personalProjectItem.profileId).toBe("root");
    expect(service.listItems({ scope: "work" }).map((entry) => entry.id)).toEqual([item.id]);
    expect(service.listItems({ scope: "personal" }).map((entry) => entry.id)).toEqual([personalProjectItem.id]);
    expect(service.listItems({ projectId: "open-even" }).map((entry) => entry.id)).toEqual([personalProjectItem.id]);
    expect(() =>
      service.addItem({
        title: "Broken link",
        kind: "todo",
        projectId: "missing-project",
        schedule: { kind: "manual" },
      })).toThrow("Project not found: missing-project");
  });

  test("limits non-root profiles to their own routine items", () => {
    writeProjectsRegistry(runtimeRoot);

    const rootProfiles = new ProfileService("root");
    const rootProjects = new ProjectsService(rootProfiles.getActiveProfile(), rootProfiles);
    const rootService = new RoutinesService(rootProjects);
    const telecorderItem = rootService.addItem({
      title: "Prepare telecorder video",
      kind: "todo",
      projectId: "telecorder",
      schedule: { kind: "manual" },
    });
    const rootItem = rootService.addItem({
      title: "Buy groceries",
      kind: "todo",
      schedule: { kind: "manual" },
    });

    updateTestRuntimeConfig((config) => {
      config.core.profile.activeProfileId = "restricted";
    });
    const restrictedProfiles = new ProfileService("restricted");
    const restrictedProjects = new ProjectsService(restrictedProfiles.getActiveProfile(), restrictedProfiles);
    const restrictedService = new RoutinesService(restrictedProjects);

    expect(restrictedService.listItems().map((item) => item.id)).toEqual([telecorderItem.id]);
    expect(restrictedService.getItem(rootItem.id)).toBeUndefined();
    expect(() => restrictedService.markDone(rootItem.id)).toThrow(`Routine item not found: ${rootItem.id}`);
  });

  test("surfaces unseen manual backlog items in the heartbeat snapshot and marks them reminded", () => {
    const service = new RoutinesService();
    const item = service.addItem({
      title: "Book freezer delivery",
      kind: "todo",
      schedule: { kind: "manual" },
    });

    const snapshot = service.getHeartbeatReminderSnapshot(new Date("2026-03-17T18:05:00.000-04:00"));

    expect(snapshot.requiredCandidates.map((entry) => entry.itemId)).toContain(item.id);
    expect(snapshot.requiredCandidates.find((entry) => entry.itemId === item.id)?.state).toBe("backlog");

    service.markReminded(snapshot.itemIds, snapshot.occurrenceKeys, new Date("2026-03-17T18:05:00.000-04:00"));

    const reminded = service.getItem(item.id);
    expect(reminded?.state.lastRemindedAt).toBeTruthy();
    const nextSnapshot = service.getHeartbeatReminderSnapshot(new Date("2026-03-17T18:10:00.000-04:00"));
    expect(nextSnapshot.requiredCandidates.map((entry) => entry.itemId)).not.toContain(item.id);
  });

  test("re-surfaces manual backlog items when their follow-up reminder is due", () => {
    const service = new RoutinesService();
    const item = service.addItem({
      title: "Take progesterone",
      kind: "todo",
      schedule: { kind: "manual" },
      reminder: {
        followUpMinutes: 180,
        maxReminders: 2,
        escalate: false,
      },
    });

    service.markReminded([item.id], [`manual:${item.id}`], new Date("2026-03-17T13:31:00.000-04:00"));

    const beforeFollowUp = service.getHeartbeatReminderSnapshot(new Date("2026-03-17T16:30:00.000-04:00"));
    expect(beforeFollowUp.requiredCandidates.map((entry) => entry.itemId)).not.toContain(item.id);

    const dueFollowUp = service.getHeartbeatReminderSnapshot(new Date("2026-03-17T16:31:00.000-04:00"));
    const candidate = dueFollowUp.requiredCandidates.find((entry) => entry.itemId === item.id);
    expect(candidate).toBeTruthy();
    expect(candidate?.state).toBe("backlog");
    expect(candidate?.reminderStage).toBe("follow_up");
    expect(candidate?.reason).toBe("manual backlog follow-up reminder");
  });

  test("listItems all=true ignores list filters but still excludes completed items", () => {
    writeProjectsRegistry(runtimeRoot);
    const profiles = new ProfileService("root");
    const projects = new ProjectsService(profiles.getActiveProfile(), profiles);
    const service = new RoutinesService(projects);

    const workItem = service.addItem({
      title: "Prepare telecorder video",
      kind: "todo",
      projectId: "telecorder",
      schedule: { kind: "manual" },
    });
    service.addItem({
      title: "Buy groceries",
      kind: "todo",
      schedule: { kind: "manual" },
    });
    const completedItem = service.addItem({
      title: "Done already",
      kind: "todo",
      schedule: { kind: "manual" },
    });
    service.markDone(completedItem.id);

    const items = service.listItems({
      all: true,
      scope: "personal",
      projectId: "telecorder",
      status: "completed",
      kind: "deadline",
      limit: 1,
    });

    expect(items.map((item) => item.id).sort()).toEqual([
      workItem.id,
      items.find((item) => item.title === "Buy groceries")?.id,
    ].filter((itemId): itemId is string => Boolean(itemId)).sort());
    expect(items.map((item) => item.id)).not.toContain(completedItem.id);
  });

  test("includes nearby transit-required events in the assistant context", () => {
    const service = new RoutinesService();
    service.replaceCalendarEvents([
      {
        title: "Clinic Visit",
        start: "2026-03-17T22:20:00.000Z",
        end: "2026-03-17T23:00:00.000Z",
        location: "123 Clinic St",
        requiresTransit: true,
      },
    ]);

    const context = service.buildAssistantContext(new Date("2026-03-17T21:55:00.000Z"));
    expect(context).toContain("Upcoming transit-required event: Clinic Visit.");
  });

  test("computes the next routine attention wake-up from scheduled items", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: {
        ...service.loadData().settings,
        timezone: "UTC",
      },
    });
    service.addItem({
      title: "Morning meds",
      kind: "med",
      priority: "high",
      schedule: { kind: "daily", time: "09:00" },
    });

    const nextAttentionAt = service.getNextRoutineAttentionAt(new Date("2026-03-17T07:30:00.000Z"));

    expect(nextAttentionAt).toBe("2026-03-17T09:00:00.000Z");
  });

  test("addItem with alarm: true stores the flag", () => {
    const service = new RoutinesService();
    const item = service.addItem({
      title: "Take morning meds",
      kind: "med",
      alarm: true,
      schedule: { kind: "daily", time: "09:00" },
    });

    expect(item.alarm).toBe(true);
    const loaded = service.getItem(item.id);
    expect(loaded?.alarm).toBe(true);
  });

  test("updateItem can toggle alarm", () => {
    const service = new RoutinesService();
    const item = service.addItem({
      title: "Take meds",
      kind: "med",
      schedule: { kind: "daily", time: "09:00" },
    });

    expect(item.alarm).toBeUndefined();

    const updated = service.updateItem(item.id, { alarm: true });
    expect(updated.alarm).toBe(true);

    const toggled = service.updateItem(item.id, { alarm: false });
    expect(toggled.alarm).toBe(false);
  });

  test("assessNow sets nextAttentionAt to occurrence dueAt for alarm-flagged upcoming items", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: {
        ...service.loadData().settings,
        timezone: "UTC",
      },
    });
    service.addItem({
      title: "Alarm routine",
      kind: "routine",
      priority: "low",
      alarm: true,
      schedule: { kind: "daily", time: "14:00" },
    });

    const assessment = service.assessNow(new Date("2026-03-17T10:00:00.000Z"));
    const entry = assessment.items.find((item) => item.item.title === "Alarm routine");

    expect(entry).toBeTruthy();
    expect(entry?.state).toBe("upcoming");
    expect(entry?.nextAttentionAt).toBe("2026-03-17T14:00:00.000Z");
  });

  test("hasAlarmRoutinesDueNow returns true when an alarm routine is due", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: {
        ...service.loadData().settings,
        timezone: "UTC",
      },
    });
    service.addItem({
      title: "Alarm med",
      kind: "med",
      alarm: true,
      schedule: { kind: "daily", time: "09:00" },
    });

    expect(service.hasAlarmRoutinesDueNow(new Date("2026-03-17T09:05:00.000Z"))).toBe(true);
  });

  test("hasAlarmRoutinesDueNow returns false when no alarm routines are due", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: {
        ...service.loadData().settings,
        timezone: "UTC",
      },
    });
    service.addItem({
      title: "Non-alarm med",
      kind: "med",
      schedule: { kind: "daily", time: "09:00" },
    });

    expect(service.hasAlarmRoutinesDueNow(new Date("2026-03-17T09:05:00.000Z"))).toBe(false);
  });

  test("formatItem includes alarm tag", () => {
    const service = new RoutinesService();
    const item = service.addItem({
      title: "Alarm item",
      kind: "med",
      alarm: true,
      schedule: { kind: "daily", time: "09:00" },
    });

    expect(service.formatItem(item)).toContain("alarm");

    const nonAlarmItem = service.addItem({
      title: "Normal item",
      kind: "med",
      schedule: { kind: "daily", time: "10:00" },
    });

    expect(service.formatItem(nonAlarmItem)).not.toContain("alarm");
  });

  // --- daily schedule with weekday filter ---

  test("daily schedule with days only fires on matching weekdays", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC" },
    });
    // 2026-03-17 is a Tuesday
    const item = service.addItem({
      title: "Workday standup",
      kind: "routine",
      schedule: { kind: "daily", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] },
    });

    // Tuesday — should be due
    const tuesdayAssessment = service.assessNow(new Date("2026-03-17T09:05:00.000Z"));
    const tuesdayEntry = tuesdayAssessment.items.find((i) => i.item.id === item.id);
    expect(tuesdayEntry).toBeTruthy();
    expect(tuesdayEntry?.state).toBe("due");

    // Saturday 2026-03-21 — should find the next Monday as upcoming
    const saturdayAssessment = service.assessNow(new Date("2026-03-21T09:05:00.000Z"));
    const saturdayEntry = saturdayAssessment.items.find((i) => i.item.id === item.id);
    expect(saturdayEntry).toBeTruthy();
    // On Saturday, next matching day is Monday — should be upcoming
    expect(saturdayEntry?.state).toBe("upcoming");
  });

  test("daily schedule without days fires every day (no regression)", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC" },
    });
    const item = service.addItem({
      title: "Daily meditation",
      kind: "habit",
      schedule: { kind: "daily", time: "08:00" },
    });

    // Saturday 2026-03-21
    const satAssessment = service.assessNow(new Date("2026-03-21T08:05:00.000Z"));
    const satEntry = satAssessment.items.find((i) => i.item.id === item.id);
    expect(satEntry).toBeTruthy();
    expect(satEntry?.state).toBe("due");

    // Sunday 2026-03-22
    const sunAssessment = service.assessNow(new Date("2026-03-22T08:05:00.000Z"));
    const sunEntry = sunAssessment.items.find((i) => i.item.id === item.id);
    expect(sunEntry).toBeTruthy();
    expect(sunEntry?.state).toBe("due");
  });

  test("daily schedule with days shows as upcoming before the scheduled time on a matching day", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC" },
    });
    service.addItem({
      title: "Weekday coffee",
      kind: "routine",
      schedule: { kind: "daily", time: "10:00", days: ["mon", "tue", "wed", "thu", "fri"] },
    });

    // Tuesday 2026-03-17 at 07:00 — before the 10:00 time
    const assessment = service.assessNow(new Date("2026-03-17T07:00:00.000Z"));
    const entry = assessment.items.find((i) => i.item.title === "Weekday coffee");
    expect(entry).toBeTruthy();
    expect(entry?.state).toBe("upcoming");
  });

  test("formatSchedule shows days for daily-with-days schedule", () => {
    const service = new RoutinesService();
    const item = service.addItem({
      title: "MWF routine",
      kind: "routine",
      schedule: { kind: "daily", time: "09:00", days: ["mon", "wed", "fri"] },
    });

    const formatted = service.formatItem(item);
    expect(formatted).toContain("daily mon,wed,fri @ 09:00");
  });

  test("formatSchedule omits days for plain daily schedule", () => {
    const service = new RoutinesService();
    const item = service.addItem({
      title: "Every day thing",
      kind: "routine",
      schedule: { kind: "daily", time: "07:00" },
    });

    const formatted = service.formatItem(item);
    expect(formatted).toContain("daily @ 07:00");
    expect(formatted).not.toContain("mon");
  });

  test("daily-with-days streak continues across non-matching days", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC" },
    });
    const item = service.addItem({
      title: "MWF workout",
      kind: "habit",
      schedule: { kind: "daily", time: "09:00", days: ["mon", "wed", "fri"] },
    });

    // Complete on Monday 2026-03-16
    service.markDone(item.id, new Date("2026-03-16T09:30:00.000Z"));
    expect(service.getItem(item.id)?.state.streak).toBe(1);

    // Complete on Wednesday 2026-03-18 — 2 days gap but within tolerance (7)
    service.markDone(item.id, new Date("2026-03-18T09:30:00.000Z"));
    expect(service.getItem(item.id)?.state.streak).toBe(2);

    // Complete on Friday 2026-03-20 — another 2 days gap
    service.markDone(item.id, new Date("2026-03-20T09:30:00.000Z"));
    expect(service.getItem(item.id)?.state.streak).toBe(3);
  });

  test("daily streak increments on each markDone", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC" },
    });
    const item = service.addItem({
      title: "Daily journal",
      kind: "habit",
      schedule: { kind: "daily", time: "21:00" },
    });

    service.markDone(item.id, new Date("2026-03-16T21:30:00.000Z"));
    expect(service.getItem(item.id)?.state.streak).toBe(1);

    service.markDone(item.id, new Date("2026-03-17T21:30:00.000Z"));
    expect(service.getItem(item.id)?.state.streak).toBe(2);

    service.markDone(item.id, new Date("2026-03-18T21:30:00.000Z"));
    expect(service.getItem(item.id)?.state.streak).toBe(3);
  });

  test("heartbeat snapshot includes daily-with-days items that are due", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC" },
    });
    const item = service.addItem({
      title: "Weekday meds",
      kind: "med",
      alarm: true,
      schedule: { kind: "daily", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] },
    });

    // Tuesday 2026-03-17 at 09:05 — due
    const snapshot = service.getHeartbeatReminderSnapshot(new Date("2026-03-17T09:05:00.000Z"));
    expect(snapshot.requiredCandidates.some((c) => c.itemId === item.id)).toBe(true);
  });

  test("heartbeat snapshot does not surface daily-with-days items on non-matching days as due", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC" },
    });
    const item = service.addItem({
      title: "Weekday meds",
      kind: "med",
      alarm: true,
      schedule: { kind: "daily", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] },
    });

    // Saturday 2026-03-21 at 09:05 — not a matching day, should be upcoming not due
    const snapshot = service.getHeartbeatReminderSnapshot(new Date("2026-03-21T09:05:00.000Z"));
    const candidate = snapshot.requiredCandidates.find((c) => c.itemId === item.id);
    // Should not appear as required since next occurrence is Monday (upcoming)
    if (candidate) {
      expect(candidate.state).not.toBe("due");
    }
  });

  test("daily-with-days alarm sets nextAttentionAt to next matching day", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC" },
    });
    service.addItem({
      title: "Weekday alarm",
      kind: "routine",
      alarm: true,
      schedule: { kind: "daily", time: "09:00", days: ["mon", "tue", "wed", "thu", "fri"] },
    });

    // Friday 2026-03-20 at 10:00 — already past today's time, next is Monday 2026-03-23
    const assessment = service.assessNow(new Date("2026-03-20T10:00:00.000Z"));
    const entry = assessment.items.find((i) => i.item.title === "Weekday alarm");
    // The occurrence should be Friday (due) since it's past the time
    expect(entry).toBeTruthy();
    expect(entry?.state).toBe("due");
  });

  // --- general routine lifecycle tests ---

  test("markDone and undoDone cycle for recurring routines", () => {
    const service = new RoutinesService();
    const item = service.addItem({
      title: "Stretch",
      kind: "routine",
      schedule: { kind: "daily", time: "07:00" },
    });

    const done = service.markDone(item.id, new Date("2026-03-17T07:15:00.000Z"));
    expect(done.status).toBe("active");
    expect(done.state.lastCompletedAt).toBeTruthy();
    expect(done.state.streak).toBe(1);

    const undone = service.undoDone(item.id);
    expect(undone.state.lastCompletedAt).toBeUndefined();
    expect(undone.state.streak).toBe(0);
    expect(undone.state.completionHistory).toEqual([]);
  });

  test("snooze suppresses reminders until the snooze expires", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC" },
    });
    const item = service.addItem({
      title: "Snooze test",
      kind: "med",
      schedule: { kind: "daily", time: "09:00" },
    });

    service.snooze(item.id, 60, new Date("2026-03-17T09:05:00.000Z"));

    const snoozed = service.getItem(item.id);
    expect(snoozed?.state.snoozedUntil).toBeTruthy();

    // Still snoozed at 09:30
    const during = service.assessNow(new Date("2026-03-17T09:30:00.000Z"));
    const duringEntry = during.items.find((i) => i.item.id === item.id);
    expect(duringEntry).toBeUndefined();

    // Snooze expired at 10:06
    const after = service.assessNow(new Date("2026-03-17T10:06:00.000Z"));
    const afterEntry = after.items.find((i) => i.item.id === item.id);
    expect(afterEntry).toBeTruthy();
    expect(afterEntry?.state).toBe("due");
  });

  test("paused items are excluded from assessment", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC" },
    });
    const item = service.addItem({
      title: "Paused routine",
      kind: "routine",
      schedule: { kind: "daily", time: "09:00" },
    });

    service.pause(item.id);

    const assessment = service.assessNow(new Date("2026-03-17T09:05:00.000Z"));
    const entry = assessment.items.find((i) => i.item.id === item.id);
    expect(entry).toBeUndefined();
  });

  test("disabled items are excluded from assessment", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC" },
    });
    const item = service.addItem({
      title: "Disabled routine",
      kind: "routine",
      schedule: { kind: "daily", time: "09:00" },
    });

    // Disable by pausing (pause sets enabled=false)
    service.pause(item.id);

    const assessment = service.assessNow(new Date("2026-03-17T09:05:00.000Z"));
    const entry = assessment.items.find((i) => i.item.id === item.id);
    expect(entry).toBeUndefined();
  });

  test("weekly schedule shows as upcoming before scheduled time on matching day", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC" },
    });
    const item = service.addItem({
      title: "Weekly review",
      kind: "routine",
      schedule: { kind: "weekly", time: "14:00", days: ["fri"] },
    });

    // Friday 2026-03-20 at 10:00 — before scheduled time, upcoming
    const beforeAssessment = service.assessNow(new Date("2026-03-20T10:00:00.000Z"));
    const beforeEntry = beforeAssessment.items.find((i) => i.item.id === item.id);
    expect(beforeEntry).toBeTruthy();
    expect(beforeEntry?.state).toBe("upcoming");

    // Wednesday 2026-03-18 at 14:05 — upcoming (next Friday)
    const wedAssessment = service.assessNow(new Date("2026-03-18T14:05:00.000Z"));
    const wedEntry = wedAssessment.items.find((i) => i.item.id === item.id);
    expect(wedEntry).toBeTruthy();
    expect(wedEntry?.state).toBe("upcoming");
  });

  test("monthly schedule is due on the right day of month", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC" },
    });
    const item = service.addItem({
      title: "Monthly review",
      kind: "routine",
      schedule: { kind: "monthly", time: "10:00", dayOfMonth: 15 },
    });

    // March 15 at 10:05 — due
    const dueAssessment = service.assessNow(new Date("2026-03-15T10:05:00.000Z"));
    const dueEntry = dueAssessment.items.find((i) => i.item.id === item.id);
    expect(dueEntry).toBeTruthy();
    expect(dueEntry?.state).toBe("due");
  });

  test("interval schedule fires after the configured number of days", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC" },
    });
    const item = service.addItem({
      title: "Every 3 days",
      kind: "habit",
      schedule: { kind: "interval", time: "09:00", everyDays: 3 },
    });

    // Due immediately on first day
    const firstAssessment = service.assessNow(new Date("2026-03-17T09:05:00.000Z"));
    const firstEntry = firstAssessment.items.find((i) => i.item.id === item.id);
    expect(firstEntry).toBeTruthy();
    expect(firstEntry?.state).toBe("due");

    // Mark done, next should be 3 days later
    service.markDone(item.id, new Date("2026-03-17T09:10:00.000Z"));
    const afterDone = service.assessNow(new Date("2026-03-18T09:05:00.000Z"));
    const afterEntry = afterDone.items.find((i) => i.item.id === item.id);
    expect(afterEntry).toBeTruthy();
    expect(afterEntry?.state).toBe("upcoming");
  });

  test("once schedule is due at the specified time and becomes completed", () => {
    const service = new RoutinesService();
    const item = service.addItem({
      title: "One-time task",
      kind: "todo",
      schedule: { kind: "once", dueAt: "2026-03-20T15:00:00.000Z" },
    });

    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC" },
    });

    // Before due
    const beforeAssessment = service.assessNow(new Date("2026-03-20T14:00:00.000Z"));
    const beforeEntry = beforeAssessment.items.find((i) => i.item.id === item.id);
    expect(beforeEntry).toBeTruthy();
    expect(beforeEntry?.state).toBe("upcoming");

    // After due
    const afterAssessment = service.assessNow(new Date("2026-03-20T15:05:00.000Z"));
    const afterEntry = afterAssessment.items.find((i) => i.item.id === item.id);
    expect(afterEntry).toBeTruthy();
    expect(afterEntry?.state).toBe("due");

    // Complete it — todo becomes completed
    const completed = service.markDone(item.id, new Date("2026-03-20T15:10:00.000Z"));
    expect(completed.status).toBe("completed");
  });

  test("multiple items sort by priority in assessment", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC" },
    });
    const low = service.addItem({
      title: "Low priority",
      kind: "routine",
      priority: "low",
      schedule: { kind: "daily", time: "09:00" },
    });
    const urgent = service.addItem({
      title: "Urgent thing",
      kind: "routine",
      priority: "urgent",
      schedule: { kind: "daily", time: "09:00" },
    });
    const high = service.addItem({
      title: "High priority",
      kind: "routine",
      priority: "high",
      schedule: { kind: "daily", time: "09:00" },
    });

    const assessment = service.assessNow(new Date("2026-03-17T09:05:00.000Z"));
    const ids = assessment.items.map((i) => i.item.id);
    expect(ids.indexOf(urgent.id)).toBeLessThan(ids.indexOf(high.id));
    expect(ids.indexOf(high.id)).toBeLessThan(ids.indexOf(low.id));
  });

  test("reminder escalation for med items", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC" },
    });
    const item = service.addItem({
      title: "Take pill",
      kind: "med",
      schedule: { kind: "daily", time: "09:00" },
    });

    // Default med reminder policy: followUpMinutes: 60, maxReminders: 3, escalate: true
    expect(item.reminder.followUpMinutes).toBe(60);
    expect(item.reminder.maxReminders).toBe(3);
    expect(item.reminder.escalate).toBe(true);

    // First reminder
    const snap1 = service.getHeartbeatReminderSnapshot(new Date("2026-03-17T09:05:00.000Z"));
    const c1 = snap1.requiredCandidates.find((c) => c.itemId === item.id);
    expect(c1).toBeTruthy();
    expect(c1?.reminderStage).toBe("initial");

    service.markReminded(snap1.itemIds, snap1.occurrenceKeys, new Date("2026-03-17T09:05:00.000Z"));

    // Too early for follow-up
    const snap2 = service.getHeartbeatReminderSnapshot(new Date("2026-03-17T09:30:00.000Z"));
    expect(snap2.requiredCandidates.find((c) => c.itemId === item.id)).toBeFalsy();

    // Follow-up due after 60 minutes
    const snap3 = service.getHeartbeatReminderSnapshot(new Date("2026-03-17T10:06:00.000Z"));
    const c3 = snap3.requiredCandidates.find((c) => c.itemId === item.id);
    expect(c3).toBeTruthy();
    expect(c3?.reminderStage).toBe("follow_up");
  });

  test("addItem generates a sensible ID from kind and title", () => {
    const service = new RoutinesService();
    const item = service.addItem({
      title: "Take Morning Meds!",
      kind: "med",
      schedule: { kind: "daily", time: "09:00" },
    });

    expect(item.id).toMatch(/^med_take-morning-meds_/);
  });

  test("getNextRoutineAttentionAt returns null when no items exist", () => {
    const service = new RoutinesService();
    const result = service.getNextRoutineAttentionAt(new Date("2026-03-17T09:00:00.000Z"));
    expect(result).toBeNull();
  });

  test("assessNow uses quietHours timezone for mode calculation instead of settings.timezone", () => {
    const service = new RoutinesService();
    // Set top-level timezone to UTC but quietHours timezone to America/New_York.
    // The sleep block is 00:00-09:00 (local time).
    // At midnight UTC it is 8 PM ET — that should NOT be sleep mode.
    service.saveData({
      ...service.loadData(),
      settings: {
        ...service.loadData().settings,
        timezone: "UTC",
        sleepBlock: {
          days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          start: "00:00",
          end: "09:00",
        },
        quietHours: {
          enabled: true,
          timezone: "America/New_York",
          start: "00:01",
          end: "09:00",
        },
      },
    });

    // Midnight UTC = 8 PM ET (EDT, March 17 2026). Should be "personal", not "sleep".
    const assessment = service.assessNow(new Date("2026-03-17T00:00:00.000Z"));
    expect(assessment.context.mode).not.toBe("sleep");
    expect(assessment.context.timezone).toBe("America/New_York");

    // 5 AM UTC = 1 AM ET. Should be "sleep".
    const lateNight = service.assessNow(new Date("2026-03-17T05:00:00.000Z"));
    expect(lateNight.context.mode).toBe("sleep");
    expect(lateNight.context.timezone).toBe("America/New_York");
  });

  test("buildSchedule in routine tools passes days through for daily schedules", async () => {
    const { buildSchedule } = await import("../functions/domains/routine-functions");

    const withDays = buildSchedule({
      scheduleKind: "daily",
      time: "09:00",
      days: ["mon", "wed", "fri"],
    });
    expect(withDays).toEqual({ kind: "daily", time: "09:00", days: ["mon", "wed", "fri"] });

    const withoutDays = buildSchedule({
      scheduleKind: "daily",
      time: "09:00",
    });
    expect(withoutDays).toEqual({ kind: "daily", time: "09:00" });
  });

  // --- Bug fix tests: alarm reminder runaway ---

  test("upcoming high-salience path respects maxReminders", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC" },
    });
    // Create an alarm med item scheduled at 10:00
    const item = service.addItem({
      title: "Melatonin alarm",
      kind: "med",
      alarm: true,
      priority: "high",
      schedule: { kind: "daily", time: "10:00" },
      reminder: { followUpMinutes: 60, maxReminders: 3, escalate: true },
    });

    // Simulate having already been reminded maxReminders times for today's occurrence.
    // At 09:30 the item is "upcoming" and within 60 minutes of due.
    // First, figure out what the occurrence key would be at 09:30 UTC.
    const referenceTime = new Date("2026-03-17T09:30:00.000Z");
    const preAssessment = service.assessNow(referenceTime);
    const preEntry = preAssessment.items.find((i) => i.item.id === item.id);
    expect(preEntry).toBeTruthy();
    expect(preEntry?.state).toBe("upcoming");
    const occurrenceKey = preEntry!.occurrenceKey;

    // Mark reminded 3 times (maxReminders) for this occurrence
    for (let i = 0; i < 3; i++) {
      service.markReminded(
        [item.id],
        [occurrenceKey],
        new Date(`2026-03-17T09:${10 + i}:00.000Z`),
      );
    }

    // Now assess again at 09:30 — should NOT fire because count >= maxReminders
    const assessment = service.assessNow(referenceTime);
    const entry = assessment.items.find((i) => i.item.id === item.id);
    expect(entry).toBeTruthy();
    expect(entry?.shouldRemindNow).toBe(false);
  });

  test("getNextRoutineAttentionAt returns future time for non-local timezone", () => {
    const service = new RoutinesService();
    // Use Pacific/Honolulu (UTC-10), which is behind both EDT and UTC.
    // On an EDT (UTC-4) machine, the fake-local-as-UTC trick produces a Date whose
    // epoch is 6 hours behind the real reference, so nextAttentionAt for a "due" item
    // (where nextAttentionAt = now = fakeLocal) ends up in the past relative to the
    // real reference time.
    // Must also set quietHours.timezone to match, since assessNow uses
    // quietHours.timezone as effectiveTimezone when it exists.
    service.saveData({
      ...service.loadData(),
      settings: {
        ...service.loadData().settings,
        timezone: "Pacific/Honolulu",
        quietHours: {
          enabled: false,
          timezone: "Pacific/Honolulu",
          start: "00:01",
          end: "09:00",
        },
      },
    });
    service.addItem({
      title: "Morning meds Honolulu",
      kind: "med",
      priority: "high",
      schedule: { kind: "daily", time: "09:00" },
    });

    // Reference: 2026-03-17T20:00:00Z = 2026-03-17 10:00 HST (UTC-10).
    // In Hawaii time the item (scheduled 09:00) is already due (10:00 > 09:00).
    // So assessNow sets nextAttentionAt = now (the fake-local Date).
    // The returned value must still be >= reference (real UTC) for the scheduler to work.
    const reference = new Date("2026-03-17T20:00:00.000Z");
    const nextAttentionAt = service.getNextRoutineAttentionAt(reference);

    expect(nextAttentionAt).not.toBeNull();
    const nextDate = new Date(nextAttentionAt!);
    expect(nextDate.getTime()).toBeGreaterThanOrEqual(reference.getTime());
  });

  test("hasAlarmRoutinesDueNow returns false when reminders exhausted", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC" },
    });
    const item = service.addItem({
      title: "Alarm med exhausted",
      kind: "med",
      alarm: true,
      schedule: { kind: "daily", time: "09:00" },
      reminder: { followUpMinutes: 60, maxReminders: 3, escalate: true },
    });

    // At 09:05 it's due — should return true before any reminders
    expect(service.hasAlarmRoutinesDueNow(new Date("2026-03-17T09:05:00.000Z"))).toBe(true);

    // The occurrence key for a daily schedule at 09:00 on 2026-03-17 is "2026-03-17"
    const occurrenceKey = "2026-03-17";

    // Mark reminded 3 times (maxReminders)
    for (let i = 0; i < 3; i++) {
      service.markReminded(
        [item.id],
        [occurrenceKey],
        new Date(`2026-03-17T09:${String(5 + i).padStart(2, "0")}:00.000Z`),
      );
    }

    // Now hasAlarmRoutinesDueNow should return false — reminders exhausted
    expect(service.hasAlarmRoutinesDueNow(new Date("2026-03-17T09:30:00.000Z"))).toBe(false);
  });

  // --- dayResetHour tests ---

  test("dayResetHour=4: daily med at 21:00 is still due at 02:00 next day with previous day key", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC", dayResetHour: 4 },
    });
    const item = service.addItem({
      title: "Melatonin",
      kind: "med",
      schedule: { kind: "daily", time: "21:00" },
    });

    // At 02:00 March 25 (still in "March 24" routine day because dayResetHour=4)
    // dayAnchor = 02:00 - 4h = 22:00 March 24
    // dueAt = 21:00 March 24
    // key = "2026-03-24"
    // 21:00 March 24 <= 02:00 March 25 => "due"
    const assessment = service.assessNow(new Date("2026-03-25T02:00:00.000Z"));
    const entry = assessment.items.find((i) => i.item.id === item.id);
    expect(entry).toBeTruthy();
    expect(entry?.state).toBe("due");
    expect(entry?.occurrenceKey).toBe("2026-03-24");

    // At 04:01 March 25 (new routine day "March 25")
    // dayAnchor = 04:01 - 4h = 00:01 March 25
    // dueAt = 21:00 March 25
    // key = "2026-03-25"
    // 21:00 March 25 > 04:01 March 25 => "upcoming"
    const assessment2 = service.assessNow(new Date("2026-03-25T04:01:00.000Z"));
    const entry2 = assessment2.items.find((i) => i.item.id === item.id);
    expect(entry2).toBeTruthy();
    expect(entry2?.state).toBe("upcoming");
    expect(entry2?.occurrenceKey).toBe("2026-03-25");
  });

  test("dayResetHour=4: completion across midnight counts as same routine day", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC", dayResetHour: 4 },
    });
    const item = service.addItem({
      title: "Evening meds",
      kind: "med",
      schedule: { kind: "daily", time: "21:00" },
    });

    // Complete at 01:00 March 25 (still routine day "March 24" with dayResetHour=4)
    service.markDone(item.id, new Date("2026-03-25T01:00:00.000Z"));

    // At 02:00 March 25, the item should be considered completed for the "March 24" occurrence
    // because the completion at 01:00 is in the same routine day as the 21:00 due time
    const assessment = service.assessNow(new Date("2026-03-25T02:00:00.000Z"));
    const entry = assessment.items.find((i) => i.item.id === item.id);
    // Should not appear because it's counted as completed for the "March 24" routine day
    expect(entry).toBeUndefined();

    // At 22:00 March 25 (now in routine day "March 25"), the item should appear again
    // because the completion at 01:00 was for routine day "March 24", not "March 25"
    const assessment2 = service.assessNow(new Date("2026-03-25T22:00:00.000Z"));
    const entry2 = assessment2.items.find((i) => i.item.id === item.id);
    expect(entry2).toBeTruthy();
    expect(entry2?.state).toBe("due");
    expect(entry2?.occurrenceKey).toBe("2026-03-25");
  });

  test("dayResetHour=4: morning check-in at 08:00 is due for previous day at 03:30", () => {
    const service = new RoutinesService();
    service.saveData({
      ...service.loadData(),
      settings: { ...service.loadData().settings, timezone: "UTC", dayResetHour: 4 },
    });
    const item = service.addItem({
      title: "Morning check-in",
      kind: "routine",
      schedule: { kind: "daily", time: "08:00" },
    });

    // At 03:30 March 25 (still routine day "March 24" with dayResetHour=4)
    // dayAnchor = 03:30 - 4h = 23:30 March 24
    // dueAt = 08:00 March 24
    // key = "2026-03-24"
    // 08:00 March 24 <= 03:30 March 25 => "due" (overdue from previous routine day)
    const assessment = service.assessNow(new Date("2026-03-25T03:30:00.000Z"));
    const entry = assessment.items.find((i) => i.item.id === item.id);
    expect(entry).toBeTruthy();
    expect(entry?.state).toBe("due");
    expect(entry?.occurrenceKey).toBe("2026-03-24");

    // At 04:30 March 25 (new routine day "March 25")
    // dayAnchor = 04:30 - 4h = 00:30 March 25
    // dueAt = 08:00 March 25
    // key = "2026-03-25"
    // 08:00 March 25 > 04:30 March 25 => "upcoming"
    const assessment2 = service.assessNow(new Date("2026-03-25T04:30:00.000Z"));
    const entry2 = assessment2.items.find((i) => i.item.id === item.id);
    expect(entry2).toBeTruthy();
    expect(entry2?.state).toBe("upcoming");
    expect(entry2?.occurrenceKey).toBe("2026-03-25");
  });
});
