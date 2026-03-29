/**
 * Routine and alarm function definitions.
 * Migrated from src/tools/groups/routine-tools.ts.
 * These produce agent tools, API routes, and Discord commands from a single source.
 */
import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";
import type {
  RoutineItemKind,
  RoutinePriority,
  RoutineSchedule,
  RoutineStatus,
  Weekday,
} from "../../domain/routines";

// ---------------------------------------------------------------------------
// Shared schemas (same as routine-tools.ts)
// ---------------------------------------------------------------------------

const weekdaySchema = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const routineKindSchema = z.enum(["todo", "routine", "habit", "med", "deadline", "precommitment"]);
const routinePrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
const routineScheduleKindSchema = z.enum(["manual", "once", "daily", "weekly", "interval", "monthly"]);
const routineStatusSchema = z.enum(["active", "paused", "archived", "completed"]);

const addRoutineSchema = z.object({
  title: z.string().min(1),
  kind: routineKindSchema.default("todo"),
  profileId: z.string().min(1).optional(),
  priority: routinePrioritySchema.optional(),
  description: z.string().optional(),
  notes: z.string().optional().describe("Legacy alias for description."),
  dose: z.string().optional(),
  labels: z.array(z.string()).optional(),
  jobId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  blockedBy: z.array(z.string()).optional(),
  scheduleKind: routineScheduleKindSchema.default("manual"),
  dueAt: z.string().optional(),
  time: z.string().optional(),
  days: z.array(weekdaySchema).optional(),
  everyDays: z.number().int().positive().optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
});

const listRoutineSchema = z.object({
  status: routineStatusSchema.or(z.literal("all")).optional(),
  kind: routineKindSchema.or(z.literal("all")).optional(),
  profileId: z.union([z.string().min(1), z.literal("all")]).optional(),
  scope: z.enum(["work", "personal", "all"]).optional(),
  jobId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  all: z.boolean().optional(),
});

const updateRoutineSchema = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  kind: routineKindSchema.optional(),
  priority: routinePrioritySchema.optional(),
  description: z.string().optional(),
  notes: z.string().optional().describe("Legacy alias for description."),
  labels: z.array(z.string()).optional(),
  jobId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  blockedBy: z.array(z.string()).optional(),
  scheduleKind: routineScheduleKindSchema.optional(),
  dueAt: z.string().optional(),
  time: z.string().optional(),
  days: z.array(weekdaySchema).optional(),
  everyDays: z.number().int().positive().optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
}).superRefine((value, ctx) => {
  const hasScheduleUpdate =
    value.scheduleKind !== undefined
    || value.dueAt !== undefined
    || value.time !== undefined
    || value.days !== undefined
    || value.everyDays !== undefined
    || value.dayOfMonth !== undefined;
  const hasFieldUpdate =
    value.profileId !== undefined
    || value.title !== undefined
    || value.kind !== undefined
    || value.priority !== undefined
    || value.description !== undefined
    || value.notes !== undefined
    || value.labels !== undefined
    || value.jobId !== undefined
    || value.projectId !== undefined
    || value.blockedBy !== undefined
    || hasScheduleUpdate;

  if (!hasFieldUpdate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide at least one field to update.",
    });
  }

  if (hasScheduleUpdate && value.scheduleKind === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "scheduleKind is required when updating the schedule.",
      path: ["scheduleKind"],
    });
  }
});

const idSchema = z.object({ id: z.string().min(1) });

const snoozeSchema = z.object({
  id: z.string().min(1),
  minutes: z.number().int().positive().max(10080),
});

const setAlarmSchema = z.object({
  name: z.string().min(1),
  time: z.string().min(1),
});

const setTimerSchema = z.object({
  name: z.string().min(1),
  duration: z.string().min(1),
});

