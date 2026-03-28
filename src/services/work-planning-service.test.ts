import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ProfileService } from "./profiles";
import { ProjectsService } from "./projects-service";
import { RoutinesService } from "./scheduling/routines-service";
import { WorkPlanningService } from "./work-planning-service";

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
          priority: "urgent",
          summary: "Primary client.",
          availabilityBlocks: [
            {
              startAt: "2026-03-16T13:00:00.000-04:00",
              endAt: "2026-03-16T18:00:00.000-04:00",
              kind: "vacation",
              note: "Out for the afternoon.",
            },
          ],
        },
        {
          id: "remote",
          name: "Remote",
          status: "active",
          priority: "medium",
          summary: "Secondary client.",
        },
      ],
      projects: [
        {
          id: "telecorder",
          name: "Telecorder",
          status: "active",
          jobId: "restricted",
          priority: "urgent",
          allowedRoles: [],
          workspacePath: path.join(rootDir, ".openelinarotest", "projects/telecorder/workspace"),
          summary: "Telecorder work.",
          currentState: "Need demo proof.",
          state: "Telecorder is in the proof-building phase for the operator demo.",
          future: "Telecorder should unify remote operation, monitoring, and recordings across multiple environments.",
          milestone: "Build the first whiplash-to-telecorder adapter boundary with coordinate-convention tests.",
          nextFocus: ["Prepare operator demo."],
          structure: ["README.md", "projects/registry.json: embedded state/future/milestone"],
          tags: ["restricted"],
          docs: {
            readme: "projects/telecorder/README.md",
          },
        },
        {
          id: "link-coach",
          name: "Link Coach",
          status: "active",
          jobId: "remote",
          priority: "medium",
          allowedRoles: [],
          workspacePath: path.join(rootDir, ".openelinarotest", "projects/link-coach/workspace"),
          summary: "Link Coach work.",
          currentState: "Client work in progress.",
          state: "Link Coach is configured for SSH-backed access but still needs live remote verification.",
          future: "Link Coach should settle into a normal remote project workflow through the remote profile.",
          nextFocus: ["Ship the due feature."],
          structure: ["README.md", "projects/registry.json: embedded state/future"],
          tags: ["remote"],
          docs: {
            readme: "projects/link-coach/README.md",
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
          state: "openEven is personal and should stay out of work-time steering.",
          future: "Explore custom device integrations.",
          nextFocus: ["Review SDK options."],
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
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-work-planning-"));
  process.env.OPENELINARO_ROOT_DIR = runtimeRoot;
  writeProfileRegistry(runtimeRoot);
  writeProjectsRegistry(runtimeRoot);
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

function createService() {
  const profiles = new ProfileService("root");
  const profile = profiles.getActiveProfile();
  const projects = new ProjectsService(profile, profiles);
  const routines = new RoutinesService(projects);
  const workPlanning = new WorkPlanningService(routines, projects);
  return {
    routines,
    workPlanning,
  };
}

describe("WorkPlanningService", () => {
  test("ranks closer due work ahead of a higher-priority job on vacation", () => {
    const { routines, workPlanning } = createService();
    routines.saveData({
      ...routines.loadData(),
      settings: {
        ...routines.loadData().settings,
        timezone: "America/New_York",
        workBlock: {
          days: ["mon", "tue", "wed", "thu", "fri"],
          start: "09:00",
          end: "17:00",
        },
      },
    });

    routines.addItem({
      title: "Telecorder stretch goal",
      kind: "todo",
      projectId: "telecorder",
      priority: "urgent",
      schedule: { kind: "once", dueAt: "2026-03-17T17:00:00.000-04:00" },
    });
    routines.addItem({
      title: "Link Coach client deadline",
      kind: "todo",
      projectId: "link-coach",
      priority: "medium",
      schedule: { kind: "once", dueAt: "2026-03-16T16:30:00.000-04:00" },
    });

    const snapshot = workPlanning.getSnapshot(new Date("2026-03-16T18:00:00.000Z"));

    expect(snapshot.mode).toBe("work");
    expect(snapshot.activeJobIds).toEqual(["remote"]);
    expect(snapshot.currentFocus?.item.title).toBe("Link Coach client deadline");
  });

  test("keeps manual backlog items in the work queue", () => {
    const { routines, workPlanning } = createService();
    routines.saveData({
      ...routines.loadData(),
      settings: {
        ...routines.loadData().settings,
        timezone: "America/New_York",
      },
    });

    routines.addItem({
      title: "Record demo video",
      kind: "todo",
      projectId: "link-coach",
      priority: "high",
      schedule: { kind: "manual" },
      labels: ["in-progress"],
    });
    routines.addItem({
      title: "Capture screenshots",
      kind: "todo",
      projectId: "link-coach",
      priority: "medium",
      schedule: { kind: "manual" },
    });

    const snapshot = workPlanning.getSnapshot(new Date("2026-03-16T18:00:00.000Z"));

    expect(snapshot.currentFocus?.item.title).toBe("Record demo video");
    expect(snapshot.queue.map((entry) => entry.item.title)).toContain("Capture screenshots");
  });

  test("keeps work context minimal outside work mode when nothing is overdue", () => {
    const { routines, workPlanning } = createService();
    routines.addItem({
      title: "Tomorrow deliverable",
      kind: "todo",
      projectId: "link-coach",
      priority: "high",
      schedule: { kind: "once", dueAt: "2026-03-17T12:00:00.000-04:00" },
    });

    const text = workPlanning.buildAssistantContext(new Date("2026-03-17T02:00:00.000Z"));

    expect(text).toContain("outside work mode");
  });

  test("keeps personal project todos out of the work queue", () => {
    const { routines, workPlanning } = createService();
    routines.addItem({
      title: "Research Even SDK",
      kind: "todo",
      projectId: "open-even",
      priority: "high",
      schedule: { kind: "manual" },
    });

    const snapshot = workPlanning.getSnapshot(new Date("2026-03-16T18:00:00.000Z"));

    expect(snapshot.items).toEqual([]);
  });

  test("emits heartbeat work steering during work mode when no item is explicitly in progress", () => {
    const { routines, workPlanning } = createService();
    routines.saveData({
      ...routines.loadData(),
      settings: {
        ...routines.loadData().settings,
        timezone: "America/New_York",
        workBlock: {
          days: ["mon", "tue", "wed", "thu", "fri"],
          start: "09:00",
          end: "17:00",
        },
      },
    });
    routines.addItem({
      title: "Prepare operator demo",
      kind: "todo",
      projectId: "link-coach",
      priority: "high",
      schedule: { kind: "manual" },
    });

    const summary = workPlanning.buildHeartbeatSummary(new Date("2026-03-16T18:00:00.000Z"));

    expect(summary).toBeDefined();
    expect(summary).toContain("Work focus");
    expect(summary).toContain("Prepare operator demo");
  });
});
