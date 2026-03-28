import os from "node:os";
import { type StructuredToolInterface } from "@langchain/core/tools";
import { defineTool } from "../define-tool";
import { z } from "zod";
import type { SubagentRun } from "../../domain/subagent-run";
import type { ProjectsService } from "../../services/projects-service";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { telemetry } from "../../services/infrastructure/telemetry";
import { formatDurationMs } from "./tool-group-types";
import type { ToolContext } from "../tool-registry";

const toolTelemetry = telemetry.child({ component: "tool" });
const traceSpan = createTraceSpan(toolTelemetry);

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

export type SubagentController = {
  launchAgent: (params: {
    goal: string;
    cwd?: string;
    profileId?: string;
    provider?: "claude" | "codex";
    originConversationKey?: string;
    requestedBy?: string;
    timeoutMs?: number;
    subagentDepth?: number;
  }) => Promise<SubagentRun>;
  resumeAgent: (params: {
    runId: string;
    message?: string;
    timeoutMs?: number;
  }) => Promise<SubagentRun>;
  steerAgent: (params: {
    runId: string;
    message: string;
  }) => Promise<SubagentRun>;
  cancelAgent: (params: {
    runId: string;
  }) => Promise<SubagentRun>;
  getAgentRun: (runId: string) => SubagentRun | undefined;
  listAgentRuns: () => SubagentRun[];
  captureAgentPane: (runId: string, lines?: number) => Promise<string>;
  readAgentTerminal: (runId: string) => Promise<string>;
  listAvailableProviders: (profileId?: string) => Array<{ provider: "claude" | "codex"; path: string; description?: string }>;
};

export interface SubagentToolBuildContext {
  subagents: SubagentController;
  projects: ProjectsService;
}

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

export function buildSubagentTools(
  ctx: SubagentToolBuildContext,
  context?: ToolContext,
): StructuredToolInterface[] {
  const availableProviders = ctx.subagents.listAvailableProviders();
  const providerHints = availableProviders.length > 1
    ? "\n\nAvailable providers for this profile:\n" + availableProviders
        .map((p) => `- ${p.provider}${p.description ? `: ${p.description}` : ""}`)
        .join("\n")
      + "\n\nChoose the provider that best fits the task. Pass provider explicitly when multiple are available."
    : "";

  const workspaceHints = buildWorkspaceHints(ctx.projects);

  return [
    defineTool(
      async (input) =>
        traceSpan(
          "tool.launch_agent",
          async () => {
            if (!input.provider && availableProviders.length > 1) {
              return [
                "Multiple agent providers are available. Please specify which provider to use:",
                ...availableProviders.map((p) =>
                  `- provider: "${p.provider}"${p.description ? ` — ${p.description}` : ""}`
                ),
                "",
                "Re-call launch_agent with provider set to your choice.",
              ].join("\n");
            }

            const resolvedCwd = resolveWorkspacePath(ctx.projects, input.workspace);

            const run = await ctx.subagents.launchAgent({
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
          { attributes: input },
        ),
        {
          name: "launch_agent",
          description:
          `Launch a background agent (Claude Code or Codex) in a named workspace. You MUST specify a workspace — choose the one that matches where the work should happen. The agent runs in its own tmux window with an isolated worktree. Completion updates are pushed back automatically. Omit timeoutMs to use the default (one hour).${workspaceHints}${providerHints}`,
          schema: launchAgentSchema,
        },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.resume_agent",
          async () => {
            const run = await ctx.subagents.resumeAgent({
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
          { attributes: input },
        ),
        {
          name: "resume_agent",
          description:
          "Resume a completed or failed background agent run. Spawns a fresh agent process in the same worktree with optional follow-up instructions. Completion updates are pushed back automatically.",
          schema: resumeAgentSchema,
        },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.steer_agent",
          async () => {
            const run = await ctx.subagents.steerAgent({
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
          { attributes: input },
        ),
      {
        name: "steer_agent",
        description:
          "Send a new instruction to a running background agent. The message is injected into the agent's stdin via tmux send-keys.",
        schema: steerAgentSchema,
      },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.cancel_agent",
          async () => {
            const run = await ctx.subagents.cancelAgent({
              runId: input.runId,
            });
            return [
              "Background agent cancelled.",
              `Run id: ${run.id}`,
              `Status: ${run.status}`,
            ].join("\n");
          },
          { attributes: input },
        ),
        {
          name: "cancel_agent",
          description:
          "Cancel a running background agent. Kills the tmux window and marks the run as cancelled.",
          schema: cancelAgentSchema,
        },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.agent_status",
          async () => {
            const selectedRuns = input.runId
              ? [ctx.subagents.getAgentRun(input.runId)].filter(
                  (run): run is SubagentRun => run !== undefined,
                )
              : ctx.subagents.listAgentRuns().slice(-(input.limit ?? 3));
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
                ? await ctx.subagents.captureAgentPane(run.id, captureLines)
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
          { attributes: input },
        ),
        {
          name: "agent_status",
          description:
          "Inspect one agent run by id or list the most recent background agent runs. Set capture=true to include what the agent's tmux pane is currently displaying. Use this for occasional manual spot checks, not tight polling.",
          schema: agentStatusSchema,
        },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.read_agent_terminal",
          async () => {
            const output = await ctx.subagents.readAgentTerminal(input.runId);
            return output || "(empty terminal buffer)";
          },
          { attributes: input },
        ),
        {
          name: "read_agent_terminal",
          description:
          "Read the full terminal buffer (scrollback + visible area) for a running or recently exited agent. Returns the raw text content of the tmux pane. Useful for debugging what an agent is doing or why it failed.",
          schema: z.object({
            runId: z.string().min(1).describe("The run ID of the agent whose terminal to read."),
          }),
        },
    ),
  ];
}
