import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ScheduledAlarm } from "./alarm-service";
import { AlarmNotificationService } from "./alarm-notification-service";
import { resolveAssistantContextPath } from "./runtime-user-content";

let runtimeRoot = "";
let previousRootDirEnv: string | undefined;

beforeEach(() => {
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-alarm-notification-"));
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

function makeAlarm(overrides: Partial<ScheduledAlarm> = {}): ScheduledAlarm {
  return {
    id: "alarm-001",
    kind: "alarm",
    name: "Standup",
    triggerAt: "2026-03-20T09:00:00.000Z",
    timezone: "UTC",
    createdAt: "2026-03-20T08:00:00.000Z",
    originalSpec: "9am UTC",
    ...overrides,
  };
}

describe("AlarmNotificationService", () => {
  test("loads fallback context when no alarm.md exists", () => {
    const service = new AlarmNotificationService();
    const snapshot = service.load();

    expect(snapshot.text).toContain("Alarm Notification");
    expect(snapshot.text).toContain("automated internal alarm");
    expect(snapshot.charCount).toBeGreaterThan(0);
    expect(snapshot.loadedAt).toBeTruthy();
  });

  test("loads authored alarm.md when present", () => {
    const contextRoot = resolveAssistantContextPath();
    fs.mkdirSync(contextRoot, { recursive: true });
    fs.writeFileSync(
      resolveAssistantContextPath("alarm.md"),
      "# Custom Alarm\n\nRing the bell.\n",
    );

    const service = new AlarmNotificationService();
    const snapshot = service.load();

    expect(snapshot.text).toContain("Custom Alarm");
    expect(snapshot.text).toContain("Ring the bell.");
  });

  test("buildInjectedMessage includes alarm payload and context", () => {
    const service = new AlarmNotificationService();
    const alarm = makeAlarm();
    const reference = new Date("2026-03-20T09:00:00.000Z");

    const message = service.buildInjectedMessage(alarm, reference);

    expect(message).toContain("<INJECTED_MESSAGE generated_by=\"alarm\">");
    expect(message).toContain("Automated alarm notification trigger");
    expect(message).toContain("Triggered at: 2026-03-20T09:00:00.000Z");
    expect(message).toContain("Kind: alarm");
    expect(message).toContain("Name: Standup");
    expect(message).toContain("Alarm id: alarm-001");
    expect(message).toContain("Original spec: 9am UTC");
  });

  test("normalizeAssistantReply returns undefined for empty or sentinel replies", () => {
    const service = new AlarmNotificationService();

    expect(service.normalizeAssistantReply(undefined)).toBeUndefined();
    expect(service.normalizeAssistantReply("")).toBeUndefined();
    expect(service.normalizeAssistantReply("   ")).toBeUndefined();
    expect(service.normalizeAssistantReply("The assistant responded without text output.")).toBeUndefined();
  });

  test("normalizeAssistantReply returns trimmed text for real replies", () => {
    const service = new AlarmNotificationService();

    expect(service.normalizeAssistantReply("  Your alarm went off!  ")).toBe("Your alarm went off!");
    expect(service.normalizeAssistantReply("Meeting time.")).toBe("Meeting time.");
  });
});
