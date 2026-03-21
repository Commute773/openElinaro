import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AlarmService } from "./alarm-service";

let runtimeRoot = "";
let previousRootDirEnv: string | undefined;

beforeEach(() => {
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-alarms-"));
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

describe("AlarmService", () => {
  test("stores timers, lists due items, marks delivery, and cancels alarms", () => {
    const service = new AlarmService();
    const reference = new Date("2026-03-15T12:00:00.000Z");

    const timer = service.setTimer("Tea", "10m", reference);
    const alarm = service.setAlarm("Meeting", "2026-03-15T12:30:00.000Z", reference);

    expect(service.listAlarms().map((entry) => entry.id)).toEqual([timer.id, alarm.id]);
    expect(service.listDueAlarms(new Date("2026-03-15T12:09:00.000Z"))).toEqual([]);
    expect(service.listDueAlarms(new Date("2026-03-15T12:10:00.000Z")).map((entry) => entry.id)).toEqual([timer.id]);

    service.markDelivered(timer.id, new Date("2026-03-15T12:10:01.000Z"));
    expect(service.listAlarms().map((entry) => entry.id)).toEqual([alarm.id]);

    const cancelled = service.cancelAlarm(alarm.id, new Date("2026-03-15T12:11:00.000Z"));
    expect(cancelled.cancelledAt).toBeTruthy();
    expect(service.listAlarms()).toEqual([]);
    expect(service.listAlarms({ state: "cancelled" }).map((entry) => entry.id)).toEqual([alarm.id]);
  });
});
