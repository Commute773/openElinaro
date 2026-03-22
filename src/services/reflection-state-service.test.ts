import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ReflectionStateService } from "./reflection-state-service";

let runtimeRoot = "";
let previousRootDirEnv: string | undefined;

beforeEach(() => {
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-reflection-state-"));
  process.env.OPENELINARO_ROOT_DIR = runtimeRoot;
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

describe("ReflectionStateService", () => {
  test("returns default empty state when no file exists", () => {
    const service = new ReflectionStateService();
    const state = service.load();

    expect(state).toEqual({ version: 1, profiles: {} });
  });

  test("saves and loads reflection state", () => {
    const service = new ReflectionStateService();
    service.save({
      version: 1,
      profiles: {
        "profile-1": { lastDailyLocalDate: "2026-03-20" },
      },
    });

    const loaded = service.load();
    expect(loaded.version).toBe(1);
    expect(loaded.profiles["profile-1"]?.lastDailyLocalDate).toBe("2026-03-20");
  });

  test("normalizes invalid profile state fields", () => {
    const service = new ReflectionStateService();
    const saved = service.save({
      version: 1,
      profiles: {
        "profile-1": {
          lastDailyLocalDate: "   ",
          lastSoulRewriteLocalDate: "",
        } as any,
      },
    });

    expect(saved.profiles["profile-1"]?.lastDailyLocalDate).toBeUndefined();
    expect(saved.profiles["profile-1"]?.lastSoulRewriteLocalDate).toBeUndefined();
  });

  test("returns empty state when file contains invalid JSON", () => {
    const service = new ReflectionStateService();
    service.save({ version: 1, profiles: {} });
    const statePath = path.join(runtimeRoot, ".openelinarotest", "reflection-state.json");
    fs.writeFileSync(statePath, "corrupted{{{", "utf8");

    const loaded = service.load();
    expect(loaded).toEqual({ version: 1, profiles: {} });
  });

  test("getProfileState returns empty object for unknown profile", () => {
    const service = new ReflectionStateService();
    const state = service.getProfileState("nonexistent");
    expect(state).toEqual({});
  });

  test("getProfileState returns profile state by string id", () => {
    const service = new ReflectionStateService();
    service.save({
      version: 1,
      profiles: {
        "profile-1": { lastDailyLocalDate: "2026-03-20" },
      },
    });

    const state = service.getProfileState("profile-1");
    expect(state.lastDailyLocalDate).toBe("2026-03-20");
  });

  test("getProfileState accepts a ProfileRecord-like object", () => {
    const service = new ReflectionStateService();
    service.save({
      version: 1,
      profiles: {
        "profile-2": { lastSoulRewriteLocalDate: "2026-03-19" },
      },
    });

    const state = service.getProfileState({ id: "profile-2" });
    expect(state.lastSoulRewriteLocalDate).toBe("2026-03-19");
  });

  test("updateProfileState applies updater and persists", () => {
    const service = new ReflectionStateService();

    const result = service.updateProfileState("profile-1", () => ({
      lastDailyLocalDate: "2026-03-20",
    }));

    expect(result.lastDailyLocalDate).toBe("2026-03-20");

    const loaded = service.getProfileState("profile-1");
    expect(loaded.lastDailyLocalDate).toBe("2026-03-20");
  });

  test("updateProfileState merges with existing state for other profiles", () => {
    const service = new ReflectionStateService();
    service.save({
      version: 1,
      profiles: {
        "profile-1": { lastDailyLocalDate: "2026-03-19" },
      },
    });

    service.updateProfileState("profile-2", () => ({
      lastDailyLocalDate: "2026-03-20",
    }));

    const state = service.load();
    expect(state.profiles["profile-1"]?.lastDailyLocalDate).toBe("2026-03-19");
    expect(state.profiles["profile-2"]?.lastDailyLocalDate).toBe("2026-03-20");
  });

  test("updateProfileState receives current state in the updater", () => {
    const service = new ReflectionStateService();
    service.updateProfileState("profile-1", () => ({
      lastDailyLocalDate: "2026-03-19",
    }));

    service.updateProfileState("profile-1", (current) => ({
      ...current,
      lastSoulRewriteLocalDate: "2026-03-20",
    }));

    const state = service.getProfileState("profile-1");
    expect(state.lastDailyLocalDate).toBe("2026-03-19");
    expect(state.lastSoulRewriteLocalDate).toBe("2026-03-20");
  });
});
