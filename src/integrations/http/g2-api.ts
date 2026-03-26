import type { OpenElinaroApp } from "../../app/runtime";
import { telemetry } from "../../services/telemetry";

const g2Telemetry = telemetry.child({ component: "g2_api" });

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS_HEADERS });
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function formatUptime(startedAt?: string, createdAt?: string): string {
  const ref = startedAt ?? createdAt;
  if (!ref) return "0m";
  const ms = Date.now() - new Date(ref).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${String(remainingMinutes).padStart(2, "0")}m`;
}

function truncateGoal(goal: string, maxLen = 60): string {
  return goal.length > maxLen ? goal.slice(0, maxLen - 1) + "\u2026" : goal;
}

/**
 * Handles G2 API requests.
 * Returns a Response if the request matched a G2 route, or null if it didn't.
 */
export async function handleG2ApiRequest(
  request: Request,
  pathname: string,
  app: OpenElinaroApp,
): Promise<Response | null> {
  // CORS preflight
  if (request.method === "OPTIONS" && pathname.startsWith("/api/g2")) {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // ── GET /api/g2/home ──
  if (pathname === "/api/g2/home" && request.method === "GET") {
    return g2Telemetry.span("g2_api.home", {}, () => {
      const runs = app.listAgentRuns();
      const activeAgents = runs.filter((r) => r.status === "running" || r.status === "starting");

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
  }

  // ── GET /api/g2/agents ──
  if (pathname === "/api/g2/agents" && request.method === "GET") {
    const runs = app.listAgentRuns();
    const active = runs.filter((r) => r.status === "running" || r.status === "starting");
    return json(
      active.map((r) => ({
        id: r.id,
        status: r.status.toUpperCase(),
        host: r.tmuxSession,
        uptime: formatUptime(r.startedAt, r.createdAt),
        goal_truncated: truncateGoal(r.goal),
      })),
    );
  }

  // ── GET /api/g2/agents/:id/output ──
  const agentOutputMatch = pathname.match(/^\/api\/g2\/agents\/([^/]+)\/output$/);
  if (agentOutputMatch?.[1] && request.method === "GET") {
    const runId = agentOutputMatch[1];
    const url = new URL(request.url, "http://localhost");
    const lines = parseInt(url.searchParams.get("lines") ?? "20", 10);
    const output = await app.captureAgentOutput(runId, lines);
    return json({ runId, output: output.split("\n") });
  }

  // ── POST /api/g2/agents/:id/send ──
  const agentSendMatch = pathname.match(/^\/api\/g2\/agents\/([^/]+)\/send$/);
  if (agentSendMatch?.[1] && request.method === "POST") {
    const runId = agentSendMatch[1];
    try {
      const body = (await request.json()) as { input?: string };
      const input = body.input;
      if (!input) return error("input is required");
      await app.steerAgent({ runId, message: input });
      return json({ ok: true });
    } catch (err: any) {
      return error(err.message ?? "Failed to send to agent", 500);
    }
  }

  // ── GET /api/g2/routines ──
  if (pathname === "/api/g2/routines" && request.method === "GET") {
    const allItems = app.listRoutineItems({ status: "active" });
    const assessment = app.assessRoutines();
    const now = new Date();

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
  }

  // ── POST /api/g2/routines/:id/done ──
  const routineDoneMatch = pathname.match(/^\/api\/g2\/routines\/([^/]+)\/done$/);
  if (routineDoneMatch?.[1] && request.method === "POST") {
    const id = routineDoneMatch[1];
    try {
      app.markRoutineDone(id);
      return json({ ok: true });
    } catch (err: any) {
      return error(err.message ?? "Failed to mark routine done", 500);
    }
  }

  // ── GET /api/g2/todos ──
  if (pathname === "/api/g2/todos" && request.method === "GET") {
    const todos = app.listRoutineItems({ kind: "todo", status: "active" });
    return json(
      todos.map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        priority: item.priority,
      })),
    );
  }

  // ── POST /api/g2/todos/:id/done ──
  const todoDoneMatch = pathname.match(/^\/api\/g2\/todos\/([^/]+)\/done$/);
  if (todoDoneMatch?.[1] && request.method === "POST") {
    const id = todoDoneMatch[1];
    try {
      app.markRoutineDone(id);
      return json({ ok: true });
    } catch (err: any) {
      return error(err.message ?? "Failed to mark todo done", 500);
    }
  }

  // ── POST /api/g2/ask ──
  if (pathname === "/api/g2/ask" && request.method === "POST") {
    try {
      const body = (await request.json()) as { text?: string };
      if (!body.text) return error("text is required");

      const response = await app.handleRequest({
        id: `g2-ask-${Date.now()}`,
        kind: "chat",
        text: body.text,
        conversationKey: "g2-simulator",
      });

      return json({ response: response.message });
    } catch (err: any) {
      g2Telemetry.recordError(err, { operation: "g2_api.ask" });
      return error(err.message ?? "Failed to process query", 500);
    }
  }

  // ── GET /api/g2/notifications ──
  if (pathname === "/api/g2/notifications" && request.method === "GET") {
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
    for (const entry of assessment.items.filter((a) => a.shouldRemindNow).slice(0, 10)) {
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
  }

  // ── POST /api/g2/notifications/:id/action ──
  const notifActionMatch = pathname.match(/^\/api\/g2\/notifications\/([^/]+)\/action$/);
  if (notifActionMatch?.[1] && request.method === "POST") {
    const notifId = notifActionMatch[1];
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
  }

  // Not a G2 route
  return null;
}
