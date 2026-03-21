import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { getRuntimeConfig } from "../config/runtime-config";
import { ProfileService } from "./profile-service";
import {
  assertSharedPythonRuntimeReady,
  getOpenBrowserPythonModules,
  getSharedPythonBinPath,
  getPythonRuntimeSetupCommand,
  resolvePythonScriptPath,
} from "./python-runtime";
import { SecretStoreService } from "./secret-store-service";
import { resolveRuntimePath } from "./runtime-root";
import { telemetry as rootTelemetry, type TelemetryService } from "./telemetry";

export type OpenBrowserMouseButton = "left" | "middle" | "right";
export type OpenBrowserScreenshotFormat = "png" | "jpeg" | "webp";

export type OpenBrowserAction =
  | {
      type: "navigate";
      url: string;
      waitMs?: number;
    }
  | {
      type: "wait";
      ms: number;
    }
  | {
      type: "mouse_move";
      x: number;
      y: number;
      steps?: number;
    }
  | {
      type: "mouse_click";
      x: number;
      y: number;
      button?: OpenBrowserMouseButton;
      clickCount?: number;
    }
  | {
      type: "press";
      key: string;
    }
  | {
      type: "type";
      text: string | { secretRef: string };
      submit?: boolean;
      delayMs?: number;
    }
  | {
      type: "evaluate";
      expression: string;
      args?: unknown[];
      captureResult?: boolean;
    }
  | {
      type: "screenshot";
      path?: string;
      format?: OpenBrowserScreenshotFormat;
      quality?: number;
    };

export type OpenBrowserRunInput = {
  startUrl?: string;
  headless?: boolean;
  timeoutMs?: number;
  cwd?: string;
  artifactDir?: string;
  userDataDir?: string;
  sessionKey?: string;
  resetSession?: boolean;
  viewport?: {
    width: number;
    height: number;
  };
  actions: OpenBrowserAction[];
};

export type OpenBrowserStepResult = {
  index: number;
  type: OpenBrowserAction["type"];
  status: "ok";
  detail?: string;
  value?: unknown;
  path?: string;
};

export type OpenBrowserRunErrorDetails = {
  message: string;
  category?: "action_error" | "runner_error" | "transport_error" | "parse_error";
  actionIndex?: number;
  actionType?: OpenBrowserAction["type"] | string;
  artifactDir?: string;
  pageTitle?: string;
  pageUrl?: string;
  screenshotPath?: string;
  screenshotFormat?: OpenBrowserScreenshotFormat;
  stdout?: string;
  stderr?: string;
  exception?: string;
  exitCode?: number;
  signal?: string;
};

export type OpenBrowserRunResult = {
  ok: true;
  sessionId: string;
  sessionKey?: string;
  reusedSession?: boolean;
  title: string;
  finalUrl: string;
  artifactDir: string;
  screenshots: Array<{
    path: string;
    format: OpenBrowserScreenshotFormat;
  }>;
  stepResults: OpenBrowserStepResult[];
};

type OpenBrowserRunnerPayload = OpenBrowserRunInput & {
  artifactDir: string;
  userDataDir: string;
};

type OpenBrowserRunnerCommand = {
  commandId: string;
  payload: OpenBrowserRunnerPayload;
  resetSession?: boolean;
};

type OpenBrowserRunnerResponse =
  | {
      commandId: string;
      ok: true;
      result: OpenBrowserRunResult;
    }
  | {
      commandId: string;
      ok: false;
      error: OpenBrowserRunErrorDetails;
    };

type OpenBrowserSecretReference = {
  secretRef: string;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_SESSION_IDLE_MS = 15 * 60_000;
const SESSION_CLOSE_GRACE_MS = 1_500;
const MAX_SESSION_STDERR_CHARS = 8_000;

type PendingOpenBrowserCommand = {
  reject: (error: Error) => void;
  resolve: (result: OpenBrowserRunResult) => void;
  timeoutHandle?: ReturnType<typeof setTimeout>;
};

type OpenBrowserSessionRuntime = {
  child: ChildProcessWithoutNullStreams;
  idleHandle?: ReturnType<typeof setTimeout>;
  key: string;
  pending: Map<string, PendingOpenBrowserCommand>;
  rl: readline.Interface;
  stderr: string;
  stdoutNoise: string;
};

export class OpenBrowserError extends Error {
  readonly details: OpenBrowserRunErrorDetails;

  constructor(details: OpenBrowserRunErrorDetails) {
    super(details.message);
    this.name = "OpenBrowserError";
    this.details = details;
  }
}

function resolveConfiguredRunnerScript(configuredPath: string | undefined) {
  return resolvePythonScriptPath(configuredPath, "scripts/openbrowser_runner.py");
}

function parseSessionIdleMs() {
  const parsed = getRuntimeConfig().openbrowser.sessionIdleMs;
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    return DEFAULT_SESSION_IDLE_MS;
  }
  return parsed;
}

