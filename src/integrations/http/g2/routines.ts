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
    method: "POST",
    pattern: "/api/g2/routines",
    handler: async (request, _params, app) => {
      try {
        const body = (await request.json()) as Record<string, unknown>;
        if (!body.title || typeof body.title !== "string") {
          return error("title is required");
        }
        const item = app.addRoutineItem({
          title: body.title,
          kind: (body.kind as any) ?? "routine",
          priority: body.priority as any,
          description: body.description as any,
          schedule: (body.schedule as any) ?? { kind: "manual" },
          labels: body.labels as any,
          dose: body.dose as any,
          alarm: body.alarm as any,
          jobId: body.jobId as any,
          projectId: body.projectId as any,
          blockedBy: body.blockedBy as any,
        });
        return json(item, 201);
      } catch (err: any) {
        return error(err.message ?? "Failed to create routine", 500);
      }
    },
  },
  {
    method: "PATCH",
    pattern: "/api/g2/routines/:id",
    handler: async (request, params, app) => {
      try {
        const body = (await request.json()) as Record<string, unknown>;
        const item = app.updateRoutineItem(params.id!, {
          title: body.title as any,
          description: body.description as any,
          priority: body.priority as any,
          kind: body.kind as any,
          labels: body.labels as any,
          schedule: body.schedule as any,
          alarm: body.alarm as any,
          jobId: body.jobId as any,
          projectId: body.projectId as any,
          blockedBy: body.blockedBy as any,
        });
        return json(item);
      } catch (err: any) {
        return error(err.message ?? "Failed to update routine", 500);
      }
    },
  },
  {
    method: "DELETE",
    pattern: "/api/g2/routines/:id",
    handler: async (_request, params, app) => {
      try {
        app.deleteRoutineItem(params.id!);
        return json({ ok: true });
      } catch (err: any) {
        return error(err.message ?? "Failed to delete routine", 500);
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
  {
    method: "POST",
    pattern: "/api/g2/todos",
    handler: async (request, _params, app) => {
      try {
        const body = (await request.json()) as Record<string, unknown>;
        if (!body.title || typeof body.title !== "string") {
          return error("title is required");
        }
        const item = app.addRoutineItem({
          title: body.title,
          kind: "todo",
          priority: body.priority as any,
          description: body.description as any,
          schedule: (body.schedule as any) ?? { kind: "once", dueAt: new Date().toISOString() },
          labels: body.labels as any,
          jobId: body.jobId as any,
          projectId: body.projectId as any,
          blockedBy: body.blockedBy as any,
        });
        return json(item, 201);
      } catch (err: any) {
        return error(err.message ?? "Failed to create todo", 500);
      }
    },
  },
  {
    method: "PATCH",
    pattern: "/api/g2/todos/:id",
    handler: async (request, params, app) => {
      try {
        const body = (await request.json()) as Record<string, unknown>;
        const item = app.updateRoutineItem(params.id!, {
          title: body.title as any,
          description: body.description as any,
          priority: body.priority as any,
          labels: body.labels as any,
          schedule: body.schedule as any,
          jobId: body.jobId as any,
          projectId: body.projectId as any,
          blockedBy: body.blockedBy as any,
        });
        return json(item);
      } catch (err: any) {
        return error(err.message ?? "Failed to update todo", 500);
      }
    },
  },
  {
    method: "DELETE",
    pattern: "/api/g2/todos/:id",
    handler: async (_request, params, app) => {
      try {
        app.deleteRoutineItem(params.id!);
        return json({ ok: true });
      } catch (err: any) {
        return error(err.message ?? "Failed to delete todo", 500);
      }
    },
  },
];
