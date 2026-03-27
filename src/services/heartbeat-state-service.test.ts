import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createIsolatedRuntimeRoot } from "../test/isolated-runtime-root";
import { HeartbeatStateService } from "./heartbeat-state-service";

const testRoot = createIsolatedRuntimeRoot("openelinaro-heartbeat-state-");
beforeEach(() => testRoot.setup());
afterEach(() => testRoot.teardown());

describe("HeartbeatStateService", () => {
  test("returns empty state when no file exists", () => {
    const service = new HeartbeatStateService();
    const state = service.load();
    expect(state).toEqual({});
  });

  test("saves and loads heartbeat state", () => {
    const service = new HeartbeatStateService();
    const saved = service.save({
      lastCompletedAt: "2026-03-20T10:00:00.000Z",
      consecutiveFailures: 0,
    });

    expect(saved.lastCompletedAt).toBe("2026-03-20T10:00:00.000Z");
    expect(saved.consecutiveFailures).toBe(0);

    const loaded = service.load();
    expect(loaded.lastCompletedAt).toBe("2026-03-20T10:00:00.000Z");
    expect(loaded.consecutiveFailures).toBe(0);
  });

  test("normalizes invalid fields to undefined", () => {
    const service = new HeartbeatStateService();
    const saved = service.save({
      lastCompletedAt: "   ",
      lastFailedAt: "",
      consecutiveFailures: NaN,
      nextAttemptAt: "  ",
    } as any);

    expect(saved.lastCompletedAt).toBeUndefined();
    expect(saved.lastFailedAt).toBeUndefined();
    expect(saved.consecutiveFailures).toBeUndefined();
    expect(saved.nextAttemptAt).toBeUndefined();
  });

  test("floors and clamps consecutiveFailures to non-negative integer", () => {
    const service = new HeartbeatStateService();
    const saved = service.save({
      consecutiveFailures: 3.7,
    });
    expect(saved.consecutiveFailures).toBe(3);

    const savedNeg = service.save({
      consecutiveFailures: -2,
    });
    expect(savedNeg.consecutiveFailures).toBe(0);
  });

  test("returns empty state when file contains invalid JSON", () => {
    const service = new HeartbeatStateService();
    // Save first to create directory structure, then corrupt the file
    service.save({ lastCompletedAt: "2026-03-20T10:00:00.000Z" });
    const statePath = path.join(testRoot.path, ".openelinarotest", "heartbeat-state.json");
    fs.writeFileSync(statePath, "not-valid-json{{{", "utf8");

    const loaded = service.load();
    expect(loaded).toEqual({});
  });

  test("preserves all valid fields through save-load cycle", () => {
    const service = new HeartbeatStateService();
    service.save({
      lastCompletedAt: "2026-03-20T10:00:00.000Z",
      lastFailedAt: "2026-03-20T09:00:00.000Z",
      consecutiveFailures: 2,
      nextAttemptAt: "2026-03-20T10:30:00.000Z",
    });

    const loaded = service.load();
    expect(loaded.lastCompletedAt).toBe("2026-03-20T10:00:00.000Z");
    expect(loaded.lastFailedAt).toBe("2026-03-20T09:00:00.000Z");
    expect(loaded.consecutiveFailures).toBe(2);
    expect(loaded.nextAttemptAt).toBe("2026-03-20T10:30:00.000Z");
  });

  test("normalizes non-object input to empty state", () => {
    const service = new HeartbeatStateService();
    // Write a non-object JSON value directly
    service.save({ lastCompletedAt: "2026-03-20T10:00:00.000Z" });
    const statePath = path.join(testRoot.path, ".openelinarotest", "heartbeat-state.json");
    fs.writeFileSync(statePath, '"just a string"', "utf8");

    const loaded = service.load();
    expect(loaded).toEqual({});
  });
});
