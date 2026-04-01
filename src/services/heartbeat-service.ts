import type { HeartbeatReminderSnapshot } from "../domain/routines";
import { formatLocalTime } from "./local-time-service";
import { wrapInjectedMessage } from "./injected-message-service";

const HEARTBEAT_NOOP_RESPONSE = "HEARTBEAT_OK";
const EMPTY_ASSISTANT_RESPONSES = [
  "The assistant responded without text output.",
  "The assistant did not return a reply.",
];
const HEARTBEAT_PROMPT = [
  "# Heartbeat",
  "",
  "- This is an automated internal check-in, not a user-authored message.",
  "- Check current todos, routine state, and email state before deciding whether to interrupt the user.",
  "- Heartbeat processing must always run `routine_check` first, then inspect current todos with `routine_list`.",
  "- Heartbeat processing must also check mail on every run with the `email` tool. Start with `count`, and if unread mail exists inspect it with `list_unread`.",
  "- Use `silent: true` on heartbeat housekeeping tool calls so intermediate tool echoes stay out of Discord.",
  "- If nothing needs user attention, reply with exactly `HEARTBEAT_OK`.",
  "- Do NOT greet the user, make small talk, or offer to surface optional items. The default is silence (`HEARTBEAT_OK`), not conversation.",
].join("\n");

export class HeartbeatService {
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
    const sections = [
      "Automated heartbeat trigger. This is an internal check-in, not a user-authored Discord message.",
      `Triggered at: ${reference.toISOString()}`,
      `Current local time: ${options?.localTime?.trim() || formatLocalTime(reference, options?.timezone)}`,
      HEARTBEAT_PROMPT,
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
    if (EMPTY_ASSISTANT_RESPONSES.includes(normalized)) {
      return undefined;
    }
    // If HEARTBEAT_OK appears anywhere in the message, suppress it
    if (/heartbeat[_\s]*ok/i.test(normalized)) {
      return undefined;
    }
    return normalized;
  }
}

export { HEARTBEAT_NOOP_RESPONSE };
