import { type StructuredToolInterface } from "@langchain/core/tools";
import { defineTool } from "../define-tool";
import { z } from "zod";
import type {
  RoutineItemKind,
  RoutinePriority,
  RoutineSchedule,
  Weekday,
} from "../../domain/routines";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { telemetry } from "../../services/telemetry";
import type { ToolBuildContext } from "./tool-group-types";

const toolTelemetry = telemetry.child({ component: "tool" });
const traceSpan = createTraceSpan(toolTelemetry);

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

const idSchema = z.object({
  id: z.string().min(1),
});

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

export function buildSchedule(input: {
  scheduleKind: z.infer<typeof routineScheduleKindSchema>;
  dueAt?: string;
  time?: string;
  days?: Weekday[];
  everyDays?: number;
  dayOfMonth?: number;
}): RoutineSchedule {
  if (input.scheduleKind === "manual") {
    return { kind: "manual" };
  }
  if (input.scheduleKind === "once") {
    if (!input.dueAt) {
      throw new Error("dueAt is required for once schedules.");
    }
    return { kind: "once", dueAt: new Date(input.dueAt).toISOString() };
  }
  if (input.scheduleKind === "daily") {
    if (!input.time) {
      throw new Error("time is required for daily schedules.");
    }
    return { kind: "daily", time: input.time };
  }
  if (input.scheduleKind === "weekly") {
    if (!input.time || !input.days?.length) {
      throw new Error("time and days are required for weekly schedules.");
    }
    return { kind: "weekly", time: input.time, days: input.days as Weekday[] };
  }
  if (input.scheduleKind === "interval") {
    if (!input.time || !input.everyDays) {
      throw new Error("time and everyDays are required for interval schedules.");
    }
    return { kind: "interval", time: input.time, everyDays: input.everyDays };
  }
  if (!input.time || !input.dayOfMonth) {
    throw new Error("time and dayOfMonth are required for monthly schedules.");
  }
  return { kind: "monthly", time: input.time, dayOfMonth: input.dayOfMonth };
}

