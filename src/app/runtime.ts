import type { AppProgressEvent, AppRequest, AppResponse } from "../domain/assistant";
import type { ProfileRecord } from "../domain/profiles";
import type { SubagentRun } from "../domain/subagent-run";
import { ConversationStore } from "../services/conversation-store";
import { FinanceService } from "../services/finance-service";
import { HealthTrackingService } from "../services/health-tracking-service";
import { ProfileService } from "../services/profile-service";
import { ProjectWorkspaceService } from "../services/project-workspace-service";
import { HeartbeatService } from "../services/heartbeat-service";
import type { CacheMissWarning } from "../services/cache-miss-monitor";
import type { InferencePromptDriftWarning } from "../services/inference-prompt-drift-monitor";
import { RoutinesService } from "../services/routines-service";
import { ServiceRestartNoticeService } from "../services/service-restart-notice-service";
import { SystemPromptService } from "../services/system-prompt-service";
import { telemetry } from "../services/telemetry";
import { AlarmNotificationService } from "../services/alarm-notification-service";
import { AlarmService, type ScheduledAlarm } from "../services/alarm-service";
import { WorkPlanningService } from "../services/work-planning-service";
import { CalendarSyncService } from "../services/calendar-sync-service";
import { getRuntimeConfig } from "../config/runtime-config";
import { resolveRuntimePath } from "../services/runtime-root";

