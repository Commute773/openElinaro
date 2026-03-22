import type { Client } from "discord.js";
import { OpenElinaroApp } from "../../app/runtime";
import { DocsIndexService } from "../../services/docs-index-service";
import { DocsIndexStateService } from "../../services/docs-index-state-service";
import { HeartbeatStateService } from "../../services/heartbeat-state-service";
import { getLocalTimezone } from "../../services/local-time-service";
import { telemetry } from "../../services/telemetry";
import { createTraceSpan } from "../../utils/telemetry-helpers";

const HEARTBEAT_INTERVAL_MS = 55 * 60 * 1000;
const ALERT_POLL_MIN_MS = 5_000;
const HEARTBEAT_FAILURE_BACKOFF_MS = [
  15_000,
  30_000,
  60_000,
  120_000,
  300_000,
];
const DOCS_INDEX_FAILURE_BACKOFF_MS = [
  60_000,
  300_000,
  900_000,
  3_600_000,
];
const discordNotifierTelemetry = telemetry.child({ component: "discord" });

const traceSpan = createTraceSpan(discordNotifierTelemetry);

export class DiscordRoutinesNotifier {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeAlarmScheduleChange: (() => void) | null = null;
  private readonly heartbeatState = new HeartbeatStateService();
  private readonly docsIndexState: DocsIndexStateService;
  private readonly docsIndexer: DocsIndexService;
  private nextHeartbeatAt = this.computeInitialNextHeartbeatAt();
  private nextAutonomousTimeAt: number;
  private nextDocsIndexAt: number;
  private running = false;

  constructor(
    private readonly client: Client<true>,
    private readonly app: OpenElinaroApp,
    options?: {
      docsIndexState?: DocsIndexStateService;
      docsIndexer?: DocsIndexService;
    },
  ) {
    this.docsIndexState = options?.docsIndexState ?? new DocsIndexStateService();
    this.docsIndexer = options?.docsIndexer ?? new DocsIndexService();
    this.nextAutonomousTimeAt = this.computeInitialNextAutonomousTimeAt();
    this.nextDocsIndexAt = this.computeInitialNextDocsIndexAt();
  }

  start() {
    if (this.timer) {
      return;
    }
    this.unsubscribeAlarmScheduleChange ??= this.app.onAlarmScheduleChanged(() => {
      this.scheduleNextRun();
    });
    this.scheduleNextRun();
  }

  stop() {
    this.unsubscribeAlarmScheduleChange?.();
    this.unsubscribeAlarmScheduleChange = null;
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNextRun() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const nextAlarmDueAt = this.app.getNextAlarmDueAt();
    const nextRoutineAttentionAt = this.app.getNextRoutineAttentionAt?.();
    const heartbeatDelayMs = Math.max(ALERT_POLL_MIN_MS, this.nextHeartbeatAt - Date.now());
    const alarmDelayMs = nextAlarmDueAt
      ? Math.max(ALERT_POLL_MIN_MS, new Date(nextAlarmDueAt).getTime() - Date.now())
      : Number.POSITIVE_INFINITY;
    const routineDelayMs = nextRoutineAttentionAt
      ? Math.max(ALERT_POLL_MIN_MS, new Date(nextRoutineAttentionAt).getTime() - Date.now())
      : Number.POSITIVE_INFINITY;
    const autonomousTimeDelayMs = this.nextAutonomousTimeAt
      ? Math.max(ALERT_POLL_MIN_MS, this.nextAutonomousTimeAt - Date.now())
      : Number.POSITIVE_INFINITY;
    const docsIndexDelayMs = this.docsIndexer.isEnabled()
      ? Math.max(ALERT_POLL_MIN_MS, this.nextDocsIndexAt - Date.now())
      : Number.POSITIVE_INFINITY;
    const delayMs = Math.min(heartbeatDelayMs, alarmDelayMs, routineDelayMs, autonomousTimeDelayMs, docsIndexDelayMs);

    this.timer = setTimeout(() => {
      void this.runTick();
    }, Number.isFinite(delayMs) ? delayMs : HEARTBEAT_INTERVAL_MS);
  }

