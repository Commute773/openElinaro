import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RoutineStoreData } from "../../domain/routines";
import { RoutinesStore } from "./routines-store";

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

beforeEach(() => {
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-routines-store-"));
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

describe("RoutinesStore", () => {
  test("load returns empty store when no file exists", () => {
    const store = new RoutinesStore();
    const data = store.load();
    expect(data.settings.timezone).toBeTruthy();
    expect(data.calendarEvents).toEqual([]);
    expect(data.items).toEqual({});
    expect(data.settings.workBlock.days).toContain("mon");
    expect(data.settings.sleepBlock.start).toBe("00:00");
    expect(data.settings.quietHours.enabled).toBe(true);
  });

  test("save and load round-trip persists data", () => {
    const store = new RoutinesStore();
    const data = store.load();
    data.items["test-item"] = {
      id: "test-item",
      profileId: "root",
      title: "Test routine",
      kind: "todo",
      priority: "medium",
      status: "active",
      enabled: true,
      schedule: { kind: "manual" },
      reminder: { followUpMinutes: 60, maxReminders: 1, escalate: false },
      state: {
        completionHistory: [],
        skippedOccurrenceKeys: [],
        reminderCountForOccurrence: 0,
        streak: 0,
      },
    };
    store.save(data);

    const reloaded = store.load();
    expect(reloaded.items["test-item"]).toBeTruthy();
    expect(reloaded.items["test-item"]!.title).toBe("Test routine");
    expect(reloaded.items["test-item"]!.profileId).toBe("root");
  });

  test("save overwrites previous data", () => {
    const store = new RoutinesStore();
    const data1 = store.load();
    data1.items["item-a"] = {
      id: "item-a",
      profileId: "root",
      title: "Item A",
      kind: "habit",
      priority: "low",
      status: "active",
      enabled: true,
      schedule: { kind: "daily", time: "09:00" },
      reminder: { followUpMinutes: 60, maxReminders: 1, escalate: false },
      state: {
        completionHistory: [],
        skippedOccurrenceKeys: [],
        reminderCountForOccurrence: 0,
        streak: 0,
      },
    };
    store.save(data1);

    const data2 = store.load();
    delete data2.items["item-a"];
    data2.items["item-b"] = {
      id: "item-b",
      profileId: "root",
      title: "Item B",
      kind: "todo",
      priority: "high",
      status: "active",
      enabled: true,
      schedule: { kind: "manual" },
      reminder: { followUpMinutes: 30, maxReminders: 2, escalate: false },
      state: {
        completionHistory: [],
        skippedOccurrenceKeys: [],
        reminderCountForOccurrence: 0,
        streak: 0,
      },
    };
    store.save(data2);

    const reloaded = store.load();
    expect(reloaded.items["item-a"]).toBeUndefined();
    expect(reloaded.items["item-b"]!.title).toBe("Item B");
  });

  test("load normalizes items with missing state fields", () => {
    const storePath = path.join(runtimeRoot, ".openelinarotest", "routines.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        settings: { timezone: "UTC" },
        calendarEvents: [],
        items: {
          "sparse-item": {
            id: "sparse-item",
            title: "Sparse",
            kind: "todo",
            priority: "medium",
            schedule: { kind: "manual" },
            reminder: { followUpMinutes: 60, maxReminders: 1, escalate: false },
            state: {},
          },
        },
      }),
    );

    const store = new RoutinesStore();
    const data = store.load();
    const item = data.items["sparse-item"]!;
    expect(item.state.completionHistory).toEqual([]);
    expect(item.state.skippedOccurrenceKeys).toEqual([]);
    expect(item.state.reminderCountForOccurrence).toBe(0);
    expect(item.state.streak).toBe(0);
    expect(item.enabled).toBe(true);
    expect(item.status).toBe("active");
    expect(item.profileId).toBe("root");
  });

  test("load normalizes paused items as disabled", () => {
    const storePath = path.join(runtimeRoot, ".openelinarotest", "routines.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        settings: { timezone: "UTC" },
        calendarEvents: [],
        items: {
          "paused-item": {
            id: "paused-item",
            title: "Paused",
            kind: "todo",
            priority: "medium",
            status: "paused",
            schedule: { kind: "manual" },
            reminder: { followUpMinutes: 60, maxReminders: 1, escalate: false },
            state: {},
          },
        },
      }),
    );

    const store = new RoutinesStore();
    const data = store.load();
    const item = data.items["paused-item"]!;
    expect(item.status).toBe("paused");
    expect(item.enabled).toBe(false);
  });

  test("load fills missing settings fields with defaults", () => {
    const storePath = path.join(runtimeRoot, ".openelinarotest", "routines.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        settings: { timezone: "America/New_York" },
        items: {},
      }),
    );

    const store = new RoutinesStore();
    const data = store.load();
    expect(data.settings.timezone).toBe("America/New_York");
    expect(data.settings.workBlock).toBeTruthy();
    expect(data.settings.sleepBlock).toBeTruthy();
    expect(data.settings.quietHours).toBeTruthy();
    expect(data.calendarEvents).toEqual([]);
  });

  test("save returns the data it was given", () => {
    const store = new RoutinesStore();
    const data = store.load();
    const result = store.save(data);
    expect(result).toBe(data);
  });

  test("saved file has restricted permissions (mode 0o600)", () => {
    const store = new RoutinesStore();
    store.save(store.load());
    const storePath = path.join(runtimeRoot, ".openelinarotest", "routines.json");
    const stats = fs.statSync(storePath);
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("load preserves calendar events", () => {
    const storePath = path.join(runtimeRoot, ".openelinarotest", "routines.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        settings: { timezone: "UTC" },
        calendarEvents: [
          { title: "Meeting", start: "2026-03-17T10:00:00.000Z", end: "2026-03-17T11:00:00.000Z" },
        ],
        items: {},
      }),
    );

    const store = new RoutinesStore();
    const data = store.load();
    expect(data.calendarEvents).toHaveLength(1);
    expect(data.calendarEvents[0]!.title).toBe("Meeting");
  });
});
