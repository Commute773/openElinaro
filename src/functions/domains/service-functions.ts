/**
 * Service function definitions (benchmark, version, healthcheck, update, rollback, restart).
 * Migrated from src/tools/groups/service-tools.ts.
 * These produce agent tools, API routes, and Discord commands from a single source.
 */
import path from "node:path";
import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";
import { formatResult } from "../formatters";
import { isRunningInsideManagedService } from "../../services/infrastructure/runtime-platform";
import type { RuntimePlatform } from "../../services/infrastructure/runtime-platform";
import type { ToolBuildContext } from "../context";
import { tryCatchAsync } from "../../utils/result";

// ---------------------------------------------------------------------------
// Shared schemas (same as service-tools.ts)
// ---------------------------------------------------------------------------

const benchmarkSchema = z.object({
  prompt: z.string().min(1).optional(),
  maxTokens: z.number().int().min(32).max(1_024).optional(),
});

const serviceActionSchema = z.object({
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  conversationKey: z.string().min(1).optional(),
  notifyDiscordUserId: z.string().min(1).optional(),
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

// ---------------------------------------------------------------------------
// Helpers (same as service-tools.ts)
// ---------------------------------------------------------------------------

export function formatDurationMs(durationMs: number | null) {
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

function renderShellExecResult(result: Awaited<ReturnType<ToolBuildContext["shell"]["exec"]>>) {
  return [
    `$ ${result.command}`,
    `cwd: ${result.cwd}`,
    `effectiveUser: ${result.effectiveUser}`,
    `timeoutMs: ${result.timeoutMs}`,
    `sudo: ${result.sudo ? "yes" : "no"}`,
    `exitCode: ${result.exitCode}`,
    result.stdout ? `stdout:\n${result.stdout}` : "stdout:\n",
    result.stderr ? `stderr:\n${result.stderr}` : "stderr:\n",
  ].join("\n");
}

function buildServiceCommand(
  action: "update" | "rollback" | "healthcheck",
  timeoutMs: number,
  options?: { notifyDiscordUserId?: string },
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
  if (options?.notifyDiscordUserId?.trim()) {
    envParts.push(
      `OPENELINARO_NOTIFY_DISCORD_USER_ID=${shellQuote(options.notifyDiscordUserId.trim())}`,
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

// ---------------------------------------------------------------------------
// Service auth defaults
// ---------------------------------------------------------------------------

const SERVICE_AUTH_ANYONE = { access: "anyone" as const, behavior: "uniform" as const };
const SERVICE_AUTH_ROOT = { access: "root" as const, behavior: "uniform" as const };
const SERVICE_SCOPES: ("chat" | "direct")[] = ["chat", "direct"];
const SERVICE_DOMAINS = ["service", "system"];

// ---------------------------------------------------------------------------
// Domain builder
// ---------------------------------------------------------------------------

export const buildServiceFunctions: FunctionDomainBuilder = (ctx) => {
  // Shared update preview runner
  const runUpdatePreview = async (input: z.infer<typeof serviceActionSchema>, services: ToolBuildContext) => {
    const timeoutMs = input.timeoutMs ?? 60_000;
    const pullResult = await services.shell.exec({
      command: buildGitPullCommand(),
      timeoutMs: timeoutMs + 30_000,
    });
    if (pullResult.exitCode !== 0) {
      return `Failed to sync latest version:\n${renderShellExecResult(pullResult)}`;
    }
    const tagResult = await services.shell.exec({
      command: buildGitLatestTagCommand(),
      timeoutMs: 10_000,
    });
    const latestTagVersion = tagResult.stdout?.trim() ?? "";
    const updateResult = await tryCatchAsync(
      () => services.deploymentVersion.formatAvailableUpdate(latestTagVersion),
      { operation: "update_preview.formatAvailableUpdate", latestTagVersion },
    );
    if (!updateResult.ok) {
      return [
        "Fetched tags, but could not determine available update.",
        `Reason: ${updateResult.error.message}`,
      ].join("\n");
    }
    return updateResult.value;
  };

  // Shared update runner
  const runUpdate = async (input: z.infer<typeof serviceActionSchema>, services: ToolBuildContext) => {
    const timeoutMs = input.timeoutMs ?? 60_000;
    const pullResult = await services.shell.exec({
      command: buildGitPullCommand(),
      timeoutMs: timeoutMs + 30_000,
    });
    if (pullResult.exitCode !== 0) {
      return `Failed to pull latest version:\n${renderShellExecResult(pullResult)}`;
    }
    const tagResult = await services.shell.exec({
      command: buildGitLatestTagCommand(),
      timeoutMs: 10_000,
    });
    const latestTagVersion = tagResult.exitCode === 0 ? tagResult.stdout?.trim() ?? "" : "";
    if (!await services.deploymentVersion.hasPreparedUpdate()) {
      return await services.deploymentVersion.formatPreparedUpdate(latestTagVersion);
    }
    const result = await services.shell.exec({
      command: buildServiceCommand("update", timeoutMs, {
        notifyDiscordUserId: input.notifyDiscordUserId,
      }),
      timeoutMs: timeoutMs + 180_000,
      sudo: requiresPrivilegedServiceControl(services.runtimePlatform, "update"),
    });
    return `${renderShellExecResult(result)}${describeServiceTransition("update")}`;
  };

  return [
    // -----------------------------------------------------------------------
    // benchmark
    // -----------------------------------------------------------------------
    defineFunction({
      name: "benchmark",
      description:
        "Run a live benchmark for the currently active chat model, reporting TTFT and TPS.",
      input: benchmarkSchema,
      handler: async (input, fnCtx) => {
        const modelBenchmark = await fnCtx.services.models.benchmarkActiveModel({
          prompt: input.prompt,
          maxTokens: input.maxTokens,
        });

        return [
          "Benchmark results:",
          "",
          `Active model: ${modelBenchmark.providerId}/${modelBenchmark.modelId}`,
          `Thinking: ${(await fnCtx.services.models.getActiveModel()).thinkingLevel}`,
          `TTFT: ${formatDurationMs(modelBenchmark.ttftMs)}`,
          `TPS: ${modelBenchmark.tokensPerSecond?.toFixed(2) ?? "n/a"} output tok/s`,
          `Output tokens: ${modelBenchmark.outputTokens} (${modelBenchmark.outputTokenSource})`,
          `Output size: ${modelBenchmark.contentChars} chars`,
          `Generation window: ${formatDurationMs(modelBenchmark.generationLatencyMs)}`,
          `Total latency: ${formatDurationMs(modelBenchmark.totalLatencyMs)}`,
          `Stop reason: ${modelBenchmark.stopReason}`,
          `Prompt length: ${modelBenchmark.prompt.length} chars`,
          `Max tokens cap: ${modelBenchmark.maxTokens}`,
        ].join("\n");
      },
      format: formatResult,
      auth: { access: "anyone" as const, behavior: "role-sensitive" as const, note: "Benchmark uses the active profile model." },
      domains: SERVICE_DOMAINS,
      agentScopes: SERVICE_SCOPES,
      examples: ["benchmark model latency", "compare provider performance"],
    }),

    // -----------------------------------------------------------------------
    // service_version
    // -----------------------------------------------------------------------
    defineFunction({
      name: "service_version",
      description:
        "Show the stamped deploy version and current release metadata for this runtime.",
      input: z.object({}),
      handler: async (_input, fnCtx) =>
        await fnCtx.services.deploymentVersion.formatSummary(),
      format: formatResult,
      auth: { access: "anyone" as const, behavior: "uniform" as const, note: "Reads the stamped deploy version metadata for the current runtime." },
      domains: SERVICE_DOMAINS,
      agentScopes: SERVICE_SCOPES,
      examples: ["show deployed version", "inspect current release metadata"],
      untrustedOutput: {
        sourceType: "other",
        sourceName: "service version metadata",
        notes: "Version metadata is generated locally during managed-service deploys.",
      },
    }),

    // -----------------------------------------------------------------------
    // service_changelog_since_version
    // -----------------------------------------------------------------------
    defineFunction({
      name: "service_changelog_since_version",
      description:
        "Show deploy changelog entries whose version is numerically newer than a requested version from the current runtime's DEPLOYMENTS.md metadata.",
      input: serviceChangelogSinceVersionSchema,
      handler: async (input, fnCtx) =>
        await fnCtx.services.deploymentVersion.formatChangelogSinceVersion(
          input.sinceVersion ?? input.version ?? "",
          { limit: input.limit },
        ),
      format: formatResult,
      auth: { access: "anyone" as const, behavior: "uniform" as const, note: "Reads deploy changelog entries whose version is numerically newer than a requested version for the current runtime." },
      domains: SERVICE_DOMAINS,
      agentScopes: SERVICE_SCOPES,
      examples: ["show changelog since version", "list deploy notes after a version"],
      untrustedOutput: {
        sourceType: "other",
        sourceName: "service deployment changelog",
        notes: "Deployment changelog entries are generated locally during managed-service deploys.",
      },
    }),

    // -----------------------------------------------------------------------
    // service_healthcheck
    // -----------------------------------------------------------------------
    defineFunction({
      name: "service_healthcheck",
      description:
        "Run the live managed-service healthcheck by sending a simulated message to the main agent and waiting up to one minute for HEALTHCHECK_OK.",
      input: serviceActionSchema,
      handler: async (input, fnCtx) => {
        const timeoutMs = input.timeoutMs ?? 60_000;
        const result = await fnCtx.services.shell.exec({
          command: buildServiceCommand("healthcheck", timeoutMs),
          timeoutMs: timeoutMs + 15_000,
          sudo: requiresPrivilegedServiceControl(fnCtx.services.runtimePlatform, "healthcheck"),
        });
        return renderShellExecResult(result);
      },
      format: formatResult,
      auth: { access: "root" as const, behavior: "uniform" as const, note: "Sends a simulated healthcheck message through the live local agent process and waits for HEALTHCHECK_OK." },
      domains: SERVICE_DOMAINS,
      agentScopes: SERVICE_SCOPES,
      examples: ["run service healthcheck", "verify the live agent is up"],
      readsWorkspace: true,
      untrustedOutput: {
        sourceType: "shell",
        sourceName: "service healthcheck shell output",
        notes: "Healthcheck command output can echo attacker-controlled content.",
      },
    }),

    // -----------------------------------------------------------------------
    // update_preview
    // -----------------------------------------------------------------------
    defineFunction({
      name: "update_preview",
      description:
        "Sync the source checkout without deploying. Shows pending deploy notes after pulling.",
      input: serviceActionSchema,
      handler: async (input, fnCtx) =>
        runUpdatePreview(input, fnCtx.services),
      format: formatResult,
      auth: { access: "root" as const, behavior: "uniform" as const, note: "Reads the prepared source-root update metadata and changelog entries newer than the running service version." },
      domains: SERVICE_DOMAINS,
      agentScopes: SERVICE_SCOPES,
      examples: ["sync source checkout without deploying", "show pending deploy notes after pulling"],
      readsWorkspace: true,
      untrustedOutput: {
        sourceType: "shell",
        sourceName: "source-sync and deploy-summary output",
        notes: "Pull/update output can echo attacker-controlled content from the remote repository.",
      },
    }),

    // -----------------------------------------------------------------------
    // update
    // -----------------------------------------------------------------------
    defineFunction({
      name: "update",
      description:
        "Deploy the already prepared source version into the local managed installation and verify it with the service healthcheck.",
      input: serviceActionSchema,
      handler: async (input, fnCtx) =>
        runUpdate(input, fnCtx.services),
      format: formatResult,
      auth: { access: "root" as const, behavior: "uniform" as const, note: "Applies the latest prepared local update to the managed service, runs the healthcheck, and rolls back on failure." },
      domains: SERVICE_DOMAINS,
      agentScopes: SERVICE_SCOPES,
      examples: ["deploy prepared update", "apply the latest prepared service version"],
      mutatesState: true,
      readsWorkspace: true,
      untrustedOutput: {
        sourceType: "shell",
        sourceName: "service update shell output",
        notes: "Service update output can echo attacker-controlled content from local scripts and logs.",
      },
    }),

    // -----------------------------------------------------------------------
    // service_rollback
    // -----------------------------------------------------------------------
    defineFunction({
      name: "service_rollback",
      description:
        "Roll the managed service back to the previously deployed release and verify the restored agent with the same simulated healthcheck.",
      input: serviceActionSchema,
      handler: async (input, fnCtx) => {
        const timeoutMs = input.timeoutMs ?? 60_000;
        const result = await fnCtx.services.shell.exec({
          command: buildServiceCommand("rollback", timeoutMs, {
            notifyDiscordUserId: input.notifyDiscordUserId,
          }),
          timeoutMs: timeoutMs + 180_000,
          sudo: requiresPrivilegedServiceControl(fnCtx.services.runtimePlatform, "rollback"),
        });
        return `${renderShellExecResult(result)}${describeServiceTransition("rollback")}`;
      },
      format: formatResult,
      auth: { access: "root" as const, behavior: "uniform" as const, note: "Restarts the managed service on the previous release and verifies it with the healthcheck." },
      domains: SERVICE_DOMAINS,
      agentScopes: SERVICE_SCOPES,
      examples: ["roll back the service", "restore the previous deployed version"],
      mutatesState: true,
      readsWorkspace: true,
      untrustedOutput: {
        sourceType: "shell",
        sourceName: "service rollback shell output",
        notes: "Rollback command output can echo attacker-controlled content.",
      },
    }),

    // -----------------------------------------------------------------------
    // restart
    // -----------------------------------------------------------------------
    defineFunction({
      name: "restart",
      description:
        "Restart the managed service process. The current process will exit and the service manager will start a fresh instance. Running background agents will resume automatically after restart.",
      input: z.object({}),
      handler: async (_input, fnCtx) =>
        fnCtx.services.requestManagedServiceRestart("manual"),
      format: formatResult,
      auth: { access: "root" as const, behavior: "uniform" as const, note: "Restarts the managed service process via the platform service manager." },
      domains: SERVICE_DOMAINS,
      agentScopes: SERVICE_SCOPES,
      mutatesState: true,
    }),
  ];
};
