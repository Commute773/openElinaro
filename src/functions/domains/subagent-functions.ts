/**
 * Subagent function definitions.
 * Migrated from src/tools/groups/subagent-tools.ts.
 */
import os from "node:os";
import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";
import { formatResult } from "../formatters";
import type { SubagentRun } from "../../domain/subagent-run";
import type { ProjectsService } from "../../services/projects-service";
import { summarizeAgentRun } from "../../services/subagent-summary-service";
import { formatDurationMs } from "./service-functions";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const responseFormatSchema = z.enum(["text", "json"]);

const launchAgentSchema = z.object({
  goal: z.string().min(12),
  workspace: z.string().min(1)
    .describe("Required. The workspace to launch the agent in. Use a project ID for project work, \"openElinaro\" for platform work, or \"root\" for general tasks in the home directory."),
  profile: z.string().min(1).optional(),
  provider: z.enum(["claude", "codex"]).optional(),
  timeoutMs: z.number()
    .int()
    .min(1_000)
    .max(86_400_000)
    .describe("Optional wall-clock timeout in milliseconds. Defaults to one hour; omit unless overriding.")
    .optional(),
});

const resumeAgentSchema = z.object({
  runId: z.string().min(1),
  message: z.string().min(1).optional(),
  timeoutMs: z.number()
    .int()
    .min(1_000)
    .max(86_400_000)
    .describe("Optional replacement wall-clock timeout in milliseconds.")
    .optional(),
});

const steerAgentSchema = z.object({
  runId: z.string().min(1),
  message: z.string().min(1),
});

const cancelAgentSchema = z.object({
  runId: z.string().min(1),
});

const agentStatusSchema = z.object({
  runId: z.string().optional(),
  limit: z.number().int().min(1).max(10).optional(),
  capture: z.boolean().optional().describe("When true, include the last N lines of the agent's tmux pane output."),
  captureLines: z.number().int().min(1).max(200).optional().describe("Number of tmux pane lines to capture. Defaults to 50."),
  format: responseFormatSchema.optional(),
});

