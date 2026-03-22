import type { ProfileRecord } from "../domain/profiles";
import { getExecutionBatch, isPlanComplete } from "../domain/task-plan";
import type { WorkflowRun } from "../domain/workflow-run";
import { executeWorkflowRun } from "../orchestration/workflow-graph";
import type { ProfileService } from "../services/profile-service";
import type { ProjectWorkspaceService } from "../services/project-workspace-service";
import type { ServiceRestartNoticeService } from "../services/service-restart-notice-service";
import type { SystemPromptService } from "../services/system-prompt-service";
import { nextWorkflowRunId, type WorkflowRegistry } from "../services/workflow-registry";
import type { WorkflowSessionStore } from "../services/workflow-session-store";
import { DEFAULT_CODING_AGENT_TIMEOUT_MS } from "../services/tool-defaults";
import { WORKFLOW_DEFAULT_STUCK_AFTER_MS as DEFAULT_WORKFLOW_STUCK_AFTER_MS } from "../config/service-constants";
import { telemetry } from "../services/telemetry";
import { timestamp } from "../utils/timestamp";
import { getRuntimeConfig } from "../config/runtime-config";
import type { AppResponse } from "../domain/assistant";
import type { RuntimeScope } from "./runtime-scope";

export function buildBackgroundAgentAssistantContext(
  profile: ProfileRecord,
  profileService: ProfileService,
  projects: RuntimeScope["projects"],
) {
  return [
    "Execution mode: background coding subagent.",
    "System: OpenElinaro local-first agent runtime.",
    "Parent-child flow: this run was launched by a foreground agent and completion is reported back into the parent conversation automatically.",
    profileService.buildAssistantContext(profile),
    projects.buildAssistantContext(),
    "Background coding subagents do not get automatic per-turn memory recall.",
    "When the assigned workspace is a local git repo, the runtime forks this run into an isolated linked worktree before planner or worker execution starts.",
    "Tool visibility is limited to the coding planner/worker scope for this run. If a needed tool family is not visible, call load_tool_library before guessing; if it still is not available, continue within the visible toolset.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const DEFAULT_SUBAGENT_RESUME_INSTRUCTION =
  "Continue from the current repository state and finish the next remaining work under the original goal. Only return when that work is actually complete or you hit a concrete blocker.";

function getWorkflowStuckAfterMs() {
  const configured = getRuntimeConfig().core.app.workflow.stuckAfterMs;
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_WORKFLOW_STUCK_AFTER_MS;
}

export function canViewWorkflowRun(
  profiles: ProfileService,
  activeProfile: ProfileRecord,
  profile: ProfileRecord,
  run: WorkflowRun,
) {
  const targetProfile = profiles.getProfile(run.profileId ?? activeProfile.id);
  return profiles.canSpawnProfile(profile, targetProfile);
}

export function getWorkflowView(
  workflowSessions: WorkflowSessionStore,
  run: WorkflowRun,
): WorkflowRun {
  if (run.kind !== "coding-agent" || run.status !== "running") {
    return run;
  }

  const sessionUpdatedAt = run.currentSessionId
    ? workflowSessions.get(run.currentSessionId)?.updatedAt
    : undefined;
  const taskUpdatedAt = (run.taskReports ?? [])
    .map((report) => report.updatedAt)
    .filter((value): value is string => typeof value === "string")
    .sort((left, right) => right.localeCompare(left))[0];
  const lastProgressAt = [run.lastProgressAt, sessionUpdatedAt, taskUpdatedAt, run.executionStartedAt]
    .filter((value): value is string => typeof value === "string")
    .sort((left, right) => right.localeCompare(left))[0];

  if (run.runningState === "backoff") {
    return {
      ...run,
      lastProgressAt: lastProgressAt ?? run.lastProgressAt,
      stuckSinceAt: undefined,
      stuckReason: undefined,
    };
  }

  const referenceAt = lastProgressAt ?? run.executionStartedAt ?? run.updatedAt ?? run.createdAt;
  const referenceMs = Date.parse(referenceAt);
  const isStuck = Number.isFinite(referenceMs)
    && (Date.now() - referenceMs) >= getWorkflowStuckAfterMs();

  return {
    ...run,
    runningState: isStuck ? "stuck" : "active",
    lastProgressAt: lastProgressAt ?? run.lastProgressAt,
    stuckSinceAt: isStuck
      ? (run.stuckSinceAt ?? new Date(referenceMs + getWorkflowStuckAfterMs()).toISOString())
      : undefined,
    stuckReason: isStuck
      ? "No recorded tool calls or task completions within the configured stuck threshold."
      : undefined,
  };
}

export function buildWorkflowCompletionTurn(activeProfileId: string, run: WorkflowRun) {
  return [
    "Background subagent completion update.",
    `Run id: ${run.id}`,
    `Profile: ${run.profileId ?? activeProfileId}`,
    `Subagent depth: ${run.launchDepth ?? 1}`,
    run.completionMessage ?? [
      `Background coding agent run ${run.id} ${run.status}.`,
      `Goal: ${run.goal}`,
      run.resultSummary ? `Summary: ${run.resultSummary}` : "",
      run.error ? `Error: ${run.error}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    [
      "Decide what to do next in the main thread.",
      "This completion update was pushed into the parent conversation automatically.",
      "Do not keep polling workflow_status waiting for this run to finish.",
      "Use workflow_status only for occasional manual spot checks or if you suspect an update was missed.",
      "If the user should be informed, say so directly.",
      `If the same subagent should continue, call resume_coding_agent with runId ${run.id} and optional instructions.`,
      "If more work should happen in a fresh worker instead, you may launch follow-up work.",
    ].join(" "),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function createWorkflowController(ctx: {
  sourceProfileId: string;
  profiles: ProfileService;
  activeProfile: ProfileRecord;
  appTelemetry: typeof telemetry;
  registry: WorkflowRegistry;
  workflowSessions: WorkflowSessionStore;
  workspaces: ProjectWorkspaceService;
  systemPrompts: SystemPromptService;
  activeWorkflowControllers: Map<string, AbortController>;
  backgroundRetryTimer: { current: ReturnType<typeof setTimeout> | null };
  getScope: (profileId?: string, options?: { mode?: "interactive" | "subagent" }) => RuntimeScope;
  handleRequest: (...args: any[]) => Promise<AppResponse>;
  onBackgroundConversationResponse?: (params: {
    conversationKey: string;
    response: AppResponse;
  }) => Promise<void> | void;
}) {
  const {
    sourceProfileId,
    profiles,
    activeProfile,
    appTelemetry,
    registry,
    workflowSessions,
    workspaces,
    systemPrompts,
    activeWorkflowControllers,
    backgroundRetryTimer,
    getScope,
    handleRequest,
  } = ctx;

  const sourceProfile = profiles.getProfile(sourceProfileId);

  const startWorkflowRunFn = (run: WorkflowRun) =>
    startWorkflowRun({
      run,
      appTelemetry,
      registry,
      workflowSessions,
      systemPrompts,
      profiles,
      activeProfile,
      activeWorkflowControllers,
      backgroundRetryTimer,
      getScope,
      handleRequest,
      onBackgroundConversationResponse: ctx.onBackgroundConversationResponse,
    });

  const kickFn = () =>
    kickBackgroundRunner({
      registry,
      activeWorkflowControllers,
      backgroundRetryTimer,
      appTelemetry,
      workflowSessions,
      systemPrompts,
      profiles,
      activeProfile,
      getScope,
      handleRequest,
      onBackgroundConversationResponse: ctx.onBackgroundConversationResponse,
    });

  return {
    launchCodingAgent: (params: {
      goal: string;
      cwd?: string;
      profileId?: string;
      originConversationKey?: string;
      requestedBy?: string;
      timeoutMs?: number;
      subagentDepth?: number;
    }) => {
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
      const targetScope = getScope(targetProfileId);
      const baseWorkspaceCwd = targetScope.access.assertPathAccess(params.cwd ?? process.cwd());
      const runId = nextWorkflowRunId();
      let workspaceCwd = baseWorkspaceCwd;
      const launchLog: string[] = [];
      if (!profiles.isSshExecutionProfile(targetProfile)) {
        const isolatedWorkspace = workspaces.ensureIsolatedWorkspace({
          cwd: baseWorkspaceCwd,
          runId,
          goal: params.goal,
          profileId: targetProfileId,
        });
        if (isolatedWorkspace) {
          workspaceCwd = isolatedWorkspace.workspaceCwd;
          launchLog.push(
            `Source workspace: ${isolatedWorkspace.sourceWorkspaceCwd}`,
            `Allocated linked worktree: ${isolatedWorkspace.worktreeRoot}`,
            `Isolated branch: ${isolatedWorkspace.branch}`,
          );
        }
      }
      const run = registry.enqueueCodingAgent({
        id: runId,
        profileId: targetProfileId,
        goal: params.goal,
        workspaceCwd,
        originConversationKey: params.originConversationKey,
        requestedBy: params.requestedBy,
        timeoutMs: params.timeoutMs ?? DEFAULT_CODING_AGENT_TIMEOUT_MS,
        launchDepth: nextDepth,
      });
      const savedRun = launchLog.length > 0
        ? registry.save({
            ...run,
            updatedAt: timestamp(),
            executionLog: run.executionLog.concat(launchLog),
          })
        : run;
      startWorkflowRunFn(savedRun);
      return savedRun;
    },
    resumeCodingAgent: (params: {
      runId: string;
      message?: string;
      timeoutMs?: number;
    }) => {
      const existingRun = registry.get(params.runId);
      if (!existingRun || !canViewWorkflowRun(profiles, activeProfile, sourceProfile, existingRun)) {
        throw new Error(`No workflow run found for ${params.runId}.`);
      }
      if (existingRun.kind !== "coding-agent") {
        throw new Error(`Workflow run ${params.runId} is not a coding-agent run.`);
      }
      if (existingRun.status === "running") {
        throw new Error(`Workflow run ${params.runId} is already running.`);
      }

      const followUpMessage = params.message?.trim();
      const canContinueExistingPlan = Boolean(
        existingRun.plan
          && !isPlanComplete(existingRun.plan)
          && getExecutionBatch(existingRun.plan).mode !== "idle",
      );
      const shouldReusePlan = !followUpMessage && canContinueExistingPlan;
      const pendingParentInstructions = shouldReusePlan
        ? existingRun.pendingParentInstructions
        : [
            ...(existingRun.pendingParentInstructions ?? []),
            followUpMessage || DEFAULT_SUBAGENT_RESUME_INSTRUCTION,
          ];
      const resumedRun: WorkflowRun = {
        ...existingRun,
        status: "running",
        runningState: "active",
        updatedAt: timestamp(),
        executionStartedAt: timestamp(),
        currentSessionId: undefined,
        currentTaskId: undefined,
        nextAttemptAt: undefined,
        retryCount: 0,
        lastProgressAt: timestamp(),
        stuckSinceAt: undefined,
        stuckReason: undefined,
        timeoutMs: params.timeoutMs ?? existingRun.timeoutMs ?? DEFAULT_CODING_AGENT_TIMEOUT_MS,
        plan: shouldReusePlan ? existingRun.plan : undefined,
        pendingParentInstructions,
        taskIssueCount: shouldReusePlan ? existingRun.taskIssueCount : 0,
        taskErrorCount: shouldReusePlan ? existingRun.taskErrorCount : 0,
        consecutiveTaskErrorCount: shouldReusePlan ? existingRun.consecutiveTaskErrorCount : 0,
        resultSummary: undefined,
        completionMessage: undefined,
        error: undefined,
        executionLog: existingRun.executionLog.concat(
          [
            "Main agent resumed the coding run.",
            followUpMessage
              ? `Parent instruction: ${followUpMessage}`
              : shouldReusePlan
              ? "Parent requested the existing plan to continue without replanning."
              : "Parent requested the coding agent to keep going from the current repository state.",
          ].join(" "),
        ),
      };
      registry.save(resumedRun);
      startWorkflowRunFn(resumedRun);
      return resumedRun;
    },
    steerCodingAgent: (params: {
      runId: string;
      message: string;
    }) => {
      const existingRun = registry.get(params.runId);
      if (!existingRun || !canViewWorkflowRun(profiles, activeProfile, sourceProfile, existingRun)) {
        throw new Error(`No workflow run found for ${params.runId}.`);
      }
      if (existingRun.kind !== "coding-agent") {
        throw new Error(`Workflow run ${params.runId} is not a coding-agent run.`);
      }

      const message = params.message.trim();
      if (!message) {
        throw new Error("Steering message is required.");
      }

      const nextRun: WorkflowRun = {
        ...existingRun,
        updatedAt: timestamp(),
        pendingParentInstructions:
          !existingRun.currentSessionId
            ? [...(existingRun.pendingParentInstructions ?? []), message]
            : existingRun.pendingParentInstructions,
        executionLog: existingRun.executionLog.concat(`Parent steering message: ${message}`),
      };

      if (existingRun.currentSessionId) {
        workflowSessions.appendHumanMessage(
          existingRun.currentSessionId,
          [
            "Parent steering message.",
            "This is a new instruction from the parent agent. Re-prioritize accordingly on the next step.",
            message,
          ].join("\n\n"),
        );
      }

      registry.save(nextRun);
      return nextRun;
    },
    cancelCodingAgent: (params: {
      runId: string;
    }) => {
      const existingRun = registry.get(params.runId);
      if (!existingRun || !canViewWorkflowRun(profiles, activeProfile, sourceProfile, existingRun)) {
        throw new Error(`No workflow run found for ${params.runId}.`);
      }
      if (existingRun.kind !== "coding-agent") {
        throw new Error(`Workflow run ${params.runId} is not a coding-agent run.`);
      }
      if (existingRun.status === "queued" || existingRun.status === "interrupted") {
        const cancelledRun: WorkflowRun = {
          ...existingRun,
          status: "cancelled",
          runningState: undefined,
          updatedAt: timestamp(),
          resultSummary: "Coding agent run was cancelled by the parent agent before execution started.",
          completionMessage: [
            `Background coding agent run ${existingRun.id} cancelled.`,
            `Goal: ${existingRun.goal}`,
            "Summary: Coding agent run was cancelled by the parent agent before execution started.",
          ].join("\n"),
          error: "Cancelled before execution started.",
          executionLog: existingRun.executionLog.concat("Parent agent cancelled the pending coding run."),
        };
        registry.save(cancelledRun);
        return cancelledRun;
      }
      if (existingRun.status !== "running") {
        throw new Error(`Workflow run ${params.runId} is not running.`);
      }

      if (!activeWorkflowControllers.has(existingRun.id)) {
        const cancelledRun: WorkflowRun = {
          ...existingRun,
          status: "cancelled",
          runningState: undefined,
          updatedAt: timestamp(),
          resultSummary: "Coding agent run was cancelled while waiting for automatic retry or recovery.",
          completionMessage: [
            `Background coding agent run ${existingRun.id} cancelled.`,
            `Goal: ${existingRun.goal}`,
            "Summary: Coding agent run was cancelled while waiting for automatic retry or recovery.",
          ].join("\n"),
          error: "Cancelled before automatic retry or recovery.",
          executionLog: existingRun.executionLog.concat("Parent agent cancelled the waiting coding run."),
        };
        registry.save(cancelledRun);
        kickFn();
        return cancelledRun;
      }

      activeWorkflowControllers.get(existingRun.id)?.abort();
      const pendingCancelRun: WorkflowRun = {
        ...existingRun,
        updatedAt: timestamp(),
        executionLog: existingRun.executionLog.concat("Parent agent requested cancellation."),
      };
      registry.save(pendingCancelRun);
      return pendingCancelRun;
    },
    getWorkflowRun: (runId: string) => {
      const run = registry.get(runId);
      if (!run || !canViewWorkflowRun(profiles, activeProfile, sourceProfile, run)) {
        return undefined;
      }
      return getWorkflowView(workflowSessions, run);
    },
    listWorkflowRuns: () =>
      registry.list()
        .filter((run) => canViewWorkflowRun(profiles, activeProfile, sourceProfile, run))
        .map((run) => getWorkflowView(workflowSessions, run)),
  };
}

export function startWorkflowRun(ctx: {
  run: WorkflowRun;
  appTelemetry: typeof telemetry;
  registry: WorkflowRegistry;
  workflowSessions: WorkflowSessionStore;
  systemPrompts: SystemPromptService;
  profiles: ProfileService;
  activeProfile: ProfileRecord;
  activeWorkflowControllers: Map<string, AbortController>;
  backgroundRetryTimer: { current: ReturnType<typeof setTimeout> | null };
  getScope: (profileId?: string, options?: { mode?: "interactive" | "subagent" }) => RuntimeScope;
  handleRequest: (...args: any[]) => Promise<AppResponse>;
  onBackgroundConversationResponse?: (params: {
    conversationKey: string;
    response: AppResponse;
  }) => Promise<void> | void;
}): void {
  const {
    run,
    appTelemetry,
    registry,
    workflowSessions,
    systemPrompts,
    profiles,
    activeProfile,
    activeWorkflowControllers,
    backgroundRetryTimer,
    getScope,
    handleRequest,
  } = ctx;

  if (activeWorkflowControllers.has(run.id)) {
    return;
  }

  const scope = getScope(run.profileId ?? activeProfile.id, {
    mode: "subagent",
  });
  const controller = new AbortController();
  activeWorkflowControllers.set(run.id, controller);

  void (async () => {
    let finalRun: WorkflowRun;
    try {
      finalRun = await executeWorkflowRun(run, {
        connector: scope.connector,
        toolResolver: scope.toolResolver,
        shell: scope.shell,
        workflowSessions,
        baseSystemPrompt: systemPrompts.load().text,
        assistantContext: buildBackgroundAgentAssistantContext(
          scope.profile,
          profiles,
          scope.projects,
        ),
        abortSignal: controller.signal,
        onRunUpdate: (updatedRun) => {
          registry.save(getWorkflowView(workflowSessions, updatedRun));
        },
      });
    } catch (error) {
      finalRun = registry.createFailedRun(registry.get(run.id) ?? run, error);
    } finally {
      activeWorkflowControllers.delete(run.id);
    }

    const savedRun = registry.save(getWorkflowView(workflowSessions, finalRun));
    if (savedRun.status === "completed" || savedRun.status === "failed" || savedRun.status === "cancelled") {
      await injectWorkflowCompletion({
        run: savedRun,
        activeProfileId: activeProfile.id,
        appTelemetry,
        handleRequest,
        onBackgroundConversationResponse: ctx.onBackgroundConversationResponse,
      });
    }
    kickBackgroundRunner({
      registry,
      activeWorkflowControllers,
      backgroundRetryTimer,
      appTelemetry,
      workflowSessions,
      systemPrompts,
      profiles,
      activeProfile,
      getScope,
      handleRequest,
      onBackgroundConversationResponse: ctx.onBackgroundConversationResponse,
    });
  })().catch((error) => {
    appTelemetry.recordError(error, {
      workflowRunId: run.id,
      operation: "app.workflow_runner",
    });
    kickBackgroundRunner({
      registry,
      activeWorkflowControllers,
      backgroundRetryTimer,
      appTelemetry,
      workflowSessions,
      systemPrompts,
      profiles,
      activeProfile,
      getScope,
      handleRequest,
      onBackgroundConversationResponse: ctx.onBackgroundConversationResponse,
    });
  });
}

async function notifyConversationBackgroundResponse(
  appTelemetry: typeof telemetry,
  conversationKey: string,
  response: AppResponse,
  onBackgroundConversationResponse?: (params: {
    conversationKey: string;
    response: AppResponse;
  }) => Promise<void> | void,
) {
  if (!onBackgroundConversationResponse) {
    return;
  }
  try {
    await onBackgroundConversationResponse({
      conversationKey,
      response,
    });
  } catch (error) {
    appTelemetry.recordError(error, {
      conversationKey,
      requestId: response.requestId,
      operation: "app.background_conversation_notifier",
    });
  }
}

export async function injectWorkflowCompletion(ctx: {
  run: WorkflowRun;
  activeProfileId: string;
  appTelemetry: typeof telemetry;
  handleRequest: (...args: any[]) => Promise<AppResponse>;
  onBackgroundConversationResponse?: (params: {
    conversationKey: string;
    response: AppResponse;
  }) => Promise<void> | void;
}) {
  const { run, activeProfileId, appTelemetry, handleRequest } = ctx;

  if (!run.originConversationKey || !run.completionMessage) {
    return;
  }

  try {
    const response = await handleRequest(
      {
        id: `workflow-complete-${run.id}`,
        kind: "chat",
        text: buildWorkflowCompletionTurn(activeProfileId, run),
        conversationKey: run.originConversationKey,
      },
      {
        onBackgroundResponse: async (queuedResponse: AppResponse) => {
          await notifyConversationBackgroundResponse(
            appTelemetry,
            run.originConversationKey!,
            queuedResponse,
            ctx.onBackgroundConversationResponse,
          );
        },
        typingEligible: false,
      },
    );

    if (response.mode === "immediate") {
      await notifyConversationBackgroundResponse(
        appTelemetry,
        run.originConversationKey,
        response,
        ctx.onBackgroundConversationResponse,
      );
    }
  } catch (error) {
    appTelemetry.recordError(error, {
      conversationKey: run.originConversationKey,
      workflowRunId: run.id,
      operation: "app.workflow_completion_injection",
    });
  }
}

export function injectPendingServiceRestartContinuations(ctx: {
  serviceRestartNotices: ServiceRestartNoticeService;
  registry: WorkflowRegistry;
  workflowSessions: WorkflowSessionStore;
}) {
  const { serviceRestartNotices, registry, workflowSessions } = ctx;
  const notice = serviceRestartNotices.consumePendingNotice();
  if (!notice) {
    return;
  }

  for (const run of registry.listRecoverableRuns()) {
    if (run.kind !== "coding-agent") {
      continue;
    }

    const existingInstructions = run.pendingParentInstructions ?? [];
    let injectedIntoSession = false;
    if (run.currentSessionId) {
      injectedIntoSession = Boolean(
        workflowSessions.appendHumanMessage(run.currentSessionId, notice.message),
      );
    }

    const pendingParentInstructions = injectedIntoSession || existingInstructions.includes(notice.message)
      ? existingInstructions
      : existingInstructions.concat(notice.message);
    const logEntry = [
      "Managed service restart detected.",
      `Source: ${notice.source ?? "unknown"}.`,
      `Requested at: ${notice.requestedAt}.`,
      injectedIntoSession
        ? "Injected continuation note into the persisted workflow session."
        : "Queued continuation note for the next planner turn because no persisted session was available.",
    ].join(" ");
    const executionLog = run.executionLog.includes(logEntry)
      ? run.executionLog
      : run.executionLog.concat(logEntry);
    registry.save({
      ...run,
      pendingParentInstructions,
      executionLog,
      updatedAt: timestamp(),
    });
  }
}

export function kickBackgroundRunner(ctx: {
  registry: WorkflowRegistry;
  activeWorkflowControllers: Map<string, AbortController>;
  backgroundRetryTimer: { current: ReturnType<typeof setTimeout> | null };
  appTelemetry: typeof telemetry;
  workflowSessions: WorkflowSessionStore;
  systemPrompts: SystemPromptService;
  profiles: ProfileService;
  activeProfile: ProfileRecord;
  getScope: (profileId?: string, options?: { mode?: "interactive" | "subagent" }) => RuntimeScope;
  handleRequest: (...args: any[]) => Promise<AppResponse>;
  onBackgroundConversationResponse?: (params: {
    conversationKey: string;
    response: AppResponse;
  }) => Promise<void> | void;
}): void {
  const { registry, backgroundRetryTimer } = ctx;

  if (backgroundRetryTimer.current) {
    clearTimeout(backgroundRetryTimer.current);
    backgroundRetryTimer.current = null;
  }

  for (const run of registry.listRecoverableRuns()) {
    startWorkflowRun({ run, ...ctx });
  }
  scheduleBackgroundRunner(ctx);
}

export function scheduleBackgroundRunner(ctx: {
  registry: WorkflowRegistry;
  backgroundRetryTimer: { current: ReturnType<typeof setTimeout> | null };
  activeWorkflowControllers: Map<string, AbortController>;
  appTelemetry: typeof telemetry;
  workflowSessions: WorkflowSessionStore;
  systemPrompts: SystemPromptService;
  profiles: ProfileService;
  activeProfile: ProfileRecord;
  getScope: (profileId?: string, options?: { mode?: "interactive" | "subagent" }) => RuntimeScope;
  handleRequest: (...args: any[]) => Promise<AppResponse>;
  onBackgroundConversationResponse?: (params: {
    conversationKey: string;
    response: AppResponse;
  }) => Promise<void> | void;
}) {
  const { registry, backgroundRetryTimer } = ctx;

  if (backgroundRetryTimer.current) {
    return;
  }

  const nextAttemptAt = registry.getNextRecoveryAt();
  if (!nextAttemptAt) {
    return;
  }

  const delayMs = Math.max(0, new Date(nextAttemptAt).getTime() - Date.now());
  backgroundRetryTimer.current = setTimeout(() => {
    backgroundRetryTimer.current = null;
    kickBackgroundRunner(ctx);
  }, delayMs);
}
