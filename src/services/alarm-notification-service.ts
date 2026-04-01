import fs from "node:fs";
import path from "node:path";
import type { ScheduledAlarm } from "./alarm-service";
import { wrapInjectedMessage } from "./injected-message-service";
import { formatLocalTime } from "./local-time-service";
import { getAssistantContextRoot } from "./runtime-user-content";
import { timestamp } from "../utils/timestamp";

const ALARM_FILE_NAME = "alarm.md";
const EMPTY_ASSISTANT_RESPONSES = [
  "The assistant responded without text output.",
  "The assistant did not return a reply.",
];
const FALLBACK_ALARM_CONTEXT = [
  "# Alarm Notification",
  "",
  "- This is an automated internal alarm or timer trigger, not a user-authored Discord message.",
  "- The runtime injects the trigger timestamp, local wall-clock time, timezone, and the original alarm spec.",
  "- Write one concise user-facing message for the triggered alarm or timer.",
  "- Do not dump the raw internal payload unless a field is materially useful to the user.",
].join("\n");

function getAlarmFilePath() {
  return path.join(getAssistantContextRoot(), ALARM_FILE_NAME);
}

export interface AlarmNotificationSnapshot {
  text: string;
  path: string;
  loadedAt: string;
  charCount: number;
}

export class AlarmNotificationService {
  load(): AlarmNotificationSnapshot {
    const alarmContextRoot = getAssistantContextRoot();
    const alarmFilePath = getAlarmFilePath();
    fs.mkdirSync(alarmContextRoot, { recursive: true });
    const text = fs.existsSync(alarmFilePath)
      ? fs.readFileSync(alarmFilePath, "utf8").trim()
      : FALLBACK_ALARM_CONTEXT;

    return {
      text,
      path: alarmFilePath,
      loadedAt: timestamp(),
      charCount: text.length,
    };
  }

  buildInjectedMessage(alarm: ScheduledAlarm, reference: Date = new Date()) {
    const snapshot = this.load();
    return wrapInjectedMessage("alarm", [
      "Automated alarm notification trigger. This is an internal runtime event, not a user-authored Discord message.",
      `Triggered at: ${reference.toISOString()}`,
      `Current local time: ${formatLocalTime(reference, alarm.timezone)}`,
      `Alarm instructions from ${snapshot.path}:`,
      snapshot.text,
      [
        "Triggered alarm payload. This is internal runtime context, not a user-authored message.",
        `Kind: ${alarm.kind}`,
        `Name: ${alarm.name}`,
        `Trigger timestamp: ${alarm.triggerAt}`,
        `Timezone: ${alarm.timezone}`,
        `Original spec: ${alarm.originalSpec}`,
        `Created at: ${alarm.createdAt}`,
        `Alarm id: ${alarm.id}`,
      ].join("\n"),
    ].join("\n\n"));
  }

  normalizeAssistantReply(message: string | undefined) {
    const normalized = message?.trim();
    if (!normalized || EMPTY_ASSISTANT_RESPONSES.includes(normalized)) {
      return undefined;
    }
    return normalized;
  }
}