export class OpenBrowserService {
  private readonly pythonBin: string;
  private readonly usesSharedPythonRuntime: boolean;
  private readonly runnerScript: string;
  private readonly sessionIdleMs: number;
  private readonly sessionRuntimes = new Map<string, OpenBrowserSessionRuntime>();
  private readonly telemetry: TelemetryService;
  private readonly profiles: ProfileService;
  private readonly secrets: SecretStoreService;

  constructor(options?: {
    pythonBin?: string;
    runnerScript?: string;
    sessionIdleMs?: number;
    telemetry?: TelemetryService;
    profiles?: ProfileService;
    secrets?: SecretStoreService;
  }) {
    const configured = getRuntimeConfig().openbrowser;
    this.pythonBin = options?.pythonBin ?? getSharedPythonBinPath();
    this.usesSharedPythonRuntime = options?.pythonBin === undefined;
    this.runnerScript = options?.runnerScript
      ? path.resolve(options.runnerScript)
      : resolveConfiguredRunnerScript(configured.runnerScript);
    this.sessionIdleMs = options?.sessionIdleMs ?? parseSessionIdleMs();
    this.telemetry = options?.telemetry ?? rootTelemetry.child({ component: "openbrowser" });
    this.profiles = options?.profiles ?? new ProfileService();
    this.secrets = options?.secrets ?? new SecretStoreService();
  }

  private resolvePythonBin() {
    return this.usesSharedPythonRuntime ? assertSharedPythonRuntimeReady(getOpenBrowserPythonModules()) : this.pythonBin;
  }

  async run(input: OpenBrowserRunInput): Promise<OpenBrowserRunResult> {
    const cwd = input.cwd ? path.resolve(input.cwd) : process.cwd();
    const artifactDir = this.resolveArtifactDir(cwd, input.artifactDir);
    const userDataDir = this.resolveUserDataDir(cwd, input.userDataDir);
    const profileId = this.getActiveProfileId();
    const payload: OpenBrowserRunnerPayload = {
      ...input,
      actions: input.actions.map((action) => this.resolveActionSecrets(action, profileId)),
      cwd,
      artifactDir,
      userDataDir,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };

    if (!fs.existsSync(this.runnerScript)) {
      throw new Error(`OpenBrowser runner script not found: ${this.runnerScript}`);
    }

    fs.mkdirSync(artifactDir, { recursive: true });
    fs.mkdirSync(userDataDir, { recursive: true });

    const timeoutMs = payload.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const sessionKey = input.sessionKey?.trim();

    if (sessionKey) {
      const result = await this.runPersistentSession(sessionKey, payload, {
        resetSession: input.resetSession === true,
        timeoutMs,
      });
      return {
        ...result,
        sessionKey,
      };
    }

    return this.runOneShot(payload, cwd, timeoutMs);
  }

  async dispose() {
    await Promise.all(
      Array.from(this.sessionRuntimes.keys(), (sessionKey) => this.closeSession(sessionKey, "service-dispose")),
    );
  }

  private async runOneShot(
    payload: OpenBrowserRunnerPayload,
    cwd: string,
    timeoutMs: number,
  ): Promise<OpenBrowserRunResult> {
    const result = await this.telemetry.instrumentSpawn({
      component: "openbrowser",
      operation: "openbrowser.runner",
      command: this.resolvePythonBin(),
      args: [this.runnerScript],
      timeoutMs,
      input: `${JSON.stringify(payload)}\n`,
      options: {
        cwd,
        env: this.buildRunnerEnvironment(payload.artifactDir),
        stdio: ["pipe", "pipe", "pipe"],
      },
    });

    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();
    if (result.code !== 0) {
      throw new OpenBrowserError({
        category: "runner_error",
        message: [
          `OpenBrowser runner failed with exit code ${result.code}${result.signal ? ` (${result.signal})` : ""}.`,
          stderr ? `stderr:\n${stderr}` : "",
          stdout ? `stdout:\n${stdout}` : "",
          `If the shared browser runtime is not installed yet, run \`${getPythonRuntimeSetupCommand()}\`.`,
        ]
          .filter(Boolean)
          .join("\n\n"),
        artifactDir: payload.artifactDir,
        stdout: stdout || undefined,
        stderr: stderr || undefined,
        exitCode: result.code,
        signal: result.signal ?? undefined,
      });
    }

    return this.parseRunResult(stdout, stderr);
  }

