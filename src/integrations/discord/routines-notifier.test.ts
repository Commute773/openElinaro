import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DocsIndexService } from "../../services/docs-index-service";
import type { DocsIndexStateService } from "../../services/docs-index-state-service";
import { DiscordRoutinesNotifier } from "./routines-notifier";

let runtimeRoot = "";
let previousRootDirEnv: string | undefined;

function getHeartbeatStatePath() {
  return path.join(runtimeRoot, ".openelinarotest", "heartbeat-state.json");
}

function readHeartbeatState() {
  const filePath = getHeartbeatStatePath();
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as {
    lastCompletedAt?: string;
    lastFailedAt?: string;
    consecutiveFailures?: number;
    nextAttemptAt?: string;
  };
}

function writeHeartbeatState(lastCompletedAt: string) {
  fs.mkdirSync(path.dirname(getHeartbeatStatePath()), { recursive: true });
  fs.writeFileSync(
    getHeartbeatStatePath(),
    `${JSON.stringify({ lastCompletedAt }, null, 2)}\n`,
  );
}

function createHarness(options?: {
  userId?: string | null;
  heartbeatMessage?: string;
  mode?: "immediate" | "accepted";
  throwHeartbeat?: boolean;
  heartbeatCompleted?: boolean;
  dueAlarms?: Array<{
    id: string;
    kind: "alarm" | "timer";
    name: string;
    triggerAt: string;
    timezone: string;
    createdAt: string;
    originalSpec: string;
  }>;
  alarmMessages?: Record<string, string>;
  alarmMode?: "immediate" | "accepted";
  throwAlarm?: boolean;
  failSendForMessage?: string;
  notifierOptions?: {
    docsIndexer?: Pick<DocsIndexService, "isEnabled" | "getNextScheduledRunAt" | "sync">;
    docsIndexState?: Pick<DocsIndexStateService, "load" | "save">;
  };
  nextAutonomousTimeAt?: string | null;
  autonomousTriggered?: boolean;
  throwAutonomousTime?: boolean;
}) {
  const sent: string[] = [];
  const recorded: Array<{ conversationKey: string; message: string }> = [];
  const deliveredAlarmIds: string[] = [];
  let heartbeatCalls = 0;
  let autonomousTimeCalls = 0;
  let nextAlarmDueAt: string | null = null;
  let alarmScheduleChangedListener: (() => void) | null = null;
  const client = {
    users: {
      fetch: async () => ({
        createDM: async () => ({
          send: async (message: string) => {
            if (options?.failSendForMessage && message === options.failSendForMessage) {
              throw new Error("send failed");
            }
            sent.push(message);
          },
        }),
      }),
    },
  };
  const app = {
    getNotificationTargetUserId: () => options?.userId ?? "discord-user",
    getNextAlarmDueAt: () => nextAlarmDueAt,
    getNextRoutineAttentionAt: () => null,
    getNextAutonomousTimeAt: () => options?.nextAutonomousTimeAt ?? undefined,
    listDueAlarms: () => options?.dueAlarms ?? [],
    markAlarmDelivered: (alarmId: string) => {
      deliveredAlarmIds.push(alarmId);
    },
    recordAssistantMessage: async (conversationKey: string, message: string) => {
      recorded.push({ conversationKey, message });
    },
    onAlarmScheduleChanged: (listener: () => void) => {
      alarmScheduleChangedListener = listener;
      return () => {
        if (alarmScheduleChangedListener === listener) {
          alarmScheduleChangedListener = null;
        }
      };
    },
    runHourlyHeartbeat: async (_conversationKey: string, heartbeatOptions?: {
      onBackgroundResponse?: (message: string) => Promise<void>;
    }) => {
      heartbeatCalls += 1;
      if (options?.throwHeartbeat) {
        throw new Error("heartbeat failed");
      }
      const heartbeatMessage = options?.heartbeatMessage ?? "";
      const recordHeartbeatMessage = async () => {
        if (!heartbeatMessage.trim()) {
          return;
        }
        await app.recordAssistantMessage("discord-user", heartbeatMessage.trim());
      };
      if ((options?.mode ?? "immediate") === "accepted") {
        await recordHeartbeatMessage();
        await heartbeatOptions?.onBackgroundResponse?.(heartbeatMessage);
        return {
          requestId: "heartbeat-request",
          mode: "accepted" as const,
          message: "",
          warnings: [],
          completed: options?.heartbeatCompleted ?? true,
        };
      }

      await recordHeartbeatMessage();
      return {
        requestId: "heartbeat-request",
        mode: "immediate" as const,
        message: heartbeatMessage,
        warnings: [],
        completed: options?.heartbeatCompleted ?? true,
      };
    },
    runAutonomousTimeSession: async () => {
      autonomousTimeCalls += 1;
      if (options?.throwAutonomousTime) {
        throw new Error("autonomous time failed");
      }
      return {
        requestId: "autonomous-time-request",
        mode: "accepted" as const,
        message: "",
        warnings: [],
        triggered: options?.autonomousTriggered ?? true,
      };
    },
    runAlarmNotification: async (
      _conversationKey: string,
      alarm: { id: string },
      alarmOptions?: {
        onBackgroundResponse?: (message: string) => Promise<void>;
      },
    ) => {
      if (options?.throwAlarm) {
        throw new Error("alarm failed");
      }
      const message = options?.alarmMessages?.[alarm.id] ?? "";
      if ((options?.alarmMode ?? "immediate") === "accepted") {
        await alarmOptions?.onBackgroundResponse?.(message);
        return {
          requestId: `alarm-${alarm.id}`,
          mode: "accepted" as const,
          message: "",
          warnings: [],
        };
      }
      return {
        requestId: `alarm-${alarm.id}`,
        mode: "immediate" as const,
        message,
        warnings: [],
      };
    },
  };

  return {
    sent,
    recorded,
    deliveredAlarmIds,
    heartbeatCalls: () => heartbeatCalls,
    autonomousTimeCalls: () => autonomousTimeCalls,
    setNextAlarmDueAt: (value: string | null) => {
      nextAlarmDueAt = value;
    },
    triggerAlarmScheduleChanged: () => {
      alarmScheduleChangedListener?.();
    },
    notifier: new DiscordRoutinesNotifier(client as never, app as never, options?.notifierOptions as never),
  };
}

