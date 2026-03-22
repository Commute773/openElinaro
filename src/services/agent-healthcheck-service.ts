import fs from "node:fs";
import path from "node:path";
import type { AppResponse } from "../domain/assistant";
import { resolveRuntimePath } from "./runtime-root";
import { telemetry } from "./telemetry";
import { timestamp as nowIso } from "../utils/timestamp";

export const AGENT_HEALTHCHECK_PROMPT =
  "this is a healthcheck, reply with HEALTHCHECK_OK to confirm you are up and active";
export const AGENT_HEALTHCHECK_SUCCESS_TOKEN = "HEALTHCHECK_OK";
export const DEFAULT_AGENT_HEALTHCHECK_TIMEOUT_MS = 60_000;
const DEFAULT_AGENT_HEALTHCHECK_ROOT = resolveRuntimePath("agent-healthchecks");
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface AgentHealthcheckPaths {
  rootDir: string;
  requestsDir: string;
  processingDir: string;
  responsesDir: string;
}

export interface AgentHealthcheckRequest {
  id: string;
  createdAt: string;
  timeoutMs?: number;
}

export interface AgentHealthcheckResponse {
  id: string;
  status: "ok" | "error";
  createdAt: string;
  completedAt: string;
  timeoutMs: number;
  prompt: string;
  conversationKey: string;
  immediateMessage?: string;
  backgroundMessage?: string;
  error?: string;
}

export interface AgentHealthcheckRunner {
  run(params: {
    requestId: string;
    conversationKey: string;
    prompt: string;
    onBackgroundResponse?: (message: string) => Promise<void> | void;
  }): Promise<AppResponse>;
}


function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function containsSuccessToken(message: string | undefined) {
  return typeof message === "string" && message.includes(AGENT_HEALTHCHECK_SUCCESS_TOKEN);
}

function normalizeTimeoutMs(timeoutMs: number | undefined) {
  if (!Number.isFinite(timeoutMs) || timeoutMs === undefined) {
    return DEFAULT_AGENT_HEALTHCHECK_TIMEOUT_MS;
  }
  return Math.max(1_000, Math.min(timeoutMs, 300_000));
}

export function resolveAgentHealthcheckPaths(rootDir = DEFAULT_AGENT_HEALTHCHECK_ROOT): AgentHealthcheckPaths {
  return {
    rootDir,
    requestsDir: path.join(rootDir, "requests"),
    processingDir: path.join(rootDir, "processing"),
    responsesDir: path.join(rootDir, "responses"),
  };
}

export function ensureAgentHealthcheckDirs(paths: AgentHealthcheckPaths) {
  fs.mkdirSync(paths.requestsDir, { recursive: true });
  fs.mkdirSync(paths.processingDir, { recursive: true });
  fs.mkdirSync(paths.responsesDir, { recursive: true });
}

export class AgentHealthcheckService {
  private readonly paths: AgentHealthcheckPaths;
  private readonly pollIntervalMs: number;
  private runner: AgentHealthcheckRunner | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  constructor(options?: { rootDir?: string; pollIntervalMs?: number }) {
    this.paths = resolveAgentHealthcheckPaths(options?.rootDir);
    this.pollIntervalMs = Math.max(50, options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    ensureAgentHealthcheckDirs(this.paths);
  }

  getPaths() {
    return this.paths;
  }

  start(runner: AgentHealthcheckRunner) {
    this.runner = runner;
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
    void this.pollOnce();
  }

  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.runner = null;
  }

  private async pollOnce() {
    if (this.processing || !this.runner) {
      return;
    }

    const nextPath = this.claimNextRequest();
    if (!nextPath) {
      return;
    }

    this.processing = true;
    try {
      await this.processRequest(nextPath, this.runner);
    } finally {
      this.processing = false;
    }
  }

