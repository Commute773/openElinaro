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
import { InstanceSocketServer } from "../instance/socket-server";
import { resolveRuntimePath } from "../services/runtime-root";

import { type RuntimeScope, createRuntimeScope } from "./runtime-scope";
import {
  finalizeAppResponse,
  buildThreadStartSystemContext,
  buildHeartbeatWorkFocus,
  runHourlyHeartbeat as runHourlyHeartbeatImpl,
  runAutonomousTimeSession as runAutonomousTimeSessionImpl,
  runAlarmNotification as runAlarmNotificationImpl,
  type AutomationContext,
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
  private readonly startedAt = Date.now();
  private instanceServer: InstanceSocketServer | null = null;
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

    try {
      this.startInstanceServer();
    } catch (error) {
      this.appTelemetry.recordError(error, {
        profileId: this.activeProfile.id,
        operation: "instance_server.start",
      });
    }
  }

  /**
   * Start the inter-instance messaging socket server.
   * Listens on a Unix socket for messages from peer instances.
   */
  startInstanceServer(): void {
    if (this.instanceServer) {
      return;
    }
    const config = getRuntimeConfig();
    const socketPath = config.core.app.instance.socketPath || resolveRuntimePath("instance.sock");

    this.instanceServer = new InstanceSocketServer({
      socketPath,
      profileId: this.activeProfile.id,
      onMessage: async (message) => {
        try {
          await this.handleRequest({
            id: `instance:${message.from}:${Date.now()}`,
            text: message.content,
            conversationKey: message.conversationKey,
          });
          return { accepted: true, conversationKey: message.conversationKey };
        } catch (error) {
          return {
            accepted: false,
            conversationKey: message.conversationKey,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
      onStatus: () => ({
        profileId: this.activeProfile.id,
        uptime: Date.now() - this.startedAt,
        activeConversations: [...this.scopes.keys()],
      }),
    });

    this.instanceServer.start();
    this.appTelemetry.event("instance_server.started", {
      socketPath,
      profileId: this.activeProfile.id,
    });
  }

  /** Stop the inter-instance messaging socket server. */
  stopInstanceServer(): void {
    this.instanceServer?.stop();
    this.instanceServer = null;
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
        conversationKey: request.conversationKey,
        profileId: scope.profile.id,
      },
      async () => {
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
    input: Record<string, unknown>,
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
    return runHourlyHeartbeatImpl(this.getAutomationContext(), conversationKey, options);
  }

  getNextAutonomousTimeAt(reference?: Date) {
    const nextRunAt = this.getScope().autonomousTime.getNextRunAt(reference);
    return nextRunAt?.toISOString();
  }

  async runAutonomousTimeSession(options?: { reference?: Date }) {
    return runAutonomousTimeSessionImpl(this.getAutomationContext(), options);
  }

  async runAlarmNotification(
    conversationKey: string,
    alarm: ScheduledAlarm,
    options?: {
      reference?: Date;
      onBackgroundResponse?: (message: string) => Promise<void>;
    },
  ) {
    return runAlarmNotificationImpl(this.getAutomationContext(), conversationKey, alarm, options);
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

  private getAutomationContext(): AutomationContext {
    return {
      handleRequest: this.handleRequest.bind(this),
      recordAssistantMessage: (conversationKey, message) =>
        this.recordAssistantMessage(conversationKey, message),
      getScope: () => this.getScope(),
      buildHeartbeatWorkFocus: (reference) => this.buildHeartbeatWorkFocus(reference),
      routines: this.routines,
      heartbeats: this.heartbeats,
      calendar: this.calendar,
      alarmNotifications: this.alarmNotifications,
      activeProfile: this.activeProfile,
      appTelemetry: this.appTelemetry,
    };
  }

  private getScope(): RuntimeScope {
    const profileId = this.activeProfile.id;
    const cached = this.scopes.get(profileId);
    if (cached) {
      return cached;
    }

    const scope = createRuntimeScope({
      profileId,
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
    this.scopes.set(profileId, scope);
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
