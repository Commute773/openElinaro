import fs from "node:fs";
import type { AppProgressEvent, AppRequest, AppResponse } from "../domain/assistant";
import type { ProfileRecord } from "../domain/profiles";
import { createTaskPlan, getExecutionBatch, isPlanComplete } from "../domain/task-plan";
import type { WorkflowRun } from "../domain/workflow-run";
import { executeWorkflowRun } from "../orchestration/workflow-graph";
import { ActiveModelConnector } from "../connectors/active-model-connector";
import { AgentChatService } from "../services/agent-chat-service";
import { AccessControlService } from "../services/access-control-service";
import { ConversationStateTransitionService } from "../services/conversation-state-transition-service";
import { ConversationStore } from "../services/conversation-store";
import { FinanceService } from "../services/finance-service";
import { FilesystemService } from "../services/filesystem-service";
import { HealthTrackingService } from "../services/health-tracking-service";
import { MemoryService } from "../services/memory-service";
import { ModelService } from "../services/model-service";
import { ProfileService } from "../services/profile-service";
import { ProjectWorkspaceService } from "../services/project-workspace-service";
import { ProjectsService } from "../services/projects-service";
import { resolveDiscordResponse } from "../services/discord-response-service";
import { HeartbeatService } from "../services/heartbeat-service";
import type { CacheMissWarning } from "../services/cache-miss-monitor";
import { RoutinesService } from "../services/routines-service";
import { ShellService } from "../services/shell-service";
import { ServiceRestartNoticeService } from "../services/service-restart-notice-service";
import { SshFilesystemService } from "../services/ssh-filesystem-service";
import { SshShellService } from "../services/ssh-shell-service";
import { SystemPromptService } from "../services/system-prompt-service";
import { ToolResolutionService } from "../services/tool-resolution-service";
import { telemetry } from "../services/telemetry";
import { nextWorkflowRunId, WorkflowRegistry } from "../services/workflow-registry";
import { WorkflowSessionStore } from "../services/workflow-session-store";
import { DEFAULT_CODING_AGENT_TIMEOUT_MS } from "../services/tool-defaults";
import { RoutineToolRegistry } from "../tools/routine-tool-registry";
import { AlarmNotificationService } from "../services/alarm-notification-service";
import { AlarmService, type ScheduledAlarm } from "../services/alarm-service";
import { WorkPlanningService } from "../services/work-planning-service";
import { ConversationMemoryService } from "../services/conversation-memory-service";
import { RecentThreadContextService, shouldIncludeRecentThreadContext } from "../services/recent-thread-context-service";
import { ReflectionService } from "../services/reflection-service";
import { SoulService } from "../services/soul-service";
import { CalendarSyncService } from "../services/calendar-sync-service";
import { getRuntimeConfig } from "../config/runtime-config";

type ShellRuntime = Pick<
  ShellService,
  | "consumeConversationNotifications"
  | "exec"
  | "execVerification"
  | "launchBackground"
  | "listBackgroundJobs"
  | "readBackgroundOutput"
>;
type FilesystemRuntime = Pick<
  FilesystemService,
  "applyPatch" | "copyPath" | "deletePath" | "edit" | "glob" | "grep" | "listDir" | "mkdir" | "movePath" | "multiEdit" | "read" | "statPath" | "write"
>;

type RuntimeScope = {
  profile: ProfileRecord;
  access: AccessControlService;
  projects: ProjectsService;
  models: ModelService;
  memory: MemoryService;
  conversationMemory: ConversationMemoryService;
  reflection: ReflectionService;
  connector: ActiveModelConnector;
  shell: ShellRuntime;
  transitions: ConversationStateTransitionService;
  routineTools: RoutineToolRegistry;
  toolResolver: ToolResolutionService;
  chat: AgentChatService;
};

