import { type StructuredToolInterface } from "@langchain/core/tools";
import { defineTool } from "../define-tool";
import { z } from "zod";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { telemetry } from "../../services/infrastructure/telemetry";
import type { ToolBuildContext, ShellRuntime } from "./tool-group-types";

const toolTelemetry = telemetry.child({ component: "tool" });
const traceSpan = createTraceSpan(toolTelemetry);

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

export function renderShellExecResult(result: Awaited<ReturnType<ShellRuntime["exec"]>>) {
  return [
    `$ ${result.command}`,
    `cwd: ${result.cwd}`,
    `effectiveUser: ${result.effectiveUser}`,
    `timeoutMs: ${result.timeoutMs}`,
    `sudo: ${result.sudo ? "yes" : "no"}`,
    `exitCode: ${result.exitCode}`,
    result.stdout ? `stdout:\n${result.stdout}` : "stdout:\n",
    result.stderr ? `stderr:\n${result.stderr}` : "stderr:\n",
  ].join("\n");
}

export function buildShellTools(ctx: ToolBuildContext): StructuredToolInterface[] {
  return [
    defineTool(
      async (input) => {
        if (input.background) {
          const launched = ctx.shell.launchBackground({
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

        const result = await ctx.shell.exec(input);
        return renderShellExecResult(result);
      },
      {
        name: "exec_command",
        description:
          "Execute a shell command in the configured shell, using bash by default. Non-root profiles run either as their configured local shell user or through their configured SSH execution backend. Set background=true to launch it asynchronously and get a job id you can inspect later. Passwordless sudo is only available to the root profile when sudo=true.",
        schema: execCommandSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.exec_status",
          async () => {
            if (!input.id) {
              const jobs = ctx.shell.listBackgroundJobs(input.limit ?? 10);
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

            const output = ctx.shell.readBackgroundOutput({
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
          { attributes: input },
        ),
      {
        name: "exec_status",
        description:
          "List recent background exec jobs or inspect one job, including the current output tail.",
        schema: execStatusSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.exec_output",
          async () => {
            const output = ctx.shell.readBackgroundOutput(input);
            return [
              `Job id: ${output.job.id}`,
              `Status: ${output.job.status}`,
              `Command: ${output.job.command}`,
              output.lines.length > 0
                ? `Output lines ${output.startLine}-${output.endLine} of ${output.totalLines}:\n${output.lines.join("\n")}`
                : `Output lines: (no output; total ${output.totalLines})`,
            ].join("\n");
          },
          { attributes: input },
        ),
      {
        name: "exec_output",
        description:
          "Read more output from a background exec job by tail or by 1-based line offset.",
        schema: execOutputSchema,
      },
    ),
  ];
}
