import fs from "node:fs";
import type { AppProgressEvent, AppRequest, AppResponse } from "../domain/assistant";
import type { ProfileRecord } from "../domain/profiles";
import { resolveDiscordResponse } from "../services/discord-response-service";
import { RecentThreadContextService, shouldIncludeRecentThreadContext } from "../services/recent-thread-context-service";
import { wrapInjectedMessage } from "../services/injected-message-service";
import type { ProfileService } from "../services/profiles";
import type { ConversationStore } from "../services/conversation/conversation-store";
import { WorkPlanningService } from "../services/work-planning-service";
import type { RoutinesService } from "../services/scheduling/routines-service";
import type { HeartbeatService } from "../services/heartbeat-service";
import type { CalendarSyncService } from "../services/calendar-sync-service";
import type { AlarmNotificationService } from "../services/alarm-notification-service";
import type { ScheduledAlarm } from "../services/alarm-service";
import { getRuntimeConfig } from "../config/runtime-config";
import { telemetry } from "../services/infrastructure/telemetry";
import type { RuntimeScope } from "./runtime-scope";

export function finalizeAppResponse(scope: RuntimeScope, response: AppResponse): AppResponse {
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

export async function buildThreadStartSystemContext(
  scope: RuntimeScope,
  conversationKey: string,
  appTelemetry: typeof telemetry,
  conversations: ConversationStore,
  profiles: ProfileService,
) {
  const conversation = await conversations.get(conversationKey);
  if (!shouldIncludeRecentThreadContext(conversation.messages)) {
    return undefined;
  }

  const recentThreadContext = appTelemetry.instrumentMethods(
    new RecentThreadContextService(
      scope.profile,
      scope.projects,
      profiles,
    ),
    { component: "recent_thread_context" },
  ).buildThreadStartContext();
  const reflectionContext = await scope.autonomousTime.buildThreadBootstrapContext();
  const sections = [reflectionContext, recentThreadContext].filter(Boolean);
  return sections.length > 0
    ? wrapInjectedMessage("recent_context", sections.join("\n\n"))
    : undefined;
}

export function buildHeartbeatWorkFocus(
  scope: RuntimeScope,
  appTelemetry: typeof telemetry,
  routines: RoutinesService,
  reference?: Date,
) {
  return appTelemetry.instrumentMethods(
    new WorkPlanningService(routines, scope.projects),
    { component: "work_planning" },
  ).buildHeartbeatSummary(reference) ?? undefined;
}

export function buildAutomationSessionKey(kind: string, conversationKey: string) {
  return `automation:${kind}:${conversationKey}`;
}

// ---------------------------------------------------------------------------
// Automation context & extracted orchestration functions
// ---------------------------------------------------------------------------

export type AutomationContext = {
  handleRequest: (
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
  ) => Promise<AppResponse>;
  recordAssistantMessage: (conversationKey: string, message: string) => Promise<void>;
  getScope: () => RuntimeScope;
  buildHeartbeatWorkFocus: (reference?: Date) => string | undefined;
  routines: RoutinesService;
  heartbeats: HeartbeatService;
  calendar: CalendarSyncService;
  alarmNotifications: AlarmNotificationService;
  activeProfile: ProfileRecord;
  appTelemetry: typeof telemetry;
};

/**
 * Run the hourly heartbeat check – extracted from OpenElinaroApp.runHourlyHeartbeat.
 */
export async function runHourlyHeartbeat(
  ctx: AutomationContext,
  conversationKey: string,
  options?: {
    reference?: Date;
    onBackgroundResponse?: (message: string) => Promise<void>;
  },
) {
  await ctx.calendar.syncIfNeeded({ reference: options?.reference }).catch((error) => {
    ctx.appTelemetry.recordError(error, {
      profileId: ctx.activeProfile.id,
      operation: "calendar.heartbeat_sync",
    });
  });

  if (!ctx.routines.shouldRunHeartbeat(options?.reference)) {
    return {
      requestId: `heartbeat-${Date.now()}`,
      mode: "immediate" as const,
      message: "",
      warnings: [],
      completed: true,
    };
  }

  const requestId = `heartbeat-${Date.now()}`;
  const scope = ctx.getScope();
  const heartbeatConfig = getRuntimeConfig().core.app.heartbeat;
  const useFullContext = heartbeatConfig.contextMode === "full";
  const workFocus = ctx.buildHeartbeatWorkFocus(options?.reference);
  const reminderSnapshot = ctx.routines.getHeartbeatReminderSnapshot(options?.reference);
  const localTime = reminderSnapshot.currentLocalTime;
  const reflectionEligible = scope.autonomousTime.isDailyReflectionEligible(options?.reference);
  const heartbeatConversationKey = buildAutomationSessionKey("heartbeat", conversationKey);
  let reminderMarked = false;
  let userFacingMessageSent = false;
  const recordedMainThreadMessages = new Set<string>();
  const recordHeartbeatMessageToMainThread = async (message: string, source: string) => {
    try {
      await ctx.recordAssistantMessage(conversationKey, message);
      ctx.appTelemetry.event("app.heartbeat.main_thread_handoff", {
        conversationKey,
        heartbeatConversationKey,
        requestId,
        source,
        messageChars: message.length,
      });
    } catch (error) {
      ctx.appTelemetry.recordError(error, {
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
    const normalized = ctx.heartbeats.normalizeAssistantReply(rawMessage) ?? "";
    if (!normalized) {
      return "";
    }
    if (!recordedMainThreadMessages.has(normalized)) {
      recordedMainThreadMessages.add(normalized);
      await recordHeartbeatMessageToMainThread(normalized, source);
    }
    userFacingMessageSent = true;
    if (!reminderMarked && reminderSnapshot.requiredCandidates.length > 0) {
      ctx.routines.markReminded(
        reminderSnapshot.itemIds,
        reminderSnapshot.occurrenceKeys,
        options?.reference,
      );
      reminderMarked = true;
    }
    return normalized;
  };
  const buildHeartbeatPrompt = (deliveryRequirement?: string) => {
    const prompt = ctx.heartbeats.buildInjectedMessage(options?.reference, {
      workFocus,
      localTime,
      timezone: reminderSnapshot.timezone,
      reminderSnapshot,
      reflectionTrigger: reflectionEligible
        ? "A private daily reflection is eligible after this heartbeat if no user-facing heartbeat reminder is needed."
        : undefined,
      deliveryRequirement,
    });
    ctx.appTelemetry.event("app.heartbeat.prompt_prepared", {
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
    ctx.handleRequest(
      {
        id: turnId,
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
    ctx.appTelemetry.event("app.heartbeat.model_violation", {
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
      ctx.appTelemetry.event("app.heartbeat.model_violation", {
        conversationKey,
        requestId,
        phase: "retry",
        requiredCandidateCount: reminderSnapshot.requiredCandidates.length,
      });
    }
  }
  const completed = userFacingMessageSent || reminderSnapshot.requiredCandidates.length === 0;
  if (completed && response.mode !== "accepted" && !userFacingMessageSent && reflectionEligible) {
    scope.autonomousTime.queueDailyReflectionIfEligible(options?.reference);
  }

  return {
    ...response,
    message: finalMessage,
    completed,
  };
}

/**
 * Run an autonomous time session – extracted from OpenElinaroApp.runAutonomousTimeSession.
 */
export async function runAutonomousTimeSession(
  ctx: AutomationContext,
  options?: { reference?: Date },
) {
  const scope = ctx.getScope();
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
  const automationConversationKey = buildAutomationSessionKey(`autonomous-time-${localDate}`, scope.profile.id);
  const response = await ctx.handleRequest(
    {
      id: requestId,
      text,
      conversationKey: automationConversationKey,
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
        providerSessionId: automationConversationKey,
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

/**
 * Run an alarm notification – extracted from OpenElinaroApp.runAlarmNotification.
 */
export async function runAlarmNotification(
  ctx: AutomationContext,
  conversationKey: string,
  alarm: ScheduledAlarm,
  options?: {
    reference?: Date;
    onBackgroundResponse?: (message: string) => Promise<void>;
  },
) {
  return ctx.handleRequest(
    {
      id: `alarm-notification-${alarm.id}`,
      text: ctx.alarmNotifications.buildInjectedMessage(alarm, options?.reference),
      conversationKey: buildAutomationSessionKey(alarm.kind, conversationKey),
    },
    {
      onBackgroundResponse: options?.onBackgroundResponse
        ? async (backgroundResponse) => {
            const message = ctx.alarmNotifications.normalizeAssistantReply(backgroundResponse.message);
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
    message: ctx.alarmNotifications.normalizeAssistantReply(response.message) ?? "",
  }));
}
