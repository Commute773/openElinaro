import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ProfileRecord } from "../domain/profiles";
import type { AccessControlService } from "./profiles";
import { ProfileService } from "./profiles";
import { buildOpenElinaroCommandEnvironment } from "./shell-environment";
import {
  resolveDisplayCommand,
  buildExecErrorResult,
  type ShellBackend,
  type ExecCommandResult,
  type SpawnCommandResult,
} from "./shell-backend";

const execFileAsync = promisify(execFile);

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function resolveRemoteCwd(profileService: ProfileService, profile: ProfileRecord, cwd?: string) {
  const fallback = profileService.getDefaultToolCwd(profile);
  const requested = cwd?.trim() || fallback;
  if (!requested) {
    throw new Error(`No default remote cwd is configured for profile ${profile.id}.`);
  }
  return path.posix.isAbsolute(requested)
    ? path.posix.normalize(requested)
    : path.posix.resolve(fallback ?? "/", requested);
}

export class SshShellBackend implements ShellBackend {
  private readonly profiles: ProfileService;
  private readonly sshIdentityPath: string;
  private readonly sshHost: string;
  private readonly sshUser: string;
  private readonly sshPort?: number;

  constructor(
    private readonly profile: ProfileRecord,
    private readonly access?: AccessControlService,
    private readonly environment?: Record<string, string>,
  ) {
    this.profiles = new ProfileService(profile.id);
    const execution = this.profiles.getExecution(profile);
    if (execution?.kind !== "ssh") {
      throw new Error(`Profile ${profile.id} is not configured for SSH execution.`);
    }
    this.sshIdentityPath = this.profiles.ensureProfileSshKeyPair(profile).privateKeyPath;
    this.sshHost = execution.host;
    this.sshUser = execution.user;
    this.sshPort = execution.port;
  }

  private buildCommandEnvironment() {
    return buildOpenElinaroCommandEnvironment(this.environment, {
      shellUser: this.environment?.OPENELINARO_PROFILE_SHELL_USER,
    });
  }

  private buildSshArgs(remoteCommand: string) {
    return [
      "-i",
      this.sshIdentityPath,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      ...(this.sshPort ? ["-p", String(this.sshPort)] : []),
      `${this.sshUser}@${this.sshHost}`,
      remoteCommand,
    ];
  }

  private buildRemoteCommand(command: string, cwd: string, sudo: boolean) {
    // Single-profile install: sudo is always available.
    const remoteShellCommand = sudo ? `sudo -n ${command}` : command;
    return [
      `cd ${shellQuote(cwd)}`,
      `if command -v bash >/dev/null 2>&1; then exec bash -lc ${shellQuote(remoteShellCommand)}; else exec sh -lc ${shellQuote(remoteShellCommand)}; fi`,
    ].join(" && ");
  }

  resolveCwd(cwd?: string) {
    return resolveRemoteCwd(this.profiles, this.profile, cwd);
  }

  resolveDisplayCommand(command: string, sudo: boolean) {
    return resolveDisplayCommand(command, sudo);
  }

  resolveEffectiveUserLabel() {
    return `${this.sshUser}@${this.sshHost}`;
  }

  async execCommand(command: string, opts: {
    cwd: string;
    sudo: boolean;
    timeoutMs: number;
  }): Promise<ExecCommandResult> {
    const remoteCommand = this.buildRemoteCommand(command, opts.cwd, opts.sudo);
    const effectiveUser = this.resolveEffectiveUserLabel();
    try {
      const { stdout, stderr } = await execFileAsync("ssh", this.buildSshArgs(remoteCommand), {
        timeout: opts.timeoutMs,
        maxBuffer: 1024 * 1024 * 4,
        env: this.buildCommandEnvironment(),
      });
      return {
        exitCode: 0,
        stdout,
        stderr,
        effectiveUser,
      };
    } catch (error) {
      return buildExecErrorResult(error, effectiveUser);
    }
  }

  spawnCommand(command: string, opts: {
    cwd: string;
    sudo: boolean;
  }): SpawnCommandResult {
    const remoteCommand = this.buildRemoteCommand(command, opts.cwd, opts.sudo);
    const child = spawn("ssh", this.buildSshArgs(remoteCommand), {
      stdio: ["ignore", "pipe", "pipe"],
      env: this.buildCommandEnvironment(),
    });
    return {
      child,
      effectiveUser: this.resolveEffectiveUserLabel(),
    };
  }
}
