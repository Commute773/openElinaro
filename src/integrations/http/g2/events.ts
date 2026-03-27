import type { OpenElinaroApp } from "../../../app/runtime";
import type { RouteDefinition } from "./router";
import { CORS_HEADERS, g2Telemetry, truncateGoal } from "./helpers";

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  ...CORS_HEADERS,
};

const POLL_INTERVAL_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function createEventStream(app: OpenElinaroApp, request: Request): Response {
  const knownAgentStatuses = new Map<string, string>();
  const knownRoutineReminders = new Set<string>();
  const knownAlarms = new Set<string>();

  // Seed initial state so only deltas are sent after connection
  for (const run of app.listAgentRuns()) {
    knownAgentStatuses.set(run.id, run.status);
  }
  for (const entry of app.assessRoutines().items.filter((a) => a.shouldRemindNow)) {
    knownRoutineReminders.add(entry.item.id);
  }
  for (const alarm of app.listDueAlarms()) {
    knownAlarms.add(alarm.id);
  }

  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let cancelled = false;

  const teardown = () => {
    if (cancelled) return;
    cancelled = true;
    if (pollTimer) clearInterval(pollTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  };

  const stream = new ReadableStream<string>({
    start(controller) {
      pollTimer = setInterval(() => {
        if (cancelled) return;
        try {
          const events = collectEvents(app, knownAgentStatuses, knownRoutineReminders, knownAlarms);
          for (const evt of events) {
            controller.enqueue(evt);
          }
        } catch (err) {
          g2Telemetry.recordError(err, { operation: "g2_api.events.poll" });
        }
      }, POLL_INTERVAL_MS);

      heartbeatTimer = setInterval(() => {
        if (cancelled) return;
        try {
          controller.enqueue(": heartbeat\n\n");
        } catch {
          teardown();
        }
      }, HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      teardown();
    },
  });

  request.signal?.addEventListener("abort", teardown);

  return new Response(stream, { headers: SSE_HEADERS });
}

function collectEvents(
  app: OpenElinaroApp,
  knownAgentStatuses: Map<string, string>,
  knownRoutineReminders: Set<string>,
  knownAlarms: Set<string>,
): string[] {
  const events: string[] = [];

  // --- Agent events ---
  const currentRuns = app.listAgentRuns();
  const currentRunIds = new Set<string>();
  for (const run of currentRuns) {
    currentRunIds.add(run.id);
    const previousStatus = knownAgentStatuses.get(run.id);

    if (!previousStatus) {
      knownAgentStatuses.set(run.id, run.status);
      events.push(sseEvent("agent.started", {
        id: run.id,
        goal: truncateGoal(run.goal),
        status: run.status,
        startedAt: run.startedAt ?? run.createdAt,
      }));
    } else if (previousStatus !== run.status) {
      knownAgentStatuses.set(run.id, run.status);
      if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
        events.push(sseEvent("agent.completed", {
          id: run.id,
          goal: truncateGoal(run.goal),
          status: run.status,
          completedAt: run.completedAt,
          resultSummary: run.resultSummary,
          error: run.error,
        }));
      }
    }
  }
  for (const id of knownAgentStatuses.keys()) {
    if (!currentRunIds.has(id)) {
      knownAgentStatuses.delete(id);
    }
  }

  // --- Routine reminder events ---
  const assessment = app.assessRoutines();
  const currentReminders = new Set<string>();
  for (const entry of assessment.items.filter((a) => a.shouldRemindNow)) {
    currentReminders.add(entry.item.id);
    if (!knownRoutineReminders.has(entry.item.id)) {
      knownRoutineReminders.add(entry.item.id);
      events.push(sseEvent("routine.reminder", {
        id: entry.item.id,
        title: entry.item.title,
        kind: entry.item.kind,
        state: entry.state,
        overdueMinutes: entry.overdueMinutes,
      }));
    }
  }
  for (const id of knownRoutineReminders) {
    if (!currentReminders.has(id)) {
      knownRoutineReminders.delete(id);
    }
  }

  // --- Alarm events ---
  const currentDueAlarms = app.listDueAlarms();
  const currentAlarmIds = new Set<string>();
  for (const alarm of currentDueAlarms) {
    currentAlarmIds.add(alarm.id);
    if (!knownAlarms.has(alarm.id)) {
      knownAlarms.add(alarm.id);
      events.push(sseEvent("alarm.triggered", {
        id: alarm.id,
        name: alarm.name,
        kind: alarm.kind,
        originalSpec: alarm.originalSpec,
      }));
    }
  }
  for (const id of knownAlarms) {
    if (!currentAlarmIds.has(id)) {
      knownAlarms.delete(id);
    }
  }

  return events;
}

export const eventRoutes: RouteDefinition[] = [
  {
    method: "GET",
    pattern: "/api/g2/events",
    handler: async (request, _params, app) => {
      return createEventStream(app, request);
    },
  },
];