import { type RuntimeScope, createRuntimeScope } from "./runtime-scope";
import {
  createSubagentController,
  recoverSubagentRuns,
} from "./runtime-subagent";
import {
  SubagentRegistry,
  SubagentSidecar,
  SubagentTimeoutManager,
  TmuxManager,
} from "../subagent";
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
  private readonly subagentRegistry = this.appTelemetry.instrumentMethods(new SubagentRegistry(), {
    component: "subagent_registry",
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
  private readonly tmux: TmuxManager;
  private readonly subagentTimeouts: SubagentTimeoutManager;
  private readonly subagentSidecar: SubagentSidecar;

  constructor(options?: { profileId?: string }) {
    this.profiles = this.appTelemetry.instrumentMethods(new ProfileService(options?.profileId), {
      component: "profile",
    });
    this.activeProfile = this.profiles.getActiveProfile();

    // Initialize subagent infrastructure
    const subagentConfig = getRuntimeConfig().core.app.subagent;
    this.tmux = new TmuxManager(subagentConfig.tmuxSession);
    const sidecarSocketPath = subagentConfig.sidecarSocketPath || resolveRuntimePath("subagent-sidecar.sock");
    this.subagentSidecar = new SubagentSidecar(sidecarSocketPath);
    this.subagentTimeouts = new SubagentTimeoutManager(this.tmux, subagentConfig.timeoutGraceMs);

    // Start sidecar and subscribe to events
    this.subagentSidecar.start();
    this.subagentSidecar.onEvent((event) => {
      const run = this.subagentRegistry.get(event.runId);
      if (!run) return;

      this.subagentRegistry.appendEvent(event.runId, {
        kind: event.kind,
        timestamp: event.timestamp,
        summary: (event.payload.result as string) || (event.payload.output as string) || undefined,
      });

      if (event.kind === "worker.completed") {
        this.subagentTimeouts.clear(event.runId);
        const completedRun = this.subagentRegistry.markCompleted(
          event.runId,
          (event.payload.result as string) || (event.payload.output as string) || undefined,
        );
        if (completedRun) {
          const controller = this.buildSubagentController(this.activeProfile.id);
          // Inject completion into parent conversation
          void this.handleRequest(
            {
              id: `subagent-complete-${completedRun.id}`,
              kind: "chat",
              text: `Background subagent completion update.\n\nRun id: ${completedRun.id}\nProvider: ${completedRun.provider}\nProfile: ${completedRun.profileId}\nSubagent depth: ${completedRun.launchDepth}\n\n${completedRun.completionMessage ?? ""}\n\nDecide what to do next in the main thread. This completion update was pushed into the parent conversation automatically. If the same subagent should continue, call resume_agent with runId ${completedRun.id}. If more work should happen in a fresh worker, launch a new agent.`,
              conversationKey: completedRun.originConversationKey ?? completedRun.id,
            },
            { typingEligible: false },
          ).catch((error) => {
            this.appTelemetry.recordError(error, {
              subagentRunId: completedRun.id,
              operation: "subagent.completion_injection",
            });
          });
        }
      }

      if (event.kind === "worker.failed") {
        this.subagentTimeouts.clear(event.runId);
        const failedRun = this.subagentRegistry.markFailed(
          event.runId,
          (event.payload.error as string) || "Agent failed",
        );
        if (failedRun) {
          void this.handleRequest(
            {
              id: `subagent-complete-${failedRun.id}`,
              kind: "chat",
              text: `Background subagent completion update.\n\nRun id: ${failedRun.id}\nProvider: ${failedRun.provider}\nProfile: ${failedRun.profileId}\nSubagent depth: ${failedRun.launchDepth}\n\n${failedRun.completionMessage ?? ""}\n\nDecide what to do next in the main thread. This completion update was pushed into the parent conversation automatically. If the same subagent should continue, call resume_agent with runId ${failedRun.id}. If more work should happen in a fresh worker, launch a new agent.`,
              conversationKey: failedRun.originConversationKey ?? failedRun.id,
            },
            { typingEligible: false },
          ).catch((error) => {
            this.appTelemetry.recordError(error, {
              subagentRunId: failedRun.id,
              operation: "subagent.completion_injection",
            });
          });
        }
      }
    });

    // Recover any in-flight runs from previous session
    void recoverSubagentRuns({
      registry: this.subagentRegistry,
      tmux: this.tmux,
      timeouts: this.subagentTimeouts,
      onTimeout: (runId) => {
        const run = this.subagentRegistry.get(runId);
        if (run && run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled") {
          this.subagentRegistry.markFailed(runId, "Agent timed out.");
        }
      },
    }).catch((error) => {
      this.appTelemetry.recordError(error, {
        operation: "subagent.recovery",
      });
    });

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
            background: options?.chatOptions?.background,
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

        throw new Error(`Unsupported request kind: ${request.kind}`);
      },
    );
  }

  listAgentRuns(): SubagentRun[] {
    return this.buildSubagentController(this.activeProfile.id).listAgentRuns();
  }

  launchAgent(params: {
    goal: string;
    cwd?: string;
    profileId?: string;
    provider?: "claude" | "codex";
    originConversationKey?: string;
    requestedBy?: string;
    timeoutMs?: number;
    subagentDepth?: number;
  }) {
    return this.buildSubagentController(this.activeProfile.id).launchAgent(params);
  }

  resumeAgent(params: {
    runId: string;
    message?: string;
    timeoutMs?: number;
  }) {
    return this.buildSubagentController(this.activeProfile.id).resumeAgent(params);
  }

  steerAgent(params: {
    runId: string;
    message: string;
  }) {
    return this.buildSubagentController(this.activeProfile.id).steerAgent(params);
  }

  cancelAgent(params: {
    runId: string;
  }) {
    return this.buildSubagentController(this.activeProfile.id).cancelAgent(params);
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
    const { text } = scope.autonomousTime.buildInjectedMessage(reference);
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

  getAgentRun(runId: string): SubagentRun | undefined {
    return this.buildSubagentController(this.activeProfile.id).getAgentRun(runId);
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
      onPromptDriftWarning: (warning) => {
        if (!this.onPromptDriftWarning) {
          return;
        }
        void Promise.resolve(this.onPromptDriftWarning(warning)).catch((error) => {
          this.appTelemetry.recordError(error, {
            profileId,
            sessionId: warning.sessionId,
            operation: "app.prompt_drift_warning_notifier",
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
      createSubagentController: (pid: string) => this.buildSubagentController(pid),
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

  private buildSubagentController(sourceProfileId: string) {
    const getNotifier = () => this.onBackgroundConversationResponse;
    return createSubagentController({
      sourceProfileId,
      profiles: this.profiles,
      activeProfile: this.activeProfile,
      registry: this.subagentRegistry,
      tmux: this.tmux,
      timeouts: this.subagentTimeouts,
      sidecar: this.subagentSidecar,
      workspaces: this.workspaces,
      getScope: (profileId, options) => this.getScope(profileId, options),
      handleRequest: (request: AppRequest, options?: any) => this.handleRequest(request, options),
      get onBackgroundConversationResponse() { return getNotifier(); },
    });
  }
}
