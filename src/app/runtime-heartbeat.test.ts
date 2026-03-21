import { describe, expect, test } from "bun:test";
import { OpenElinaroApp } from "./runtime";

type HeartbeatAppOverrides = {
  appTelemetry: {
    event(name: string, attributes?: Record<string, unknown>): void;
  };
  recordAssistantMessage(conversationKey: string, message: string): Promise<void>;
  calendar: {
    syncIfNeeded(options?: { reference?: Date }): Promise<void>;
  };
  routines: {
    shouldRunHeartbeat(reference?: Date): boolean;
    getHeartbeatReminderSnapshot(reference?: Date): {
      currentLocalTime: string;
      timezone: string;
      requiredCandidates: Array<{
        itemId: string;
        occurrenceKey: string;
      }>;
      optionalCandidates: unknown[];
      context: {
        mode: string;
      };
      itemIds: string[];
      occurrenceKeys: string[];
    };
    buildHeartbeatRequiredReminderMessage(): string;
    markReminded(itemIds: string[], occurrenceKeys: string[], reference?: Date): void;
  };
  heartbeats: {
    buildInjectedMessage(
      reference?: Date,
      options?: {
        workFocus?: string;
        localTime?: string;
        timezone?: string;
        reminderSnapshot?: unknown;
        reflectionTrigger?: string;
        deliveryRequirement?: string;
      },
    ): string;
    normalizeAssistantReply(message: string | undefined): string | undefined;
  };
  buildHeartbeatWorkFocus(reference?: Date): string | undefined;
  getScope(): {
    reflection: {
      isDailyReflectionEligible(reference?: Date): boolean;
      queueDailyReflectionIfEligible(reference?: Date): void;
    };
  };
  handleRequest(
    request: { id: string; conversationKey?: string; text?: string },
    options?: {
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
  ): Promise<{
    requestId: string;
    mode: "immediate";
    message: string;
    warnings: string[];
  }>;
};

function createAppDouble(options?: {
  shouldRunHeartbeat?: boolean;
  workFocus?: string;
  responseMessages?: string[];
  requiredCandidates?: Array<{
    itemId: string;
    occurrenceKey: string;
  }>;
}) {
  let injectedWorkFocus: string | undefined;
  const injectedMessages: string[] = [];
  const deliveryRequirements: string[] = [];
  let remindedItemIds: string[] = [];
  const telemetryEvents: string[] = [];
  const telemetryEventAttributes: Array<Record<string, unknown> | undefined> = [];
  const recordedMessages: Array<{ conversationKey: string; message: string }> = [];
  const handleRequests: Array<{
    request: { id: string; conversationKey?: string; text?: string };
    options?: {
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
    };
  }> = [];
  const responseMessages = [...(options?.responseMessages ?? ["HEARTBEAT_OK"])];
  const app = Object.create(OpenElinaroApp.prototype) as OpenElinaroApp;
  const mutableApp = app as unknown as HeartbeatAppOverrides & {
    runHourlyHeartbeat: OpenElinaroApp["runHourlyHeartbeat"];
  };
  mutableApp.appTelemetry = {
    event: (name: string, attributes?: Record<string, unknown>) => {
      telemetryEvents.push(name);
      telemetryEventAttributes.push(attributes);
    },
  };
  mutableApp.recordAssistantMessage = async (conversationKey: string, message: string) => {
    recordedMessages.push({ conversationKey, message });
  };
  mutableApp.calendar = {
    syncIfNeeded: async () => {},
  };
  mutableApp.routines = {
    shouldRunHeartbeat: () => options?.shouldRunHeartbeat ?? true,
    getHeartbeatReminderSnapshot: () => ({
      currentLocalTime: "Monday, March 16, 2026 at 6:00:00 PM EDT",
      timezone: "America/Montreal",
      requiredCandidates: options?.requiredCandidates ?? [],
      optionalCandidates: [],
      context: { mode: "personal" },
      itemIds: (options?.requiredCandidates ?? []).map((entry) => entry.itemId),
      occurrenceKeys: (options?.requiredCandidates ?? []).map((entry) => entry.occurrenceKey),
    }),
    buildHeartbeatRequiredReminderMessage: () => "Fallback reminder.",
    markReminded: (itemIds: string[]) => {
      remindedItemIds = itemIds;
    },
  };
  mutableApp.heartbeats = {
    buildInjectedMessage: (
      _reference?: Date,
      heartbeatOptions?: {
        workFocus?: string;
        deliveryRequirement?: string;
      },
    ) => {
      injectedWorkFocus = heartbeatOptions?.workFocus;
      if (heartbeatOptions?.deliveryRequirement) {
        deliveryRequirements.push(heartbeatOptions.deliveryRequirement);
      }
      const message = `heartbeat:${heartbeatOptions?.workFocus ?? "none"}:${heartbeatOptions?.deliveryRequirement ?? "none"}`;
      injectedMessages.push(message);
      return message;
    },
    normalizeAssistantReply: (message: string | undefined) => {
      const normalized = message?.trim();
      const nonEmptyLines = normalized
        ?.split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      return nonEmptyLines?.includes("HEARTBEAT_OK") || !normalized ? undefined : normalized;
    },
  };
  mutableApp.buildHeartbeatWorkFocus = () => options?.workFocus;
  mutableApp.getScope = () => ({
    reflection: {
      isDailyReflectionEligible: () => true,
      queueDailyReflectionIfEligible: () => {},
    },
  });
  mutableApp.handleRequest = async (
    request: { id: string; conversationKey?: string; text?: string },
    requestOptions?: {
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
  ) => {
    handleRequests.push({ request, options: requestOptions });
    return {
    requestId: request.id,
    mode: "immediate",
    message: responseMessages.shift() ?? "HEARTBEAT_OK",
    warnings: [],
    };
  };

  return {
    app: mutableApp,
    getInjectedWorkFocus: () => injectedWorkFocus,
    getInjectedMessages: () => injectedMessages,
    getDeliveryRequirements: () => deliveryRequirements,
    getRemindedItemIds: () => remindedItemIds,
    getTelemetryEvents: () => telemetryEvents,
    getTelemetryEventAttributes: () => telemetryEventAttributes,
    getRecordedMessages: () => recordedMessages,
    getHandleRequests: () => handleRequests,
  };
}

describe("OpenElinaroApp.runHourlyHeartbeat", () => {
  test("keeps work focus inside the injected heartbeat and suppresses HEARTBEAT_OK", async () => {
    const harness = createAppDouble({
      workFocus: "Work focus (restricted):\n- Now: Finish the operator demo.",
      responseMessages: ["HEARTBEAT_OK"],
    });

    const response = await harness.app.runHourlyHeartbeat("conversation-1");

    expect(harness.getInjectedWorkFocus()).toContain("Finish the operator demo.");
    expect(harness.getInjectedMessages()[0]).toContain("Work focus (restricted)");
    expect(response.message).toBe("");
    expect(response.completed).toBe(true);
  });

  test("returns only the assistant-authored heartbeat reply", async () => {
    const harness = createAppDouble({
      workFocus: "Work focus (restricted):\n- Now: Finish the operator demo.",
      responseMessages: ["Focus on telecorder next."],
    });

    const response = await harness.app.runHourlyHeartbeat("conversation-1");

    expect(response.message).toBe("Focus on telecorder next.");
    expect(response.message).not.toContain("Work focus (restricted)");
    expect(response.completed).toBe(true);
    expect(harness.getRecordedMessages()).toEqual([
      { conversationKey: "conversation-1", message: "Focus on telecorder next." },
    ]);
  });

  test("suppresses HEARTBEAT_OK even when the model adds trailing commentary", async () => {
    const harness = createAppDouble({
      responseMessages: ["HEARTBEAT_OK\n\nNo reminder needed."],
    });

    const response = await harness.app.runHourlyHeartbeat("conversation-1");

    expect(response.message).toBe("");
    expect(response.completed).toBe(true);
  });

  test("suppresses HEARTBEAT_OK even when the model adds leading commentary", async () => {
    const harness = createAppDouble({
      responseMessages: [
        "These are all unseen medium-priority backlog items, but none are urgent tonight.\n\nHEARTBEAT_OK",
      ],
    });

    const response = await harness.app.runHourlyHeartbeat("conversation-1");

    expect(response.message).toBe("");
    expect(response.completed).toBe(true);
  });

  test("isolates the heartbeat run from the main conversation and instruments the handoff", async () => {
    const harness = createAppDouble({
      responseMessages: ["Check your urgent todo now."],
    });

    await harness.app.runHourlyHeartbeat("conversation-1");

    expect(harness.getHandleRequests()).toHaveLength(1);
    expect(harness.getHandleRequests()[0]?.request.conversationKey).toBe("automation:heartbeat:conversation-1");
    expect(harness.getHandleRequests()[0]?.options?.chatOptions).toMatchObject({
      persistConversation: false,
      enableMemoryIngestion: false,
      enableThreadStartContext: false,
      enableCompaction: false,
      includeBackgroundExecNotifications: false,
      providerSessionId: "automation:heartbeat:conversation-1",
      usagePurpose: "automation_heartbeat_turn",
    });
    expect(harness.getHandleRequests()[0]?.options?.chatOptions?.contextConversationKey).toBeUndefined();
    expect(harness.getRecordedMessages()).toEqual([
      { conversationKey: "conversation-1", message: "Check your urgent todo now." },
    ]);
    expect(harness.getTelemetryEvents()).toContain("app.heartbeat.prompt_prepared");
    expect(harness.getTelemetryEvents()).toContain("app.heartbeat.main_thread_handoff");
    expect(harness.getTelemetryEventAttributes()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        conversationKey: "conversation-1",
        heartbeatConversationKey: "automation:heartbeat:conversation-1",
        isolatedFromMainConversation: true,
      }),
      expect.objectContaining({
        conversationKey: "conversation-1",
        heartbeatConversationKey: "automation:heartbeat:conversation-1",
        source: "immediate",
        messageChars: "Check your urgent todo now.".length,
      }),
    ]));
  });

  test("retries immediately when required reminders exist but the model noops", async () => {
    const harness = createAppDouble({
      requiredCandidates: [{ itemId: "todo-1", occurrenceKey: "todo-1:1" }],
      responseMessages: ["HEARTBEAT_OK", "Check your urgent todo now."],
    });

    const response = await harness.app.runHourlyHeartbeat("conversation-1");

    expect(response.message).toBe("Check your urgent todo now.");
    expect(response.completed).toBe(true);
    expect(harness.getDeliveryRequirements()).toEqual([
      "Required reminder candidates are present right now. Do not reply with HEARTBEAT_OK. Write one concise user-facing reminder now.",
    ]);
    expect(harness.getRemindedItemIds()).toEqual(["todo-1"]);
    expect(
      harness.getTelemetryEvents().filter((name) => name === "app.heartbeat.model_violation"),
    ).toEqual(["app.heartbeat.model_violation"]);
  });

  test("requests a retry on the next cadence when required reminders still noop after retry", async () => {
    const harness = createAppDouble({
      requiredCandidates: [{ itemId: "todo-1", occurrenceKey: "todo-1:1" }],
      responseMessages: ["HEARTBEAT_OK", "HEARTBEAT_OK\nstill nothing"],
    });

    const response = await harness.app.runHourlyHeartbeat("conversation-1");

    expect(response.message).toBe("");
    expect(response.completed).toBe(false);
    expect(harness.getRemindedItemIds()).toEqual([]);
    expect(
      harness.getTelemetryEvents().filter((name) => name === "app.heartbeat.model_violation"),
    ).toEqual([
      "app.heartbeat.model_violation",
      "app.heartbeat.model_violation",
    ]);
  });
});