const agentSummarySchema = z.object({
  runId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveWorkspacePath(projects: ProjectsService, workspace: string): string {
  if (workspace === "root") {
    return os.homedir();
  }
  if (workspace === "openElinaro") {
    return process.cwd();
  }
  const project = projects.getProject(workspace);
  if (project) {
    return projects.resolveWorkspacePath(project);
  }
  throw new Error(
    `Unknown workspace "${workspace}". Use "root", "openElinaro", or a valid project ID.`,
  );
}

function buildWorkspaceHints(projects: ProjectsService): string {
  const projectList = projects
    .listProjects({ status: "active" })
    .map((p) => `- "${p.id}": ${p.name} — ${p.workspacePath}`);
  return [
    "\n\nAvailable workspaces (workspace parameter is required):",
    '- "openElinaro": the openElinaro platform repo (use for platform features, bugs, and infra)',
    '- "root": home directory (use for general tasks not tied to a specific project)',
    ...projectList,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Auth / metadata
// ---------------------------------------------------------------------------

const SUBAGENT_AUTH = { access: "anyone" as const, behavior: "role-sensitive" as const };
const SUBAGENT_SCOPES: ("chat" | "direct")[] = ["chat", "direct"];
const SUBAGENT_DOMAINS = ["workflow", "agents"];

// ---------------------------------------------------------------------------
// Domain builder
// ---------------------------------------------------------------------------

export const buildSubagentFunctions: FunctionDomainBuilder = (ctx) => {
  // Compute hints lazily at build time -- tolerate missing services during tests.
  let availableProviders: Array<{ provider: "claude" | "codex"; path: string; description?: string }> = [];
  let providerHints = "";
  let workspaceHints = "";
  try {
    availableProviders = ctx.subagents.listAvailableProviders();
    providerHints = availableProviders.length > 1
      ? "\n\nAvailable providers for this profile:\n" + availableProviders
          .map((p) => `- ${p.provider}${p.description ? `: ${p.description}` : ""}`)
          .join("\n")
        + "\n\nChoose the provider that best fits the task. Pass provider explicitly when multiple are available."
      : "";
    workspaceHints = buildWorkspaceHints(ctx.projects);
  } catch {
    // During test mocks, services may not be wired up. Use empty hints.
  }

  return [
    // -----------------------------------------------------------------------
    // launch_agent
    // -----------------------------------------------------------------------
    defineFunction({
      name: "launch_agent",
      description:
        `Launch a background agent (Claude Code or Codex) in a named workspace. You MUST specify a workspace — choose the one that matches where the work should happen. The agent runs in its own tmux window with an isolated worktree. Completion updates are pushed back automatically. Omit timeoutMs to use the default (one hour).${workspaceHints}${providerHints}`,
      input: launchAgentSchema,
      handler: async (input, fnCtx) => {
        const subagents = fnCtx.services.subagents;
        const context = fnCtx.toolContext;
        // Re-read providers at call time to pick up runtime changes
        const currentProviders = subagents.listAvailableProviders();

        if (!input.provider && currentProviders.length > 1) {
          return [
            "Multiple agent providers are available. Please specify which provider to use:",
            ...currentProviders.map((p) =>
              `- provider: "${p.provider}"${p.description ? ` — ${p.description}` : ""}`
            ),
            "",
            "Re-call launch_agent with provider set to your choice.",
          ].join("\n");
        }

        const resolvedCwd = resolveWorkspacePath(fnCtx.services.projects, input.workspace);

        const run = await subagents.launchAgent({
          goal: input.goal,
          cwd: resolvedCwd,
          profileId: input.profile,
          provider: input.provider,
          originConversationKey: context?.conversationKey,
          requestedBy: context?.conversationKey ? "chat-tool" : "direct-tool",
          timeoutMs: input.timeoutMs,
          subagentDepth: context?.subagentDepth ?? 0,
        });
        return [
          `Background ${run.provider} agent launched.`,
          `Run id: ${run.id}`,
          `Goal: ${run.goal}`,
          `Profile: ${run.profileId}`,
          `Provider: ${run.provider}`,
          `Subagent depth: ${run.launchDepth}`,
          `Timeout: ${run.timeoutMs}ms`,
          `Workspace: ${input.workspace} → ${run.workspaceCwd}`,
          "Completion updates are pushed back automatically.",
          "Use agent_status only for occasional manual spot checks.",
        ].join("\n");
      },
      format: formatResult,
      auth: { ...SUBAGENT_AUTH, note: "Subagent profile selection is restricted by the caller's roles." },
      domains: SUBAGENT_DOMAINS,
      agentScopes: SUBAGENT_SCOPES,
      mutatesState: true,
      supportsBackground: true,
      examples: ["launch background coding task", "run longer code workflow"],
    }),

    // -----------------------------------------------------------------------
    // resume_agent
    // -----------------------------------------------------------------------
    defineFunction({
      name: "resume_agent",
      description:
        "Resume a completed or failed background agent run. Spawns a fresh agent process in the same worktree with optional follow-up instructions. Completion updates are pushed back automatically.",
      input: resumeAgentSchema,
      handler: async (input, fnCtx) => {
        const run = await fnCtx.services.subagents.resumeAgent({
          runId: input.runId,
          message: input.message,
          timeoutMs: input.timeoutMs,
        });
        return [
          `Background ${run.provider} agent resumed.`,
          `Run id: ${run.id}`,
          `Goal: ${run.goal}`,
          `Profile: ${run.profileId}`,
          input.message ? `Instruction: ${input.message}` : "Instruction: continue from the current run state.",
          `Timeout: ${run.timeoutMs}ms`,
          `Workspace: ${run.workspaceCwd}`,
          "Completion updates are pushed back automatically.",
        ].join("\n");
      },
      format: formatResult,
      auth: { ...SUBAGENT_AUTH, note: "Only runs visible to the active profile can be resumed." },
      domains: SUBAGENT_DOMAINS,
      agentScopes: SUBAGENT_SCOPES,
      mutatesState: true,
      supportsBackground: true,
      examples: ["send follow-up to returned subagent", "resume an existing coding run"],
    }),

    // -----------------------------------------------------------------------
    // steer_agent
    // -----------------------------------------------------------------------
    defineFunction({
      name: "steer_agent",
      description:
        "Send a new instruction to a running background agent. The message is injected into the agent's stdin via tmux send-keys.",
      input: steerAgentSchema,
      handler: async (input, fnCtx) => {
        const run = await fnCtx.services.subagents.steerAgent({
          runId: input.runId,
          message: input.message,
        });
        return [
          "Background agent steered.",
          `Run id: ${run.id}`,
          `Status: ${run.status}`,
          `Instruction: ${input.message}`,
          "The message was sent to the agent's tmux window via stdin.",
        ].join("\n");
      },
      format: formatResult,
      auth: { ...SUBAGENT_AUTH, note: "Only runs visible to the active profile can receive steering instructions." },
      domains: SUBAGENT_DOMAINS,
      agentScopes: SUBAGENT_SCOPES,
      mutatesState: true,
      examples: ["tell the subagent to focus tests first", "send a new instruction to a running agent"],
    }),

    // -----------------------------------------------------------------------
    // cancel_agent
    // -----------------------------------------------------------------------
    defineFunction({
      name: "cancel_agent",
      description:
        "Cancel a running background agent. Kills the tmux window and marks the run as cancelled.",
      input: cancelAgentSchema,
      handler: async (input, fnCtx) => {
        const run = await fnCtx.services.subagents.cancelAgent({
          runId: input.runId,
        });
        return [
          "Background agent cancelled.",
          `Run id: ${run.id}`,
          `Status: ${run.status}`,
        ].join("\n");
      },
      format: formatResult,
      auth: { ...SUBAGENT_AUTH, note: "Only runs visible to the active profile can be cancelled." },
      domains: SUBAGENT_DOMAINS,
      agentScopes: SUBAGENT_SCOPES,
      mutatesState: true,
      examples: ["stop run-123", "abort a running coding agent"],
    }),

    // -----------------------------------------------------------------------
    // agent_status
    // -----------------------------------------------------------------------
    defineFunction({
      name: "agent_status",
      description:
        "Inspect one agent run by id or list the most recent background agent runs. Set capture=true to include what the agent's tmux pane is currently displaying. Use this for occasional manual spot checks, not tight polling.",
      input: agentStatusSchema,
      handler: async (input, fnCtx) => {
        const subagents = fnCtx.services.subagents;

        const selectedRuns = input.runId
          ? [subagents.getAgentRun(input.runId)].filter(
              (run): run is SubagentRun => run !== undefined,
            )
          : subagents.listAgentRuns().slice(-(input.limit ?? 3));
        if (selectedRuns.length === 0) {
          if (input.format === "json") {
            return {
              runs: [],
              count: 0,
              message: input.runId
                ? `No agent run found for ${input.runId}.`
                : "No agent runs have been recorded yet.",
            };
          }
          return input.runId
            ? `No agent run found for ${input.runId}.`
            : "No agent runs have been recorded yet.";
        }

        const wantCapture = input.capture === true;
        const captureLines = input.captureLines ?? 50;

        const runs = await Promise.all(selectedRuns.map(async (run) => {
          const elapsedMs = run.startedAt
            ? Date.now() - Date.parse(run.startedAt)
            : undefined;
          const paneOutput = wantCapture
            ? await subagents.captureAgentPane(run.id, captureLines)
            : undefined;
          return {
            id: run.id,
            provider: run.provider,
            status: run.status,
            goal: run.goal,
            profileId: run.profileId,
            launchDepth: run.launchDepth,
            timeoutMs: run.timeoutMs,
            workspace: run.workspaceCwd,
            elapsedMs,
            canResume: run.status === "completed" || run.status === "failed",
            summary: run.resultSummary || undefined,
            error: run.error || undefined,
            eventCount: run.eventLog.length,
            paneOutput,
          };
        }));

        if (input.format === "json") {
          return { runs, count: runs.length };
        }

        return runs.map((run) =>
          [
            `Run: ${run.id}`,
            `Provider: ${run.provider}`,
            `Status: ${run.status}`,
            `Goal: ${run.goal}`,
            `Profile: ${run.profileId}`,
            `Subagent depth: ${run.launchDepth}`,
            `Timeout: ${run.timeoutMs}ms`,
            run.workspace ? `Workspace: ${run.workspace}` : "",
            run.elapsedMs !== undefined ? `Elapsed: ${formatDurationMs(run.elapsedMs)}` : "",
            run.canResume ? "Resume ready: yes" : "",
            run.summary ? `Summary: ${run.summary}` : "",
            run.error ? `Error: ${run.error}` : "",
            `Events: ${run.eventCount}`,
            run.paneOutput ? `\n--- tmux pane (last ${captureLines} lines) ---\n${run.paneOutput}` : "",
          ]
            .filter(Boolean)
            .join("\n"))
          .join("\n\n");
      },
      format: formatResult,
      auth: { ...SUBAGENT_AUTH, note: "Only runs visible to the active profile are returned." },
      domains: SUBAGENT_DOMAINS,
      agentScopes: SUBAGENT_SCOPES,
      examples: ["spot-check coding agent run", "list recent workflows"],
    }),

    // -----------------------------------------------------------------------
    // read_agent_terminal
    // -----------------------------------------------------------------------
    defineFunction({
      name: "read_agent_terminal",
      description:
        "Read the full terminal buffer (scrollback + visible area) for a running or recently exited agent. Returns the raw text content of the tmux pane. Useful for debugging what an agent is doing or why it failed.",
      input: z.object({
        runId: z.string().min(1).describe("The run ID of the agent whose terminal to read."),
      }),
      handler: async (input, fnCtx) => {
        const output = await fnCtx.services.subagents.readAgentTerminal(input.runId);
        return output || "(empty terminal buffer)";
      },
      format: formatResult,
      auth: { ...SUBAGENT_AUTH, note: "Only terminal output for runs visible to the active profile is returned." },
      domains: SUBAGENT_DOMAINS,
      agentScopes: SUBAGENT_SCOPES,
      examples: ["read agent terminal output", "see what an agent is doing"],
    }),

    defineFunction({
      name: "agent_summary",
      description:
        "Summarize a background agent's current terminal state or recent failure/completion context. Uses the full terminal buffer when available and falls back to stored run metadata when the tmux window is gone.",
      input: agentSummarySchema,
      handler: async (input, fnCtx) =>
        summarizeAgentRun({
          runId: input.runId,
          subagents: fnCtx.services.subagents,
          models: fnCtx.services.models,
        }),
      format: formatResult,
      auth: { ...SUBAGENT_AUTH, note: "Only summaries for runs visible to the active profile are returned." },
      domains: SUBAGENT_DOMAINS,
      agentScopes: SUBAGENT_SCOPES,
      examples: ["summarize what a subagent is doing", "summarize why a run failed"],
    }),
  ];
};