  private claimNextRequest() {
    const candidates = fs.readdirSync(this.paths.requestsDir)
      .filter((entry) => entry.endsWith(".json"))
      .sort((left, right) => left.localeCompare(right));

    for (const entry of candidates) {
      const requestPath = path.join(this.paths.requestsDir, entry);
      const processingPath = path.join(this.paths.processingDir, entry);
      try {
        fs.renameSync(requestPath, processingPath);
        return processingPath;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
    }

    return null;
  }

  private async processRequest(requestPath: string, runner: AgentHealthcheckRunner) {
    let request: AgentHealthcheckRequest | null = null;

    try {
      request = JSON.parse(fs.readFileSync(requestPath, "utf8")) as AgentHealthcheckRequest;
      const response = await this.executeRequest(request, runner);
      fs.writeFileSync(
        path.join(this.paths.responsesDir, `${request.id}.json`),
        `${JSON.stringify(response, null, 2)}\n`,
      );
      telemetry.event("agent.healthcheck.completed", {
        requestId: response.id,
        conversationKey: response.conversationKey,
      }, {
        level: response.status === "ok" ? "info" : "warn",
        outcome: response.status,
      });
    } catch (error) {
      const failedRequest = request ?? {
        id: path.basename(requestPath, ".json"),
        createdAt: nowIso(),
        timeoutMs: DEFAULT_AGENT_HEALTHCHECK_TIMEOUT_MS,
      };
      const response: AgentHealthcheckResponse = {
        id: failedRequest.id,
        status: "error",
        createdAt: failedRequest.createdAt,
        completedAt: nowIso(),
        timeoutMs: normalizeTimeoutMs(failedRequest.timeoutMs),
        prompt: AGENT_HEALTHCHECK_PROMPT,
        conversationKey: `agent-healthcheck-${failedRequest.id}`,
        error: error instanceof Error ? error.message : String(error),
      };
      fs.writeFileSync(
        path.join(this.paths.responsesDir, `${failedRequest.id}.json`),
        `${JSON.stringify(response, null, 2)}\n`,
      );
      telemetry.recordError(error, {
        requestId: failedRequest.id,
        operation: "agent.healthcheck",
      });
    } finally {
      fs.rmSync(requestPath, { force: true });
    }
  }

  private async executeRequest(
    request: AgentHealthcheckRequest,
    runner: AgentHealthcheckRunner,
  ): Promise<AgentHealthcheckResponse> {
    const timeoutMs = normalizeTimeoutMs(request.timeoutMs);
    const conversationKey = `agent-healthcheck-${request.id}`;
    let backgroundMessage: string | undefined;
    let resolveBackground: ((message: string | undefined) => void) | undefined;
    const backgroundPromise = new Promise<string | undefined>((resolve) => {
      resolveBackground = resolve;
    });

    const immediate = await runner.run({
      requestId: request.id,
      conversationKey,
      prompt: AGENT_HEALTHCHECK_PROMPT,
      onBackgroundResponse: async (message) => {
        backgroundMessage = message;
        if (containsSuccessToken(message)) {
          resolveBackground?.(message);
        }
      },
    });

    if (containsSuccessToken(immediate.message)) {
      return {
        id: request.id,
        status: "ok",
        createdAt: request.createdAt,
        completedAt: nowIso(),
        timeoutMs,
        prompt: AGENT_HEALTHCHECK_PROMPT,
        conversationKey,
        immediateMessage: immediate.message,
        backgroundMessage,
      };
    }

    if (containsSuccessToken(backgroundMessage)) {
      return {
        id: request.id,
        status: "ok",
        createdAt: request.createdAt,
        completedAt: nowIso(),
        timeoutMs,
        prompt: AGENT_HEALTHCHECK_PROMPT,
        conversationKey,
        immediateMessage: immediate.message,
        backgroundMessage,
      };
    }

    if (immediate.mode === "accepted") {
      const backgroundResult = await Promise.race([
        backgroundPromise,
        sleep(timeoutMs).then(() => undefined),
      ]);
      backgroundMessage = backgroundResult ?? backgroundMessage;
      if (containsSuccessToken(backgroundMessage)) {
        return {
          id: request.id,
          status: "ok",
          createdAt: request.createdAt,
          completedAt: nowIso(),
          timeoutMs,
          prompt: AGENT_HEALTHCHECK_PROMPT,
          conversationKey,
          immediateMessage: immediate.message,
          backgroundMessage,
        };
      }
      return {
        id: request.id,
        status: "error",
        createdAt: request.createdAt,
        completedAt: nowIso(),
        timeoutMs,
        prompt: AGENT_HEALTHCHECK_PROMPT,
        conversationKey,
        immediateMessage: immediate.message,
        backgroundMessage,
        error: backgroundMessage
          ? `Healthcheck background response did not include ${AGENT_HEALTHCHECK_SUCCESS_TOKEN}.`
          : `Healthcheck timed out after ${timeoutMs}ms without a successful background response.`,
      };
    }

    return {
      id: request.id,
      status: "error",
      createdAt: request.createdAt,
      completedAt: nowIso(),
      timeoutMs,
      prompt: AGENT_HEALTHCHECK_PROMPT,
      conversationKey,
      immediateMessage: immediate.message,
      backgroundMessage,
      error: `Healthcheck response did not include ${AGENT_HEALTHCHECK_SUCCESS_TOKEN}.`,
    };
  }
}