  private computeInitialNextHeartbeatAt(reference = new Date()) {
    const state = this.heartbeatState.load();
    const lastCompletedAt = state.lastCompletedAt;
    if (!lastCompletedAt) {
      const nextAttemptAt = state.nextAttemptAt ? new Date(state.nextAttemptAt).getTime() : Number.NaN;
      return Number.isFinite(nextAttemptAt) && nextAttemptAt > reference.getTime()
        ? nextAttemptAt
        : reference.getTime();
    }

    const lastCompletedTime = new Date(lastCompletedAt).getTime();
    if (!Number.isFinite(lastCompletedTime)) {
      return reference.getTime();
    }

    const nextDueAt = lastCompletedTime + HEARTBEAT_INTERVAL_MS;
    const nextAttemptAt = state.nextAttemptAt ? new Date(state.nextAttemptAt).getTime() : Number.NaN;
    const candidates = [nextDueAt, nextAttemptAt]
      .filter((value) => Number.isFinite(value))
      .filter((value) => value > reference.getTime())
      .sort((left, right) => left - right);
    return candidates[0] ?? reference.getTime();
  }

  private markHeartbeatCompleted(reference = new Date()) {
    const completedAt = reference.toISOString();
    this.heartbeatState.save({
      lastCompletedAt: completedAt,
      consecutiveFailures: 0,
    });
    this.nextHeartbeatAt = reference.getTime() + HEARTBEAT_INTERVAL_MS;
  }

  private markHeartbeatFailed(reference = new Date()) {
    const state = this.heartbeatState.load();
    const consecutiveFailures = (state.consecutiveFailures ?? 0) + 1;
    const backoffMs = HEARTBEAT_FAILURE_BACKOFF_MS[Math.min(
      consecutiveFailures - 1,
      HEARTBEAT_FAILURE_BACKOFF_MS.length - 1,
    )] ?? ALERT_POLL_MIN_MS;
    const nextAttemptAt = new Date(reference.getTime() + backoffMs).toISOString();
    this.heartbeatState.save({
      ...state,
      lastFailedAt: reference.toISOString(),
      consecutiveFailures,
      nextAttemptAt,
    });
    this.nextHeartbeatAt = new Date(nextAttemptAt).getTime();
  }

  private computeInitialNextDocsIndexAt(reference = new Date()) {
    if (!this.docsIndexer.isEnabled()) {
      return Number.POSITIVE_INFINITY;
    }

    const state = this.docsIndexState.load();
    const scheduledAt = this.docsIndexer.getNextScheduledRunAt(reference, getLocalTimezone()).getTime();
    const retryAt = state.nextAttemptAt ? new Date(state.nextAttemptAt).getTime() : Number.NaN;
    if (Number.isFinite(retryAt) && retryAt > reference.getTime()) {
      return Math.min(scheduledAt, retryAt);
    }
    return scheduledAt;
  }

  private computeInitialNextAutonomousTimeAt(reference = new Date()) {
    const nextRunAt = this.app?.getNextAutonomousTimeAt?.(reference);
    return nextRunAt ? new Date(nextRunAt).getTime() : Number.POSITIVE_INFINITY;
  }

  private markDocsIndexCompleted(reference = new Date()) {
    const completedAt = reference.toISOString();
    this.docsIndexState.save({
      lastCompletedAt: completedAt,
      consecutiveFailures: 0,
    });
    this.nextDocsIndexAt = this.docsIndexer.getNextScheduledRunAt(reference, getLocalTimezone()).getTime();
  }

  private markDocsIndexFailed(reference = new Date()) {
    const state = this.docsIndexState.load();
    const consecutiveFailures = (state.consecutiveFailures ?? 0) + 1;
    const backoffMs = DOCS_INDEX_FAILURE_BACKOFF_MS[Math.min(
      consecutiveFailures - 1,
      DOCS_INDEX_FAILURE_BACKOFF_MS.length - 1,
    )] ?? ALERT_POLL_MIN_MS;
    const nextAttemptAt = new Date(reference.getTime() + backoffMs).toISOString();
    this.docsIndexState.save({
      ...state,
      lastFailedAt: reference.toISOString(),
      consecutiveFailures,
      nextAttemptAt,
    });
    this.nextDocsIndexAt = new Date(nextAttemptAt).getTime();
  }

