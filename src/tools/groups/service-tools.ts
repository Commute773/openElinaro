import path from "node:path";
import { type StructuredToolInterface } from "@langchain/core/tools";
import { defineTool } from "../define-tool";
import { z } from "zod";
import { isRunningInsideManagedService } from "../../services/runtime-platform";
import type { RuntimePlatform } from "../../services/runtime-platform";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { telemetry } from "../../services/telemetry";
import type { ToolBuildContext } from "./tool-group-types";
import { renderShellExecResult } from "./shell-tools";

const toolTelemetry = telemetry.child({ component: "tool" });
const traceSpan = createTraceSpan(toolTelemetry);

const benchmarkSchema = z.object({
  prompt: z.string().min(1).optional(),
  maxTokens: z.number().int().min(32).max(1_024).optional(),
  embeddingItems: z.number().int().min(8).max(512).optional(),
  embeddingChars: z.number().int().min(64).max(4_000).optional(),
});

const serviceActionSchema = z.object({
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  conversationKey: z.string().min(1).optional(),
});

const serviceChangelogSinceVersionSchema = z.object({
  sinceVersion: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).superRefine((value, ctx) => {
  if (!value.sinceVersion && !value.version) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide sinceVersion or version.",
      path: ["sinceVersion"],
    });
  }
});

