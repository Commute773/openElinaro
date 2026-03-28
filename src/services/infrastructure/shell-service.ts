import fs from "node:fs";
import path from "node:path";
import { AccessControlService } from "../access-control-service";
import { LocalShellBackend } from "../shell-backend-local";
import type { ShellBackend } from "../shell-backend";
import { resolveRuntimePath } from "../runtime-root";
import { telemetry } from "./telemetry";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { timestamp } from "../../utils/timestamp";
import {
  SHELL_DEFAULT_TIMEOUT_MS as DEFAULT_TIMEOUT_MS,
  SHELL_COMMAND_PREVIEW_LIMIT as COMMAND_PREVIEW_LIMIT,
  SHELL_DEFAULT_NOTIFICATION_TAIL_LINES as DEFAULT_NOTIFICATION_TAIL_LINES,
} from "../../config/service-constants";

const SHELL_TASK_ROOT = resolveRuntimePath("shell-tasks");
const shellTelemetry = telemetry.child({ component: "shell" });

function truncateForLog(text: string, limit = COMMAND_PREVIEW_LIMIT) {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
}

function ensureTaskRoot() {
  fs.mkdirSync(SHELL_TASK_ROOT, { recursive: true });
}

function splitOutputLines(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function formatRuntimeMs(startedAt: string, completedAt?: string) {
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  const start = Date.parse(startedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "unknown";
  }
  const durationMs = Math.max(0, end - start);
  if (durationMs >= 1_000) {
    return `${(durationMs / 1_000).toFixed(2)}s`;
  }
  return `${durationMs}ms`;
}

function nextJobId() {
  return `shell-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const traceSpan = createTraceSpan(shellTelemetry);

export interface ShellExecParams {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  sudo?: boolean;
  background?: boolean;
}

export interface ShellExecResult {
  command: string;
  cwd: string;
  timeoutMs: number;
  sudo: boolean;
  effectiveUser: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ShellBackgroundJobStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "killed";

export interface ShellBackgroundJob {
  id: string;
  command: string;
  cwd: string;
  timeoutMs?: number;
  sudo: boolean;
  status: ShellBackgroundJobStatus;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
  pid?: number;
  combinedOutputPath: string;
  stdoutPath: string;
  stderrPath: string;
  outputLineCount: number;
  outputByteCount: number;
  conversationKey?: string;
  effectiveUser?: string;
}

export interface ShellBackgroundLaunchResult {
  job: ShellBackgroundJob;
}

export interface ShellBackgroundOutputResult {
  job: ShellBackgroundJob;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: string[];
}

type ShellBackgroundRuntime = {
  partialLine: string;
  recentLines: string[];
  timeoutHandle?: ReturnType<typeof setTimeout>;
  timedOut: boolean;
  stdoutStream: fs.WriteStream;
  stderrStream: fs.WriteStream;
  combinedStream: fs.WriteStream;
  finalized: boolean;
};

export class ShellService {
  private readonly backgroundJobs = new Map<string, ShellBackgroundJob>();
  private readonly backgroundRuntime = new Map<string, ShellBackgroundRuntime>();
  private readonly pendingNotifications = new Map<string, string[]>();
  private readonly backend: ShellBackend;
  private readonly access?: AccessControlService;

  constructor(backend?: ShellBackend, access?: AccessControlService) {
    this.backend = backend ?? new LocalShellBackend();
    this.access = access;
  }

  private assertShellAllowed(cwd: string) {
    this.access?.assertToolAllowed("exec_command");
    this.access?.assertPathAccess(cwd);
  }

  private assertVerificationShellAllowed(cwd: string) {
    this.access?.assertPathAccess(cwd);
  }

  private async executeCommand(
    params: ShellExecParams,
    cwd: string,
    operation: "tool.exec_command" | "workflow.exec_verification",
  ): Promise<ShellExecResult> {
    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const command = params.command;
    const displayCommand = this.backend.resolveDisplayCommand(command, params.sudo === true);

    return traceSpan(
      operation,
      async () => {
        const result = await this.backend.execCommand(command, {
          cwd,
          sudo: params.sudo === true,
          timeoutMs,
        });
        return {
          command: displayCommand,
          cwd,
          timeoutMs,
          sudo: params.sudo === true,
          effectiveUser: result.effectiveUser,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      },
      {
        attributes: {
          cwd,
          sudo: params.sudo === true,
          effectiveUser: this.backend.resolveEffectiveUserLabel(),
          timeoutMs,
          commandPreview: truncateForLog(displayCommand),
        },
      },
    );
  }

  async exec(params: ShellExecParams): Promise<ShellExecResult> {
    const cwd = this.backend.resolveCwd(params.cwd);
    this.assertShellAllowed(cwd);
    return this.executeCommand(params, cwd, "tool.exec_command");
  }

  async execVerification(params: ShellExecParams): Promise<ShellExecResult> {
    const cwd = this.backend.resolveCwd(params.cwd);
    this.assertVerificationShellAllowed(cwd);
    return this.executeCommand(params, cwd, "workflow.exec_verification");
  }

  launchBackground(
    params: ShellExecParams & { conversationKey?: string },
  ): ShellBackgroundLaunchResult {
    ensureTaskRoot();
    const cwd = this.backend.resolveCwd(params.cwd);
    this.assertShellAllowed(cwd);
    const command = params.command;
    const displayCommand = this.backend.resolveDisplayCommand(command, params.sudo === true);
    const id = nextJobId();
    const taskDir = path.join(SHELL_TASK_ROOT, id);
    fs.mkdirSync(taskDir, { recursive: true });

    const stdoutPath = path.join(taskDir, "stdout.log");
    const stderrPath = path.join(taskDir, "stderr.log");
    const combinedOutputPath = path.join(taskDir, "combined.log");
    const stdoutStream = fs.createWriteStream(stdoutPath, { flags: "a" });
    const stderrStream = fs.createWriteStream(stderrPath, { flags: "a" });
    const combinedStream = fs.createWriteStream(combinedOutputPath, { flags: "a" });
    const startedAt = timestamp();

    const { child, effectiveUser } = this.backend.spawnCommand(command, {
      cwd,
      sudo: params.sudo === true,
    });

    const job: ShellBackgroundJob = {
      id,
      command,
      cwd,
      timeoutMs: params.timeoutMs,
      sudo: params.sudo === true,
      status: "running",
      startedAt,
      pid: child.pid,
      combinedOutputPath,
      stdoutPath,
      stderrPath,
      outputLineCount: 0,
      outputByteCount: 0,
      conversationKey: params.conversationKey,
      effectiveUser,
    };
    this.backgroundJobs.set(id, job);
    this.backgroundRuntime.set(id, {
      partialLine: "",
      recentLines: [],
      timedOut: false,
      stdoutStream,
      stderrStream,
      combinedStream,
      finalized: false,
    });

    const updateOutputMetrics = (chunk: string) => {
      const current = this.backgroundJobs.get(id);
      const runtime = this.backgroundRuntime.get(id);
      if (!current || !runtime) {
        return;
      }

      const normalized = chunk.replace(/\r\n/g, "\n");
      const fragments = `${runtime.partialLine}${normalized}`.split("\n");
      runtime.partialLine = fragments.pop() ?? "";
      const completeLines = fragments.length;
      if (completeLines > 0) {
        runtime.recentLines.push(...fragments);
        if (runtime.recentLines.length > DEFAULT_NOTIFICATION_TAIL_LINES * 10) {
          runtime.recentLines.splice(
            0,
            runtime.recentLines.length - DEFAULT_NOTIFICATION_TAIL_LINES * 10,
          );
        }
      }

      this.backgroundJobs.set(id, {
        ...current,
        outputByteCount: current.outputByteCount + Buffer.byteLength(chunk),
        outputLineCount: current.outputLineCount + completeLines,
      });
    };

    const finalize = (params: {
      status: ShellBackgroundJobStatus;
      exitCode?: number;
      signal?: NodeJS.Signals;
      error?: string;
    }) => {
      const current = this.backgroundJobs.get(id);
      const runtime = this.backgroundRuntime.get(id);
      if (!current || !runtime || runtime.finalized) {
        return;
      }
      runtime.finalized = true;
      if (runtime.timeoutHandle) {
        clearTimeout(runtime.timeoutHandle);
      }
      if (runtime.partialLine) {
        runtime.recentLines.push(runtime.partialLine);
      }
      const completedAt = timestamp();
      const finalJob: ShellBackgroundJob = {
        ...current,
        status: params.status,
        exitCode: params.exitCode,
        signal: params.signal,
        completedAt,
        outputLineCount: current.outputLineCount + (runtime.partialLine ? 1 : 0),
      };
      runtime.partialLine = "";
      stdoutStream.end();
      stderrStream.end();
      combinedStream.end();
      this.backgroundJobs.set(id, finalJob);
      this.backgroundRuntime.delete(id);

      if (params.error) {
        shellTelemetry.event(
          "shell.background.error",
          {
            jobId: id,
            commandPreview: truncateForLog(current.command),
            error: params.error,
          },
          { level: "warn", outcome: "error" },
        );
      }

      this.queueCompletionNotification(finalJob, runtime.recentLines.slice(-DEFAULT_NOTIFICATION_TAIL_LINES));
      shellTelemetry.event(
        "shell.background.completed",
        {
          jobId: id,
          commandPreview: truncateForLog(current.command),
          status: finalJob.status,
          exitCode: finalJob.exitCode,
          signal: finalJob.signal,
          runtime: formatRuntimeMs(finalJob.startedAt, finalJob.completedAt),
        },
        { outcome: finalJob.status === "completed" ? "ok" : "error" },
      );
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdoutStream.write(text);
      combinedStream.write(text);
      updateOutputMetrics(text);
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderrStream.write(text);
      combinedStream.write(text);
      updateOutputMetrics(text);
    });

    child.on("error", (error) => {
      finalize({
        status: "failed",
        exitCode: 1,
        error: error.message,
      });
    });

    child.on("close", (exitCode, signal) => {
      const runtime = this.backgroundRuntime.get(id);
      const status =
        runtime?.timedOut
          ? "timed_out"
          : signal
            ? "killed"
            : (exitCode ?? 1) === 0
              ? "completed"
              : "failed";
      finalize({
        status,
        exitCode: exitCode ?? undefined,
        signal: signal ?? undefined,
      });
    });

    if (params.timeoutMs) {
      const runtime = this.backgroundRuntime.get(id);
      if (runtime) {
        runtime.timeoutHandle = setTimeout(() => {
          runtime.timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!runtime.finalized) {
              child.kill("SIGKILL");
            }
          }, 5_000);
        }, params.timeoutMs);
      }
    }

    shellTelemetry.event("shell.background.started", {
      jobId: id,
      commandPreview: truncateForLog(displayCommand),
      cwd,
      timeoutMs: params.timeoutMs,
      pid: child.pid,
      conversationKey: params.conversationKey,
      effectiveUser,
    });

    return {
      job,
    };
  }

  listBackgroundJobs(limit = 10) {
    this.access?.assertToolAllowed("exec_status");
    return Array.from(this.backgroundJobs.values())
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, limit);
  }

  getBackgroundJob(id: string) {
    this.access?.assertToolAllowed("exec_status");
    return this.backgroundJobs.get(id);
  }

  readBackgroundOutput(params: {
    id: string;
    tailLines?: number;
    offset?: number;
    limit?: number;
  }): ShellBackgroundOutputResult {
    this.access?.assertToolAllowed("exec_output");
    const job = this.backgroundJobs.get(params.id);
    if (!job) {
      throw new Error(`No background shell job found for ${params.id}.`);
    }

    const text = fs.existsSync(job.combinedOutputPath)
      ? fs.readFileSync(job.combinedOutputPath, "utf8")
      : "";
    const lines = splitOutputLines(text);
    const totalLines = lines.length;

    if (params.tailLines) {
      const selected = lines.slice(-params.tailLines);
      const startLine = selected.length === 0 ? 0 : totalLines - selected.length + 1;
      return {
        job,
        startLine,
        endLine: selected.length === 0 ? 0 : totalLines,
        totalLines,
        lines: selected,
      };
    }

    const startLine = Math.max(1, params.offset ?? 1);
    const limit = Math.max(1, params.limit ?? 100);
    const selected = lines.slice(startLine - 1, startLine - 1 + limit);
    return {
      job,
      startLine: selected.length === 0 ? 0 : startLine,
      endLine: selected.length === 0 ? 0 : startLine + selected.length - 1,
      totalLines,
      lines: selected,
    };
  }

  consumeConversationNotifications(conversationKey: string) {
    const notifications = this.pendingNotifications.get(conversationKey) ?? [];
    this.pendingNotifications.delete(conversationKey);
    return notifications;
  }

  private queueCompletionNotification(job: ShellBackgroundJob, tailLines: string[]) {
    if (!job.conversationKey) {
      return;
    }

    const lines = [
      "Background exec completed.",
      `Job id: ${job.id}`,
      `Command: ${job.command}`,
      `Status: ${job.status}`,
      `cwd: ${job.cwd}`,
      job.effectiveUser ? `effectiveUser: ${job.effectiveUser}` : "",
      `Started: ${job.startedAt}`,
      job.completedAt ? `Completed: ${job.completedAt}` : "",
      `Runtime: ${formatRuntimeMs(job.startedAt, job.completedAt)}`,
      job.pid ? `pid: ${job.pid}` : "",
      job.exitCode !== undefined ? `exitCode: ${job.exitCode}` : "",
      job.signal ? `signal: ${job.signal}` : "",
      `Output lines: ${job.outputLineCount}`,
      tailLines.length > 0 ? `Tail ${Math.min(DEFAULT_NOTIFICATION_TAIL_LINES, tailLines.length)}:` : "",
      ...tailLines,
    ].filter(Boolean);

    const pending = this.pendingNotifications.get(job.conversationKey) ?? [];
    pending.push(lines.join("\n"));
    this.pendingNotifications.set(job.conversationKey, pending);
  }
}