export function buildRoutineTools(ctx: ToolBuildContext): StructuredToolInterface[] {
  return [
    defineTool(
      async () =>
        traceSpan("tool.routine_check", async () => ctx.routines.buildCheckSummary()),
      {
        name: "routine_check",
        description: "Check which routine items, meds, deadlines, and todos need attention now.",
        schema: z.object({}),
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.routine_list",
          async () => {
            const items = ctx.routines.listItems({
              status: input.status as import("../../domain/routines").RoutineStatus | "all" | undefined,
              kind: (input.kind as RoutineItemKind | "all" | undefined) ?? "all",
              profileId: input.profileId,
              scope: input.scope,
              jobId: input.jobId,
              projectId: input.projectId,
              limit: input.limit,
              all: input.all,
            });
            if (items.length === 0) {
              return "No routine items matched.";
            }
            return items.map((item) => `- ${ctx.routines.formatItem(item)}`).join("\n");
          },
          { attributes: input },
        ),
      {
        name: "routine_list",
        description: "List routine items including meds, habits, todos, and deadlines with optional filters. Set all=true to ignore list filters and return every non-completed visible item.",
        schema: listRoutineSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.routine_get",
          async () => {
            const item = ctx.routines.getItem(input.id);
            if (!item) {
              throw new Error(`Routine item not found: ${input.id}`);
            }
            return ctx.routines.formatItem(item);
          },
          { attributes: input },
        ),
      {
        name: "routine_get",
        description: "Get one routine item by id.",
        schema: idSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.routine_add",
          async () => {
            const item = ctx.routines.addItem({
              title: input.title,
              kind: input.kind as RoutineItemKind,
              profileId: input.profileId,
              priority: input.priority as RoutinePriority | undefined,
              description: input.description,
              dose: input.dose,
              labels: input.labels,
              jobId: input.jobId,
              projectId: input.projectId,
              blockedBy: input.blockedBy,
              schedule: buildSchedule(input),
            });
            return `Saved routine item ${item.id}: ${ctx.routines.formatItem(item)}`;
          },
          { attributes: { kind: input.kind, scheduleKind: input.scheduleKind } },
        ),
      {
        name: "routine_add",
        description: "Create a new todo, med, routine, habit, deadline, or precommitment.",
        schema: addRoutineSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.routine_update",
          async () => {
            const item = ctx.routines.updateItem(input.id, {
              profileId: input.profileId,
              title: input.title,
              kind: input.kind as RoutineItemKind | undefined,
              priority: input.priority as RoutinePriority | undefined,
              description: input.description,
              labels: input.labels,
              jobId: input.jobId,
              projectId: input.projectId,
              blockedBy: input.blockedBy,
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
            return `Updated routine item ${item.id}: ${ctx.routines.formatItem(item)}`;
          },
          {
            attributes: {
              id: input.id,
              kind: input.kind,
              priority: input.priority,
              scheduleKind: input.scheduleKind,
            },
          },
        ),
      {
        name: "routine_update",
        description:
          "Edit an existing routine item's title, description, priority, kind, blocking dependencies, or full schedule. To update the schedule, provide scheduleKind plus the matching schedule fields.",
        schema: updateRoutineSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.routine_delete",
          async () => {
            const item = ctx.routines.deleteItem(input.id);
            return `Deleted routine item ${item.id}: ${item.title}`;
          },
          { attributes: input },
        ),
      {
        name: "routine_delete",
        description: "Permanently delete a routine item by id.",
        schema: idSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.routine_done",
          async () => {
            const item = ctx.routines.markDone(input.id);
            return `Marked done: ${ctx.routines.formatItem(item)}`;
          },
          { attributes: input },
        ),
      {
        name: "routine_done",
        description: "Mark a routine item completed.",
        schema: idSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.routine_undo_done",
          async () => {
            const item = ctx.routines.undoDone(input.id);
            return `Undid completion: ${ctx.routines.formatItem(item)}`;
          },
          { attributes: input },
        ),
      {
        name: "routine_undo_done",
        description: "Undo the most recent completion for a routine item.",
        schema: idSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.routine_snooze",
          async () => {
            const item = ctx.routines.snooze(input.id, input.minutes);
            return `Snoozed ${item.id} until ${item.state.snoozedUntil ?? "later"}.`;
          },
          { attributes: input },
        ),
      {
        name: "routine_snooze",
        description: "Snooze a routine item for a number of minutes.",
        schema: snoozeSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.routine_skip",
          async () => {
            const item = ctx.routines.skip(input.id);
            return `Skipped the current occurrence for ${item.id}.`;
          },
          { attributes: input },
        ),
      {
        name: "routine_skip",
        description: "Skip the current occurrence of a routine item.",
        schema: idSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.routine_pause",
          async () => {
            const item = ctx.routines.pause(input.id);
            return `Paused ${item.id}.`;
          },
          { attributes: input },
        ),
      {
        name: "routine_pause",
        description: "Pause a routine item.",
        schema: idSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.routine_resume",
          async () => {
            const item = ctx.routines.resume(input.id);
            return `Resumed ${item.id}.`;
          },
          { attributes: input },
        ),
      {
        name: "routine_resume",
        description: "Resume a paused routine item.",
        schema: idSchema,
      },
    ),
    // Alarm/timer tools are closely related to routines
    defineTool(
      async (input) =>
        traceSpan(
          "tool.set_alarm",
          async () => {
            const alarm = ctx.alarms.setAlarm(input.name, input.time);
            return [
              `Alarm set: ${alarm.name}`,
              `Id: ${alarm.id}`,
              `Triggers at: ${alarm.triggerAt}`,
              `Accepted formats: local HH:MM or a future ISO timestamp.`,
            ].join("\n");
          },
          { attributes: input },
        ),
      {
        name: "set_alarm",
        description:
          "Schedule a Discord alarm. Use time as local HH:MM or a future ISO timestamp such as 07:30 or 2026-03-16T09:00:00-04:00.",
        schema: setAlarmSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.set_timer",
          async () => {
            const timer = ctx.alarms.setTimer(input.name, input.duration);
            return [
              `Timer set: ${timer.name}`,
              `Id: ${timer.id}`,
              `Triggers at: ${timer.triggerAt}`,
              "Accepted duration suffixes: s, m, h, d.",
            ].join("\n");
          },
          { attributes: input },
        ),
      {
        name: "set_timer",
        description:
          "Schedule a Discord timer. Use duration strings like 30s, 10m, 2h, or 1d.",
        schema: setTimerSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.alarm_list",
          async () => {
            const alarms = ctx.alarms.listAlarms({
              state: input.state,
              limit: input.limit,
            });
            if (alarms.length === 0) {
              return "No alarms or timers matched.";
            }
            return alarms.map((alarm) =>
              [
                `- ${alarm.id}`,
                `${alarm.kind}/${alarm.name}`,
                `triggerAt=${alarm.triggerAt}`,
                `state=${alarm.cancelledAt ? "cancelled" : alarm.deliveredAt ? "delivered" : "pending"}`,
                `spec=${alarm.originalSpec}`,
              ].join(" | ")).join("\n");
          },
          { attributes: input },
        ),
      {
        name: "alarm_list",
        description: "List scheduled alarms and timers. Defaults to pending items only.",
        schema: listAlarmSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.alarm_cancel",
          async () => {
            const alarm = ctx.alarms.cancelAlarm(input.id);
            return `Cancelled ${alarm.kind} ${alarm.id}: ${alarm.name}`;
          },
          { attributes: input },
        ),
      {
        name: "alarm_cancel",
        description: "Cancel a scheduled alarm or timer by id.",
        schema: idSchema,
      },
    ),
  ];
}
