import { describe, expect, test } from "bun:test";
import { runHourlyHeartbeat, type AutomationContext } from "./runtime-automation";
import { wrapInjectedMessage } from "../services/injected-message-service";

function createAutomationDouble(options?: {
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

  const ctx: AutomationContext = {
    handleRequest: async (request, requestOptions) => {
      handleRequests.push({ request, options: requestOptions });
      return {
        requestId: request.id,
        mode: "immediate" as const,
        message: responseMessages.shift() ?? "HEARTBEAT_OK",
        warnings: [],
      };
    },
    recordAssistantMessage: async (conversationKey: string, message: string) => {
      recordedMessages.push({ conversationKey, message });
    },
    getScope: () => ({
      reflection: {
        isDailyReflectionEligible: () => true,
        queueDailyReflectionIfEligible: () => {},
      },
    }) as any,
    buildHeartbeatWorkFocus: () => options?.workFocus,
    routines: {
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
    } as any,
    heartbeats: {
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
        const message = wrapInjectedMessage(
          "heartbeat",
          `heartbeat:${heartbeatOptions?.workFocus ?? "none"}:${heartbeatOptions?.deliveryRequirement ?? "none"}`,
        );
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
    } as any,
    calendar: {
      syncIfNeeded: async () => {},
    } as any,
    alarmNotifications: {} as any,
    activeProfile: { id: "test-profile" } as any,
    appTelemetry: {
      event: (name: string, attributes?: Record<string, unknown>) => {
        telemetryEvents.push(name);
        telemetryEventAttributes.push(attributes);
      },
      recordError: () => {},
      instrumentMethods: (obj: any) => obj,
    } as any,
  };

  return {
    ctx,
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
    const harness = createAutomationDouble({
      workFocus: "Work focus (restricted):\n- Now: Finish the operator demo.",
      responseMessages: ["HEARTBEAT_OK"],
    });

    const response = await runHourlyHeartbeat(harness.ctx, "conversation-1");

    expect(harness.getInjectedWorkFocus()).toContain("Finish the operator demo.");
    expect(harness.getInjectedMessages()[0]).toContain("<INJECTED_MESSAGE generated_by=\"heartbeat\">");
    expect(harness.getInjectedMessages()[0]).toContain("Work focus (restricted)");
    expect(response.message).toBe("");
    expect(response.completed).toBe(true);
  });

  test("returns only the assistant-authored heartbeat reply", async () => {
    const harness = createAutomationDouble({
      workFocus: "Work focus (restricted):\n- Now: Finish the operator demo.",
      responseMessages: ["Focus on telecorder next."],
    });

    const response = await runHourlyHeartbeat(harness.ctx, "conversation-1");

    expect(response.message).toBe("Focus on telecorder next.");
    expect(response.message).not.toContain("Work focus (restricted)");
    expect(response.completed).toBe(true);
    expect(harness.getRecordedMessages()).toEqual([
      { conversationKey: "conversation-1", message: "Focus on telecorder next." },
    ]);
  });

  test("suppresses HEARTBEAT_OK even when the model adds trailing commentary", async () => {
    const harness = createAutomationDouble({
      responseMessages: ["HEARTBEAT_OK\n\nNo reminder needed."],
    });

    const response = await runHourlyHeartbeat(harness.ctx, "conversation-1");

    expect(response.message).toBe("");
    expect(response.completed).toBe(true);
  });

  test("suppresses HEARTBEAT_OK even when the model adds leading commentary", async () => {
    const harness = createAutomationDouble({
      responseMessages: [
        "These are all unseen medium-priority backlog items, but none are urgent tonight.\n\nHEARTBEAT_OK",
      ],
    });

    const response = await runHourlyHeartbeat(harness.ctx, "conversation-1");

    expect(response.message).toBe("");
    expect(response.completed).toBe(true);
  });

  test("isolates the heartbeat run from the main conversation and instruments the handoff", async () => {
    const harness = createAutomationDouble({
      responseMessages: ["Check your urgent todo now."],
    });

    await runHourlyHeartbeat(harness.ctx, "conversation-1");

    expect(harness.getHandleRequests()).toHaveLength(1);
    expect(harness.getHandleRequests()[0]?.request.conversationKey).toBe("automation:heartbeat:conversation-1");
    const chatOptions = harness.getHandleRequests()[0]?.options?.chatOptions;
    expect(chatOptions).toMatchObject({
      persistConversation: false,
      enableMemoryIngestion: false,
      enableThreadStartContext: false,
      enableCompaction: false,
      includeBackgroundExecNotifications: false,
      usagePurpose: "automation_heartbeat_turn",
    });
    expect(chatOptions?.providerSessionId).toStartWith("automation:heartbeat:conversation-1-");
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
    const harness = createAutomationDouble({
      requiredCandidates: [{ itemId: "todo-1", occurrenceKey: "todo-1:1" }],
      responseMessages: ["HEARTBEAT_OK", "Check your urgent todo now."],
    });

    const response = await runHourlyHeartbeat(harness.ctx, "conversation-1");

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
    const harness = createAutomationDouble({
      requiredCandidates: [{ itemId: "todo-1", occurrenceKey: "todo-1:1" }],
      responseMessages: ["HEARTBEAT_OK", "HEARTBEAT_OK\nstill nothing"],
    });

    const response = await runHourlyHeartbeat(harness.ctx, "conversation-1");

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