function formatDurationMs(durationMs: number | null) {
  if (durationMs === null) {
    return "n/a";
  }
  if (durationMs >= 1_000) {
    return `${(durationMs / 1_000).toFixed(2)}s`;
  }
  return `${durationMs.toFixed(2)}ms`;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildServiceCommand(
  action: "update" | "rollback" | "healthcheck",
  timeoutMs: number,
  options?: { conversationKey?: string },
) {
  const rootDir = process.env.OPENELINARO_ROOT_DIR?.trim() || process.cwd();
  if (action === "healthcheck") {
    const healthcheckPath = path.resolve(rootDir, "src/cli/healthcheck.ts");
    return `${shellQuote(process.execPath)} ${shellQuote(healthcheckPath)} --timeout-ms=${timeoutMs}`;
  }

  const detached = isRunningInsideManagedService();
  const scriptPath = path.resolve(
    rootDir,
    "scripts",
    detached ? `service-${action}-detached.sh` : `service-${action}.sh`,
  );

  const envParts = [
    `OPENELINARO_HEALTHCHECK_TIMEOUT_MS=${shellQuote(String(timeoutMs))}`,
    `OPENELINARO_AGENT_SERVICE_CONTROL=${shellQuote("1")}`,
  ];
  const passthroughEnv = [
    "OPENELINARO_ROOT_DIR",
    "OPENELINARO_SERVICE_ROOT_DIR",
    "OPENELINARO_USER_DATA_DIR",
    "OPENELINARO_SERVICE_USER",
    "OPENELINARO_SERVICE_GROUP",
    "OPENELINARO_SERVICE_LABEL",
    "OPENELINARO_SYSTEMD_UNIT_PATH",
  ] as const;
  for (const envName of passthroughEnv) {
    const envValue = process.env[envName]?.trim();
    if (envValue) {
      envParts.push(`${envName}=${shellQuote(envValue)}`);
    }
  }
  if (options?.conversationKey?.trim()) {
    envParts.push(
      `OPENELINARO_NOTIFY_DISCORD_USER_ID=${shellQuote(options.conversationKey.trim())}`,
    );
  }

  return [
    ...envParts,
    shellQuote(scriptPath),
  ].join(" ");
}

function buildGitLatestTagCommand() {
  const rootDir = process.env.OPENELINARO_ROOT_DIR?.trim() || process.cwd();
  return `${["git", "-C", rootDir, "tag", "-l", "v*", "--sort=-version:refname"].map((arg) => shellQuote(arg)).join(" ")} | head -n1 | sed 's/^v//'`;
}

function buildGitPullCommand() {
  const rootDir = process.env.OPENELINARO_ROOT_DIR?.trim() || process.cwd();
  return [
    ["git", "-C", rootDir, "fetch", "--tags", "origin"].map((arg) => shellQuote(arg)).join(" "),
    ["git", "-C", rootDir, "pull", "--ff-only"].map((arg) => shellQuote(arg)).join(" "),
  ].join(" && ");
}

function describeServiceTransition(action: "update" | "rollback") {
  if (!isRunningInsideManagedService()) {
    return "";
  }

  return [
    "",
    `IMPORTANT: the ${action} has been SCHEDULED but is NOT complete yet. The service will restart in approximately 10-15 seconds. Do NOT tell the user the ${action} is finished or attempt any actions that depend on it. The user will receive an "update complete" Discord DM once the new version is running and verified.`,
  ].join("\n");
}

function requiresPrivilegedServiceControl(runtimePlatform: RuntimePlatform, action: "update" | "rollback" | "healthcheck" | "restart") {
  return runtimePlatform.serviceManager === "systemd" && action !== "healthcheck";
}

export function buildServiceTools(ctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = [];

  // Benchmark
  tools.push(
    defineTool(
      async (input) =>
        traceSpan(
          "tool.benchmark",
          async () => {
            const modelBenchmark = await ctx.models.benchmarkActiveModel({
              prompt: input.prompt,
              maxTokens: input.maxTokens,
            });
            const embeddingBenchmark = await ctx.memory.benchmarkEmbedding({
              itemCount: input.embeddingItems,
              charsPerItem: input.embeddingChars,
            });

            return [
              "Benchmark results:",
              "",
              `Active model: ${modelBenchmark.providerId}/${modelBenchmark.modelId}`,
              `Thinking: ${(await ctx.models.getActiveModel()).thinkingLevel}`,
              `TTFT: ${formatDurationMs(modelBenchmark.ttftMs)}`,
              `TPS: ${modelBenchmark.tokensPerSecond?.toFixed(2) ?? "n/a"} output tok/s`,
              `Output tokens: ${modelBenchmark.outputTokens} (${modelBenchmark.outputTokenSource})`,
              `Output size: ${modelBenchmark.contentChars} chars`,
              `Generation window: ${formatDurationMs(modelBenchmark.generationLatencyMs)}`,
              `Total latency: ${formatDurationMs(modelBenchmark.totalLatencyMs)}`,
              `Stop reason: ${modelBenchmark.stopReason}`,
              `Prompt length: ${modelBenchmark.prompt.length} chars`,
              `Max tokens cap: ${modelBenchmark.maxTokens}`,
              "",
              `Memory embedding model: ${embeddingBenchmark.modelId}`,
              `Embedding throughput: ${embeddingBenchmark.itemsPerSecond.toFixed(2)} items/s`,
              `Items benchmarked: ${embeddingBenchmark.itemCount}`,
              `Chars per item: ${embeddingBenchmark.charsPerItem}`,
              `Embedding batch size: ${embeddingBenchmark.batchSize}`,
              `Vector dimensions: ${embeddingBenchmark.vectorDimensions}`,
              `Warmup: ${formatDurationMs(embeddingBenchmark.warmupMs)}`,
              `Benchmark duration: ${formatDurationMs(embeddingBenchmark.durationMs)}`,
            ].join("\n");
          },
          { attributes: input },
        ),
      {
        name: "benchmark",
        description:
          "Run a live benchmark for the currently active chat model and the local memory embedding model, reporting TTFT, TPS, and embedding items per second.",
        schema: benchmarkSchema,
      },
    ),
  );

  // Service/deployment tools
  const runUpdatePreview = async (input: z.infer<typeof serviceActionSchema>, operation: string) =>
    traceSpan(
      operation,
      async () => {
        const timeoutMs = input.timeoutMs ?? 60_000;
        const pullResult = await ctx.shell.exec({
          command: buildGitPullCommand(),
          timeoutMs: timeoutMs + 30_000,
        });
        if (pullResult.exitCode !== 0) {
          return `Failed to sync latest version:\n${renderShellExecResult(pullResult)}`;
        }
        const tagResult = await ctx.shell.exec({
          command: buildGitLatestTagCommand(),
          timeoutMs: 10_000,
        });
        const latestTagVersion = tagResult.stdout?.trim() ?? "";
        try {
          return await ctx.deploymentVersion.formatAvailableUpdate(latestTagVersion);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return [
            "Fetched tags, but could not determine available update.",
            `Reason: ${detail}`,
          ].join("\n");
        }
      },
      { attributes: input },
    );

  const runUpdate = async (input: z.infer<typeof serviceActionSchema>, operation: string) =>
    traceSpan(
      operation,
      async () => {
        const timeoutMs = input.timeoutMs ?? 60_000;
        const pullResult = await ctx.shell.exec({
          command: buildGitPullCommand(),
          timeoutMs: timeoutMs + 30_000,
        });
        if (pullResult.exitCode !== 0) {
          return `Failed to pull latest version:\n${renderShellExecResult(pullResult)}`;
        }
        const tagResult = await ctx.shell.exec({
          command: buildGitLatestTagCommand(),
          timeoutMs: 10_000,
        });
        const latestTagVersion = tagResult.exitCode === 0 ? tagResult.stdout?.trim() ?? "" : "";
        if (!await ctx.deploymentVersion.hasPreparedUpdate()) {
          return await ctx.deploymentVersion.formatPreparedUpdate(latestTagVersion);
        }
        const result = await ctx.shell.exec({
          command: buildServiceCommand("update", timeoutMs, {
            conversationKey: input.conversationKey,
          }),
          timeoutMs: timeoutMs + 180_000,
          sudo: requiresPrivilegedServiceControl(ctx.runtimePlatform, "update"),
        });
        return `${renderShellExecResult(result)}${describeServiceTransition("update")}`;
      },
      { attributes: input },
    );

  tools.push(
    defineTool(
      async () =>
        traceSpan(
          "tool.service_version",
          async () => await ctx.deploymentVersion.formatSummary(),
        ),
      {
        name: "service_version",
        description:
          "Show the stamped deploy version and current release metadata for this runtime.",
        schema: z.object({}),
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.service_changelog_since_version",
          async () => await ctx.deploymentVersion.formatChangelogSinceVersion(
            input.sinceVersion ?? input.version ?? "",
            { limit: input.limit },
          ),
          { attributes: input },
        ),
      {
        name: "service_changelog_since_version",
        description:
          "Show deploy changelog entries whose version is numerically newer than a requested version from the current runtime's DEPLOYMENTS.md metadata.",
        schema: serviceChangelogSinceVersionSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.service_healthcheck",
          async () => {
            const timeoutMs = input.timeoutMs ?? 60_000;
            const result = await ctx.shell.exec({
              command: buildServiceCommand("healthcheck", timeoutMs),
              timeoutMs: timeoutMs + 15_000,
              sudo: requiresPrivilegedServiceControl(ctx.runtimePlatform, "healthcheck"),
            });
            return renderShellExecResult(result);
          },
          { attributes: input },
        ),
      {
        name: "service_healthcheck",
        description:
          "Run the live managed-service healthcheck by sending a simulated message to the main agent and waiting up to one minute for HEALTHCHECK_OK.",
        schema: serviceActionSchema,
      },
    ),
    defineTool(
      async (input) => runUpdatePreview(input, "tool.update_preview"),
      {
        name: "update_preview",
        description:
          "Sync the source checkout without deploying. Shows pending deploy notes after pulling.",
        schema: serviceActionSchema,
      },
    ),
    defineTool(
      async (input) => runUpdate(input, "tool.update"),
      {
        name: "update",
        description:
          "Deploy the already prepared source version into the local managed installation and verify it with the service healthcheck.",
        schema: serviceActionSchema,
      },
    ),
    defineTool(
      async (input) =>
        traceSpan(
          "tool.service_rollback",
          async () => {
            const timeoutMs = input.timeoutMs ?? 60_000;
            const result = await ctx.shell.exec({
              command: buildServiceCommand("rollback", timeoutMs, {
                conversationKey: input.conversationKey,
              }),
              timeoutMs: timeoutMs + 180_000,
              sudo: requiresPrivilegedServiceControl(ctx.runtimePlatform, "rollback"),
            });
            return `${renderShellExecResult(result)}${describeServiceTransition("rollback")}`;
          },
          { attributes: input },
        ),
      {
        name: "service_rollback",
        description:
          "Roll the managed service back to the previously deployed release and verify the restored agent with the same simulated healthcheck.",
        schema: serviceActionSchema,
      },
    ),
    defineTool(
      async () =>
        traceSpan(
          "tool.restart",
          async () => ctx.requestManagedServiceRestart("manual"),
        ),
      {
        name: "restart",
        description:
          "Restart the managed service process. The current process will exit and the service manager will start a fresh instance. Running background agents will resume automatically after restart.",
        schema: z.object({}),
      },
    ),
  );

  return tools;
}
