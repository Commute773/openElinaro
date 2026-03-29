/**
 * Notification function definitions (list, action).
 */
import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";
import { formatNotification } from "../formatters";

const NOTIFICATION_AUTH = { access: "anyone" as const, behavior: "uniform" as const };

export const buildNotificationFunctions: FunctionDomainBuilder = (_ctx) => [
  // -------------------------------------------------------------------------
  // GET /api/g2/notifications
  // -------------------------------------------------------------------------
  defineFunction({
    name: "api_notifications_list",
    description: "List pending notifications from routines and alarms.",
    input: z.object({}),
    surfaces: ["api"],
    handler: async (_input, fnCtx) => {
      const { routines, alarms } = fnCtx.services;
      const assessment = routines.assessNow();
      const dueAlarms = alarms.listDueAlarms();
      const notifications: Array<{
        id: string;
        type: string;
        title: string;
        body: string;
        actions: string[];
        display: string;
      }> = [];

      for (const entry of assessment.items
        .filter((a) => a.shouldRemindNow)
        .slice(0, 10)) {
        const timing =
          entry.state === "due" && entry.overdueMinutes > 0
            ? `${entry.overdueMinutes}m overdue`
            : entry.state === "upcoming"
              ? `due in ${entry.minutesUntilDue}m`
              : "due now";
        const notif = {
          id: `routine:${entry.item.id}`,
          type: "routine",
          title: entry.item.title,
          body: `${entry.item.kind} \u2014 ${timing}`,
          actions: ["done", "snooze", "dismiss"],
        };
        notifications.push({ ...notif, display: formatNotification(notif) });
      }

      for (const alarm of dueAlarms.slice(0, 5)) {
        const alarmNotif = {
          id: `alarm:${alarm.id}`,
          type: alarm.kind,
          title: alarm.name,
          body: `${alarm.kind === "timer" ? "Timer" : "Alarm"}: ${alarm.originalSpec}`,
          actions: ["done", "snooze", "dismiss"],
        };
        notifications.push({ ...alarmNotif, display: formatNotification(alarmNotif) });
      }

      return notifications;
    },
    auth: NOTIFICATION_AUTH,
    domains: ["routines", "notifications"],
    agentScopes: [],
    http: { method: "GET", path: "/notifications" },
  }),

  // -------------------------------------------------------------------------
  // POST /api/g2/notifications/:id/action
  // -------------------------------------------------------------------------
  defineFunction({
    name: "api_notification_action",
    description: "Perform an action (done, snooze, dismiss) on a notification.",
    input: z.object({
      id: z.string().min(1),
      action: z.enum(["done", "snooze", "dismiss"]).default("dismiss"),
    }),
    surfaces: ["api"],
    handler: async (input, fnCtx) => {
      const { routines, alarms } = fnCtx.services;
      const [type, itemId] = input.id.split(":", 2);

      if (type === "routine" && itemId) {
        if (input.action === "done") {
          routines.markDone(itemId);
        } else if (input.action === "snooze") {
          routines.snooze(itemId, 15);
        }
      }

      if (type === "alarm" && itemId) {
        if (input.action === "done" || input.action === "dismiss") {
          alarms.markDelivered(itemId);
        }
      }

      return { ok: true };
    },
    auth: NOTIFICATION_AUTH,
    domains: ["routines", "notifications"],
    agentScopes: [],
    mutatesState: true,
    http: { method: "POST", path: "/notifications/:id/action" },
  }),
];
