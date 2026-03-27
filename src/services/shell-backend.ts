import type { ChildProcess } from "node:child_process";

export interface ExecCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  effectiveUser: string;
}

export interface SpawnCommandResult {
  child: ChildProcess;
  effectiveUser: string;
}

export interface ShellBackend {
  resolveCwd(cwd?: string): string;
  resolveDisplayCommand(command: string, sudo: boolean): string;
  resolveEffectiveUserLabel(): string;
  execCommand(command: string, opts: {
    cwd: string;
    sudo: boolean;
    timeoutMs: number;
  }): Promise<ExecCommandResult>;
  spawnCommand(command: string, opts: {
    cwd: string;
    sudo: boolean;
  }): SpawnCommandResult;
}

export function resolveDisplayCommand(command: string, sudo: boolean) {
  return sudo ? `sudo -n ${command}` : command;
}

export function buildExecErrorResult(
  error: unknown,
  effectiveUser: string,
): ExecCommandResult {
  const execError = error as NodeJS.ErrnoException & {
    code?: string | number;
    stdout?: string;
    stderr?: string;
    killed?: boolean;
    signal?: NodeJS.Signals;
  };
  return {
    exitCode:
      typeof execError.code === "number"
        ? execError.code
        : execError.killed
          ? 124
          : 1,
    stdout: execError.stdout ?? "",
    stderr:
      execError.stderr ??
      execError.message ??
      `Command failed${execError.signal ? ` with signal ${execError.signal}` : ""}.`,
    effectiveUser,
  };
}