beforeEach(() => {
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-heartbeat-notifier-"));
  process.env.OPENELINARO_ROOT_DIR = runtimeRoot;
});

afterEach(() => {
  if (previousRootDirEnv === undefined) {
    delete process.env.OPENELINARO_ROOT_DIR;
  } else {
    process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
  }
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  runtimeRoot = "";
});

describe("DiscordRoutinesNotifier", () => {
  test("sends the heartbeat reply when it is immediately actionable", async () => {
    const harness = createHarness({
      heartbeatMessage: "Check your urgent todos.",
    });

    await (harness.notifier as never as { runTick: () => Promise<void> }).runTick();
    harness.notifier.stop();

    expect(harness.sent).toEqual(["Check your urgent todos."]);
    expect(harness.recorded).toEqual([{ conversationKey: "discord-user", message: "Check your urgent todos." }]);
    expect(readHeartbeatState()?.lastCompletedAt).toBeString();
  });

  test("stays quiet when the heartbeat returns no user-facing message", async () => {
    const harness = createHarness({
      heartbeatMessage: "",
    });

    await (harness.notifier as never as { runTick: () => Promise<void> }).runTick();
    harness.notifier.stop();

    expect(harness.sent).toEqual([]);
    expect(harness.recorded).toEqual([]);
    expect(readHeartbeatState()?.lastCompletedAt).toBeString();
  });

  test("delivers a deferred heartbeat reply from the background callback", async () => {
    const harness = createHarness({
      mode: "accepted",
      heartbeatMessage: "You have one overdue task.",
    });

    await (harness.notifier as never as { runTick: () => Promise<void> }).runTick();
    harness.notifier.stop();

    expect(harness.sent).toEqual(["You have one overdue task."]);
    expect(harness.recorded).toEqual([{ conversationKey: "discord-user", message: "You have one overdue task." }]);
    expect(readHeartbeatState()?.lastCompletedAt).toBeString();
  });

  test("does not run an immediate heartbeat when the persisted cadence is still fresh", async () => {
    const recentCompletedAt = new Date(Date.now() - (10 * 60 * 1000)).toISOString();
    writeHeartbeatState(recentCompletedAt);
    const harness = createHarness({
      heartbeatMessage: "Should not send yet.",
    });

    await (harness.notifier as never as { runTick: () => Promise<void> }).runTick();
    harness.notifier.stop();

    expect(harness.heartbeatCalls()).toBe(0);
    expect(harness.sent).toEqual([]);
    expect(readHeartbeatState()).toEqual({
      lastCompletedAt: recentCompletedAt,
    });
  });

  test("runs an overdue heartbeat immediately after startup catch-up", async () => {
    const overdueCompletedAt = new Date(Date.now() - (60 * 60 * 1000)).toISOString();
    writeHeartbeatState(overdueCompletedAt);
    const harness = createHarness({
      heartbeatMessage: "",
    });

    await (harness.notifier as never as { runTick: () => Promise<void> }).runTick();
    harness.notifier.stop();

    expect(harness.heartbeatCalls()).toBe(1);
    expect(new Date(readHeartbeatState()?.lastCompletedAt ?? "").getTime()).toBeGreaterThan(new Date(overdueCompletedAt).getTime());
  });

  test("does not advance persisted cadence when the heartbeat run fails", async () => {
    const overdueCompletedAt = new Date(Date.now() - (60 * 60 * 1000)).toISOString();
    writeHeartbeatState(overdueCompletedAt);
    const harness = createHarness({
      throwHeartbeat: true,
    });

    await (harness.notifier as never as { runTick: () => Promise<void> }).runTick();
    harness.notifier.stop();

    expect(harness.heartbeatCalls()).toBe(1);
    expect(readHeartbeatState()).toEqual(expect.objectContaining({
      lastCompletedAt: overdueCompletedAt,
      consecutiveFailures: 1,
    }));
    expect(readHeartbeatState()?.nextAttemptAt).toBeString();
  });

  test("backs off instead of completing the cadence when the heartbeat requests a retry", async () => {
    const overdueCompletedAt = new Date(Date.now() - (60 * 60 * 1000)).toISOString();
    writeHeartbeatState(overdueCompletedAt);
    const harness = createHarness({
      heartbeatMessage: "",
      heartbeatCompleted: false,
    });

    await (harness.notifier as never as { runTick: () => Promise<void> }).runTick();
    harness.notifier.stop();

    expect(harness.sent).toEqual([]);
    expect(readHeartbeatState()).toEqual(expect.objectContaining({
      lastCompletedAt: overdueCompletedAt,
      consecutiveFailures: 1,
    }));
  });

  test("routes timer notifications through the agent and appends only the final assistant message", async () => {
    const harness = createHarness({
      dueAlarms: [{
        id: "timer-1",
        kind: "timer",
        name: "Shower time",
        triggerAt: "2026-03-18T15:07:27.000Z",
        timezone: "America/Montreal",
        createdAt: "2026-03-18T14:57:27.000Z",
        originalSpec: "10m",
      }],
      alarmMessages: {
        "timer-1": "Shower time.",
      },
    });

    await (harness.notifier as never as { runTick: () => Promise<void> }).runTick();
    harness.notifier.stop();

    expect(harness.sent).toEqual(["Shower time."]);
    expect(harness.sent[0]).not.toContain("Timer triggered:");
    expect(harness.recorded).toEqual([{ conversationKey: "discord-user", message: "Shower time." }]);
    expect(harness.deliveredAlarmIds).toEqual(["timer-1"]);
  });

  test("leaves alarms pending when Discord delivery fails", async () => {
    const harness = createHarness({
      dueAlarms: [{
        id: "alarm-1",
        kind: "alarm",
        name: "Take meds",
        triggerAt: "2026-03-18T15:07:27.000Z",
        timezone: "America/Montreal",
        createdAt: "2026-03-18T14:57:27.000Z",
        originalSpec: "15:07",
      }],
      alarmMessages: {
        "alarm-1": "Take your meds now.",
      },
      failSendForMessage: "Take your meds now.",
    });

    await (harness.notifier as never as { runTick: () => Promise<void> }).runTick();
    harness.notifier.stop();

    expect(harness.deliveredAlarmIds).toEqual([]);
    expect(harness.recorded).toEqual([]);
  });

  test("clamps overdue routine attention to the minimum poll interval", () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const scheduled: number[] = [];
    let nextHandle = 0;
    const client = {
      users: {
        fetch: async () => ({
          createDM: async () => ({
            send: async () => {},
          }),
        }),
      },
    };
    const app = {
      getNotificationTargetUserId: () => "discord-user",
      getNextAlarmDueAt: () => null,
      getNextRoutineAttentionAt: () => new Date(Date.now() - 60_000).toISOString(),
      listDueAlarms: () => [],
      markAlarmDelivered: () => {},
      recordAssistantMessage: async () => {},
      onAlarmScheduleChanged: () => () => {},
      runHourlyHeartbeat: async () => ({
        requestId: "heartbeat-request",
        mode: "immediate" as const,
        message: "",
        warnings: [],
        completed: true,
      }),
      runAlarmNotification: async () => ({
        requestId: "alarm-request",
        mode: "immediate" as const,
        message: "",
        warnings: [],
      }),
    };

    globalThis.setTimeout = ((callback: (...args: never[]) => void, delay?: number) => {
      void callback;
      scheduled.push(delay as number);
      return (++nextHandle) as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as unknown as typeof clearTimeout;

    try {
      new DiscordRoutinesNotifier(client as never, app as never).start();
      expect(scheduled[0]).toBe(5_000);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  test("reschedules the notifier when a newly created alarm is earlier than the next heartbeat", () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const scheduled: number[] = [];
    const cleared: ReturnType<typeof setTimeout>[] = [];
    let nextHandle = 0;

    globalThis.setTimeout = ((callback: (...args: never[]) => void, delay?: number) => {
      void callback;
      scheduled.push(delay as number);
      return (++nextHandle) as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
      if (handle) {
        cleared.push(handle);
      }
    }) as unknown as typeof clearTimeout;

    try {
      const now = new Date("2026-03-17T14:16:03.802Z");
      const harness = createHarness();
      const notifier = harness.notifier as never as {
        nextHeartbeatAt: number;
        scheduleNextRun: () => void;
      };

      notifier.nextHeartbeatAt = new Date("2026-03-17T14:53:57.672Z").getTime();

      const realNow = Date.now;
      Date.now = () => now.getTime();
      try {
        harness.notifier.start();
        harness.setNextAlarmDueAt("2026-03-17T14:30:00.000Z");
        harness.triggerAlarmScheduleChanged();
      } finally {
        Date.now = realNow;
      }

      harness.notifier.stop();

      expect(scheduled).toEqual([
        2_273_870,
        836_198,
      ]);
      expect(cleared.length).toBeGreaterThanOrEqual(2);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  test("schedules the docs indexer when its midnight run is earlier than the next heartbeat", () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const scheduled: number[] = [];
    let nextHandle = 0;

    globalThis.setTimeout = ((callback: (...args: never[]) => void, delay?: number) => {
      void callback;
      scheduled.push(delay as number);
      return (++nextHandle) as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as unknown as typeof clearTimeout;

    try {
      const now = new Date("2026-03-18T23:54:00.000Z");
      const harness = createHarness({
        notifierOptions: {
          docsIndexer: {
            isEnabled: () => true,
            getNextScheduledRunAt: () => new Date("2026-03-18T23:59:00.000Z"),
            sync: () => ({
              generatedAt: now.toISOString(),
              rootDir: runtimeRoot,
              docs: [],
              orphanDocs: [],
              missingDocTargets: [],
              managedFiles: [],
              changedFiles: [],
              repoSnapshot: { topLevelPaths: [] },
            }),
          },
          docsIndexState: {
            load: () => ({}),
            save: () => ({}),
          },
        },
      });
      const realNow = Date.now;
      Date.now = () => now.getTime();
      try {
        harness.notifier.start();
      } finally {
        Date.now = realNow;
      }
      harness.notifier.stop();

      expect(scheduled[0]).toBe(300_000);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  test("runs the docs indexer when it is due and enabled", async () => {
    let syncCalls = 0;
    const harness = createHarness({
      notifierOptions: {
        docsIndexer: {
          isEnabled: () => true,
          getNextScheduledRunAt: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
          sync: () => {
            syncCalls += 1;
            return {
              generatedAt: new Date().toISOString(),
              rootDir: runtimeRoot,
              docs: [],
              orphanDocs: [],
              missingDocTargets: [],
              managedFiles: [],
              changedFiles: ["docs/README.md"],
              repoSnapshot: { topLevelPaths: [] },
            };
          },
        },
        docsIndexState: {
          load: () => ({}),
          save: () => ({}),
        },
      },
    });

    (harness.notifier as never as { nextDocsIndexAt: number }).nextDocsIndexAt = Date.now() - 1;
    await (harness.notifier as never as { runTick: () => Promise<void> }).runTick();
    harness.notifier.stop();

    expect(syncCalls).toBe(1);
  });

  test("runs autonomous time when it is due even without a Discord target user", async () => {
    const harness = createHarness({
      userId: null,
      nextAutonomousTimeAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await (harness.notifier as never as { runTick: () => Promise<void> }).runTick();
    harness.notifier.stop();

    expect(harness.autonomousTimeCalls()).toBe(1);
    expect(harness.sent).toEqual([]);
    expect(harness.recorded).toEqual([]);
  });

  test("runs the heartbeat when alarm routines are due even if the heartbeat interval has not elapsed", async () => {
    const recentCompletedAt = new Date(Date.now() - (10 * 60 * 1000)).toISOString();
    writeHeartbeatState(recentCompletedAt);

    const sent: string[] = [];
    const recorded: Array<{ conversationKey: string; message: string }> = [];
    let heartbeatCalls = 0;
    let routineScheduleChangedListener: (() => void) | null = null;
    const client = {
      users: {
        fetch: async () => ({
          createDM: async () => ({
            send: async (message: string) => {
              sent.push(message);
            },
          }),
        }),
      },
    };
    const app = {
      getNotificationTargetUserId: () => "discord-user",
      getNextAlarmDueAt: () => null,
      getNextRoutineAttentionAt: () => null,
      getNextAutonomousTimeAt: () => undefined,
      listDueAlarms: () => [],
      markAlarmDelivered: () => {},
      recordAssistantMessage: async (conversationKey: string, message: string) => {
        recorded.push({ conversationKey, message });
      },
      onAlarmScheduleChanged: () => () => {},
      onRoutineScheduleChanged: (listener: () => void) => {
        routineScheduleChangedListener = listener;
        return () => {
          routineScheduleChangedListener = null;
        };
      },
      hasAlarmRoutinesDueNow: () => true,
      runHourlyHeartbeat: async () => {
        heartbeatCalls += 1;
        return {
          requestId: "heartbeat-request",
          mode: "immediate" as const,
          message: "Alarm routine reminder.",
          warnings: [],
          completed: true,
        };
      },
      runAlarmNotification: async () => ({
        requestId: "alarm-request",
        mode: "immediate" as const,
        message: "",
        warnings: [],
      }),
      runAutonomousTimeSession: async () => ({
        requestId: "autonomous-time-request",
        mode: "accepted" as const,
        message: "",
        warnings: [],
        triggered: false,
      }),
    };

    const notifier = new DiscordRoutinesNotifier(client as never, app as never);
    await (notifier as never as { runTick: () => Promise<void> }).runTick();
    notifier.stop();

    expect(heartbeatCalls).toBe(1);
    expect(sent).toEqual(["Alarm routine reminder."]);
  });

  test("schedules autonomous time when it is earlier than the next heartbeat", () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const scheduled: number[] = [];
    let nextHandle = 0;

    globalThis.setTimeout = ((callback: (...args: never[]) => void, delay?: number) => {
      void callback;
      scheduled.push(delay as number);
      return (++nextHandle) as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as unknown as typeof clearTimeout;

    try {
      const now = new Date("2026-03-22T06:55:00.000Z");
      const harness = createHarness({
        nextAutonomousTimeAt: "2026-03-22T07:00:00.000Z",
      });
      const notifier = harness.notifier as never as {
        nextHeartbeatAt: number;
      };
      notifier.nextHeartbeatAt = new Date("2026-03-22T08:00:00.000Z").getTime();

      const realNow = Date.now;
      Date.now = () => now.getTime();
      try {
        harness.notifier.start();
      } finally {
        Date.now = realNow;
      }
      harness.notifier.stop();

      expect(scheduled[0]).toBe(300_000);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });
});
