/**
 * Dashboard (home) function definitions.
 */
import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";

const DASHBOARD_AUTH = { access: "anyone" as const, behavior: "uniform" as const };

export const buildDashboardFunctions: FunctionDomainBuilder = (_ctx) => [
  defineFunction({
    name: "api_home",
    description: "Dashboard summary: time context, active agent count, next routine, and pending notification count.",
    input: z.object({}),
    surfaces: ["api"],
    handler: async (_input, fnCtx) => {
      const { subagents, routines, alarms } = fnCtx.services;

      const runs = subagents.listAgentRuns();
      const activeAgents = runs.filter(
        (r) => r.status === "running" || r.status === "starting",
      );

      const assessment = routines.assessNow();

      const upcoming = assessment.items.find((a) => a.state === "upcoming");
      const nextRoutine = upcoming
        ? {
            name: upcoming.item.title,
            time: upcoming.dueAt ?? "",
            type: upcoming.item.kind,
          }
        : null;

      const overdueItems = assessment.items.filter((a) => a.shouldRemindNow);
      const dueAlarms = alarms.listDueAlarms();
      const pendingNotificationCount = overdueItems.length + dueAlarms.length;

      return {
        timeContext: assessment.context,
        activeAgentCount: activeAgents.length,
        nextRoutine,
        pendingNotificationCount,
      };
    },
    auth: DASHBOARD_AUTH,
    domains: ["dashboard"],
    agentScopes: [],
    http: { method: "GET", path: "/api/g2/home" },
  }),
];