function buildBackgroundAgentAssistantContext(
  profile: ProfileRecord,
  profileService: ProfileService,
  projects: ProjectsService,
) {
  return [
    "Execution mode: background coding subagent.",
    "System: OpenElinaro local-first agent runtime.",
    "Parent-child flow: this run was launched by a foreground agent and completion is reported back into the parent conversation automatically.",
    profileService.buildAssistantContext(profile),
    projects.buildAssistantContext(),
    "Background coding subagents do not get automatic per-turn memory recall.",
    "When the assigned workspace is a local git repo, the runtime forks this run into an isolated linked worktree before planner or worker execution starts.",
    "Tool visibility is limited to the coding planner/worker scope for this run. If a needed tool is not visible, call tool_search before guessing; if it still is not available, continue within the visible toolset.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

type BackgroundConversationResponseNotifier = (params: {
  conversationKey: string;
  response: AppResponse;
}) => Promise<void> | void;

const DEFAULT_SUBAGENT_RESUME_INSTRUCTION =
  "Continue from the current repository state and finish the next remaining work under the original goal. Only return when that work is actually complete or you hit a concrete blocker.";

const DEFAULT_WORKFLOW_STUCK_AFTER_MS = 15 * 60_000;

function isAutomaticConversationMemoryDisabled() {
  return getRuntimeConfig().core.app.automaticConversationMemoryEnabled === false;
}

function timestamp() {
  return new Date().toISOString();
}

function getWorkflowStuckAfterMs() {
  const configured = getRuntimeConfig().core.app.workflow.stuckAfterMs;
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_WORKFLOW_STUCK_AFTER_MS;
}

export class OpenElinaroApp {
  private readonly appTelemetry = telemetry.child({ component: "app" });
  private readonly registry = this.appTelemetry.instrumentMethods(new WorkflowRegistry(), {
    component: "workflow_registry",
  });
  private readonly routines = this.appTelemetry.instrumentMethods(new RoutinesService(), {
    component: "routine",
  });
  private readonly finance = this.appTelemetry.instrumentMethods(new FinanceService(), {
    component: "finance",
  });
  private readonly health = this.appTelemetry.instrumentMethods(new HealthTrackingService(), {
    component: "health",
  });
  private readonly alarms = this.appTelemetry.instrumentMethods(new AlarmService(), {
    component: "alarm",
  });
  private readonly alarmNotifications = this.appTelemetry.instrumentMethods(new AlarmNotificationService(), {
    component: "alarm_notification",
  });
  private readonly conversations = this.appTelemetry.instrumentMethods(new ConversationStore(), {
    component: "conversation_store",
  });
  private readonly systemPrompts = this.appTelemetry.instrumentMethods(new SystemPromptService(), {
    component: "system_prompt",
  });
  private readonly heartbeats = this.appTelemetry.instrumentMethods(new HeartbeatService(), {
    component: "heartbeat",
  });
  private readonly serviceRestartNotices = this.appTelemetry.instrumentMethods(new ServiceRestartNoticeService(), {
    component: "service_restart_notice",
  });
  private readonly calendar = this.appTelemetry.instrumentMethods(new CalendarSyncService(this.routines), {
    component: "calendar",
  });
  private readonly workflowSessions = this.appTelemetry.instrumentMethods(new WorkflowSessionStore(), {
    component: "workflow_session_store",
  });
  private readonly workspaces = this.appTelemetry.instrumentMethods(new ProjectWorkspaceService(), {
    component: "project_workspace",
  });
  private readonly profiles: ProfileService;
  private readonly activeProfile: ProfileRecord;
  private readonly scopes = new Map<string, RuntimeScope>();
  private onCacheMissWarning?: (warning: CacheMissWarning) => Promise<void> | void;
  private onBackgroundConversationResponse?: BackgroundConversationResponseNotifier;
  private onConversationActivityChange?: (params: {
    conversationKey: string;
    active: boolean;
  }) => Promise<void> | void;
  private readonly activeWorkflowControllers = new Map<string, AbortController>();
  private backgroundRetryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options?: { profileId?: string }) {
    this.profiles = this.appTelemetry.instrumentMethods(new ProfileService(options?.profileId), {
      component: "profile",
    });
    this.activeProfile = this.profiles.getActiveProfile();

    void this.getScope().memory.ensureReady().catch((error) => {
      this.appTelemetry.recordError(error, {
        profileId: this.activeProfile.id,
        operation: "memory.ensure_ready",
      });
    });
    void this.calendar.syncIfNeeded().catch((error) => {
      this.appTelemetry.recordError(error, {
        profileId: this.activeProfile.id,
        operation: "calendar.initial_sync",
      });
    });

    this.injectPendingServiceRestartContinuations();
    this.kickBackgroundRunner();
  }

  async handleRequest(
    request: AppRequest,
    options?: {
      onBackgroundResponse?: (response: AppResponse) => Promise<void>;
      onToolUse?: (event: AppProgressEvent) => Promise<void>;
      typingEligible?: boolean;
      chatOptions?: {
        contextConversationKey?: string;
        persistConversation?: boolean;
        enableMemoryIngestion?: boolean;
        enableThreadStartContext?: boolean;
        enableCompaction?: boolean;
        includeBackgroundExecNotifications?: boolean;
        providerSessionId?: string;
        usagePurpose?: string;
      };
    },
  ): Promise<AppResponse> {
    const scope = this.getScope();
    return this.appTelemetry.span(
      "app.handle_request",
      {
        requestId: request.id,
        kind: request.kind,
        conversationKey: request.conversationKey,
        profileId: scope.profile.id,
      },
      async () => {
        if (request.kind === "chat") {
          const conversationKey = request.conversationKey ?? request.id;
          const contextConversationKey = options?.chatOptions?.contextConversationKey ?? conversationKey;
          const systemContext = options?.chatOptions?.enableThreadStartContext === false
            ? undefined
            : await this.buildThreadStartSystemContext(scope, contextConversationKey);
          const result = await scope.chat.reply({
            conversationKey,
            contextConversationKey,
            content: request.chatContent ?? request.text,
            systemContext,
            typingEligible: options?.typingEligible,
            onBackgroundResponse: options?.onBackgroundResponse
              ? async (result) => options.onBackgroundResponse?.(
                  this.finalizeAppResponse(scope, {
                    requestId: request.id,
                    mode: result.mode,
                    message: result.message,
                    warnings: result.warnings,
                  }),
                )
              : undefined,
            onToolUse: options?.onToolUse,
            persistConversation: options?.chatOptions?.persistConversation,
            enableMemoryIngestion: options?.chatOptions?.enableMemoryIngestion,
            enableCompaction: options?.chatOptions?.enableCompaction,
            includeBackgroundExecNotifications: options?.chatOptions?.includeBackgroundExecNotifications,
            providerSessionId: options?.chatOptions?.providerSessionId,
            usagePurpose: options?.chatOptions?.usagePurpose,
          });
          return this.finalizeAppResponse(scope, {
            requestId: request.id,
            mode: result.mode,
            message: result.message,
            warnings: result.warnings,
          });
        }

        if (request.kind === "todo") {
          const message = await this.invokeRoutineTool("routine_add", {
            title: request.todoTitle ?? request.text,
            kind: "todo",
            priority: "medium",
            description: request.text,
            scheduleKind: "once",
            dueAt: new Date().toISOString(),
          });
          return this.finalizeAppResponse(scope, {
            requestId: request.id,
            mode: "immediate",
            message,
          });
        }

        if (request.kind === "medication") {
          const message = await this.invokeRoutineTool("routine_add", {
            title: request.medicationName ?? request.text,
            kind: "med",
            priority: "high",
            description: request.text,
            scheduleKind: request.medicationDueAt ? "once" : "manual",
            dueAt: request.medicationDueAt,
          });
          return this.finalizeAppResponse(scope, {
            requestId: request.id,
            mode: "immediate",
            message,
          });
        }

        if (!request.workflowPlan) {
          throw new Error("Workflow requests require a workflowPlan.");
        }

        const run = this.registry.enqueuePlan(request.workflowPlan, {
          profileId: scope.profile.id,
          originConversationKey: request.conversationKey,
          requestedBy: "app-runtime",
        });
        this.kickBackgroundRunner();

        return this.finalizeAppResponse(scope, {
          requestId: request.id,
          mode: "accepted",
          message: "Complex work accepted into the background workflow lane.",
          workflowRunId: run.id,
        });
      },
    );
  }

  listWorkflowRuns(): WorkflowRun[] {
    return this.createWorkflowController(this.activeProfile.id).listWorkflowRuns();
  }

  launchCodingAgent(params: {
    goal: string;
    cwd?: string;
    profileId?: string;
    originConversationKey?: string;
    requestedBy?: string;
    timeoutMs?: number;
    subagentDepth?: number;
  }) {
    return this.createWorkflowController(this.activeProfile.id).launchCodingAgent(params);
  }

  resumeCodingAgent(params: {
    runId: string;
    message?: string;
    timeoutMs?: number;
  }) {
    return this.createWorkflowController(this.activeProfile.id).resumeCodingAgent(params);
  }

  steerCodingAgent(params: {
    runId: string;
    message: string;
  }) {
    return this.createWorkflowController(this.activeProfile.id).steerCodingAgent(params);
  }

  cancelCodingAgent(params: {
    runId: string;
  }) {
    return this.createWorkflowController(this.activeProfile.id).cancelCodingAgent(params);
  }

  noteDiscordUser(userId: string) {
    this.routines.noteNotificationTargetUserId(userId);
  }

  setCacheMissWarningNotifier(notifier?: (warning: CacheMissWarning) => Promise<void> | void) {
    this.onCacheMissWarning = notifier;
  }

  setBackgroundConversationNotifier(notifier?: BackgroundConversationResponseNotifier) {
    this.onBackgroundConversationResponse = notifier;
  }

  setConversationActivityNotifier(notifier?: (params: {
    conversationKey: string;
    active: boolean;
  }) => Promise<void> | void) {
    this.onConversationActivityChange = notifier;
    for (const scope of this.scopes.values()) {
      scope.chat.setConversationActivityNotifier((params) => {
        if (!this.onConversationActivityChange) {
          return;
        }
        void Promise.resolve(this.onConversationActivityChange(params)).catch((error) => {
          this.appTelemetry.recordError(error, {
            conversationKey: params.conversationKey,
            active: params.active,
            operation: "app.conversation_activity_notifier",
          });
        });
      });
    }
  }

  getRoutineSummary() {
    return this.routines.buildCheckSummary();
  }

  listRoutineItems(filters?: Parameters<RoutinesService["listItems"]>[0]) {
    return this.routines.listItems(filters);
  }

  addRoutineItem(params: Parameters<RoutinesService["addItem"]>[0]) {
    return this.routines.addItem(params);
  }

  updateRoutineItem(id: string, updates: Parameters<RoutinesService["updateItem"]>[1]) {
    return this.routines.updateItem(id, updates);
  }

  deleteRoutineItem(id: string) {
    return this.routines.deleteItem(id);
  }

  setAlarm(name: string, time: string) {
    return this.alarms.setAlarm(name, time);
  }

  setTimer(name: string, duration: string) {
    return this.alarms.setTimer(name, duration);
  }

  listAlarms(options?: Parameters<AlarmService["listAlarms"]>[0]) {
    return this.alarms.listAlarms(options);
  }

  cancelAlarm(id: string) {
    return this.alarms.cancelAlarm(id);
  }

  listDueAlarms(reference?: Date, limit?: number) {
    return this.alarms.listDueAlarms(reference, limit);
  }

  markAlarmDelivered(id: string, reference?: Date) {
    return this.alarms.markDelivered(id, reference);
  }

  getNextAlarmDueAt() {
    return this.alarms.getNextDueAt();
  }

  onAlarmScheduleChanged(listener: () => void) {
    return this.alarms.onScheduleChanged(listener);
  }

  markRoutineDone(id: string) {
    return this.routines.markDone(id);
  }

  undoRoutineDone(id: string) {
    return this.routines.undoDone(id);
  }

  snoozeRoutine(id: string, minutes: number) {
    return this.routines.snooze(id, minutes);
  }

  skipRoutine(id: string) {
    return this.routines.skip(id);
  }

  pauseRoutine(id: string) {
    return this.routines.pause(id);
  }

  resumeRoutine(id: string) {
    return this.routines.resume(id);
  }

  getRoutineToolNames() {
    return this.getScope().routineTools.getToolNames();
  }

  getActiveModel() {
    return this.getScope().models.getActiveModel();
  }

  getActiveProfile() {
    return this.activeProfile;
  }

  async invokeRoutineTool(
    name: string,
    input: unknown,
    options?: {
      conversationKey?: string;
      onToolUse?: (event: AppProgressEvent) => Promise<void>;
    },
  ) {
    return this.getScope().routineTools.invoke(name, input, options);
  }

  buildAssistantRoutineContext() {
    return this.routines.buildAssistantContext();
  }

  buildAssistantProjectContext() {
    return this.getScope().projects.buildAssistantContext();
  }

  buildAssistantWorkContext(reference?: Date) {
    const scope = this.getScope();
    return this.appTelemetry.instrumentMethods(
      new WorkPlanningService(this.routines, scope.projects),
      { component: "work_planning" },
    ).buildAssistantContext(reference);
  }

  recordAssistantMessage(conversationKey: string, message: string) {
    return this.getScope().chat.recordAssistantMessage({ conversationKey, message });
  }

  stopConversation(conversationKey: string) {
    return this.getScope().chat.stopConversation(conversationKey);
  }

  getNotificationTargetUserId() {
    return this.routines.getNotificationTargetUserId();
  }

  async runHourlyHeartbeat(
    conversationKey: string,
    options?: {
      reference?: Date;
      onBackgroundResponse?: (message: string) => Promise<void>;
    },
  ) {
    await this.calendar.syncIfNeeded({ reference: options?.reference }).catch((error) => {
      this.appTelemetry.recordError(error, {
        profileId: this.activeProfile.id,
        operation: "calendar.heartbeat_sync",
      });
    });

    if (!this.routines.shouldRunHeartbeat(options?.reference)) {
      return {
        requestId: `heartbeat-${Date.now()}`,
        mode: "immediate" as const,
        message: "",
        warnings: [],
        completed: true,
      };
    }

    const requestId = `heartbeat-${Date.now()}`;
    const scope = this.getScope();
    const workFocus = this.buildHeartbeatWorkFocus(options?.reference);
    const reminderSnapshot = this.routines.getHeartbeatReminderSnapshot(options?.reference);
    const localTime = reminderSnapshot.currentLocalTime;
    const reflectionEligible = scope.reflection.isDailyReflectionEligible(options?.reference);
    const heartbeatConversationKey = this.buildAutomationSessionKey("heartbeat", conversationKey);
    let reminderMarked = false;
    let userFacingMessageSent = false;
    const recordedMainThreadMessages = new Set<string>();
    const recordHeartbeatMessageToMainThread = async (message: string, source: string) => {
      try {
        await this.recordAssistantMessage(conversationKey, message);
        this.appTelemetry.event("app.heartbeat.main_thread_handoff", {
          conversationKey,
          heartbeatConversationKey,
          requestId,
          source,
          messageChars: message.length,
        });
      } catch (error) {
        this.appTelemetry.event(
          "app.heartbeat.main_thread_handoff_error",
          {
            conversationKey,
            heartbeatConversationKey,
            requestId,
            source,
            messageChars: message.length,
            error: error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : String(error),
          },
          { level: "error", outcome: "error" },
        );
      }
    };
    const finalizeHeartbeatMessage = async (rawMessage: string | undefined, source: string) => {
      const normalized = this.heartbeats.normalizeAssistantReply(rawMessage) ?? "";
      if (!normalized) {
        return "";
      }
      if (!recordedMainThreadMessages.has(normalized)) {
        recordedMainThreadMessages.add(normalized);
        await recordHeartbeatMessageToMainThread(normalized, source);
      }
      userFacingMessageSent = true;
      if (!reminderMarked && reminderSnapshot.requiredCandidates.length > 0) {
        this.routines.markReminded(
          reminderSnapshot.itemIds,
          reminderSnapshot.occurrenceKeys,
          options?.reference,
        );
        reminderMarked = true;
      }
      return normalized;
    };
    const buildHeartbeatPrompt = (deliveryRequirement?: string) => {
      const prompt = this.heartbeats.buildInjectedMessage(options?.reference, {
        workFocus,
        localTime,
        timezone: reminderSnapshot.timezone,
        reminderSnapshot,
        reflectionTrigger: reflectionEligible
          ? "A private daily reflection is eligible after this heartbeat if no user-facing heartbeat reminder is needed."
          : undefined,
        deliveryRequirement,
      });
      this.appTelemetry.event("app.heartbeat.prompt_prepared", {
        conversationKey,
        heartbeatConversationKey,
        requestId,
        promptChars: prompt.length,
        workFocusChars: workFocus?.length ?? 0,
        requiredCandidateCount: reminderSnapshot.requiredCandidates.length,
        optionalCandidateCount: reminderSnapshot.optionalCandidates.length,
        reflectionEligible,
        hasDeliveryRequirement: Boolean(deliveryRequirement),
        isolatedFromMainConversation: true,
      });
      return prompt;
    };
    const runHeartbeatTurn = async (turnId: string, deliveryRequirement?: string) =>
      this.handleRequest(
        {
          id: turnId,
          kind: "chat",
          text: buildHeartbeatPrompt(deliveryRequirement),
          conversationKey: heartbeatConversationKey,
        },
        {
          onBackgroundResponse: options?.onBackgroundResponse
            ? async (backgroundResponse) => {
                const message = await finalizeHeartbeatMessage(backgroundResponse.message, "background");
                if (!message) {
                  return;
                }
                await options.onBackgroundResponse?.(message);
              }
            : undefined,
          onToolUse: async () => {},
          typingEligible: false,
          chatOptions: {
            persistConversation: false,
            enableMemoryIngestion: false,
            enableThreadStartContext: false,
            enableCompaction: false,
            includeBackgroundExecNotifications: false,
            providerSessionId: heartbeatConversationKey,
            usagePurpose: "automation_heartbeat_turn",
          },
        },
      );

    let response = await runHeartbeatTurn(requestId);

    const message = response.mode === "accepted" && !response.message.trim()
      ? ""
      : await finalizeHeartbeatMessage(response.message, "immediate");
    let finalMessage = message;
    if (!finalMessage && reminderSnapshot.requiredCandidates.length > 0) {
      this.appTelemetry.event("app.heartbeat.model_violation", {
        conversationKey,
        requestId,
        phase: "initial",
        requiredCandidateCount: reminderSnapshot.requiredCandidates.length,
      });
      const retryResponse = await runHeartbeatTurn(
        `${requestId}-retry`,
        "Required reminder candidates are present right now. Do not reply with HEARTBEAT_OK. Write one concise user-facing reminder now.",
      );
      response = retryResponse;
      finalMessage = retryResponse.mode === "accepted" && !retryResponse.message.trim()
        ? ""
        : await finalizeHeartbeatMessage(retryResponse.message, "retry");
      if (!finalMessage) {
        this.appTelemetry.event("app.heartbeat.model_violation", {
          conversationKey,
          requestId,
          phase: "retry",
          requiredCandidateCount: reminderSnapshot.requiredCandidates.length,
        });
      }
    }
    const completed = userFacingMessageSent || reminderSnapshot.requiredCandidates.length === 0;
    if (completed && response.mode !== "accepted" && !userFacingMessageSent && reflectionEligible) {
      scope.reflection.queueDailyReflectionIfEligible(options?.reference);
    }

    return {
      ...response,
      message: finalMessage,
      completed,
    };
  }

  async runAlarmNotification(
    conversationKey: string,
    alarm: ScheduledAlarm,
    options?: {
      reference?: Date;
      onBackgroundResponse?: (message: string) => Promise<void>;
    },
  ) {
    return this.handleRequest(
      {
        id: `alarm-notification-${alarm.id}`,
        kind: "chat",
        text: this.alarmNotifications.buildInjectedMessage(alarm, options?.reference),
        conversationKey: this.buildAutomationSessionKey(alarm.kind, conversationKey),
      },
      {
        onBackgroundResponse: options?.onBackgroundResponse
          ? async (backgroundResponse) => {
              const message = this.alarmNotifications.normalizeAssistantReply(backgroundResponse.message);
              if (!message) {
                return;
              }
              await options.onBackgroundResponse?.(message);
            }
          : undefined,
        onToolUse: async () => {},
        typingEligible: false,
        chatOptions: {
          contextConversationKey: conversationKey,
          persistConversation: false,
          enableMemoryIngestion: false,
          enableThreadStartContext: false,
          enableCompaction: false,
          includeBackgroundExecNotifications: false,
          providerSessionId: this.buildAutomationSessionKey(alarm.kind, conversationKey),
          usagePurpose: `automation_${alarm.kind}_turn`,
        },
      },
    ).then((response) => ({
      ...response,
      message: this.alarmNotifications.normalizeAssistantReply(response.message) ?? "",
    }));
  }

  prepareProactiveRoutineReminder() {
    return this.routines.prepareProactiveReminder();
  }

  markRoutineReminderDelivered(itemIds: string[], occurrenceKeys: string[]) {
    this.routines.markReminded(itemIds, occurrenceKeys);
  }

  getNextRoutineAttentionAt(reference?: Date) {
    return this.routines.getNextRoutineAttentionAt(reference);
  }

  getWorkflowRun(runId: string): WorkflowRun | undefined {
    return this.createWorkflowController(this.activeProfile.id).getWorkflowRun(runId);
  }

  createDemoWorkflowRequest(requestId: string): AppRequest {
    return {
      id: requestId,
      kind: "workflow",
      text: "Prepare the full care update and task plan",
      workflowPlan: createTaskPlan("Prepare a care and operations update", [
        {
          id: "collect-notes",
          title: "Collect recent notes",
          status: "completed",
          executionMode: "serial",
          dependsOn: [],
        },
        {
          id: "review-meds",
          title: "Review medication schedule",
          status: "ready",
          executionMode: "serial",
          dependsOn: ["collect-notes"],
        },
        {
          id: "draft-summary",
          title: "Draft summary",
          status: "ready",
          executionMode: "parallel",
          dependsOn: ["review-meds"],
        },
        {
          id: "update-todos",
          title: "Update todo list",
          status: "ready",
          executionMode: "parallel",
          dependsOn: ["review-meds"],
        },
      ]),
    };
  }

  private async buildThreadStartSystemContext(scope: RuntimeScope, conversationKey: string) {
    const conversation = this.conversations.get(conversationKey);
    if (!shouldIncludeRecentThreadContext(conversation.messages)) {
      return undefined;
    }

    const recentThreadContext = this.appTelemetry.instrumentMethods(
      new RecentThreadContextService(
        scope.profile,
        scope.projects,
        this.profiles,
      ),
      { component: "recent_thread_context" },
    ).buildThreadStartContext();
    const reflectionContext = await scope.reflection.buildThreadBootstrapContext();
    const sections = [reflectionContext, recentThreadContext].filter(Boolean);
    return sections.length > 0 ? sections.join("\n\n") : undefined;
  }

  private finalizeAppResponse(scope: RuntimeScope, response: AppResponse): AppResponse {
    return resolveDiscordResponse({
      response,
      assertPathAccess: (targetPath) => {
        const resolvedPath = scope.access.assertPathAccess(targetPath);
        if (!fs.existsSync(resolvedPath)) {
          return resolvedPath;
        }

        return scope.access.assertPathAccess(resolvedPath);
      },
    });
  }

  private buildHeartbeatWorkFocus(reference?: Date) {
    const scope = this.getScope();
    return this.appTelemetry.instrumentMethods(
      new WorkPlanningService(this.routines, scope.projects),
      { component: "work_planning" },
    ).buildHeartbeatSummary(reference) ?? undefined;
  }

  private buildAutomationSessionKey(kind: string, conversationKey: string) {
    return `automation:${kind}:${conversationKey}`;
  }

  private getScope(
    profileId = this.activeProfile.id,
    options?: {
      mode?: "interactive" | "subagent";
    },
  ): RuntimeScope {
    const mode = options?.mode ?? "interactive";
    const scopeKey = mode === "subagent" ? `${profileId}:subagent` : profileId;
    const cached = this.scopes.get(scopeKey);
    if (cached) {
      return cached;
    }

    const profile = this.profiles.getProfile(profileId);
    const shellEnvironment = this.profiles.buildProfileShellEnvironment(profile);
    const projects = this.appTelemetry.instrumentMethods(
      new ProjectsService(profile, this.profiles),
      { component: "projects", profileId },
    );
    const access = this.appTelemetry.instrumentMethods(
      new AccessControlService(profile, this.profiles, projects),
      { component: "access_control", profileId },
    );
    const subagentDefaults = mode === "subagent"
      ? {
          providerId: profile.subagentPreferredProvider ?? profile.preferredProvider,
          modelId: profile.subagentDefaultModelId ?? profile.defaultModelId,
          thinkingLevel: "high" as const,
        }
      : undefined;
    const models = new ModelService(profile, {
      onCacheMissWarning: (warning) => {
        if (!this.onCacheMissWarning) {
          return;
        }

        void Promise.resolve(this.onCacheMissWarning(warning)).catch((error) => {
          this.appTelemetry.recordError(error, {
            profileId,
            conversationKey: warning.conversationKey,
            operation: "app.cache_miss_warning_notifier",
          });
        });
      },
      selectionStoreKey: mode === "subagent" ? `${profile.id}:subagent` : profile.id,
      defaultSelectionOverride: subagentDefaults,
    });
    const memory = new MemoryService(profile, this.profiles);
    const conversationMemory = new ConversationMemoryService(
      profile,
      this.conversations,
      memory,
      models,
      this.profiles,
    );
    const soul = new SoulService(
      profile,
      this.routines,
      memory,
      models,
    );
    const reflection = new ReflectionService(
      profile,
      this.routines,
      this.conversations,
      memory,
      models,
      soul,
    );
    const automaticConversationMemoryDisabled = isAutomaticConversationMemoryDisabled();
    const connector = new ActiveModelConnector(models);
    const shell: ShellRuntime = this.profiles.isSshExecutionProfile(profile)
      ? new SshShellService(profile, access, shellEnvironment)
      : new ShellService(access, shellEnvironment);
    const filesystem: FilesystemRuntime = this.profiles.isSshExecutionProfile(profile)
      ? new SshFilesystemService(profile, shell as SshShellService, access)
      : new FilesystemService(access);
    const transitions = this.appTelemetry.instrumentMethods(
      new ConversationStateTransitionService(
        connector,
        this.conversations,
        memory,
        models,
        this.systemPrompts,
      ),
      { component: "conversation_transition", profileId },
    );
    const routineTools = new RoutineToolRegistry(
      this.routines,
      projects,
      models,
      this.conversations,
      memory,
      this.systemPrompts,
      transitions,
      this.createWorkflowController(profileId),
      access,
      shell,
      filesystem,
      undefined,
      this.finance,
      this.health,
      reflection,
    );
    const toolResolver = this.appTelemetry.instrumentMethods(
      new ToolResolutionService(routineTools),
      { component: "tool_resolution", profileId },
    );
    const chat = new AgentChatService(
      connector,
      routineTools,
      toolResolver,
      transitions,
      this.conversations,
      this.systemPrompts,
      models,
      mode === "subagent" || automaticConversationMemoryDisabled ? undefined : conversationMemory,
      reflection,
      mode === "interactive" && profile.id === "root",
      this.onConversationActivityChange
        ? (params) => {
            void Promise.resolve(this.onConversationActivityChange?.(params)).catch((error) => {
              this.appTelemetry.recordError(error, {
                conversationKey: params.conversationKey,
                active: params.active,
                operation: "app.conversation_activity_notifier",
              });
            });
          }
        : undefined,
    );

    const scope: RuntimeScope = {
      profile,
      access,
      projects,
      models,
      memory,
      conversationMemory,
      reflection,
      connector,
      shell,
      transitions,
      routineTools,
      toolResolver,
      chat,
    };
    this.scopes.set(scopeKey, scope);
    return scope;
  }

  private createWorkflowController(sourceProfileId: string) {
    const sourceProfile = this.profiles.getProfile(sourceProfileId);
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
        const maxDepth = this.profiles.getMaxSubagentDepth(sourceProfile);
        if (nextDepth > maxDepth) {
          throw new Error(
            maxDepth === 0
              ? `Subagents are disabled for profile ${sourceProfile.id}.`
              : `Subagent depth limit reached for profile ${sourceProfile.id}: current depth ${sourceDepth}, max ${maxDepth}.`,
          );
        }

        const targetProfileId = params.profileId?.trim() || sourceProfileId;
        const targetProfile = this.profiles.getProfile(targetProfileId);
        this.profiles.assertCanSpawnProfile(sourceProfile, targetProfile);
        const targetScope = this.getScope(targetProfileId);
        const baseWorkspaceCwd = targetScope.access.assertPathAccess(params.cwd ?? process.cwd());
        const runId = nextWorkflowRunId();
        let workspaceCwd = baseWorkspaceCwd;
        const launchLog: string[] = [];
        if (!this.profiles.isSshExecutionProfile(targetProfile)) {
          const isolatedWorkspace = this.workspaces.ensureIsolatedWorkspace({
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
        const run = this.registry.enqueueCodingAgent({
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
          ? this.registry.save({
              ...run,
              updatedAt: timestamp(),
              executionLog: run.executionLog.concat(launchLog),
            })
          : run;
        this.startWorkflowRun(savedRun);
        return savedRun;
      },
      resumeCodingAgent: (params: {
        runId: string;
        message?: string;
        timeoutMs?: number;
      }) => {
        const existingRun = this.registry.get(params.runId);
        if (!existingRun || !this.canViewWorkflowRun(sourceProfile, existingRun)) {
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
        this.registry.save(resumedRun);
        this.startWorkflowRun(resumedRun);
        return resumedRun;
      },
      steerCodingAgent: (params: {
        runId: string;
        message: string;
      }) => {
        const existingRun = this.registry.get(params.runId);
        if (!existingRun || !this.canViewWorkflowRun(sourceProfile, existingRun)) {
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
          this.workflowSessions.appendHumanMessage(
            existingRun.currentSessionId,
            [
              "Parent steering message.",
              "This is a new instruction from the parent agent. Re-prioritize accordingly on the next step.",
              message,
            ].join("\n\n"),
          );
        }

        this.registry.save(nextRun);
        return nextRun;
      },
      cancelCodingAgent: (params: {
        runId: string;
      }) => {
        const existingRun = this.registry.get(params.runId);
        if (!existingRun || !this.canViewWorkflowRun(sourceProfile, existingRun)) {
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
          this.registry.save(cancelledRun);
          return cancelledRun;
        }
        if (existingRun.status !== "running") {
          throw new Error(`Workflow run ${params.runId} is not running.`);
        }

        if (!this.activeWorkflowControllers.has(existingRun.id)) {
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
          this.registry.save(cancelledRun);
          this.kickBackgroundRunner();
          return cancelledRun;
        }

        this.activeWorkflowControllers.get(existingRun.id)?.abort();
        const pendingCancelRun: WorkflowRun = {
          ...existingRun,
          updatedAt: timestamp(),
          executionLog: existingRun.executionLog.concat("Parent agent requested cancellation."),
        };
        this.registry.save(pendingCancelRun);
        return pendingCancelRun;
      },
      getWorkflowRun: (runId: string) => {
        const run = this.registry.get(runId);
        if (!run || !this.canViewWorkflowRun(sourceProfile, run)) {
          return undefined;
        }
        return this.getWorkflowView(run);
      },
      listWorkflowRuns: () =>
        this.registry.list()
          .filter((run) => this.canViewWorkflowRun(sourceProfile, run))
          .map((run) => this.getWorkflowView(run)),
    };
  }

  private canViewWorkflowRun(profile: ProfileRecord, run: WorkflowRun) {
    const targetProfile = this.profiles.getProfile(run.profileId ?? this.activeProfile.id);
    return this.profiles.canSpawnProfile(profile, targetProfile);
  }

  private getWorkflowView(run: WorkflowRun): WorkflowRun {
    if (run.kind !== "coding-agent" || run.status !== "running") {
      return run;
    }

    const sessionUpdatedAt = run.currentSessionId
      ? this.workflowSessions.get(run.currentSessionId)?.updatedAt
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

  private buildWorkflowCompletionTurn(run: WorkflowRun) {
    return [
      "Background subagent completion update.",
      `Run id: ${run.id}`,
      `Profile: ${run.profileId ?? this.activeProfile.id}`,
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

  private async notifyConversationBackgroundResponse(conversationKey: string, response: AppResponse) {
    if (!this.onBackgroundConversationResponse) {
      return;
    }
    try {
      await this.onBackgroundConversationResponse({
        conversationKey,
        response,
      });
    } catch (error) {
      this.appTelemetry.recordError(error, {
        conversationKey,
        requestId: response.requestId,
        operation: "app.background_conversation_notifier",
      });
    }
  }

  private async injectWorkflowCompletion(run: WorkflowRun) {
    if (!run.originConversationKey || !run.completionMessage) {
      return;
    }

    try {
      const response = await this.handleRequest(
        {
          id: `workflow-complete-${run.id}`,
          kind: "chat",
          text: this.buildWorkflowCompletionTurn(run),
          conversationKey: run.originConversationKey,
        },
        {
          onBackgroundResponse: async (queuedResponse) => {
            await this.notifyConversationBackgroundResponse(run.originConversationKey!, queuedResponse);
          },
          typingEligible: false,
        },
      );

      if (response.mode === "immediate") {
        await this.notifyConversationBackgroundResponse(run.originConversationKey, response);
      }
    } catch (error) {
      this.appTelemetry.recordError(error, {
        conversationKey: run.originConversationKey,
        workflowRunId: run.id,
        operation: "app.workflow_completion_injection",
      });
    }
  }

  private startWorkflowRun(run: WorkflowRun): void {
    if (this.activeWorkflowControllers.has(run.id)) {
      return;
    }

    const scope = this.getScope(run.profileId ?? this.activeProfile.id, {
      mode: "subagent",
    });
    const controller = new AbortController();
    this.activeWorkflowControllers.set(run.id, controller);

    void (async () => {
      let finalRun: WorkflowRun;
      try {
        finalRun = await executeWorkflowRun(run, {
          connector: scope.connector,
          toolResolver: scope.toolResolver,
          shell: scope.shell,
          workflowSessions: this.workflowSessions,
          baseSystemPrompt: this.systemPrompts.load().text,
          assistantContext: buildBackgroundAgentAssistantContext(
            scope.profile,
            this.profiles,
            scope.projects,
          ),
          abortSignal: controller.signal,
          onRunUpdate: (updatedRun) => {
            this.registry.save(this.getWorkflowView(updatedRun));
          },
        });
      } catch (error) {
        finalRun = this.registry.createFailedRun(this.registry.get(run.id) ?? run, error);
      } finally {
        this.activeWorkflowControllers.delete(run.id);
      }

      const savedRun = this.registry.save(this.getWorkflowView(finalRun));
      if (savedRun.status === "completed" || savedRun.status === "failed" || savedRun.status === "cancelled") {
        await this.injectWorkflowCompletion(savedRun);
      }
      this.kickBackgroundRunner();
    })().catch((error) => {
      this.appTelemetry.recordError(error, {
        workflowRunId: run.id,
        operation: "app.workflow_runner",
      });
      this.kickBackgroundRunner();
    });
  }

  private injectPendingServiceRestartContinuations() {
    const notice = this.serviceRestartNotices.consumePendingNotice();
    if (!notice) {
      return;
    }

    for (const run of this.registry.listRecoverableRuns()) {
      if (run.kind !== "coding-agent") {
        continue;
      }

      const existingInstructions = run.pendingParentInstructions ?? [];
      let injectedIntoSession = false;
      if (run.currentSessionId) {
        injectedIntoSession = Boolean(
          this.workflowSessions.appendHumanMessage(run.currentSessionId, notice.message),
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
      this.registry.save({
        ...run,
        pendingParentInstructions,
        executionLog,
        updatedAt: timestamp(),
      });
    }
  }

  private kickBackgroundRunner(): void {
    if (this.backgroundRetryTimer) {
      clearTimeout(this.backgroundRetryTimer);
      this.backgroundRetryTimer = null;
    }

    for (const run of this.registry.listRecoverableRuns()) {
      this.startWorkflowRun(run);
    }
    this.scheduleBackgroundRunner();
  }

  private scheduleBackgroundRunner() {
    if (this.backgroundRetryTimer) {
      return;
    }

    const nextAttemptAt = this.registry.getNextRecoveryAt();
    if (!nextAttemptAt) {
      return;
    }

    const delayMs = Math.max(0, new Date(nextAttemptAt).getTime() - Date.now());
    this.backgroundRetryTimer = setTimeout(() => {
      this.backgroundRetryTimer = null;
      this.kickBackgroundRunner();
    }, delayMs);
  }
}
