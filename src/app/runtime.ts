import type { AppProgressEvent, AppRequest, AppResponse } from "../domain/assistant";
import type { ProfileRecord } from "../domain/profiles";
import { ConversationStore } from "../services/conversation/conversation-store";
import { FinanceService } from "../services/finance-service";
import { HealthTrackingService } from "../services/health-tracking-service";
import { ProfileService } from "../services/profiles";
import { ProjectWorkspaceService } from "../services/project-workspace-service";
import { HeartbeatService } from "../services/heartbeat-service";
import type { CacheMissWarning } from "../services/cache-miss-monitor";
import type { InferencePromptDriftWarning } from "../services/inference-prompt-drift-monitor";
import { RoutinesService } from "../services/scheduling/routines-service";
import { ServiceRestartNoticeService } from "../services/service-restart-notice-service";
import { SystemPromptService } from "../services/system-prompt-service";
import { telemetry } from "../services/infrastructure/telemetry";
import { AlarmNotificationService } from "../services/alarm-notification-service";
import { AlarmService, type ScheduledAlarm } from "../services/alarm-service";
import { WorkPlanningService } from "../services/work-planning-service";
import { CalendarSyncService } from "../services/calendar-sync-service";
import { getRuntimeConfig } from "../config/runtime-config";
import type { FeatureId } from "../services/feature-config-service";

import { type RuntimeScope, createRuntimeScope } from "./runtime-scope";
import {
  finalizeAppResponse,
  buildThreadStartSystemContext,
  buildHeartbeatWorkFocus,
  buildAutomationSessionKey,
} from "./runtime-automation";
import { ATTACHMENT_FAILED_PREFIX } from "../services/discord-response-service";

type BackgroundConversationResponseNotifier = (params: {
  conversationKey: string;
  response: AppResponse;
}) => Promise<void> | void;