  private async runTick() {
    if (this.running) {
      this.scheduleNextRun();
      return;
    }

    this.running = true;
    this.timer = null;

    try {
      await traceSpan(
        "discord.routines_notifier.tick",
        async () => {
          const userId = this.app.getNotificationTargetUserId();
          if (!userId) {
            discordNotifierTelemetry.event("discord.routines_notifier.no_target", undefined, {
              level: "debug",
            });
          } else {
            const user = await this.client.users.fetch(userId);
            const dm = await user.createDM();
            const dueAlarms = this.app.listDueAlarms(new Date(), 20);
            for (const alarm of dueAlarms) {
              let delivered = false;
              const response = await this.app.runAlarmNotification(userId, alarm, {
                onBackgroundResponse: async (message) => {
                  delivered = await this.deliverAssistantMessage(userId, dm, message);
                },
              });
              if (response.message) {
                delivered = await this.deliverAssistantMessage(userId, dm, response.message) || delivered;
              }
              if (!delivered) {
                discordNotifierTelemetry.event(
                  "discord.alarm.noop",
                  { userId, alarmId: alarm.id, kind: alarm.kind },
                  { level: "debug" },
                );
                continue;
              }
              this.app.markAlarmDelivered(alarm.id);
              discordNotifierTelemetry.event("discord.alarm.sent", {
                userId,
                alarmId: alarm.id,
                kind: alarm.kind,
              });
            }

            if (Date.now() >= this.nextHeartbeatAt) {
              const response = await this.app.runHourlyHeartbeat(userId, {
                onBackgroundResponse: async (message) => {
                  if (!await this.sendAssistantMessage(dm, message)) {
                    return;
                  }
                  discordNotifierTelemetry.event("discord.routines_notifier.sent_background", { userId });
                },
              });
              if (response.message) {
                await this.sendAssistantMessage(dm, response.message);
                discordNotifierTelemetry.event("discord.routines_notifier.sent", { userId, mode: response.mode });
              } else {
                discordNotifierTelemetry.event(
                  "discord.routines_notifier.noop",
                  { userId, mode: response.mode },
                  { level: "debug" },
                );
              }
              if (response.completed) {
                this.markHeartbeatCompleted(new Date());
              } else {
                this.markHeartbeatFailed(new Date());
              }
            }
          }

          if (Date.now() >= this.nextAutonomousTimeAt) {
            try {
              const response = await this.app.runAutonomousTimeSession({
                reference: new Date(),
              });
              this.nextAutonomousTimeAt = this.computeInitialNextAutonomousTimeAt(new Date());
              discordNotifierTelemetry.event(
                response.triggered
                  ? "discord.autonomous_time.triggered"
                  : "discord.autonomous_time.skipped",
                { mode: response.mode },
                response.triggered ? undefined : { level: "debug" },
              );
            } catch (error) {
              this.nextAutonomousTimeAt = this.computeInitialNextAutonomousTimeAt(new Date());
              discordNotifierTelemetry.event(
                "discord.autonomous_time.error",
                {
                  error: error instanceof Error
                    ? { name: error.name, message: error.message, stack: error.stack }
                    : String(error),
                },
                { level: "error", outcome: "error" },
              );
            }
          }
        },
      );

      if (this.docsIndexer.isEnabled() && Date.now() >= this.nextDocsIndexAt) {
        try {
          const report = this.docsIndexer.sync();
          this.markDocsIndexCompleted(new Date());
          discordNotifierTelemetry.event("discord.docs_index.synced", {
            changedFiles: report.changedFiles,
            orphanDocs: report.orphanDocs.length,
            missingDocTargets: report.missingDocTargets.length,
          });
        } catch (error) {
          this.markDocsIndexFailed(new Date());
          discordNotifierTelemetry.event(
            "discord.docs_index.error",
            {
              error: error instanceof Error
                ? { name: error.name, message: error.message, stack: error.stack }
                : String(error),
            },
            { level: "error", outcome: "error" },
          );
        }
      }
    } catch (error) {
      this.markHeartbeatFailed(new Date());
      discordNotifierTelemetry.event(
        "discord.routines_notifier.error",
        {
          error: error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : String(error),
        },
        { level: "error", outcome: "error" },
      );
    } finally {
      this.running = false;
      this.scheduleNextRun();
    }
  }

  private async deliverAssistantMessage(
    conversationKey: string,
    dm: { send: (message: string) => Promise<unknown> },
    message: string,
  ) {
    const normalized = message.trim();
    if (!normalized) {
      return false;
    }

    await dm.send(normalized);
    try {
      await this.app.recordAssistantMessage(conversationKey, normalized);
    } catch (error) {
      discordNotifierTelemetry.event(
        "discord.routines_notifier.record_assistant_message_error",
        {
          conversationKey,
          error: error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : String(error),
        },
        { level: "error", outcome: "error" },
      );
    }
    return true;
  }

  private async sendAssistantMessage(
    dm: { send: (message: string) => Promise<unknown> },
    message: string,
  ) {
    const normalized = message.trim();
    if (!normalized) {
      return false;
    }

    await dm.send(normalized);
    return true;
  }
}
