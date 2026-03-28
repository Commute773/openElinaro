import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { getRuntimeConfig } from "../config/runtime-config";
import {
  assertSharedPythonRuntimeReady,
  getWebFetchPythonModules,
  getSharedPythonBinPath,
  getPythonRuntimeSetupCommand,
  resolvePythonScriptPath,
} from "./python-runtime";
import { resolveRuntimePath } from "./runtime-root";
import { telemetry as rootTelemetry, type TelemetryService } from "./infrastructure/telemetry";

export type WebFetchParams = {
  url: string;
  format?: "text" | "markdown" | "html";
  timeoutMs?: number;
  maxChars?: number;
};

export type WebFetchResult = {
  url: string;
  finalUrl: string;
  format: "text" | "markdown" | "html";
  contentType: string;
  title?: string;
  content: string;
  truncated: boolean;
  backend: "crawl4ai";
  artifactDir: string;
};

type WebFetchRunnerPayload = {
  url: string;
  format: "text" | "markdown" | "html";
  timeoutMs: number;
  maxChars: number;
  artifactDir: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CHARS = 12_000;
const MAX_MAX_CHARS = 40_000;

function resolveConfiguredRunnerScript(configuredPath: string | undefined) {
  return resolvePythonScriptPath(configuredPath, "scripts/crawl4ai_fetch_runner.py");
}

export class WebFetchService {
  private readonly pythonBin: string;
  private readonly usesSharedPythonRuntime: boolean;
  private readonly runnerScript: string;
  private readonly telemetry: TelemetryService;

  constructor(
    options?: { pythonBin?: string; runnerScript?: string; telemetry?: TelemetryService },
  ) {
    const configured = getRuntimeConfig().webFetch;
    this.pythonBin = options?.pythonBin ?? getSharedPythonBinPath();
    this.usesSharedPythonRuntime = options?.pythonBin === undefined;
    this.runnerScript = options?.runnerScript
      ? path.resolve(options.runnerScript)
      : resolveConfiguredRunnerScript(configured.runnerScript);
    this.telemetry = options?.telemetry ?? rootTelemetry.child({ component: "web_fetch" });
  }

  private resolvePythonBin() {
    return this.usesSharedPythonRuntime ? assertSharedPythonRuntimeReady(getWebFetchPythonModules()) : this.pythonBin;
  }

  async fetch(params: WebFetchParams): Promise<WebFetchResult> {
    const format = params.format ?? "markdown";
    const timeoutMs = Math.min(Math.max(params.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
    const maxChars = Math.min(Math.max(params.maxChars ?? DEFAULT_MAX_CHARS, 500), MAX_MAX_CHARS);
    const url = params.url.trim();

    if (!/^https?:\/\//i.test(url)) {
      throw new Error("web_fetch requires an http:// or https:// URL.");
    }
    const artifactDir = resolveRuntimePath(
      "web-fetch",
      `${Date.now()}-${randomUUID().slice(0, 8)}`,
    );
    const payload: WebFetchRunnerPayload = {
      url,
      format,
      timeoutMs,
      maxChars,
      artifactDir,
    };

    if (!fs.existsSync(this.runnerScript)) {
      throw new Error(`web_fetch runner script not found: ${this.runnerScript}`);
    }

    const result = await this.telemetry.instrumentSpawn({
      component: "web_fetch",
      operation: "web_fetch.runner",
      command: this.resolvePythonBin(),
      args: [this.runnerScript],
      timeoutMs: timeoutMs + 5_000,
      input: JSON.stringify(payload),
      options: {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    });

    if (result.code !== 0) {
      throw new Error(
        [
          `Crawl4AI web_fetch runner failed with exit code ${result.code}${result.signal ? ` (${result.signal})` : ""}.`,
          result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
          result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : "",
          `If the shared web runtime is not installed yet, run \`${getPythonRuntimeSetupCommand()}\`.`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    }

    const lastJsonLine = result.stdout
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);

    try {
      return JSON.parse(lastJsonLine ?? "") as WebFetchResult;
    } catch (error) {
      throw new Error(
        [
          "web_fetch runner returned invalid JSON.",
          error instanceof Error ? error.message : String(error),
          result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
          result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    }
  }
}
