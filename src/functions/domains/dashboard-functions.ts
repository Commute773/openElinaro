/**
 * Dashboard (home) function definitions.
 */
import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";
import { formatResult } from "../formatters";

const DASHBOARD_AUTH = { access: "anyone" as const, behavior: "uniform" as const };

export const buildDashboardFunctions: FunctionDomainBuilder = (_ctx) => [
  defineFunction({
    name: "api_home",
    description: "Dashboard summary: time context, active agent count, next routine, and pending notification count.",
    input: z.object({}),
    surfaces: ["api"],
    handler: async (_input, fnCtx) => {
      const { routines, alarms } = fnCtx.services;

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

      // Enrich time context with human-readable fields
      const ctx = assessment.context;
      const nowDate = new Date(ctx.now);
      const fmtOpts = { timeZone: ctx.timezone };
      const dayOfWeek = nowDate.toLocaleDateString("en-US", { ...fmtOpts, weekday: "long" });
      const localDate = nowDate.toLocaleDateString("en-CA", fmtOpts); // YYYY-MM-DD
      const localTime = nowDate.toLocaleTimeString("en-US", { ...fmtOpts, hour: "2-digit", minute: "2-digit", hour12: false });
      const hour = parseInt(localTime.split(":")[0]!, 10);
      const dayPeriod = hour < 6 ? "night" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 21 ? "evening" : "night";

      return {
        timeContext: { ...ctx, dayOfWeek, localDate, localTime, dayPeriod },
        nextRoutine,
        pendingNotificationCount,
      };
    },
    format: (result) => {
      const tc = result.timeContext;
      const lines = [
        `${tc.dayOfWeek} ${tc.localDate} ${tc.localTime} (${tc.dayPeriod})`,
        result.nextRoutine ? `Next: ${result.nextRoutine.name} at ${result.nextRoutine.time}` : "Next: none",
        `Pending notifications: ${result.pendingNotificationCount}`,
      ];
      return lines.join("\n");
    },
    auth: DASHBOARD_AUTH,
    domains: ["dashboard"],
    agentScopes: [],
    http: { method: "GET", path: "/home" },
  }),

  // -----------------------------------------------------------------------
  // api_health — migrated from static route in api/data.ts
  // -----------------------------------------------------------------------
  defineFunction({
    name: "api_health",
    description: "Health summary and recent check-ins.",
    input: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
    surfaces: ["api"],
    handler: async (input, fnCtx) => {
      const { health } = fnCtx.services;
      const limit = input.limit ?? 10;
      const summary = health.summary();
      const checkins = health.listCheckins(limit).map((c) => ({
        id: c.id,
        observedAt: c.observedAt,
        kind: c.kind ?? "checkin",
        energy: c.energy,
        mood: c.mood,
        sleepHours: c.sleepHours,
        anxiety: c.anxiety,
      }));
      return { summary, checkins };
    },
    format: formatResult,
    auth: DASHBOARD_AUTH,
    domains: ["dashboard", "health"],
    agentScopes: [],
    http: {
      method: "GET",
      path: "/health",
      queryParams: z.object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
  }),

  // -----------------------------------------------------------------------
  // api_projects — migrated from static route in api/data.ts
  // -----------------------------------------------------------------------
  defineFunction({
    name: "api_projects",
    description: "List project summaries with status, priority, and tags.",
    input: z.object({}),
    surfaces: ["api"],
    handler: async (_input, fnCtx) => {
      const projects = fnCtx.services.projects.listProjects({ status: "all" });
      return projects.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        priority: p.priority,
        summary: p.summary,
        tags: p.tags,
      }));
    },
    format: (result) => {
      if (result.length === 0) return "No projects.";
      return result.map((p: any) => `${p.id} [${p.status}/${p.priority}] ${p.name} — ${p.summary ?? ""}`).join("\n");
    },
    auth: DASHBOARD_AUTH,
    domains: ["dashboard", "projects"],
    agentScopes: [],
    http: { method: "GET", path: "/projects" },
  }),

  // -----------------------------------------------------------------------
  // api_conversations — migrated from static route in api/data.ts
  // -----------------------------------------------------------------------
  defineFunction({
    name: "api_conversations",
    description: "List conversation summaries with message counts.",
    input: z.object({}),
    surfaces: ["api"],
    handler: async (_input, fnCtx) => {
      const conversations = await fnCtx.services.conversations.list();
      return conversations.map((c) => ({
        key: c.key,
        messageCount: c.messages.length,
        updatedAt: c.updatedAt,
      }));
    },
    format: (result) => {
      if (result.length === 0) return "No conversations.";
      return result.map((c: any) => `${c.key} — ${c.messageCount} messages, updated ${c.updatedAt}`).join("\n");
    },
    auth: DASHBOARD_AUTH,
    domains: ["dashboard", "conversations"],
    agentScopes: [],
    http: { method: "GET", path: "/conversations" },
  }),
];
