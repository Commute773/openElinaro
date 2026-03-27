import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createIsolatedRuntimeRoot } from "../test/isolated-runtime-root";
import { CalendarSyncService, parseCalendarOccurrences } from "./calendar-sync-service";
import { ProfileService } from "./profile-service";
import { RoutinesService } from "./routines-service";

const testRoot = createIsolatedRuntimeRoot("openelinaro-calendar-");

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

const SAMPLE_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:doctor-1",
  "DTSTART;TZID=America/Montreal:20260318T141500",
  "DTEND;TZID=America/Montreal:20260318T150000",
  "SUMMARY:Doctor Appointment",
  "LOCATION:123 Clinic St",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:standup-1",
  "DTSTART;TZID=America/Montreal:20260316T090000",
  "DTEND;TZID=America/Montreal:20260316T093000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260401T000000Z",
  "SUMMARY:Team Standup",
  "LOCATION:https://meet.google.com/example",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

beforeEach(() => {
  testRoot.setup();
  writeProfileRegistry(testRoot.path);
});
afterEach(() => testRoot.teardown());

describe("CalendarSyncService", () => {
  test("parses direct and recurring ICS events with transit inference", () => {
    const events = parseCalendarOccurrences(SAMPLE_ICS, new Date("2026-03-18T12:00:00.000Z"), 20);
    expect(events.some((event) => event.title === "Doctor Appointment" && event.requiresTransit)).toBe(true);
    expect(events.some((event) => event.title === "Team Standup" && event.requiresTransit === false)).toBe(true);
    expect(events.filter((event) => event.title === "Team Standup").length).toBeGreaterThan(1);
  });

  test("syncs calendar events into routines state", async () => {
    const profiles = new ProfileService("root");
    profiles.getActiveProfile();
    const routines = new RoutinesService();
    const calls: string[] = [];
    const service = new CalendarSyncService(
      routines,
      undefined,
      async (input) => {
        calls.push(String(input));
        return new Response(SAMPLE_ICS, {
          status: 200,
          headers: {
            "content-type": "text/calendar",
            etag: '"abc123"',
          },
        });
      },
      "https://example.test/calendar.ics",
    );

    const result = await service.syncIfNeeded({
      reference: new Date("2026-03-18T12:00:00.000Z"),
      force: true,
      lookaheadDays: 20,
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const calendarEvents = routines.loadData().calendarEvents;
    expect(calendarEvents.some((event) => event.title === "Doctor Appointment")).toBe(true);
    expect(calendarEvents.some((event) => event.title === "Team Standup")).toBe(true);
  });

  test("backs off after rate limiting", async () => {
    const routines = new RoutinesService();
    let callCount = 0;
    const service = new CalendarSyncService(
      routines,
      undefined,
      async () => {
        callCount += 1;
        return new Response("", {
          status: 429,
          headers: {
            "retry-after": "8",
          },
        });
      },
      "https://example.test/calendar.ics",
    );

    const first = await service.syncIfNeeded({
      reference: new Date("2026-03-18T12:00:00.000Z"),
      force: true,
    });
    const second = await service.syncIfNeeded({
      reference: new Date("2026-03-18T12:00:05.000Z"),
    });

    expect(first).toMatchObject({ ok: false, reason: "http_error", status: 429 });
    expect(second).toMatchObject({ ok: false, reason: "backoff" });
    expect(callCount).toBe(1);
  });
});
