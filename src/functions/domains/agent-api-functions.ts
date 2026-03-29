/**
 * Agent API function definitions (list, output, send).
 */
import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";
import { summarizeAgentRun } from "../../services/subagent-summary-service";

const AGENT_API_AUTH = { access: "anyone" as const, behavior: "uniform" as const };

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

// ---------------------------------------------------------------------------
// Domain builder
// ---------------------------------------------------------------------------

export const buildAgentApiFunctions: FunctionDomainBuilder = (_ctx) => [
  // -------------------------------------------------------------------------
  // GET /api/g2/agents
  // -------------------------------------------------------------------------
  defineFunction({
    name: "api_agents_list",
    description: "List active agents with id, status, host, uptime, and truncated goal.",
    input: z.object({}),
    surfaces: ["api"],
    handler: async (_input, fnCtx) => {
      const runs = fnCtx.services.subagents.listAgentRuns();
      const active = runs.filter(
        (r) => r.status === "running" || r.status === "starting",
      );
      return active.map((r) => ({
        id: r.id,
        status: r.status.toUpperCase(),
        host: r.tmuxSession,
        uptime: formatUptime(r.startedAt, r.createdAt),
        goal_truncated: truncateGoal(r.goal),
      }));
    },
    auth: AGENT_API_AUTH,
    domains: ["agents"],
    agentScopes: [],
    http: { method: "GET", path: "/agents" },
  }),

  // -------------------------------------------------------------------------
  // GET /api/g2/agents/:id/output
  // -------------------------------------------------------------------------
  defineFunction({
    name: "api_agent_output",
    description: "Get terminal output lines for a running agent.",
    input: z.object({
      id: z.string().min(1),
      lines: z.coerce.number().int().positive().optional(),
    }),
    surfaces: ["api"],
    handler: async (input, fnCtx) => {
      const lines = input.lines ?? 20;
      const output = await fnCtx.services.subagents.captureAgentPane(input.id, lines);
      return { runId: input.id, output: output.split("\n") };
    },
    auth: AGENT_API_AUTH,
    domains: ["agents"],
    agentScopes: [],
    http: {
      method: "GET",
      path: "/agents/:id/output",
      queryParams: z.object({
        lines: z.string().optional(),
      }),
    },
  }),

  defineFunction({
    name: "api_agent_summary",
    description: "Summarize a running or recently completed agent.",
    input: z.object({
      id: z.string().min(1),
    }),
    surfaces: ["api"],
    handler: async (input, fnCtx) => ({
      runId: input.id,
      summary: await summarizeAgentRun({
        runId: input.id,
        subagents: fnCtx.services.subagents,
        models: fnCtx.services.models,
      }),
    }),
    auth: AGENT_API_AUTH,
    domains: ["agents"],
    agentScopes: [],
    http: {
      method: "GET",
      path: "/agents/:id/summary",
    },
  }),

  // -------------------------------------------------------------------------
  // POST /api/g2/agents/:id/send
  // -------------------------------------------------------------------------
  defineFunction({
    name: "api_agent_send",
    description: "Send input text to a running agent.",
    input: z.object({
      id: z.string().min(1),
      input: z.string().min(1),
    }),
    surfaces: ["api"],
    handler: async (input, fnCtx) => {
      await fnCtx.services.subagents.steerAgent({
        runId: input.id,
        message: input.input,
      });
      return { ok: true };
    },
    auth: AGENT_API_AUTH,
    domains: ["agents"],
    agentScopes: [],
    mutatesState: true,
    http: { method: "POST", path: "/agents/:id/send" },
  }),
];
