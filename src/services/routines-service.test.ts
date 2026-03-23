import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { updateTestRuntimeConfig } from "../test/runtime-config-test-helpers";
import { ProfileService } from "./profile-service";
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
      })).toThrow("Unknown project for routine item: missing-project");
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
});
