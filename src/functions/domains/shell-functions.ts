/**
 * Shell execution function definitions.
 * Migrated from src/tools/groups/shell-tools.ts.
 * These produce agent tools, API routes, and Discord commands from a single source.
 */
import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";
import { formatResult } from "../formatters";
import { renderShellExecResult } from "../context";

// ---------------------------------------------------------------------------
// Schemas (same as shell-tools.ts)
// ---------------------------------------------------------------------------

const execCommandSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  sudo: z.boolean().optional(),
  background: z.boolean().optional(),
  conversationKey: z.string().optional(),
});

const execStatusSchema = z.object({
  id: z.string().optional(),
  limit: z.number().int().min(1).max(20).optional(),
  tailLines: z.number().int().min(1).max(200).optional(),
});

const execOutputSchema = z.object({
  id: z.string().min(1),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  tailLines: z.number().int().min(1).max(500).optional(),
});

// ---------------------------------------------------------------------------
// Auth / metadata defaults
// ---------------------------------------------------------------------------

const SHELL_AUTH = { access: "anyone" as const, behavior: "role-sensitive" as const, note: "Non-root profiles run shell commands through their configured local shellUser or SSH execution backend, when present." };
const SHELL_SCOPES: ("chat" | "coding-planner" | "coding-worker" | "direct")[] = ["chat", "coding-planner", "coding-worker", "direct"];
const SHELL_DOMAINS = ["shell", "execution"];

// ---------------------------------------------------------------------------
// Domain builder
// ---------------------------------------------------------------------------

export const buildShellFunctions: FunctionDomainBuilder = (ctx) => [
  // -------------------------------------------------------------------------
  // exec_command
  // -------------------------------------------------------------------------
  defineFunction({
    name: "exec_command",
    description:
      "Execute a shell command in the configured shell, using bash by default. Non-root profiles run either as their configured local shell user or through their configured SSH execution backend. Set background=true to launch it asynchronously and get a job id you can inspect later. Passwordless sudo is only available to the root profile when sudo=true.",
    input: execCommandSchema,
    handler: async (input, fnCtx) => {
      if (input.background) {
        const launched = fnCtx.services.shell.launchBackground({
          ...input,
          conversationKey: input.conversationKey,
        });
        return [
          "Background exec launched.",
          `Job id: ${launched.job.id}`,
          `Command: ${launched.job.command}`,
          `cwd: ${launched.job.cwd}`,
          launched.job.effectiveUser ? `effectiveUser: ${launched.job.effectiveUser}` : "",
          launched.job.pid ? `pid: ${launched.job.pid}` : "",
          `Started: ${launched.job.startedAt}`,
          `timeoutMs: ${launched.job.timeoutMs ?? "none"}`,
          `sudo: ${launched.job.sudo ? "yes" : "no"}`,
          "Use exec_status with the job id for status and the current tail.",
          "Use exec_output with the job id to read more output.",
        ]
          .filter(Boolean)
          .join("\n");
      }

      const result = await fnCtx.services.shell.exec(input);
      return renderShellExecResult(result);
    },
    format: formatResult,
    auth: SHELL_AUTH,
    domains: SHELL_DOMAINS,
    agentScopes: SHELL_SCOPES,
    defaultVisibleScopes: ["chat", "coding-worker", "direct"],
    examples: ["run bun test", "execute a shell command"],
    supportsBackground: true,
    mutatesState: true,
    readsWorkspace: true,
    untrustedOutput: {
      sourceType: "shell",
      sourceName: "shell stdout/stderr",
      notes: "Command output can echo attacker-controlled content.",
    },
  }),

  // -------------------------------------------------------------------------
  // exec_status
  // -------------------------------------------------------------------------
  defineFunction({
    name: "exec_status",
    description:
      "List recent background exec jobs or inspect one job, including the current output tail.",
    input: execStatusSchema,
    handler: async (input, fnCtx) => {
      if (!input.id) {
        const jobs = fnCtx.services.shell.listBackgroundJobs(input.limit ?? 10);
        if (jobs.length === 0) {
          return "No background exec jobs have been launched yet.";
        }
        return jobs.map((job) => [
          `Job id: ${job.id}`,
          `Status: ${job.status}`,
          `Command: ${job.command}`,
          `cwd: ${job.cwd}`,
          job.effectiveUser ? `effectiveUser: ${job.effectiveUser}` : "",
          job.pid ? `pid: ${job.pid}` : "",
          `Started: ${job.startedAt}`,
          job.completedAt ? `Completed: ${job.completedAt}` : "",
          job.exitCode !== undefined ? `exitCode: ${job.exitCode}` : "",
          `Output lines: ${job.outputLineCount}`,
        ]
          .filter(Boolean)
          .join("\n")).join("\n\n");
      }

      const output = fnCtx.services.shell.readBackgroundOutput({
        id: input.id,
        tailLines: input.tailLines ?? 20,
      });
      const job = output.job;
      return [
        `Job id: ${job.id}`,
        `Status: ${job.status}`,
        `Command: ${job.command}`,
        `cwd: ${job.cwd}`,
        job.effectiveUser ? `effectiveUser: ${job.effectiveUser}` : "",
        job.pid ? `pid: ${job.pid}` : "",
        `Started: ${job.startedAt}`,
        job.completedAt ? `Completed: ${job.completedAt}` : "",
        job.exitCode !== undefined ? `exitCode: ${job.exitCode}` : "",
        job.signal ? `signal: ${job.signal}` : "",
        `Output lines: ${output.totalLines}`,
        output.lines.length > 0
          ? `Tail lines ${output.startLine}-${output.endLine}:\n${output.lines.join("\n")}`
          : "Tail lines: (no output yet)",
      ]
        .filter(Boolean)
        .join("\n");
    },
    format: formatResult,
    auth: { access: "anyone" as const, behavior: "role-sensitive" as const, note: "Background shell job visibility follows the active profile's shell access." },
    domains: SHELL_DOMAINS,
    agentScopes: SHELL_SCOPES,
    defaultVisibleScopes: ["chat", "coding-worker", "direct"],
    examples: ["check command status", "list background jobs"],
    readsWorkspace: true,
    untrustedOutput: {
      sourceType: "shell",
      sourceName: "background shell status and tail output",
      notes: "Background job output can echo attacker-controlled content.",
    },
  }),

  // -------------------------------------------------------------------------
  // exec_output
  // -------------------------------------------------------------------------
  defineFunction({
    name: "exec_output",
    description:
      "Read more output from a background exec job by tail or by 1-based line offset.",
    input: execOutputSchema,
    handler: async (input, fnCtx) => {
      const output = fnCtx.services.shell.readBackgroundOutput(input);
      return [
        `Job id: ${output.job.id}`,
        `Status: ${output.job.status}`,
        `Command: ${output.job.command}`,
        output.lines.length > 0
          ? `Output lines ${output.startLine}-${output.endLine} of ${output.totalLines}:\n${output.lines.join("\n")}`
          : `Output lines: (no output; total ${output.totalLines})`,
      ].join("\n");
    },
    format: formatResult,
    auth: { access: "anyone" as const, behavior: "role-sensitive" as const, note: "Background shell output visibility follows the active profile's shell access." },
    domains: SHELL_DOMAINS,
    agentScopes: SHELL_SCOPES,
    defaultVisibleScopes: ["chat", "coding-worker", "direct"],
    examples: ["show command output", "tail process logs"],
    untrustedOutput: {
      sourceType: "shell",
      sourceName: "background shell output",
      notes: "Background job output can echo attacker-controlled content.",
    },
  }),
];
