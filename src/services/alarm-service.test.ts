import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createIsolatedRuntimeRoot } from "../test/isolated-runtime-root";
import { AlarmService } from "./alarm-service";

const testRoot = createIsolatedRuntimeRoot("openelinaro-alarms-");
beforeEach(() => testRoot.setup());
afterEach(() => testRoot.teardown());

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
