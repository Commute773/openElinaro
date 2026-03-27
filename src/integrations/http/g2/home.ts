import type { RouteDefinition } from "./router";
import { json, g2Telemetry } from "./helpers";

export const homeRoutes: RouteDefinition[] = [
  {
    method: "GET",
    pattern: "/api/g2/home",
    handler: async (_request, _params, app) => {
      return g2Telemetry.span("g2_api.home", {}, () => {
        const runs = app.listAgentRuns();
        const activeAgents = runs.filter(
          (r) => r.status === "running" || r.status === "starting",
        );

        const assessment = app.assessRoutines();
        const allRoutines = app.listRoutineItems({ status: "active" });

        // Best streak across all active items
        let maxStreak = 0;
        for (const item of allRoutines) {
          if (item.state.streak > maxStreak) {
            maxStreak = item.state.streak;
          }
        }

        // Next upcoming routine from assessment
        const upcoming = assessment.items.find((a) => a.state === "upcoming");
        const nextRoutine = upcoming
          ? {
              name: upcoming.item.title,
              time: upcoming.dueAt ?? "",
              type: upcoming.item.kind,
            }
          : null;

        // Pending notifications: overdue assessment items + due alarms
        const overdueItems = assessment.items.filter((a) => a.shouldRemindNow);
        const dueAlarms = app.listDueAlarms();
        const pendingNotificationCount = overdueItems.length + dueAlarms.length;

        return json({
          timeContext: assessment.context,
          activeAgentCount: activeAgents.length,
          streak: maxStreak,
          nextRoutine,
          pendingNotificationCount,
        });
      });
    },
  },
];
