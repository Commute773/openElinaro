import fs from "node:fs";
import type { ProfileRecord } from "../domain/profiles";
import type { SubagentProvider, SubagentRun } from "../domain/subagent-run";
import type { ProfileService } from "../services/profiles";
import type { ProjectWorkspaceService } from "../services/project-workspace-service";
import { getRuntimeConfig } from "../config/runtime-config";
import { resolveRuntimePath } from "../services/runtime-root";
import { telemetry } from "../services/telemetry";
import { timestamp } from "../utils/timestamp";
import type { AppResponse } from "../domain/assistant";
import type { RuntimeScope } from "./runtime-scope";
import {
  SubagentRegistry,
  SubagentSidecar,
  SubagentTimeoutManager,
  TmuxManager,
  nextSubagentRunId,
  buildClaudeSpawnCommand,
  buildCodexSpawnCommand,
  buildSshWrappedSpawnCommand,
  writeClaudeHooksConfig,
  writeCodexNotifyConfig,
} from "../subagent";
import type { SubagentEvent } from "../subagent";

const DEFAULT_SUBAGENT_TIMEOUT_MS = 3_600_000;

function getSubagentConfig() {
  return getRuntimeConfig().core.app.subagent;
}

function getSidecarSocketPath(): string {
  const configured = getSubagentConfig().sidecarSocketPath;
  return configured || resolveRuntimePath("subagent-sidecar.sock");
}

// --- Completion turn building ---

