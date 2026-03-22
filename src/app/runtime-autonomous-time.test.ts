import { describe, expect, test } from "bun:test";
import { OpenElinaroApp } from "./runtime";

type AutonomousTimeAppOverrides = {
  getScope(): {
    profile: {
      id: string;
    };
    autonomousTime: {
      isEligible(reference?: Date): boolean;
      buildInjectedMessage(reference?: Date): { text: string };
      getTriggerLocalDate(reference?: Date): string;
      markTriggered(reference?: Date): void;
      getNextRunAt(reference?: Date): Date | null;
    };
  };
  handleRequest(
    request: { id: string; conversationKey?: string; text?: string },
    options?: {
      chatOptions?: {
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
  ): Promise<{
    requestId: string;
    mode: "accepted";
    message: string;
    warnings: string[];
  }>;
};

function createAppDouble(options?: {
  eligible?: boolean;
  localDate?: string;
  handleRequestError?: string;
}) {
  let markTriggeredCalls = 0;
  const handleRequests: Array<{
    request: { id: string; conversationKey?: string; text?: string };
    options?: {
      chatOptions?: {
        background?: boolean;
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
  const app = Object.create(OpenElinaroApp.prototype) as OpenElinaroApp;
  const mutableApp = app as unknown as AutonomousTimeAppOverrides & {
    runAutonomousTimeSession: OpenElinaroApp["runAutonomousTimeSession"];
    getNextAutonomousTimeAt: OpenElinaroApp["getNextAutonomousTimeAt"];
  };

  mutableApp.getScope = () => ({
    profile: { id: "root" },
    autonomousTime: {
      isEligible: () => options?.eligible ?? true,
      buildInjectedMessage: () => ({ text: "You have autonomous time." }),
      getTriggerLocalDate: () => options?.localDate ?? "2026-03-22",
      markTriggered: () => {
        markTriggeredCalls += 1;
      },
      getNextRunAt: () => new Date("2026-03-22T08:00:00.000Z"),
    },
  });
  mutableApp.handleRequest = async (request, requestOptions) => {
    if (options?.handleRequestError) {
      throw new Error(options.handleRequestError);
    }
    handleRequests.push({ request, options: requestOptions });
    return {
      requestId: request.id,
      mode: "accepted",
      message: "message accepted into the background queue",
      warnings: [],
    };
  };

  return {
    app: mutableApp,
    handleRequests,
    markTriggeredCalls: () => markTriggeredCalls,
  };
}

describe("OpenElinaroApp.runAutonomousTimeSession", () => {
  test("skips the launch when autonomous time is not eligible", async () => {
    const harness = createAppDouble({ eligible: false });

    const response = await harness.app.runAutonomousTimeSession({
      reference: new Date("2026-03-22T08:01:00.000Z"),
    });

    expect(response.triggered).toBe(false);
    expect(harness.handleRequests).toEqual([]);
    expect(harness.markTriggeredCalls()).toBe(0);
  });

  test("launches an isolated background session and marks the day as triggered", async () => {
    const harness = createAppDouble({ localDate: "2026-03-22" });

    const response = await harness.app.runAutonomousTimeSession({
      reference: new Date("2026-03-22T08:01:00.000Z"),
    });

    expect(response.triggered).toBe(true);
    expect(harness.markTriggeredCalls()).toBe(1);
    expect(harness.handleRequests).toHaveLength(1);
    expect(harness.handleRequests[0]?.request.conversationKey).toBe("automation:autonomous-time-2026-03-22:root");
    expect(harness.handleRequests[0]?.request.text).toContain("You have autonomous time.");
    expect(harness.handleRequests[0]?.options?.chatOptions).toEqual(expect.objectContaining({
      background: true,
      persistConversation: true,
      enableMemoryIngestion: true,
      enableThreadStartContext: false,
      enableCompaction: true,
      includeBackgroundExecNotifications: true,
      providerSessionId: "automation:autonomous-time-2026-03-22:root",
      usagePurpose: "automation_autonomous_time",
    }));
  });

  test("does not mark the session as triggered when launch fails", async () => {
    const harness = createAppDouble({ handleRequestError: "launch failed" });

    await expect(
      harness.app.runAutonomousTimeSession({
        reference: new Date("2026-03-22T08:01:00.000Z"),
      }),
    ).rejects.toThrow("launch failed");
    expect(harness.markTriggeredCalls()).toBe(0);
  });
});