const listAlarmSchema = z.object({
  state: z.enum(["pending", "delivered", "cancelled", "all"]).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

// ---------------------------------------------------------------------------
// Schedule builder (shared between add and update)
// ---------------------------------------------------------------------------

export function buildSchedule(input: {
  scheduleKind: z.infer<typeof routineScheduleKindSchema>;
  dueAt?: string;
  time?: string;
  days?: Weekday[];
  everyDays?: number;
  dayOfMonth?: number;
}): RoutineSchedule {
  if (input.scheduleKind === "manual") return { kind: "manual" };
  if (input.scheduleKind === "once") {
    if (!input.dueAt) throw new Error("dueAt is required for once schedules.");
    return { kind: "once", dueAt: new Date(input.dueAt).toISOString() };
  }
  if (input.scheduleKind === "daily") {
    if (!input.time) throw new Error("time is required for daily schedules.");
    return input.days?.length
      ? { kind: "daily", time: input.time, days: input.days as Weekday[] }
      : { kind: "daily", time: input.time };
  }
  if (input.scheduleKind === "weekly") {
    if (!input.time || !input.days?.length) throw new Error("time and days are required for weekly schedules.");
    return { kind: "weekly", time: input.time, days: input.days as Weekday[] };
  }
  if (input.scheduleKind === "interval") {
    if (!input.time || !input.everyDays) throw new Error("time and everyDays are required for interval schedules.");
    return { kind: "interval", time: input.time, everyDays: input.everyDays };
  }
  if (!input.time || !input.dayOfMonth) throw new Error("time and dayOfMonth are required for monthly schedules.");
  return { kind: "monthly", time: input.time, dayOfMonth: input.dayOfMonth };
}

// ---------------------------------------------------------------------------
// Routine auth defaults
// ---------------------------------------------------------------------------

const ROUTINE_AUTH = { access: "anyone" as const, behavior: "uniform" as const };
const ROUTINE_SCOPES: ("chat" | "direct")[] = ["chat", "direct"];
const ROUTINE_DOMAINS = ["routines", "personal-ops"];

// ---------------------------------------------------------------------------
// Domain builder
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers for structured → agent-string formatting
// ---------------------------------------------------------------------------

const fmtItem = (r: any) => `${r.id}: [${r.profileId}] ${r.title} (${r.kind}, ${r.priority}, ${r.status})`;
const fmtAlarm = (a: any) => `${a.id}: ${a.kind}/${a.name} triggerAt=${a.triggerAt} state=${a.state}`;

function serializeItem(item: any) {
  return {
    id: item.id,
    profileId: item.profileId,
    title: item.title,
    kind: item.kind,
    priority: item.priority,
    status: item.status,
    description: item.description,
    dose: item.dose,
    labels: item.labels,
    jobId: item.jobId,
    projectId: item.projectId,
    schedule: item.schedule,
    state: item.state,
  };
}

function serializeAlarm(alarm: any) {
  return {
    id: alarm.id,
    kind: alarm.kind,
    name: alarm.name,
    triggerAt: alarm.triggerAt,
    originalSpec: alarm.originalSpec,
    state: alarm.cancelledAt ? "cancelled" : alarm.deliveredAt ? "delivered" : "pending",
  };
}

export const buildRoutineFunctions: FunctionDomainBuilder = (ctx) => [
  // -----------------------------------------------------------------------
  // routine_check
  // -----------------------------------------------------------------------
  defineFunction({
    name: "routine_check",
    description: "Check which routine items, meds, deadlines, and todos need attention now.",
    input: z.object({}),
    handler: async (_input, fnCtx) => {
      const assessment = fnCtx.services.routines.assessNow();
      const actionable = assessment.items.filter((a) => a.shouldRemindNow);
      return {
        context: assessment.context,
        actionableCount: actionable.length,
        items: actionable.map((a) => ({
          id: a.item.id,
          title: a.item.title,
          kind: a.item.kind,
          priority: a.item.priority,
          state: a.state,
          overdueMinutes: a.overdueMinutes,
          dueAt: a.dueAt,
        })),
      };
    },
    agentFormat: (result: any) => {
      if (result.actionableCount === 0) return `Nothing needs active attention right now. Context: ${result.context.mode}.`;
      return `Context: ${result.context.mode}\n` + result.items.map((i: any) =>
        `- ${i.id}: [${i.kind}] ${i.title} (${i.state}, ${i.overdueMinutes}m overdue)`,
      ).join("\n");
    },
    auth: ROUTINE_AUTH,
    domains: ROUTINE_DOMAINS,
    agentScopes: ROUTINE_SCOPES,
    examples: ["check routines", "what's due now"],
    http: { method: "GET", path: "/routines/check" },
  }),

  // -----------------------------------------------------------------------
  // routine_list
  // -----------------------------------------------------------------------
  defineFunction({
    name: "routine_list",
    description: "List routine items including meds, habits, todos, and deadlines with optional filters. Set all=true to ignore list filters and return every non-completed visible item.",
    input: listRoutineSchema,
    handler: async (input, fnCtx) => {
      const items = fnCtx.services.routines.listItems({
        status: input.status as RoutineStatus | "all" | undefined,
        kind: (input.kind as RoutineItemKind | "all" | undefined) ?? "all",
        profileId: input.profileId,
        scope: input.scope,
        jobId: input.jobId,
        projectId: input.projectId,
        limit: input.limit,
        all: input.all,
      });
      return items.map(serializeItem);
    },
    agentFormat: (result: any) => {
      const items = result as any[];
      if (items.length === 0) return "No routine items matched.";
      return items.map((item: any) => `- ${fmtItem(item)}`).join("\n");
    },
    auth: ROUTINE_AUTH,
    domains: ROUTINE_DOMAINS,
    agentScopes: ROUTINE_SCOPES,
    examples: ["list active routines", "show paused todos"],
    http: {
      method: "GET",
      path: "/routines",
      queryParams: z.object({
        status: z.string().optional(),
        kind: z.string().optional(),
        scope: z.string().optional(),
        all: z.string().optional(),
      }),
    },
  }),

  // -----------------------------------------------------------------------
  // routine_get
  // -----------------------------------------------------------------------
  defineFunction({
    name: "routine_get",
    description: "Get one routine item by id.",
    input: idSchema,
    handler: async (input, fnCtx) => {
      const item = fnCtx.services.routines.getItem(input.id);
      if (!item) throw new Error(`Routine item not found: ${input.id}`);
      return serializeItem(item);
    },
    agentFormat: (result: any) => fmtItem(result),
    auth: ROUTINE_AUTH,
    domains: ROUTINE_DOMAINS,
    agentScopes: ROUTINE_SCOPES,
    examples: ["show routine details", "inspect routine by id"],
    http: { method: "GET", path: "/routines/:id" },
  }),

  // -----------------------------------------------------------------------
  // routine_add
  // -----------------------------------------------------------------------
  defineFunction({
    name: "routine_add",
    description: "Create a new todo, med, routine, habit, deadline, or precommitment.",
    input: addRoutineSchema,
    handler: async (input, fnCtx) => {
      const item = fnCtx.services.routines.addItem({
        title: input.title,
        kind: input.kind as RoutineItemKind,
        profileId: input.profileId,
        priority: input.priority as RoutinePriority | undefined,
        description: input.description ?? input.notes,
        notes: input.notes,
        dose: input.dose,
        labels: input.labels,
        jobId: input.jobId,
        projectId: input.projectId,
        blockedBy: input.blockedBy,
        schedule: buildSchedule(input),
      });
      return serializeItem(item);
    },
    agentFormat: (result: any) => `Saved routine item ${result.id}: ${fmtItem(result)}`,
    auth: ROUTINE_AUTH,
    domains: ROUTINE_DOMAINS,
    agentScopes: ROUTINE_SCOPES,
    examples: ["add a weekly workout", "create a deadline reminder"],
    mutatesState: true,
    http: { method: "POST", path: "/routines", successStatus: 201 },
  }),

  // -----------------------------------------------------------------------
  // routine_update
  // -----------------------------------------------------------------------
  defineFunction({
    name: "routine_update",
    description: "Edit an existing routine item's title, description, priority, kind, blocking dependencies, or full schedule. To update the schedule, provide scheduleKind plus the matching schedule fields.",
    input: updateRoutineSchema,
    handler: async (input, fnCtx) => {
      const item = fnCtx.services.routines.updateItem(input.id, {
        profileId: input.profileId,
        title: input.title,
        kind: input.kind as RoutineItemKind | undefined,
        priority: input.priority as RoutinePriority | undefined,
        description: input.description ?? input.notes,
        labels: input.labels,
        jobId: input.jobId,
        projectId: input.projectId,
        blockedBy: input.blockedBy,
        notes: input.notes,
        schedule: input.scheduleKind
          ? buildSchedule({
              scheduleKind: input.scheduleKind,
              dueAt: input.dueAt,
              time: input.time,
              days: input.days as Weekday[] | undefined,
              everyDays: input.everyDays,
              dayOfMonth: input.dayOfMonth,
            })
          : undefined,
      });
      return serializeItem(item);
    },
    agentFormat: (result: any) => `Updated routine item ${result.id}: ${fmtItem(result)}`,
    auth: ROUTINE_AUTH,
    domains: ROUTINE_DOMAINS,
    agentScopes: ROUTINE_SCOPES,
    examples: ["rename a todo", "change a routine schedule"],
    mutatesState: true,
    http: { method: "PATCH", path: "/routines/:id" },
  }),

  // -----------------------------------------------------------------------
  // routine_delete
  // -----------------------------------------------------------------------
  defineFunction({
    name: "routine_delete",
    description: "Permanently delete a routine item by id.",
    input: idSchema,
    handler: async (input, fnCtx) => {
      const item = fnCtx.services.routines.deleteItem(input.id);
      return { id: item.id, title: item.title, deleted: true };
    },
    agentFormat: (result: any) => `Deleted routine item ${result.id}: ${result.title}`,
    auth: ROUTINE_AUTH,
    domains: ROUTINE_DOMAINS,
    agentScopes: ROUTINE_SCOPES,
    examples: ["delete a routine", "remove a stale todo"],
    mutatesState: true,
    http: { method: "DELETE", path: "/routines/:id" },
  }),

  // -----------------------------------------------------------------------
  // routine_done
  // -----------------------------------------------------------------------
  defineFunction({
    name: "routine_done",
    description: "Mark a routine item completed.",
    input: idSchema,
    handler: async (input, fnCtx) => serializeItem(fnCtx.services.routines.markDone(input.id)),
    agentFormat: (result: any) => `Marked done: ${fmtItem(result)}`,
    auth: ROUTINE_AUTH,
    domains: ROUTINE_DOMAINS,
    agentScopes: ROUTINE_SCOPES,
    examples: ["mark routine done", "complete today's task"],
    mutatesState: true,
    http: { method: "POST", path: "/routines/:id/done" },
  }),

  // -----------------------------------------------------------------------
  // routine_undo_done
  // -----------------------------------------------------------------------
  defineFunction({
    name: "routine_undo_done",
    description: "Undo the most recent completion for a routine item.",
    input: idSchema,
    handler: async (input, fnCtx) => serializeItem(fnCtx.services.routines.undoDone(input.id)),
    agentFormat: (result: any) => `Undid completion: ${fmtItem(result)}`,
    auth: ROUTINE_AUTH,
    domains: ROUTINE_DOMAINS,
    agentScopes: ROUTINE_SCOPES,
    examples: ["undo a completion", "reopen completed routine"],
    mutatesState: true,
    http: { method: "POST", path: "/routines/:id/undo" },
  }),

  // -----------------------------------------------------------------------
  // routine_snooze
  // -----------------------------------------------------------------------
  defineFunction({
    name: "routine_snooze",
    description: "Snooze a routine item for a number of minutes.",
    input: snoozeSchema,
    handler: async (input, fnCtx) => {
      const item = fnCtx.services.routines.snooze(input.id, input.minutes);
      return { ...serializeItem(item), snoozedUntil: item.state.snoozedUntil };
    },
    agentFormat: (result: any) => `Snoozed ${result.id} until ${result.snoozedUntil ?? "later"}.`,
    auth: ROUTINE_AUTH,
    domains: ROUTINE_DOMAINS,
    agentScopes: ROUTINE_SCOPES,
    examples: ["snooze for 30 minutes", "delay this reminder"],
    mutatesState: true,
    http: { method: "POST", path: "/routines/:id/snooze" },
  }),

  // -----------------------------------------------------------------------
  // routine_skip
  // -----------------------------------------------------------------------
  defineFunction({
    name: "routine_skip",
    description: "Skip the current occurrence of a routine item.",
    input: idSchema,
    handler: async (input, fnCtx) => serializeItem(fnCtx.services.routines.skip(input.id)),
    agentFormat: (result: any) => `Skipped the current occurrence for ${result.id}.`,
    auth: ROUTINE_AUTH,
    domains: ROUTINE_DOMAINS,
    agentScopes: ROUTINE_SCOPES,
    examples: ["skip today's occurrence", "skip this reminder"],
    mutatesState: true,
    http: { method: "POST", path: "/routines/:id/skip" },
  }),

  // -----------------------------------------------------------------------
  // routine_pause
  // -----------------------------------------------------------------------
  defineFunction({
    name: "routine_pause",
    description: "Pause a routine item.",
    input: idSchema,
    handler: async (input, fnCtx) => serializeItem(fnCtx.services.routines.pause(input.id)),
    agentFormat: (result: any) => `Paused ${result.id}.`,
    auth: ROUTINE_AUTH,
    domains: ROUTINE_DOMAINS,
    agentScopes: ROUTINE_SCOPES,
    examples: ["pause this routine", "stop reminders for now"],
    mutatesState: true,
    http: { method: "POST", path: "/routines/:id/pause" },
  }),

  // -----------------------------------------------------------------------
  // routine_resume
  // -----------------------------------------------------------------------
  defineFunction({
    name: "routine_resume",
    description: "Resume a paused routine item.",
    input: idSchema,
    handler: async (input, fnCtx) => serializeItem(fnCtx.services.routines.resume(input.id)),
    agentFormat: (result: any) => `Resumed ${result.id}.`,
    auth: ROUTINE_AUTH,
    domains: ROUTINE_DOMAINS,
    agentScopes: ROUTINE_SCOPES,
    examples: ["resume this routine", "restart reminders"],
    mutatesState: true,
    http: { method: "POST", path: "/routines/:id/resume" },
  }),

  // -----------------------------------------------------------------------
  // set_alarm
  // -----------------------------------------------------------------------
  defineFunction({
    name: "set_alarm",
    description: "Schedule a Discord alarm. Use time as local HH:MM or a future ISO timestamp such as 07:30 or 2026-03-16T09:00:00-04:00.",
    input: setAlarmSchema,
    handler: async (input, fnCtx) => {
      const alarm = fnCtx.services.alarms.setAlarm(input.name, input.time);
      return serializeAlarm(alarm);
    },
    agentFormat: (result: any) => `Alarm set: ${result.name}\nId: ${result.id}\nTriggers at: ${result.triggerAt}`,
    auth: ROUTINE_AUTH,
    domains: ["routines", "alarms"],
    agentScopes: ROUTINE_SCOPES,
    examples: ["set an alarm for 07:30", "set an alarm for 2026-03-16T09:00:00-04:00"],
    mutatesState: true,
    http: { method: "POST", path: "/alarms", successStatus: 201 },
  }),

  // -----------------------------------------------------------------------
  // set_timer
  // -----------------------------------------------------------------------
  defineFunction({
    name: "set_timer",
    description: "Schedule a Discord timer. Use duration strings like 30s, 10m, 2h, or 1d.",
    input: setTimerSchema,
    handler: async (input, fnCtx) => {
      const timer = fnCtx.services.alarms.setTimer(input.name, input.duration);
      return serializeAlarm(timer);
    },
    agentFormat: (result: any) => `Timer set: ${result.name}\nId: ${result.id}\nTriggers at: ${result.triggerAt}`,
    auth: ROUTINE_AUTH,
    domains: ["routines", "alarms"],
    agentScopes: ROUTINE_SCOPES,
    examples: ["set a 10m timer", "set a 2h timer"],
    mutatesState: true,
    http: { method: "POST", path: "/timers", successStatus: 201 },
  }),

  // -----------------------------------------------------------------------
  // alarm_list
  // -----------------------------------------------------------------------
  defineFunction({
    name: "alarm_list",
    description: "List scheduled alarms and timers. Defaults to pending items only.",
    input: listAlarmSchema,
    handler: async (input, fnCtx) => {
      const alarms = fnCtx.services.alarms.listAlarms({ state: input.state, limit: input.limit });
      return alarms.map(serializeAlarm);
    },
    agentFormat: (result: any) => {
      const alarms = result as any[];
      if (alarms.length === 0) return "No alarms or timers matched.";
      return alarms.map((a: any) => `- ${fmtAlarm(a)}`).join("\n");
    },
    auth: ROUTINE_AUTH,
    domains: ["routines", "alarms"],
    agentScopes: ROUTINE_SCOPES,
    examples: ["list pending alarms", "show delivered timers"],
    http: {
      method: "GET",
      path: "/alarms",
      queryParams: z.object({
        state: z.string().optional(),
        limit: z.string().optional(),
      }),
    },
  }),

  // -----------------------------------------------------------------------
  // alarm_cancel
  // -----------------------------------------------------------------------
  defineFunction({
    name: "alarm_cancel",
    description: "Cancel a scheduled alarm or timer by id.",
    input: idSchema,
    handler: async (input, fnCtx) => {
      const alarm = fnCtx.services.alarms.cancelAlarm(input.id);
      return serializeAlarm(alarm);
    },
    agentFormat: (result: any) => `Cancelled ${result.kind} ${result.id}: ${result.name}`,
    auth: ROUTINE_AUTH,
    domains: ["routines", "alarms"],
    agentScopes: ROUTINE_SCOPES,
    examples: ["cancel alarm-123", "cancel a timer by id"],
    mutatesState: true,
    http: { method: "DELETE", path: "/alarms/:id" },
  }),

  // -----------------------------------------------------------------------
  // API-only: todo shortcuts (same underlying service, different API paths)
  // -----------------------------------------------------------------------
  defineFunction({
    name: "api_todo_list",
    description: "List active todos.",
    input: z.object({}),
    surfaces: ["api"],
    handler: async (_input, fnCtx) => {
      const todos = fnCtx.services.routines.listItems({ kind: "todo", status: "active" });
      return todos.map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        priority: item.priority,
      }));
    },
    auth: ROUTINE_AUTH,
    domains: ROUTINE_DOMAINS,
    agentScopes: [],
    http: { method: "GET", path: "/todos" },
  }),

  defineFunction({
    name: "api_todo_create",
    description: "Create a new todo.",
    input: z.object({
      title: z.string().min(1),
      priority: routinePrioritySchema.optional(),
      description: z.string().optional(),
      labels: z.array(z.string()).optional(),
      jobId: z.string().min(1).optional(),
      projectId: z.string().min(1).optional(),
      blockedBy: z.array(z.string()).optional(),
      schedule: z.any().optional(),
    }),
    surfaces: ["api"],
    handler: async (input, fnCtx) => {
      return fnCtx.services.routines.addItem({
        title: input.title,
        kind: "todo",
        priority: input.priority as RoutinePriority | undefined,
        description: input.description,
        labels: input.labels,
        jobId: input.jobId,
        projectId: input.projectId,
        blockedBy: input.blockedBy,
        schedule: (input.schedule as RoutineSchedule | undefined) ?? { kind: "once", dueAt: new Date().toISOString() },
      });
    },
    auth: ROUTINE_AUTH,
    domains: ROUTINE_DOMAINS,
    agentScopes: [],
    mutatesState: true,
    http: { method: "POST", path: "/todos", successStatus: 201 },
  }),

  defineFunction({
    name: "api_todo_done",
    description: "Mark a todo as done.",
    input: idSchema,
    surfaces: ["api"],
    handler: async (input, fnCtx) => {
      fnCtx.services.routines.markDone(input.id);
      return { ok: true };
    },
    auth: ROUTINE_AUTH,
    domains: ROUTINE_DOMAINS,
    agentScopes: [],
    mutatesState: true,
    http: { method: "POST", path: "/todos/:id/done" },
  }),

  defineFunction({
    name: "api_todo_update",
    description: "Update a todo.",
    input: z.object({
      id: z.string().min(1),
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      priority: routinePrioritySchema.optional(),
      labels: z.array(z.string()).optional(),
      schedule: z.any().optional(),
      jobId: z.string().min(1).optional(),
      projectId: z.string().min(1).optional(),
      blockedBy: z.array(z.string()).optional(),
    }),
    surfaces: ["api"],
    handler: async (input, fnCtx) => {
      return fnCtx.services.routines.updateItem(input.id, {
        title: input.title,
        description: input.description,
        priority: input.priority as RoutinePriority | undefined,
        labels: input.labels,
        schedule: input.schedule as RoutineSchedule | undefined,
        jobId: input.jobId,
        projectId: input.projectId,
        blockedBy: input.blockedBy,
      });
    },
    auth: ROUTINE_AUTH,
    domains: ROUTINE_DOMAINS,
    agentScopes: [],
    mutatesState: true,
    http: { method: "PATCH", path: "/todos/:id" },
  }),

  defineFunction({
    name: "api_todo_delete",
    description: "Delete a todo.",
    input: idSchema,
    surfaces: ["api"],
    handler: async (input, fnCtx) => {
      fnCtx.services.routines.deleteItem(input.id);
      return { ok: true };
    },
    auth: ROUTINE_AUTH,
    domains: ROUTINE_DOMAINS,
    agentScopes: [],
    mutatesState: true,
    http: { method: "DELETE", path: "/todos/:id" },
  }),
];