export class OpenElinaroApp {
  private readonly appTelemetry = telemetry.child({ component: "app" });
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
  private readonly workspaces = this.appTelemetry.instrumentMethods(new ProjectWorkspaceService(), {
    component: "project_workspace",
  });
  private readonly profiles: ProfileService;
  private readonly activeProfile: ProfileRecord;
  private readonly scopes = new Map<string, RuntimeScope>();
  private onCacheMissWarning?: (warning: CacheMissWarning) => Promise<void> | void;
  private onPromptDriftWarning?: (warning: InferencePromptDriftWarning) => Promise<void> | void;
  private onBackgroundConversationResponse?: BackgroundConversationResponseNotifier;
  private onConversationActivityChange?: (params: {
    conversationKey: string;
    active: boolean;
  }) => Promise<void> | void;

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
  }

  async handleRequest(
    request: AppRequest,
    options?: {
      onBackgroundResponse?: (response: AppResponse) => Promise<void>;
      onToolUse?: (event: AppProgressEvent) => Promise<void>;
      typingEligible?: boolean;
      chatOptions?: {
        contextConversationKey?: string;
        background?: boolean;
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
              ? async (result) => {
                  const finalized = finalizeAppResponse(scope, {
                    requestId: request.id,
                    mode: result.mode,
                    message: result.message,
                    warnings: result.warnings,
                  });
                  await options.onBackgroundResponse?.(finalized);
                  await this.injectAttachmentErrorFeedback(scope, conversationKey, finalized);
                }
              : undefined,
            onToolUse: options?.onToolUse,
            persistConversation: options?.chatOptions?.persistConversation,
            background: options?.chatOptions?.background,
            enableMemoryIngestion: options?.chatOptions?.enableMemoryIngestion,
            enableCompaction: options?.chatOptions?.enableCompaction,
            includeBackgroundExecNotifications: options?.chatOptions?.includeBackgroundExecNotifications,
            providerSessionId: options?.chatOptions?.providerSessionId,
            usagePurpose: options?.chatOptions?.usagePurpose,
          });
          const response = finalizeAppResponse(scope, {
            requestId: request.id,
            mode: result.mode,
            message: result.message,
            warnings: result.warnings,
          });
          await this.injectAttachmentErrorFeedback(scope, conversationKey, response);
          return response;
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

        throw new Error(`Unsupported request kind: ${request.kind}`);
      },
    );
  }

  noteDiscordUser(userId: string) {
    this.routines.noteNotificationTargetUserId(userId);
  }

  setCacheMissWarningNotifier(notifier?: (warning: CacheMissWarning) => Promise<void> | void) {
    this.onCacheMissWarning = notifier;
  }

  setPromptDriftWarningNotifier(notifier?: (warning: InferencePromptDriftWarning) => Promise<void> | void) {
    this.onPromptDriftWarning = notifier;
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

  getToolCatalog() {
    return this.getScope().routineTools.getToolCatalog();
  }

  getToolJsonSchema(name: string) {
    return this.getScope().routineTools.getToolJsonSchema(name);
  }

  /**
   * Returns generated API routes from the function layer.
   * Used by the G2 router to serve function-layer endpoints.
   */
  /** Returns the FunctionRegistry for use by integration surfaces (Discord, HTTP). */
  getFunctionRegistry() {
    const registry = this.getScope().routineTools.functionRegistry;
    return registry.isBuilt ? registry : null;
  }

  isFeatureActive(featureId: FeatureId): boolean {
    return this.getScope().routineTools.isFeatureActive(featureId);
  }

  getGeneratedApiRoutes() {
    const scope = this.getScope();
    const registry = scope.routineTools.functionRegistry;
    if (!registry.isBuilt) return [];
    const toolBuildContext = scope.routineTools.getToolBuildContext();
    return registry.generateApiRoutes(
      () => toolBuildContext,
      (featureId) => scope.routineTools.isFeatureActive(featureId),
    );
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
    const heartbeatConfig = getRuntimeConfig().core.app.heartbeat;
    const useFullContext = heartbeatConfig.contextMode === "full";
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
        this.appTelemetry.recordError(error, {
          conversationKey,
          heartbeatConversationKey,
          requestId,
          source,
          messageChars: message.length,
          eventName: "app.heartbeat.main_thread_handoff",
        });
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
        contextMode: heartbeatConfig.contextMode,
        isolatedFromMainConversation: !useFullContext,
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
            contextConversationKey: useFullContext ? conversationKey : undefined,
            persistConversation: false,
            enableMemoryIngestion: false,
            enableThreadStartContext: useFullContext,
            enableCompaction: false,
            includeBackgroundExecNotifications: false,
            providerSessionId: `${heartbeatConversationKey}-${turnId}`,
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

  getNextAutonomousTimeAt(reference?: Date) {
    const nextRunAt = this.getScope().autonomousTime.getNextRunAt(reference);
    return nextRunAt?.toISOString();
  }

  async runAutonomousTimeSession(options?: { reference?: Date }) {
    const scope = this.getScope();
    const reference = options?.reference ?? new Date();
    if (!scope.autonomousTime.isEligible(reference)) {
      return {
        requestId: `autonomous-time-${Date.now()}`,
        mode: "immediate" as const,
        message: "",
        warnings: [],
        triggered: false,
      };
    }

    const requestId = `autonomous-time-${Date.now()}`;
    const { text } = await scope.autonomousTime.buildInjectedMessage(reference);
    const localDate = scope.autonomousTime.getTriggerLocalDate(reference);
    const conversationKey = buildAutomationSessionKey(`autonomous-time-${localDate}`, scope.profile.id);
    const response = await this.handleRequest(
      {
        id: requestId,
        kind: "chat",
        text,
        conversationKey,
      },
      {
        onToolUse: async () => {},
        typingEligible: false,
        chatOptions: {
          background: true,
          persistConversation: true,
          enableMemoryIngestion: true,
          enableThreadStartContext: false,
          enableCompaction: true,
          includeBackgroundExecNotifications: true,
          providerSessionId: conversationKey,
          usagePurpose: "automation_autonomous_time",
        },
      },
    );
    scope.autonomousTime.markTriggered(reference);

    return {
      ...response,
      triggered: true,
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
          providerSessionId: `${buildAutomationSessionKey(alarm.kind, conversationKey)}-alarm-notification-${alarm.id}`,
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

  hasAlarmRoutinesDueNow(reference?: Date) {
    return this.routines.hasAlarmRoutinesDueNow(reference);
  }

  onRoutineScheduleChanged(listener: () => void) {
    return this.routines.onScheduleChanged(listener);
  }

  getNextRoutineAttentionAt(reference?: Date) {
    return this.routines.getNextRoutineAttentionAt(reference);
  }

  getRoutineTimezone(): string {
    return this.routines.getTimezone();
  }

  assessRoutines(reference?: Date) {
    return this.routines.assessNow(reference);
  }

  getHealthSummary() {
    return this.health.summary();
  }

  listHealthCheckins(limit = 10) {
    return this.health.listCheckins(limit).map((c) => ({
      id: c.id,
      observedAt: c.observedAt,
      kind: c.kind ?? "checkin",
      energy: c.energy,
      mood: c.mood,
      sleepHours: c.sleepHours,
      anxiety: c.anxiety,
    }));
  }

  listProjectSummaries() {
    return this.getScope().projects.listProjects({ status: "all" }).map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      priority: p.priority,
      summary: p.summary,
      tags: p.tags,
    }));
  }

  async listConversationSummaries() {
    const conversations = await this.conversations.list();
    return conversations.map((c) => ({
      key: c.key,
      messageCount: c.messages.length,
      updatedAt: c.updatedAt,
    }));
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
    });
    this.scopes.set(scopeKey, scope);
    this.wirePlaybackEndNotification(scope);
    return scope;
  }

  private wirePlaybackEndNotification(scope: RuntimeScope) {
    const mediaService = scope.routineTools.getMediaService();
    if (!mediaService) {
      return;
    }
    mediaService.onPlaybackEnd((event) => {
      const userId = this.getNotificationTargetUserId();
      const conversationKey = userId ?? scope.profile.id;
      const text = `Playback ended: ${event.title} on speaker ${event.speakerId}.`;
      void this.handleRequest(
        {
          id: `playback-end-${event.speakerId}-${Date.now()}`,
          kind: "chat",
          text,
          conversationKey,
        },
        { typingEligible: false },
      ).catch((error) => {
        this.appTelemetry.recordError(error, {
          speakerId: event.speakerId,
          title: event.title,
          operation: "media.playback_end_notification",
        });
      });
    });
  }

  private async injectAttachmentErrorFeedback(
    scope: RuntimeScope,
    conversationKey: string,
    response: AppResponse,
  ): Promise<void> {
    const errors = response.attachmentErrors;
    if (!errors || errors.length === 0) {
      return;
    }
    const feedbackLines = [
      `${ATTACHMENT_FAILED_PREFIX} The following file attachments failed to send to the user:`,
      ...errors.map((filePath) => `- ${filePath}`),
      "You should inform the user or recreate the file and try again.",
    ];
    try {
      await scope.chat.recordAssistantMessage({
        conversationKey,
        message: feedbackLines.join("\n"),
      });
    } catch (error) {
      this.appTelemetry.recordError(error, {
        conversationKey,
        operation: "app.inject_attachment_error_feedback",
        failedPaths: errors.join(", "),
      });
    }
  }

}
