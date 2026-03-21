import { spawn } from "node:child_process";
import crypto from "node:crypto";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { AgentToolScope, ToolCatalogCard } from "../domain/tool-catalog";
import type {
  ToolProgramAvailableTool,
  ToolProgramRunReport,
  ToolProgramWorkerRequest,
  ToolProgramWorkerResponse,
} from "../domain/tool-program";
import type { ToolContext } from "../tools/routine-tool-registry";
import { stringifyToolErrorEnvelope } from "./tool-error-service";
import { telemetry } from "./telemetry";

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 180_000;
const WORKER_SCRIPT_PATH = fileURLToPath(
  new URL("../workers/tool-program-worker.ts", import.meta.url),
);
const toolProgramTelemetry = telemetry.child({ component: "tool_program" });

type ToolProgramHost = {
  getToolCatalog(context?: ToolContext): ToolCatalogCard[];
  invokeRaw(name: string, input: unknown, context?: ToolContext): Promise<unknown>;
};

type RunParams = {
  objective: string;
  code: string;
  scope?: AgentToolScope;
  allowedTools?: string[];
  timeoutMs?: number;
  context?: ToolContext;
};

function nextRunId() {
  return `tool-program-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

function clampTimeoutMs(value?: number) {
  if (!value) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(value, 1_000), MAX_TIMEOUT_MS);
}

function serializeMessage(message: ToolProgramWorkerRequest) {
  return `${JSON.stringify(message)}\n`;
}

function traceSpan<T>(
  operation: string,
  fn: () => Promise<T>,
  options?: { attributes?: Record<string, unknown> },
) {
  return toolProgramTelemetry.span(operation, options?.attributes ?? {}, fn);
}

function toWorkerToolCards(cards: ToolCatalogCard[], allowedTools: Set<string>): ToolProgramAvailableTool[] {
  return cards
    .filter((card) => allowedTools.has(card.canonicalName) && !card.aliasOf)
    .map((card) => ({
      name: card.canonicalName,
      description: card.description,
      examples: card.examples,
      domains: card.domains,
    }));
}

export class ToolProgramService {
  constructor(private readonly host: ToolProgramHost) {}

  async run(params: RunParams) {
    return traceSpan(
      "tool_program.run",
      async () => {
        const runId = nextRunId();
        const scope = params.scope ?? "chat";
        const timeoutMs = clampTimeoutMs(params.timeoutMs);
        const allowedTools = await this.resolveAllowedTools({
          scope,
          requested: params.allowedTools,
          context: params.context,
        });
        const allowedToolSet = new Set(allowedTools);
        const availableTools = toWorkerToolCards(
          this.host.getToolCatalog(params.context),
          allowedToolSet,
        );

        const report = await this.executeInWorker({
          runId,
          objective: params.objective,
          code: params.code,
          scope,
          allowedTools,
          availableTools,
          timeoutMs,
          context: params.context,
        });

        return {
          runId,
          ...report,
        };
      },
      {
        attributes: {
          scope: params.scope ?? "chat",
          requestedAllowedTools: params.allowedTools?.length ?? 0,
        },
      },
    );
  }

  private async executeInWorker(params: {
    runId: string;
    objective: string;
    code: string;
    scope: AgentToolScope;
    allowedTools: string[];
    availableTools: ToolProgramAvailableTool[];
    timeoutMs: number;
    context?: ToolContext;
  }): Promise<ToolProgramRunReport> {
    const child = spawn(process.execPath, [WORKER_SCRIPT_PATH], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    let settled = false;
    let stderrText = "";
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const finalize = <T>(handler: () => T) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      rl.close();
      child.stdin.end();
      return handler();
    };

    return new Promise<ToolProgramRunReport>((resolve, reject) => {
      child.stderr.on("data", (chunk) => {
        stderrText += chunk.toString("utf8");
      });

      rl.on("line", async (line) => {
        if (!line.trim() || settled) {
          return;
        }

        try {
          const message = JSON.parse(line) as ToolProgramWorkerResponse;
          if (message.type === "invoke_tool") {
            try {
              const result = await this.host.invokeRaw(message.name, message.input, params.context);
              child.stdin.write(serializeMessage({
                type: "invoke_tool_result",
                id: message.id,
                ok: true,
                result,
              }));
            } catch (error) {
              child.stdin.write(serializeMessage({
                type: "invoke_tool_result",
                id: message.id,
                ok: false,
                error: stringifyToolErrorEnvelope(message.name, error),
              }));
            }
            return;
          }

          if (message.type === "telemetry_event") {
            toolProgramTelemetry.event(
              message.name,
              {
                runId: params.runId,
                ...(message.attributes ?? {}),
              },
              {
                level: message.level,
                message: message.message,
                outcome: message.outcome,
              },
            );
            return;
          }

          if (message.type === "complete") {
            finalize(() => resolve(message.report));
            child.kill();
            return;
          }

          if (message.type === "error") {
            finalize(() => reject(new Error(message.error)));
            child.kill();
          }
        } catch (error) {
          finalize(() => reject(error instanceof Error ? error : new Error(String(error))));
          child.kill("SIGKILL");
        }
      });

      child.on("exit", (code, signal) => {
        if (settled) {
          return;
        }

        const details = [
          `Tool program worker exited before completing.`,
          code !== null ? `exitCode=${code}` : "",
          signal ? `signal=${signal}` : "",
          stderrText.trim() ? `stderr=${stderrText.trim()}` : "",
        ]
          .filter(Boolean)
          .join(" ");

        finalize(() => reject(new Error(details)));
      });

      child.on("error", (error) => {
        finalize(() => reject(error));
      });

      timeoutHandle = setTimeout(() => {
        finalize(() =>
          reject(new Error(`Tool program worker timed out after ${params.timeoutMs}ms.`)),
        );
        child.kill("SIGKILL");
      }, params.timeoutMs + 2_000);

      child.stdin.write(serializeMessage({
        type: "run",
        runId: params.runId,
        objective: params.objective,
        code: params.code,
        scope: params.scope,
        allowedTools: params.allowedTools,
        availableTools: params.availableTools,
        timeoutMs: params.timeoutMs,
      }));
    });
  }

  private async resolveAllowedTools(params: {
    scope: AgentToolScope;
    requested?: string[];
    context?: ToolContext;
  }) {
    const requested = Array.from(
      new Set(
        (params.requested ?? [])
          .map((name) => name.trim())
          .filter(Boolean),
      ),
    );
    if (requested.length > 0) {
      return requested;
    }

    return Array.from(
      new Set(
        this.host.getToolCatalog(params.context)
          .filter((card) => !card.aliasOf)
          .filter((card) => card.agentScopes.includes(params.scope))
          .filter((card) => !["run_tool_program", "tool_search"].includes(card.canonicalName))
          .map((card) => card.canonicalName),
      ),
    );
  }
}
