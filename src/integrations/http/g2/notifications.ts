import type { RouteDefinition } from "./router";
import { json, error } from "./helpers";

export const notificationRoutes: RouteDefinition[] = [
  {
    method: "GET",
    pattern: "/api/g2/notifications",
    handler: async (_request, _params, app) => {
      const assessment = app.assessRoutines();
      const dueAlarms = app.listDueAlarms();
      const notifications: Array<{
        id: string;
        type: string;
        title: string;
        body: string;
        actions: string[];
      }> = [];

      // Routine reminders
      for (const entry of assessment.items
        .filter((a) => a.shouldRemindNow)
        .slice(0, 10)) {
        const timing =
          entry.state === "due" && entry.overdueMinutes > 0
            ? `${entry.overdueMinutes}m overdue`
            : entry.state === "upcoming"
              ? `due in ${entry.minutesUntilDue}m`
              : "due now";
        notifications.push({
          id: `routine:${entry.item.id}`,
          type: "routine",
          title: entry.item.title,
          body: `${entry.item.kind} — ${timing}`,
          actions: ["done", "snooze", "dismiss"],
        });
      }

      // Alarm notifications
      for (const alarm of dueAlarms.slice(0, 5)) {
        notifications.push({
          id: `alarm:${alarm.id}`,
          type: alarm.kind,
          title: alarm.name,
          body: `${alarm.kind === "timer" ? "Timer" : "Alarm"}: ${alarm.originalSpec}`,
          actions: ["done", "snooze", "dismiss"],
        });
      }

      return json(notifications);
    },
  },
  {
    method: "POST",
    pattern: "/api/g2/notifications/:id/action",
    handler: async (request, params, app) => {
      const notifId = params.id!;
      try {
        const body = (await request.json()) as { action?: string };
        const action = body.action ?? "dismiss";

        // Parse notification ID (format: "routine:<id>" or "alarm:<id>")
        const [type, itemId] = notifId.split(":", 2);

        if (type === "routine" && itemId) {
          if (action === "done") {
            app.markRoutineDone(itemId);
          } else if (action === "snooze") {
            app.snoozeRoutine(itemId, 15);
          }
          // "dismiss" = no-op, just acknowledge
        }

        if (type === "alarm" && itemId) {
          if (action === "done" || action === "dismiss") {
            app.markAlarmDelivered(itemId);
          }
          // snooze for alarms is not currently supported
        }

        return json({ ok: true });
      } catch (err: any) {
        return error(err.message ?? "Failed to handle notification action", 500);
      }
    },
  },
];
