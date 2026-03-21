import { ChannelType, MessageFlags, type Attachment, type ChatInputCommandInteraction, type Message } from "discord.js";
import { describe, expect, test } from "bun:test";
import { DiscordAuthSessionManager } from "./auth-session-manager";
import { createDiscordDmMessageBatcher, createDiscordEventHandlers, type DiscordAppRuntime } from "./bot";

class FakeCommandOptions {
  constructor(
    private readonly values: Record<string, unknown> = {},
    private readonly subcommand?: string,
  ) {}

  getString(name: string, required?: boolean) {
    const value = this.values[name];
    if (typeof value === "string") {
      return value;
    }
    if (required) {
      throw new Error(`Missing required option: ${name}`);
    }
    return null;
  }

  getSubcommand(required?: boolean) {
    if (!this.subcommand && required) {
      throw new Error("Missing subcommand");
    }
    return this.subcommand ?? null;
  }
}

class FakeInteraction {
  replied = false;
  deferred = false;
  readonly replies: Array<{ content?: string; flags?: MessageFlags; files?: unknown[] }> = [];
  readonly user = {
    id: "discord-user",
    createDM: async () => ({
      async send() {},
    }),
  };
  readonly channel = { type: ChannelType.DM };
  readonly channelId = "discord-channel";
  readonly options: FakeCommandOptions;

  constructor(
    readonly commandName: string,
    values: Record<string, unknown> = {},
    subcommand?: string,
  ) {
    this.options = new FakeCommandOptions(values, subcommand);
  }

  isChatInputCommand() {
    return true;
  }

  async reply(payload: string | { content?: string; flags?: MessageFlags; files?: unknown[] }) {
    this.replied = true;
    if (typeof payload === "string") {
      this.replies.push({ content: payload });
      return;
    }
    this.replies.push(payload);
  }

  async deferReply() {
    this.deferred = true;
  }

  async editReply(payload: { content?: string; files?: unknown[] }) {
    this.replied = true;
    this.replies.push({ content: payload.content, files: payload.files });
  }

  async followUp(payload: { content?: string; flags?: MessageFlags; files?: unknown[] }) {
    this.replies.push(payload);
  }
}

function createFakeApp(calls: Array<{ name: string; input: unknown }>): DiscordAppRuntime {
  return {
    noteDiscordUser() {},
    stopConversation() {
      return { stopped: false, message: "No active agent is running for this conversation." };
    },
    async handleRequest(request) {
      return {
        requestId: request.id,
        mode: "immediate" as const,
        message: "unused",
      };
    },
    async invokeRoutineTool(name, input) {
      calls.push({ name, input });
      return "context ok";
    },
    getActiveModel() {
      return { providerId: "openai-codex" as const };
    },
    getActiveProfile() {
      return { id: "root" };
    },
    createDemoWorkflowRequest(requestId: string) {
      return {
        id: requestId,
        kind: "workflow" as const,
        text: "demo",
      };
    },
    getWorkflowRun() {
      return undefined;
    },
    listWorkflowRuns() {
      return [];
    },
  };
}

function createFakeDiscordMessage(content: string, options?: {
  userId?: string;
  channelId?: string;
  attachments?: Attachment[];
}) {
  const attachments = new Map<string, Attachment>();
  for (const [index, attachment] of (options?.attachments ?? []).entries()) {
    attachments.set(String(index), attachment);
  }

  return {
    content,
    channelId: options?.channelId ?? "discord-channel",
    author: {
      id: options?.userId ?? "discord-user",
      bot: false,
    },
    attachments,
  } as unknown as Message;
}

describe("Discord context command", () => {
  test("routes summary and verbose slash modes to the context tool", async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const handlers = createDiscordEventHandlers({
      app: createFakeApp(calls),
      authManager: new DiscordAuthSessionManager(),
      profileId: "root",
    });

    const summaryInteraction = new FakeInteraction("context");
    await handlers.handleInteraction(summaryInteraction as unknown as ChatInputCommandInteraction);

    const verboseInteraction = new FakeInteraction("context", { mode: "v" });
    await handlers.handleInteraction(verboseInteraction as unknown as ChatInputCommandInteraction);

    const fullInteraction = new FakeInteraction("context", { mode: "full" });
    await handlers.handleInteraction(fullInteraction as unknown as ChatInputCommandInteraction);

    expect(calls[0]).toEqual({ name: "context", input: {} });
    expect(calls[1]).toEqual({ name: "context", input: { mode: "v" } });
    expect(calls[2]).toEqual({ name: "context", input: { mode: "full" } });
    expect(summaryInteraction.replies.map((reply) => reply.content).join("\n")).toContain("context ok");
    expect(verboseInteraction.replies.map((reply) => reply.content).join("\n")).toContain("context ok");
    expect(fullInteraction.replies.map((reply) => reply.content).join("\n")).toContain("context ok");
  });

  test("buffers continued DM fragments until the final message arrives", async () => {
    const dispatched: Array<{ content: string; attachmentCount: number; reason: string }> = [];
    const batcher = createDiscordDmMessageBatcher({
      async onDispatch(batch) {
        dispatched.push({
          content: batch.content,
          attachmentCount: batch.attachments.length,
          reason: batch.reason,
        });
      },
    });

    const firstAttachment = { name: "one.txt", url: "https://example.com/one.txt" } as Attachment;
    const secondAttachment = { name: "two.txt", url: "https://example.com/two.txt" } as Attachment;

    await expect(
      batcher.handleMessage(
        createFakeDiscordMessage("first bit /continued", { attachments: [firstAttachment] }),
      ),
    ).resolves.toBe("buffered");
    await expect(
      batcher.handleMessage(
        createFakeDiscordMessage("second bit /Continued", { attachments: [secondAttachment] }),
      ),
    ).resolves.toBe("buffered");
    await expect(
      batcher.handleMessage(createFakeDiscordMessage("final bit")),
    ).resolves.toBe("dispatched");

    expect(dispatched).toEqual([
      {
        content: "first bit\nsecond bit\nfinal bit",
        attachmentCount: 2,
        reason: "completed",
      },
    ]);
  });

  test("dispatches a buffered continued DM when the timeout fires", async () => {
    const dispatched: Array<{ content: string; reason: string }> = [];
    const scheduled: Array<() => void> = [];
    const cleared: ReturnType<typeof setTimeout>[] = [];
    const batcher = createDiscordDmMessageBatcher({
      timeoutMs: 123,
      scheduleTimeout(callback) {
        scheduled.push(callback);
        return { token: scheduled.length } as unknown as ReturnType<typeof setTimeout>;
      },
      clearScheduledTimeout(timer) {
        cleared.push(timer);
      },
      async onDispatch(batch) {
        dispatched.push({ content: batch.content, reason: batch.reason });
      },
    });

    const message = createFakeDiscordMessage("lonely fragment /continued");
    await expect(batcher.handleMessage(message)).resolves.toBe("buffered");
    expect(batcher.hasPending(message)).toBe(true);
    expect(scheduled).toHaveLength(1);

    await scheduled[0]?.();

    expect(dispatched).toEqual([{ content: "lonely fragment", reason: "timeout" }]);
    expect(batcher.hasPending(message)).toBe(false);
    expect(cleared).toHaveLength(1);
  });
});
