import type { RouteDefinition } from "./router";
import { json, error } from "./helpers";

export const routineRoutes: RouteDefinition[] = [
  {
    method: "GET",
    pattern: "/api/g2/routines",
    handler: async (_request, _params, app) => {
      const allItems = app.listRoutineItems({ status: "active" });
      const assessment = app.assessRoutines();

      // Build a set of item IDs that are currently assessed (not done)
      const assessedIds = new Set(assessment.items.map((a) => a.item.id));

      // Items with scheduled times (routine/habit/med kinds with daily/weekly/monthly schedules)
      const scheduled = allItems.filter((item) => {
        if (item.kind === "todo") return false;
        return item.schedule.kind !== "manual" && item.schedule.kind !== "once";
      });

      const routines = scheduled.map((item) => {
        const time = "time" in item.schedule ? (item.schedule as any).time : "";
        const isInAssessment = assessedIds.has(item.id);

        let status: "done" | "pending" | "missed";
        if (!isInAssessment) {
          // Not in assessment = already done today (filtered out by assessNow)
          status = "done";
        } else {
          const assessed = assessment.items.find((a) => a.item.id === item.id);
          if (assessed?.state === "due" && assessed.overdueMinutes > 30) {
            status = "missed";
          } else {
            status = "pending";
          }
        }

        return {
          id: item.id,
          name: item.title,
          time: time || "",
          status,
        };
      });

      // Sort by time
      routines.sort((a, b) => a.time.localeCompare(b.time));
      return json(routines);
    },
  },
  {
    method: "POST",
    pattern: "/api/g2/routines/:id/done",
    handler: async (_request, params, app) => {
      try {
        app.markRoutineDone(params.id!);
        return json({ ok: true });
      } catch (err: any) {
        return error(err.message ?? "Failed to mark routine done", 500);
      }
    },
  },
  {
    method: "GET",
    pattern: "/api/g2/todos",
    handler: async (_request, _params, app) => {
      const todos = app.listRoutineItems({ kind: "todo", status: "active" });
      return json(
        todos.map((item) => ({
          id: item.id,
          title: item.title,
          status: item.status,
          priority: item.priority,
        })),
      );
    },
  },
  {
    method: "POST",
    pattern: "/api/g2/todos/:id/done",
    handler: async (_request, params, app) => {
      try {
        app.markRoutineDone(params.id!);
        return json({ ok: true });
      } catch (err: any) {
        return error(err.message ?? "Failed to mark todo done", 500);
      }
    },
  },
];
