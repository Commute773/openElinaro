import type { AppProgressEvent, AppRequest, AppResponse } from "../domain/assistant";
import type { ProfileRecord } from "../domain/profiles";
import { createTaskPlan } from "../domain/task-plan";
import type { WorkflowRun } from "../domain/workflow-run";
import { ConversationStore } from "../services/conversation-store";
import { FinanceService } from "../services/finance-service";
import { HealthTrackingService } from "../services/health-tracking-service";
import { ProfileService } from "../services/profile-service";
import { ProjectWorkspaceService } from "../services/project-workspace-service";
import { HeartbeatService } from "../services/heartbeat-service";
import type { CacheMissWarning } from "../services/cache-miss-monitor";
import { RoutinesService } from "../services/routines-service";
import { ServiceRestartNoticeService } from "../services/service-restart-notice-service";
import { SystemPromptService } from "../services/system-prompt-service";
import { telemetry } from "../services/telemetry";
import { WorkflowRegistry } from "../services/workflow-registry";
import { WorkflowSessionStore } from "../services/workflow-session-store";
import { AlarmNotificationService } from "../services/alarm-notification-service";
import { AlarmService, type ScheduledAlarm } from "../services/alarm-service";
import { WorkPlanningService } from "../services/work-planning-service";
import { CalendarSyncService } from "../services/calendar-sync-service";

import { type RuntimeScope, createRuntimeScope } from "./runtime-scope";
import {
  createWorkflowController,
  startWorkflowRun,
  injectPendingServiceRestartContinuations,
  kickBackgroundRunner,
} from "./runtime-workflow";
import {
  finalizeAppResponse,
  buildThreadStartSystemContext,
  buildHeartbeatWorkFocus,
  buildAutomationSessionKey,
} from "./runtime-automation";

type BackgroundConversationResponseNotifier = (params: {
  conversationKey: string;
  response: AppResponse;
}) => Promise<void> | void;

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
  private readonly backgroundRetryTimerRef: { current: ReturnType<typeof setTimeout> | null } = { current: null };

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

    injectPendingServiceRestartContinuations({
      serviceRestartNotices: this.serviceRestartNotices,
      registry: this.registry,
      workflowSessions: this.workflowSessions,
    });
    this.doKickBackgroundRunner();
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
            : await buildThreadStartSystemContext(scope, contextConversationKey, this.appTelemetry, this.conversations, this.profiles);
          const result = await scope.chat.reply({
            conversationKey,
            contextConversationKey,
            content: request.chatContent ?? request.text,
            systemContext,
            typingEligible: options?.typingEligible,
            onBackgroundResponse: options?.onBackgroundResponse
              ? async (result) => options.onBackgroundResponse?.(
                  finalizeAppResponse(scope, {
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
          return finalizeAppResponse(scope, {
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
          return finalizeAppResponse(scope, {
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
          return finalizeAppResponse(scope, {
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
        this.doKickBackgroundRunner();

        return finalizeAppResponse(scope, {
          requestId: request.id,
          mode: "accepted",
          message: "Complex work accepted into the background workflow lane.",
          workflowRunId: run.id,
        });
      },
    );
  }

  listWorkflowRuns(): WorkflowRun[] {
    return this.buildWorkflowController(this.activeProfile.id).listWorkflowRuns();
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
    return this.buildWorkflowController(this.activeProfile.id).launchCodingAgent(params);
  }

  resumeCodingAgent(params: {
    runId: string;
    message?: string;
    timeoutMs?: number;
  }) {
    return this.buildWorkflowController(this.activeProfile.id).resumeCodingAgent(params);
  }

  steerCodingAgent(params: {
    runId: string;
    message: string;
  }) {
    return this.buildWorkflowController(this.activeProfile.id).steerCodingAgent(params);
  }

  cancelCodingAgent(params: {
    runId: string;
  }) {
    return this.buildWorkflowController(this.activeProfile.id).cancelCodingAgent(params);
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

  buildHeartbeatWorkFocus(reference?: Date): string | undefined {
    return buildHeartbeatWorkFocus(this.getScope(), this.appTelemetry, this.routines, reference);
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
    const heartbeatConversationKey = buildAutomationSessionKey("heartbeat", conversationKey);
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
        conversationKey: buildAutomationSessionKey(alarm.kind, conversationKey),
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
          providerSessionId: buildAutomationSessionKey(alarm.kind, conversationKey),
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
    return this.buildWorkflowController(this.activeProfile.id).getWorkflowRun(runId);
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

    const scope = createRuntimeScope({
      profileId,
      mode,
      appTelemetry: this.appTelemetry,
      profiles: this.profiles,
      activeProfile: this.activeProfile,
      routines: this.routines,
      conversations: this.conversations,
      systemPrompts: this.systemPrompts,
      finance: this.finance,
      health: this.health,
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
      onConversationActivityChange: this.onConversationActivityChange
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
      createWorkflowController: (pid: string) => this.buildWorkflowController(pid),
    });
    this.scopes.set(scopeKey, scope);
    return scope;
  }

  private buildWorkflowController(sourceProfileId: string) {
    return createWorkflowController({
      sourceProfileId,
      profiles: this.profiles,
      activeProfile: this.activeProfile,
      appTelemetry: this.appTelemetry,
      registry: this.registry,
      workflowSessions: this.workflowSessions,
      workspaces: this.workspaces,
      systemPrompts: this.systemPrompts,
      activeWorkflowControllers: this.activeWorkflowControllers,
      backgroundRetryTimer: this.backgroundRetryTimerRef,
      getScope: (profileId, options) => this.getScope(profileId, options),
      handleRequest: (request: AppRequest, options?: any) => this.handleRequest(request, options),
      onBackgroundConversationResponse: this.onBackgroundConversationResponse,
    });
  }

  private doKickBackgroundRunner(): void {
    kickBackgroundRunner({
      registry: this.registry,
      activeWorkflowControllers: this.activeWorkflowControllers,
      backgroundRetryTimer: this.backgroundRetryTimerRef,
      appTelemetry: this.appTelemetry,
      workflowSessions: this.workflowSessions,
      systemPrompts: this.systemPrompts,
      profiles: this.profiles,
      activeProfile: this.activeProfile,
      getScope: (profileId, options) => this.getScope(profileId, options),
      handleRequest: (request: AppRequest, options?: any) => this.handleRequest(request, options),
      onBackgroundConversationResponse: this.onBackgroundConversationResponse,
    });
  }
}
