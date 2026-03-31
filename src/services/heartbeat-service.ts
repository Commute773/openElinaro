import fs from "node:fs";
import path from "node:path";
import type { HeartbeatReminderSnapshot } from "../domain/routines";
import { formatLocalTime } from "./local-time-service";
import { wrapInjectedMessage } from "./injected-message-service";
import { getAssistantContextRoot } from "./runtime-user-content";
import { timestamp } from "../utils/timestamp";

const HEARTBEAT_FILE_NAME = "heartbeat.md";
const HEARTBEAT_NOOP_RESPONSE = "HEARTBEAT_OK";
const EMPTY_ASSISTANT_RESPONSE = "The assistant responded without text output.";
const FALLBACK_HEARTBEAT = [
  "# Heartbeat",
  "",
  "- This is an automated internal check-in, not a user-authored message.",
  "- Check current todos, routine state, and email state before deciding whether to interrupt the user.",
  "- Heartbeat processing must always run `routine_check` first, then inspect current todos with `routine_list`.",
  "- Heartbeat processing must also check mail on every run with the `email` tool. Start with `count`, and if unread mail exists inspect it with `list_unread`.",
  "- Use `silent: true` on heartbeat housekeeping tool calls so intermediate tool echoes stay out of Discord.",
  "- If nothing needs user attention, reply with exactly `HEARTBEAT_OK`.",
].join("\n");

function getHeartbeatFilePath() {
  return path.join(getAssistantContextRoot(), HEARTBEAT_FILE_NAME);
}

export interface HeartbeatSnapshot {
  text: string;
  path: string;
  loadedAt: string;
  charCount: number;
}

export class HeartbeatService {
  load(): HeartbeatSnapshot {
    const heartbeatContextRoot = getAssistantContextRoot();
    const heartbeatFilePath = getHeartbeatFilePath();
    fs.mkdirSync(heartbeatContextRoot, { recursive: true });
    const text = fs.existsSync(heartbeatFilePath)
      ? fs.readFileSync(heartbeatFilePath, "utf8").trim()
      : FALLBACK_HEARTBEAT;

    return {
      text,
      path: heartbeatFilePath,
      loadedAt: timestamp(),
      charCount: text.length,
    };
  }

  buildInjectedMessage(
    reference: Date = new Date(),
    options?: {
      workFocus?: string;
      localTime?: string;
      timezone?: string;
      reminderSnapshot?: HeartbeatReminderSnapshot;
      reflectionTrigger?: string;
      deliveryRequirement?: string;
    },
  ) {
    const snapshot = this.load();
    const sections = [
      "Automated heartbeat trigger. This is an internal check-in, not a user-authored Discord message.",
      `Triggered at: ${reference.toISOString()}`,
      `Current local time: ${options?.localTime?.trim() || formatLocalTime(reference, options?.timezone)}`,
      `Heartbeat instructions from ${snapshot.path}:`,
      snapshot.text,
    ];
    const reminderSnapshot = options?.reminderSnapshot;
    if (reminderSnapshot) {
      sections.push([
        "Structured reminder snapshot. This is internal runtime context, not a user-authored message.",
        `Reminder timezone: ${reminderSnapshot.timezone}`,
        `Reminder context mode: ${reminderSnapshot.context.mode}`,
        `Required candidates: ${reminderSnapshot.requiredCandidates.length}`,
        ...(reminderSnapshot.requiredCandidates.length > 0
          ? reminderSnapshot.requiredCandidates.map((entry, index) =>
              [
                `required_${index + 1}: ${entry.title}`,
                `kind=${entry.kind} priority=${entry.priority} state=${entry.state}`,
                entry.dueAt ? `due_at=${entry.dueAt}` : "due_at=n/a",
                `minutes_until_due=${entry.minutesUntilDue}`,
                `overdue_minutes=${entry.overdueMinutes}`,
                `reason=${entry.reason}`,
              ].join(" | "))
          : ["required: none"]),
        `Optional candidates: ${reminderSnapshot.optionalCandidates.length}`,
      ].join("\n"));
    }
    const reflectionTrigger = options?.reflectionTrigger?.trim();
    if (reflectionTrigger) {
      sections.push([
        "Reflection trigger note. This is internal context, not a user-authored message.",
        reflectionTrigger,
      ].join("\n"));
    }
    const deliveryRequirement = options?.deliveryRequirement?.trim();
    if (deliveryRequirement) {
      sections.push([
        "Delivery requirement. This is internal runtime context, not a user-authored message.",
        deliveryRequirement,
      ].join("\n"));
    }
    const workFocus = options?.workFocus?.trim();
    if (workFocus) {
      sections.push([
        "Automated work-focus note. This is internal context, not a user-authored message.",
        "Only mention it if it materially changes what the user should do now. Do not quote or dump it verbatim.",
        workFocus,
      ].join("\n"));
    }
    return wrapInjectedMessage("heartbeat", sections.join("\n\n"));
  }

  normalizeAssistantReply(message: string | undefined) {
    const normalized = message?.trim();
    if (!normalized) {
      return undefined;
    }
    const nonEmptyLines = normalized
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    // Check for HEARTBEAT_OK / heartbeat_ok with any casing and optional trailing punctuation
    const heartbeatPattern = /^heartbeat[_\s]*ok[.!]?$/i;
    if (nonEmptyLines.some((line) => line === HEARTBEAT_NOOP_RESPONSE || heartbeatPattern.test(line))) {
      return undefined;
    }
    // Filter if the entire message is just a heartbeat noop variant (possibly with filler)
    const stripped = nonEmptyLines.filter((line) => !heartbeatPattern.test(line)).join(" ").trim();
    if (!stripped) {
      return undefined;
    }
    if (normalized === EMPTY_ASSISTANT_RESPONSE) {
      return undefined;
    }
    return normalized;
  }
}

export { HEARTBEAT_NOOP_RESPONSE, getAssistantContextRoot as HEARTBEAT_CONTEXT_ROOT, getHeartbeatFilePath as HEARTBEAT_FILE_PATH };