export function buildSubagentCompletionTurn(activeProfileId: string, run: SubagentRun): string {
  return [
    "Background subagent completion update.",
    `Run id: ${run.id}`,
    `Provider: ${run.provider}`,
    `Profile: ${run.profileId ?? activeProfileId}`,
    `Subagent depth: ${run.launchDepth}`,
    run.completionMessage ?? [
      `Background ${run.provider} agent run ${run.id} ${run.status}.`,
      `Goal: ${run.goal}`,
      run.resultSummary ? `Summary: ${run.resultSummary}` : "",
      run.error ? `Error: ${run.error}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    [
      "Decide what to do next in the main thread.",
      "This completion update was pushed into the parent conversation automatically.",
      `If the same subagent should continue, call resume_agent with runId ${run.id} and optional instructions.`,
      "If more work should happen in a fresh worker, launch a new agent.",
    ].join(" "),
  ]
    .filter(Boolean)
    .join("\n\n");
}

// --- Subagent controller ---

export interface SubagentController {
  launchAgent: (params: {
    goal: string;
    cwd?: string;
    profileId?: string;
    provider?: SubagentProvider;
    originConversationKey?: string;
    requestedBy?: string;
    timeoutMs?: number;
    subagentDepth?: number;
  }) => Promise<SubagentRun>;
  resumeAgent: (params: {
    runId: string;
    message?: string;
    timeoutMs?: number;
  }) => Promise<SubagentRun>;
  steerAgent: (params: {
    runId: string;
    message: string;
  }) => Promise<SubagentRun>;
  cancelAgent: (params: {
    runId: string;
  }) => Promise<SubagentRun>;
  getAgentRun: (runId: string) => SubagentRun | undefined;
  listAgentRuns: () => SubagentRun[];
  captureAgentPane: (runId: string, lines?: number) => Promise<string>;
  /** Read the full terminal buffer (scrollback + visible) for a running agent. */
  readAgentTerminal: (runId: string) => Promise<string>;
  /** List available subagent providers for the source profile, with descriptions. */
  listAvailableProviders: (profileId?: string) => Array<{ provider: "claude" | "codex"; path: string; description?: string }>;
}

export function createSubagentController(ctx: {
  sourceProfileId: string;
  profiles: ProfileService;
  activeProfile: ProfileRecord;
  registry: SubagentRegistry;
  tmux: TmuxManager;
  timeouts: SubagentTimeoutManager;
  sidecar: SubagentSidecar;
  workspaces: ProjectWorkspaceService;
  getScope: (profileId?: string, options?: { mode?: "interactive" | "subagent" }) => RuntimeScope;
  handleRequest: (...args: any[]) => Promise<AppResponse>;
  onBackgroundConversationResponse?: (params: {
    conversationKey: string;
    response: AppResponse;
  }) => Promise<void> | void;
}): SubagentController {
  const {
    sourceProfileId,
    profiles,
    registry,
    tmux,
    timeouts,
    sidecar,
    workspaces,
    getScope,
    handleRequest,
  } = ctx;

  const sourceProfile = profiles.getProfile(sourceProfileId);

  const onTimeout = (runId: string) => {
    const run = registry.get(runId);
    if (run && run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled") {
      const failedRun = registry.markFailed(runId, "Agent timed out.");
      if (failedRun) {
        void injectCompletion(failedRun);
      }
    }
  };

  async function injectCompletion(run: SubagentRun) {
    if (!run.originConversationKey || !run.completionMessage) return;

    try {
      const response = await handleRequest(
        {
          id: `subagent-complete-${run.id}`,
          kind: "chat",
          text: buildSubagentCompletionTurn(ctx.activeProfile.id, run),
          conversationKey: run.originConversationKey,
        },
        {
          onBackgroundResponse: async (queuedResponse: AppResponse) => {
            if (ctx.onBackgroundConversationResponse) {
              await ctx.onBackgroundConversationResponse({
                conversationKey: run.originConversationKey!,
                response: queuedResponse,
              });
            }
          },
          typingEligible: false,
        },
      );

      if (response.mode === "immediate" && ctx.onBackgroundConversationResponse) {
        await ctx.onBackgroundConversationResponse({
          conversationKey: run.originConversationKey,
          response,
        });
      }
    } catch (error) {
      telemetry.recordError(error, {
        conversationKey: run.originConversationKey,
        subagentRunId: run.id,
        operation: "subagent.completion_injection",
      });
    }
  }

  return {
    launchAgent: async (params) => {
      const sourceDepth = params.subagentDepth ?? 0;
      const nextDepth = sourceDepth + 1;
      const maxDepth = profiles.getMaxSubagentDepth(sourceProfile);
      if (nextDepth > maxDepth) {
        throw new Error(
          maxDepth === 0
            ? `Subagents are disabled for profile ${sourceProfile.id}.`
            : `Subagent depth limit reached for profile ${sourceProfile.id}: current depth ${sourceDepth}, max ${maxDepth}.`,
        );
      }

      const targetProfileId = params.profileId?.trim() || sourceProfileId;
      const targetProfile = profiles.getProfile(targetProfileId);
      profiles.assertCanSpawnProfile(sourceProfile, targetProfile);

      // Resolve provider
      const provider: SubagentProvider = params.provider
        ?? profiles.resolveSubagentProvider(targetProfile);
      const isSsh = profiles.isSshExecutionProfile(targetProfile);
      const binaryPath = profiles.getSubagentBinaryPath(targetProfile, provider);
      if (!binaryPath) {
        throw new Error(
          `No ${provider} binary path configured for profile ${targetProfileId}. Set subagentPaths.${provider} in the profile registry.`,
        );
      }
      // Skip local binary existence check for SSH profiles — the binary lives on the remote machine
      if (!isSsh && !fs.existsSync(binaryPath)) {
        throw new Error(`Subagent binary not found: ${binaryPath}`);
      }

      // Resolve workspace
      const targetScope = getScope(targetProfileId);
      const baseWorkspaceCwd = targetScope.access.assertPathAccess(params.cwd ?? process.cwd());

      const runId = nextSubagentRunId();
      const config = getSubagentConfig();
      const timeoutMs = params.timeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;

      // Create isolated worktree
      let workspaceCwd = baseWorkspaceCwd;
      let worktreeRoot: string | undefined;
      let worktreeBranch: string | undefined;
      let sourceWorkspaceCwd: string | undefined;

      if (!profiles.isSshExecutionProfile(targetProfile)) {
        const isolatedWorkspace = workspaces.ensureIsolatedWorkspace({
          cwd: baseWorkspaceCwd,
          runId,
          goal: params.goal,
          profileId: targetProfileId,
        });
        if (isolatedWorkspace) {
          workspaceCwd = isolatedWorkspace.workspaceCwd;
          worktreeRoot = isolatedWorkspace.worktreeRoot;
          worktreeBranch = isolatedWorkspace.branch;
          sourceWorkspaceCwd = isolatedWorkspace.sourceWorkspaceCwd;
        }
      }

      // Write hook/notify config — skip for SSH profiles since hooks reference
      // the local sidecar Unix socket which is unreachable from the remote machine.
      // Completion detection for SSH profiles relies on the early health check
      // (tmux process alive check) and the timeout system.
      const socketPath = sidecar.socketPath;
      let hooksSettingsPath: string | undefined;
      let notifyScriptPath: string | undefined;
      if (!isSsh) {
        if (provider === "claude") {
          const hookResult = writeClaudeHooksConfig({ runId, worktreeCwd: workspaceCwd, sidecarSocketPath: socketPath });
          hooksSettingsPath = hookResult.settingsPath;
        } else {
          notifyScriptPath = writeCodexNotifyConfig({ runId, sidecarSocketPath: socketPath });
        }
      }

      // Build spawn command
      let spawnCommand = provider === "claude"
        ? buildClaudeSpawnCommand({
            runId,
            provider,
            binaryPath,
            goal: params.goal,
            cwd: workspaceCwd,
            profileId: targetProfileId,
            sidecarSocketPath: socketPath,
            timeoutMs,
            hooksSettingsPath,
          })
        : buildCodexSpawnCommand({
            runId,
            provider,
            binaryPath,
            goal: params.goal,
            cwd: workspaceCwd,
            profileId: targetProfileId,
            sidecarSocketPath: socketPath,
            timeoutMs,
            notifyScriptPath,
          });

      // For SSH profiles, wrap the spawn command in an SSH invocation so the
      // agent binary runs on the remote machine instead of locally.
      if (isSsh) {
        const execution = profiles.getExecution(targetProfile);
        if (!execution || execution.kind !== "ssh") {
          throw new Error(`Profile ${targetProfileId} is marked as SSH but has no SSH execution config.`);
        }
        const { privateKeyPath } = profiles.ensureProfileSshKeyPair(targetProfile);
        spawnCommand = buildSshWrappedSpawnCommand({
          innerCommand: spawnCommand,
          host: execution.host,
          user: execution.user,
          port: execution.port,
          keyPath: privateKeyPath,
          remoteCwd: workspaceCwd,
        });
      }

      // Create run record
      const run = registry.create({
        id: runId,
        profileId: targetProfileId,
        provider,
        goal: params.goal,
        tmuxSession: config.tmuxSession,
        tmuxWindow: runId,
        workspaceCwd,
        worktreeRoot,
        worktreeBranch,
        sourceWorkspaceCwd,
        originConversationKey: params.originConversationKey,
        requestedBy: params.requestedBy,
        launchDepth: nextDepth,
        timeoutMs,
      });

      // Spawn in tmux — for SSH profiles, use a local fallback cwd since the
      // real working directory is on the remote machine (handled inside the SSH command).
      const tmuxCwd = isSsh ? "/tmp" : workspaceCwd;
      await tmux.runInWindow(runId, spawnCommand, tmuxCwd);
      registry.markStarted(runId);

      // Register timeout
      timeouts.register(runId, timeoutMs, onTimeout);

      // Schedule early health check: if the process dies in the first few
      // seconds without firing hooks, we capture the pane output and mark
      // the run as failed so the error is never silently swallowed.
      const EARLY_HEALTH_CHECK_MS = 5_000;
      setTimeout(async () => {
        try {
          const currentRun = registry.get(runId);
          if (!currentRun) return;
          if (currentRun.status === "completed" || currentRun.status === "failed" || currentRun.status === "cancelled") return;

          const alive = await tmux.isWindowProcessAlive(runId);
          if (alive) return;

          // Process died without firing hooks — capture pane for diagnostics
          let paneOutput = "";
          try {
            paneOutput = await tmux.capturePane(runId, 100);
          } catch {
            // best effort
          }
          // Clean up remain-on-exit window
          await tmux.killWindow(runId);

          const errorParts = [`Agent process exited early without reporting completion (provider: ${provider}).`];
          if (paneOutput) {
            errorParts.push(`Terminal output:\n${paneOutput}`);
          } else {
            errorParts.push("No terminal output was captured. The process may have crashed on startup. Check that the binary path is correct and API keys are configured.");
          }

          timeouts.clear(runId);
          const failedRun = registry.markFailed(runId, errorParts.join("\n"));
          if (failedRun) {
            void injectCompletion(failedRun);
          }
        } catch (error) {
          telemetry.recordError(error, {
            runId,
            operation: "subagent.early_health_check",
          });
        }
      }, EARLY_HEALTH_CHECK_MS);

      telemetry.event("subagent.launched", {
        runId,
        provider,
        profileId: targetProfileId,
        launchDepth: nextDepth,
        workspaceCwd,
      });

      return registry.get(runId) ?? run;
    },

    resumeAgent: async (params) => {
      const existingRun = registry.get(params.runId);
      if (!existingRun) {
        throw new Error(`No subagent run found for ${params.runId}.`);
      }
      if (existingRun.status === "running" || existingRun.status === "starting") {
        throw new Error(`Subagent run ${params.runId} is already running.`);
      }
      if (existingRun.status === "cancelled") {
        throw new Error(`Subagent run ${params.runId} was cancelled and cannot be resumed.`);
      }

      const message = params.message?.trim()
        || "Continue from the current repository state and finish the next remaining work under the original goal.";
      const fullGoal = `Continue previous work.\n\nOriginal goal: ${existingRun.goal}\n\nFollow-up instruction: ${message}`;

      const config = getSubagentConfig();
      const timeoutMs = params.timeoutMs ?? existingRun.timeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_SUBAGENT_TIMEOUT_MS;

      const resumeTargetProfile = profiles.getProfile(existingRun.profileId);
      const isResumeSsh = profiles.isSshExecutionProfile(resumeTargetProfile);
      const binaryPath = profiles.getSubagentBinaryPath(
        resumeTargetProfile,
        existingRun.provider,
      );
      if (!binaryPath) {
        throw new Error(`No ${existingRun.provider} binary path configured for profile ${existingRun.profileId}.`);
      }

      // Re-write hooks (in case socket path changed) — skip for SSH profiles
      const socketPath = sidecar.socketPath;
      let resumeHooksSettingsPath: string | undefined;
      let resumeNotifyScriptPath: string | undefined;
      if (!isResumeSsh) {
        if (existingRun.provider === "claude") {
          const hookResult = writeClaudeHooksConfig({
            runId: existingRun.id,
            worktreeCwd: existingRun.workspaceCwd,
            sidecarSocketPath: socketPath,
          });
          resumeHooksSettingsPath = hookResult.settingsPath;
        } else {
          resumeNotifyScriptPath = writeCodexNotifyConfig({
            runId: existingRun.id,
            sidecarSocketPath: socketPath,
          });
        }
      }

      let spawnCommand = existingRun.provider === "claude"
        ? buildClaudeSpawnCommand({
            runId: existingRun.id,
            provider: existingRun.provider,
            binaryPath,
            goal: fullGoal,
            cwd: existingRun.workspaceCwd,
            profileId: existingRun.profileId,
            sidecarSocketPath: socketPath,
            timeoutMs,
            hooksSettingsPath: resumeHooksSettingsPath,
          })
        : buildCodexSpawnCommand({
            runId: existingRun.id,
            provider: existingRun.provider,
            binaryPath,
            goal: fullGoal,
            cwd: existingRun.workspaceCwd,
            profileId: existingRun.profileId,
            sidecarSocketPath: socketPath,
            timeoutMs,
            notifyScriptPath: resumeNotifyScriptPath,
          });

      // Wrap in SSH for SSH profiles
      if (isResumeSsh) {
        const execution = profiles.getExecution(resumeTargetProfile);
        if (!execution || execution.kind !== "ssh") {
          throw new Error(`Profile ${existingRun.profileId} is marked as SSH but has no SSH execution config.`);
        }
        const { privateKeyPath } = profiles.ensureProfileSshKeyPair(resumeTargetProfile);
        spawnCommand = buildSshWrappedSpawnCommand({
          innerCommand: spawnCommand,
          host: execution.host,
          user: execution.user,
          port: execution.port,
          keyPath: privateKeyPath,
          remoteCwd: existingRun.workspaceCwd,
        });
      }

      // Kill old window if it exists
      await tmux.killWindow(existingRun.id);

      // Reset run state
      const resumedRun = registry.save({
        ...existingRun,
        status: "starting",
        startedAt: undefined,
        completedAt: undefined,
        resultSummary: undefined,
        completionMessage: undefined,
        error: undefined,
        timeoutMs,
        eventLog: [
          ...existingRun.eventLog,
          { kind: "worker.started", timestamp: timestamp(), summary: `Resumed: ${message}` },
        ],
      });

      // Spawn in tmux — local fallback cwd for SSH profiles
      const resumeTmuxCwd = isResumeSsh ? "/tmp" : existingRun.workspaceCwd;
      await tmux.runInWindow(existingRun.id, spawnCommand, resumeTmuxCwd);
      registry.markStarted(existingRun.id);
      timeouts.register(existingRun.id, timeoutMs, onTimeout);

      return registry.get(existingRun.id) ?? resumedRun;
    },

    steerAgent: async (params) => {
      const run = registry.get(params.runId);
      if (!run) {
        throw new Error(`No subagent run found for ${params.runId}.`);
      }
      if (run.status !== "running" && run.status !== "starting") {
        throw new Error(`Subagent run ${params.runId} is not running (status: ${run.status}).`);
      }

      const message = params.message.trim();
      if (!message) {
        throw new Error("Steering message is required.");
      }

      await tmux.sendKeys(run.id, message);

      return registry.appendEvent(run.id, {
        kind: "worker.progress",
        timestamp: timestamp(),
        summary: `Steered: ${message.slice(0, 200)}`,
      }) ?? run;
    },

    cancelAgent: async (params) => {
      const run = registry.get(params.runId);
      if (!run) {
        throw new Error(`No subagent run found for ${params.runId}.`);
      }
      if (run.status !== "running" && run.status !== "starting") {
        throw new Error(`Subagent run ${params.runId} is not running (status: ${run.status}).`);
      }

      timeouts.clear(run.id);
      await tmux.killWindow(run.id);
      const cancelledRun = registry.markCancelled(run.id);

      if (cancelledRun) {
        void injectCompletion(cancelledRun);
      }

      return cancelledRun ?? run;
    },

    getAgentRun: (runId) => registry.get(runId),

    listAgentRuns: () => registry.list(),

    captureAgentPane: async (runId, lines = 50) => {
      const run = registry.get(runId);
      if (!run) return "";
      const hasWindow = await tmux.hasWindow(run.id);
      if (!hasWindow) return "(tmux window no longer exists)";
      return tmux.capturePane(run.id, lines);
    },

    readAgentTerminal: async (runId) => {
      const run = registry.get(runId);
      if (!run) return `No agent run found for ${runId}.`;
      const hasWindow = await tmux.hasWindow(run.id);
      if (!hasWindow) return "(tmux window no longer exists)";
      return tmux.readTerminal(run.id);
    },

    listAvailableProviders: (profileId) => {
      const targetProfileId = profileId?.trim() || sourceProfileId;
      const targetProfile = profiles.getProfile(targetProfileId);
      return profiles.listAvailableSubagents(targetProfile);
    },
  };
}

/**
 * On startup, recover any in-flight runs by checking if their tmux
 * windows still exist.
 */
export async function recoverSubagentRuns(ctx: {
  registry: SubagentRegistry;
  tmux: TmuxManager;
  timeouts: SubagentTimeoutManager;
  onTimeout: (runId: string) => void;
}): Promise<void> {
  const { registry, tmux, timeouts, onTimeout } = ctx;

  for (const run of registry.list()) {
    if (run.status !== "running" && run.status !== "starting") continue;

    const hasWindow = await tmux.hasWindow(run.id);
    if (hasWindow) {
      // Agent is still alive in tmux - re-register timeout for remaining time
      const elapsed = Date.now() - Date.parse(run.startedAt ?? run.createdAt);
      const remaining = Math.max(1000, run.timeoutMs - elapsed);
      timeouts.register(run.id, remaining, onTimeout);
    } else {
      // Agent process was lost
      registry.markFailed(run.id, "Agent process lost during runtime restart.");
    }
  }
}
