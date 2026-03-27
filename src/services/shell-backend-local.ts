import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { buildOpenElinaroCommandEnvironment } from "./shell-environment";
import {
  resolveDisplayCommand,
  buildExecErrorResult,
  type ShellBackend,
  type ExecCommandResult,
  type SpawnCommandResult,
} from "./shell-backend";

const execFileAsync = promisify(execFile);
const DEFAULT_CWD = process.cwd();
const DEFAULT_SHELL_BIN = "bash";
const SHELL_USER_ENV_BLOCKLIST = new Set([
  "HOME",
  "LOGNAME",
  "MAIL",
  "OLDPWD",
  "PWD",
  "SHELL",
  "USER",
]);

function resolveCwd(cwd?: string) {
  if (!cwd) {
    return DEFAULT_CWD;
  }
  return path.isAbsolute(cwd) ? cwd : path.resolve(DEFAULT_CWD, cwd);
}

export class LocalShellBackend implements ShellBackend {
  constructor(private readonly environment?: Record<string, string>) {}

  private buildCommandEnvironment() {
    return buildOpenElinaroCommandEnvironment(this.environment);
  }

  private getConfiguredShellUser() {
    const value = this.environment?.OPENELINARO_PROFILE_SHELL_USER?.trim();
    return value || undefined;
  }

  private resolveEffectiveUser() {
    return this.getConfiguredShellUser() ?? process.env.USER ?? "unknown";
  }

  private getShellBinary() {
    return this.environment?.OPENELINARO_SHELL_BIN?.trim() || DEFAULT_SHELL_BIN;
  }

  private buildEnvArgs(options?: { stripIdentity?: boolean }) {
    return Object.entries(this.buildCommandEnvironment())
      .filter((entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        !(options?.stripIdentity && SHELL_USER_ENV_BLOCKLIST.has(entry[0]))
      )
      .map(([key, value]) => `${key}=${value}`);
  }

  private buildCommandInvocation(command: string, sudo: boolean) {
    const shellUser = this.getConfiguredShellUser();
    const shellBin = this.getShellBinary();
    if (sudo && shellUser) {
      throw new Error("sudo=true is only available when running as the root profile.");
    }

    if (shellUser) {
      return {
        file: "sudo",
        args: [
          "-n",
          "-H",
          "-u",
          shellUser,
          "env",
          ...this.buildEnvArgs({ stripIdentity: true }),
          `USER=${shellUser}`,
          `LOGNAME=${shellUser}`,
          shellBin,
          "-lc",
          command,
        ],
        effectiveUser: shellUser,
      };
    }

    return {
      file: shellBin,
      args: ["-lc", sudo ? `sudo -n ${command}` : command],
      effectiveUser: this.resolveEffectiveUser(),
    };
  }

  resolveCwd(cwd?: string) {
    return resolveCwd(cwd);
  }

  resolveDisplayCommand(command: string, sudo: boolean) {
    return resolveDisplayCommand(command, sudo);
  }

  resolveEffectiveUserLabel() {
    return this.resolveEffectiveUser();
  }

  async execCommand(command: string, opts: {
    cwd: string;
    sudo: boolean;
    timeoutMs: number;
  }): Promise<ExecCommandResult> {
    const invocation = this.buildCommandInvocation(command, opts.sudo);
    try {
      const { stdout, stderr } = await execFileAsync(invocation.file, invocation.args, {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: 1024 * 1024 * 4,
        env: this.buildCommandEnvironment(),
      });
      return {
        exitCode: 0,
        stdout,
        stderr,
        effectiveUser: invocation.effectiveUser,
      };
    } catch (error) {
      return buildExecErrorResult(error, invocation.effectiveUser);
    }
  }

  spawnCommand(command: string, opts: {
    cwd: string;
    sudo: boolean;
  }): SpawnCommandResult {
    const invocation = this.buildCommandInvocation(command, opts.sudo);
    const child = spawn(invocation.file, invocation.args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: this.buildCommandEnvironment(),
    });
    return {
      child,
      effectiveUser: invocation.effectiveUser,
    };
  }
}
