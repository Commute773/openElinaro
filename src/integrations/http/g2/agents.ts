import type { RouteDefinition } from "./router";
import { json, error, formatUptime, truncateGoal } from "./helpers";

export const agentRoutes: RouteDefinition[] = [
  {
    method: "GET",
    pattern: "/api/g2/agents",
    handler: async (_request, _params, app) => {
      const runs = app.listAgentRuns();
      const active = runs.filter(
        (r) => r.status === "running" || r.status === "starting",
      );
      return json(
        active.map((r) => ({
          id: r.id,
          status: r.status.toUpperCase(),
          host: r.tmuxSession,
          uptime: formatUptime(r.startedAt, r.createdAt),
          goal_truncated: truncateGoal(r.goal),
        })),
      );
    },
  },
  {
    method: "GET",
    pattern: "/api/g2/agents/:id/output",
    handler: async (request, params, app) => {
      const runId = params.id!;
      const url = new URL(request.url, "http://localhost");
      const lines = parseInt(url.searchParams.get("lines") ?? "20", 10);
      const output = await app.captureAgentOutput(runId, lines);
      return json({ runId, output: output.split("\n") });
    },
  },
  {
    method: "POST",
    pattern: "/api/g2/agents/:id/send",
    handler: async (request, params, app) => {
      const runId = params.id!;
      try {
        const body = (await request.json()) as { input?: string };
        const input = body.input;
        if (!input) return error("input is required");
        await app.steerAgent({ runId, message: input });
        return json({ ok: true });
      } catch (err: any) {
        return error(err.message ?? "Failed to send to agent", 500);
      }
    },
  },
];
