import crypto from "node:crypto";
import readline from "node:readline";
import vm from "node:vm";
import type {
  ToolProgramRunReport,
  ToolProgramWorkerRequest,
  ToolProgramWorkerResponse,
} from "../domain/tool-program";
import { ToolProgramArtifactService, type ToolProgramArtifactRecord } from "../services/tool-program-artifact-service";
import { normalizeString } from "../utils/text-utils";

const AUTO_ARTIFACT_CHAR_THRESHOLD = 4_000;

type PendingToolCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

function send(message: ToolProgramWorkerResponse) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function emitTelemetry(
  name: string,
  attributes?: Record<string, unknown>,
  options?: {
    level?: "debug" | "info" | "warn" | "error";
    message?: string;
    outcome?: "ok" | "error" | "cancelled" | "timeout" | "rejected";
  },
) {
  send({
    type: "telemetry_event",
    name,
    attributes,
    level: options?.level,
    message: options?.message,
    outcome: options?.outcome,
  });
}

function stringifyValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeValue(value: unknown) {
  const text = stringifyValue(value).replace(/\s+/g, " ").trim();
  if (text.length <= 220) {
    return text;
  }
  return `${text.slice(0, 217)}...`;
}

function buildResultSummary(result: unknown) {
  const resultStr = normalizeString(result);
  if (resultStr) {
    return resultStr;
  }

  if (result && typeof result === "object" && !Array.isArray(result)) {
    const summary = normalizeString((result as { summary?: unknown }).summary);
    if (summary) {
      return summary;
    }
  }

  return "Program completed.";
}

async function executeRun(message: Extract<ToolProgramWorkerRequest, { type: "run" }>) {
  const pending = new Map<string, PendingToolCall>();
  activePending = pending;
  const artifactsService = new ToolProgramArtifactService();
  const artifacts: ToolProgramArtifactRecord[] = [];
  const logs: string[] = [];
  const toolCalls: ToolProgramRunReport["toolCalls"] = [];
  const allowedSet = new Set(message.allowedTools);

  const saveArtifact = (name: string, content: unknown, mediaType?: string) => {
    const artifact = artifactsService.writeArtifact({
      runId: message.runId,
      name,
      content,
      mediaType,
    });
    artifacts.push(artifact);
    emitTelemetry("tool_program.artifact_saved", {
      runId: message.runId,
      name,
      path: artifact.path,
      mediaType,
      byteLength: artifact.byteLength,
    });
    return artifact;
  };

  emitTelemetry("tool_program.worker_started", {
    runId: message.runId,
    scope: message.scope,
    timeoutMs: message.timeoutMs,
    allowedToolCount: message.allowedTools.length,
  });

  const programApi = {
    invokeTool: async (name: string, input?: unknown, options?: { artifactName?: string; mediaType?: string }) => {
      if (!allowedSet.has(name)) {
        throw new Error(`Tool ${name} is not allowed in this program run.`);
      }

      const id = crypto.randomBytes(8).toString("hex");
      emitTelemetry("tool_program.invoke_tool.started", {
        runId: message.runId,
        requestId: id,
        toolName: name,
        inputPreview: summarizeValue(input ?? {}),
      });
      const resultPromise = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      send({
        type: "invoke_tool",
        id,
        name,
        input: input ?? {},
      });

      const result = await resultPromise;
      const preview = summarizeValue(result);
      let artifactPath: string | undefined;
      const serialized = stringifyValue(result);
      if (options?.artifactName || serialized.length > AUTO_ARTIFACT_CHAR_THRESHOLD) {
        artifactPath = saveArtifact(
          options?.artifactName ?? `${name}.json`,
          result,
          options?.mediaType ?? "application/json",
        ).path;
      }

      toolCalls.push({
        name,
        artifactPath,
        preview,
      });
      emitTelemetry("tool_program.invoke_tool.completed", {
        runId: message.runId,
        requestId: id,
        toolName: name,
        preview,
        artifactPath,
      });
      return result;
    },
    saveArtifact: async (name: string, content: unknown, mediaType?: string) =>
      saveArtifact(name, content, mediaType),
    getAvailableTools: () => message.availableTools,
    log: (entry: unknown) => {
      const text = String(entry).trim();
      if (text) {
        logs.push(text);
        emitTelemetry(
          "tool_program.log",
          {
            runId: message.runId,
            entry: text,
          },
          { level: "debug", message: text },
        );
      }
    },
  };

  const context = vm.createContext({
    tools: programApi,
    program: programApi,
    console: {
      log: (...args: unknown[]) => logs.push(args.map((arg) => summarizeValue(arg)).join(" ")),
    },
    JSON,
    Math,
    Date,
    setTimeout,
    clearTimeout,
  });

  const source = `'use strict';\n(async () => {\n${message.code}\n})()`;
  const execution = vm.runInContext(source, context, {
    displayErrors: true,
  }) as Promise<unknown>;

  const result = await Promise.race([
    execution,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Tool program timed out after ${message.timeoutMs}ms.`)), message.timeoutMs);
    }),
  ]);
  const summary = buildResultSummary(result);
  if (result && typeof result === "object") {
    saveArtifact("result.json", result, "application/json");
  }

  const manifest = saveArtifact(
    "manifest.json",
    {
      runId: message.runId,
      objective: message.objective,
      scope: message.scope,
      timeoutMs: message.timeoutMs,
      allowedTools: message.allowedTools,
      toolCalls,
      logs,
      summary,
    },
    "application/json",
  );

  emitTelemetry(
    "tool_program.worker_completed",
    {
      runId: message.runId,
      summary,
      toolCallCount: toolCalls.length,
      artifactCount: artifacts.length,
      logCount: logs.length,
    },
    { outcome: "ok" },
  );

  return {
    report: {
      scope: message.scope,
      summary,
      allowedTools: message.allowedTools,
      toolCalls,
      logs,
      artifacts,
      manifestPath: manifest.path,
    } satisfies ToolProgramRunReport,
    pending,
  };
}

let activePending = new Map<string, PendingToolCall>();

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", async (line) => {
  if (!line.trim()) {
    return;
  }

  try {
    const message = JSON.parse(line) as ToolProgramWorkerRequest;
    if (message.type === "invoke_tool_result") {
      const pending = activePending.get(message.id);
      if (!pending) {
        return;
      }
      activePending.delete(message.id);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error));
      }
      return;
    }

    if (message.type === "run") {
      const execution = await executeRun(message);
      activePending = execution.pending;
      send({
        type: "complete",
        report: execution.report,
      });
    }
  } catch (error) {
    emitTelemetry(
      "tool_program.worker_error",
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { level: "error", outcome: "error" },
    );
    send({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