  private resolveArtifactDir(cwd: string, requested: string | undefined) {
    if (requested?.trim()) {
      return path.resolve(cwd, requested.trim());
    }

    return resolveRuntimePath("openbrowser", `${Date.now()}-${randomUUID().slice(0, 8)}`);
  }

  private resolveUserDataDir(cwd: string, requested: string | undefined) {
    if (requested?.trim()) {
      return path.resolve(cwd, requested.trim());
    }

    return resolveRuntimePath("openbrowser", "profiles", this.getActiveProfileId(), "user-data");
  }

  private getActiveProfileId() {
    try {
      return this.profiles.getActiveProfile().id;
    } catch {
      return "root";
    }
  }

  private resolveActionSecrets(action: OpenBrowserAction, profileId: string): OpenBrowserAction {
    return this.resolveValue(action, profileId) as OpenBrowserAction;
  }

  private resolveValue(value: unknown, profileId: string): unknown {
    if (this.isSecretReference(value)) {
      return this.secrets.resolveSecretRef(value.secretRef, profileId);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.resolveValue(entry, profileId));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, this.resolveValue(entry, profileId)]),
      );
    }
    return value;
  }

  private isSecretReference(value: unknown): value is OpenBrowserSecretReference {
    return Boolean(
      value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof (value as { secretRef?: unknown }).secretRef === "string",
    );
  }

  private buildRunnerEnvironment(artifactDir: string) {
    return {
      ...process.env,
      OPENBROWSER_SETUP_LOGGING: "false",
      OPENBROWSER_ARTIFACT_DIR: artifactDir,
      PYTHONUNBUFFERED: "1",
    };
  }

  private parseRunResult(stdout: string, stderr: string) {
    const lastJsonLine = stdout
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);

    try {
      const parsed = JSON.parse(lastJsonLine ?? "") as OpenBrowserRunResult | { ok: false; error: OpenBrowserRunErrorDetails };
      if (parsed && typeof parsed === "object" && "ok" in parsed && parsed.ok === false) {
        throw new OpenBrowserError({
          ...parsed.error,
          stderr: parsed.error.stderr ?? (stderr || undefined),
          stdout: parsed.error.stdout ?? (stdout || undefined),
        });
      }
      return parsed as OpenBrowserRunResult;
    } catch (error) {
      if (error instanceof OpenBrowserError) {
        throw error;
      }
      throw new OpenBrowserError({
        category: "parse_error",
        message: [
          "OpenBrowser runner returned invalid JSON.",
          error instanceof Error ? error.message : String(error),
          stderr ? `stderr:\n${stderr}` : "",
          stdout ? `stdout:\n${stdout}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        stdout: stdout || undefined,
        stderr: stderr || undefined,
      });
    }
  }

  private async runPersistentSession(
    sessionKey: string,
    payload: OpenBrowserRunnerPayload,
    options: {
      resetSession: boolean;
      timeoutMs: number;
    },
  ) {
    const session = this.getOrCreateSession(sessionKey, payload.cwd ?? process.cwd(), payload.artifactDir);
    const commandId = randomUUID();
    const command: OpenBrowserRunnerCommand = {
      commandId,
      payload,
      resetSession: options.resetSession,
    };

    this.resetSessionIdleTimer(session);

    return await new Promise<OpenBrowserRunResult>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        session.pending.delete(commandId);
        void this.closeSession(sessionKey, "command-timeout");
        reject(new Error(`OpenBrowser session ${sessionKey} timed out after ${options.timeoutMs}ms.`));
      }, options.timeoutMs + 1_000);

      session.pending.set(commandId, {
        resolve: (result) => {
          clearTimeout(timeoutHandle);
          this.resetSessionIdleTimer(session);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeoutHandle);
          reject(error);
        },
        timeoutHandle,
      });

      try {
        session.child.stdin.write(`${JSON.stringify(command)}\n`);
      } catch (error) {
        clearTimeout(timeoutHandle);
        session.pending.delete(commandId);
        void this.closeSession(sessionKey, "transport-error");
        reject(
          new Error(
            `OpenBrowser session ${sessionKey} could not send the command: ${error instanceof Error ? error.message : String(error)}.`,
          ),
        );
      }
    });
  }

  private getOrCreateSession(sessionKey: string, cwd: string, artifactDir: string) {
    const existing = this.sessionRuntimes.get(sessionKey);
    if (existing) {
      return existing;
    }

    const child = spawn(this.resolvePythonBin(), [this.runnerScript], {
      cwd,
      env: this.buildRunnerEnvironment(artifactDir),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    const session: OpenBrowserSessionRuntime = {
      child,
      key: sessionKey,
      pending: new Map(),
      rl,
      stderr: "",
      stdoutNoise: "",
    };

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      session.stderr = `${session.stderr}${chunk}`.slice(-MAX_SESSION_STDERR_CHARS);
    });

    rl.on("line", (line) => {
      this.handleSessionOutput(session, line);
    });

    child.on("error", (error) => {
      this.rejectSessionPending(session, this.buildSessionFailure(session, error.message));
      this.teardownSession(sessionKey);
    });

    child.on("exit", (code, signal) => {
      const details = [
        code !== null ? `exitCode=${code}` : "",
        signal ? `signal=${signal}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      this.rejectSessionPending(
        session,
        this.buildSessionFailure(
          session,
          `OpenBrowser session ${sessionKey} exited before completing${details ? ` (${details})` : ""}.`,
        ),
      );
      this.teardownSession(sessionKey);
    });

    this.sessionRuntimes.set(sessionKey, session);
    this.resetSessionIdleTimer(session);
    return session;
  }

  private handleSessionOutput(session: OpenBrowserSessionRuntime, line: string) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let message: OpenBrowserRunnerResponse;
    try {
      message = JSON.parse(trimmed) as OpenBrowserRunnerResponse;
    } catch (error) {
      session.stdoutNoise = `${session.stdoutNoise}${trimmed}\n`.slice(-MAX_SESSION_STDERR_CHARS);
      return;
    }

    const pending = session.pending.get(message.commandId);
    if (!pending) {
      return;
    }
    session.pending.delete(message.commandId);

    if (message.ok) {
      pending.resolve(message.result);
      return;
    }

    pending.reject(this.buildSessionFailure(session, message.error));
  }

  private rejectSessionPending(session: OpenBrowserSessionRuntime, error: Error) {
    for (const [commandId, pending] of session.pending.entries()) {
      session.pending.delete(commandId);
      if (pending.timeoutHandle) {
        clearTimeout(pending.timeoutHandle);
      }
      pending.reject(error);
    }
  }

  private resetSessionIdleTimer(session: OpenBrowserSessionRuntime) {
    if (session.idleHandle) {
      clearTimeout(session.idleHandle);
    }
    session.idleHandle = setTimeout(() => {
      void this.closeSession(session.key, "idle-timeout");
    }, this.sessionIdleMs);
  }

  private async closeSession(sessionKey: string, reason: string) {
    const session = this.sessionRuntimes.get(sessionKey);
    if (!session) {
      return;
    }

    this.rejectSessionPending(
      session,
      this.buildSessionFailure(session, `OpenBrowser session ${sessionKey} closed (${reason}).`),
    );

    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        this.teardownSession(sessionKey);
        resolve();
      };

      session.child.once("exit", finish);
      session.child.once("error", finish);
      session.child.stdin.end();
      setTimeout(() => {
        if (!finished) {
          session.child.kill("SIGTERM");
        }
      }, 100);
      setTimeout(() => {
        if (!finished) {
          session.child.kill("SIGKILL");
          finish();
        }
      }, SESSION_CLOSE_GRACE_MS);
    });
  }

  private teardownSession(sessionKey: string) {
    const session = this.sessionRuntimes.get(sessionKey);
    if (!session) {
      return;
    }
    if (session.idleHandle) {
      clearTimeout(session.idleHandle);
    }
    session.rl.close();
    this.sessionRuntimes.delete(sessionKey);
  }

  private buildSessionFailure(session: OpenBrowserSessionRuntime, error: string | OpenBrowserRunErrorDetails) {
    const details = typeof error === "string"
      ? {
          category: "transport_error" as const,
          message: error,
        }
      : error;

    return new OpenBrowserError({
      ...details,
      stdout: details.stdout ?? (session.stdoutNoise.trim() || undefined),
      stderr: details.stderr ?? (session.stderr.trim() || undefined),
      message: [
        details.message,
        (details.stdout ?? session.stdoutNoise.trim()) ? `stdout:\n${details.stdout ?? session.stdoutNoise.trim()}` : "",
        (details.stderr ?? session.stderr.trim()) ? `stderr:\n${details.stderr ?? session.stderr.trim()}` : "",
        `If the shared browser runtime is not installed yet, run \`${getPythonRuntimeSetupCommand()}\`.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
  }
}
