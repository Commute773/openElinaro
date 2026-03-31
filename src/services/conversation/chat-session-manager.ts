import type { ChatPromptContent, AppProgressEvent } from "../../domain/assistant";
import type {
  ChatReplyResult,
  ChatExecutionOptions,
  ConversationSessionState,
  QueuedConversationJob,
  QueuedChatJob,
  PendingSteeringMessage,
} from "./chat-types";
import { combineQueuedChatContents } from "./chat-helpers";
import { telemetry } from "../infrastructure/telemetry";
import { attempt } from "../../utils/result";

const QUEUED_WHILE_COMPACTING_MESSAGE = "message queued as we are currently compacting";
const STEERING_ACCEPTED_MESSAGE = "message accepted and will steer the current agent at the next turn";
const BACKGROUND_ACCEPTED_MESSAGE = "message accepted into the background queue";
const STOPPED_MESSAGE = "Current agent halted.";
const QUEUED_STOPPED_MESSAGE = "Queued request cancelled because the conversation was stopped.";

const agentChatTelemetry = telemetry.child({ component: "agent_chat" });

export class AgentRunStoppedError extends Error {
  constructor(message = STOPPED_MESSAGE) {
    super(message);
    this.name = "AgentRunStoppedError";
  }
}

export type ProcessJobCallback = (job: QueuedChatJob) => Promise<ChatReplyResult>;

export class ChatSessionManager {
  private readonly sessions = new Map<string, ConversationSessionState>();
  private conversationActivityNotifier?: (params: { conversationKey: string; active: boolean }) => void;
  private processJob: ProcessJobCallback;
  private appendAssistantMessage: (job: { conversationKey: string; message: string }) => Promise<void>;

  constructor(params: {
    processJob: ProcessJobCallback;
    appendAssistantMessage: (job: { conversationKey: string; message: string }) => Promise<void>;
    conversationActivityNotifier?: (params: { conversationKey: string; active: boolean }) => void;
  }) {
    this.processJob = params.processJob;
    this.appendAssistantMessage = params.appendAssistantMessage;
    this.conversationActivityNotifier = params.conversationActivityNotifier;
  }

  setConversationActivityNotifier(
    notifier?: (params: { conversationKey: string; active: boolean }) => void,
  ) {
    this.conversationActivityNotifier = notifier;
    for (const [conversationKey, session] of this.sessions.entries()) {
      this.refreshConversationActivity(conversationKey, session);
    }
  }

  getSession(conversationKey: string) {
    const existing = this.sessions.get(conversationKey);
    if (existing) {
      return existing;
    }

    const created: ConversationSessionState = {
      processing: false,
      compacting: false,
      queue: [],
      activatedToolNames: new Set<string>(),
      pendingSteeringMessages: [],
      activeJobKind: null,
      activeTypingEligible: false,
      activeAbortController: null,
      stopRequested: false,
      typingIndicatorActive: false,
    };
    this.sessions.set(conversationKey, created);
    return created;
  }

  getExistingSession(conversationKey: string) {
    return this.sessions.get(conversationKey);
  }

  deleteSession(conversationKey: string) {
    const session = this.sessions.get(conversationKey);
    this.closeSdkSessionHandle(session);
    this.sessions.delete(conversationKey);
  }

  kickSession(conversationKey: string) {
    const session = this.getSession(conversationKey);
    if (session.processing) {
      return;
    }

    session.processing = true;
    void this.processSession(conversationKey, session)
      .catch((error) => {
        agentChatTelemetry.recordError(error, {
          conversationKey,
          eventName: "agent_chat.session",
        });
      })
      .finally(() => {
        session.processing = false;
        session.activeJobKind = null;
        session.activeTypingEligible = false;
        session.activeAbortController = null;
        this.refreshConversationActivity(conversationKey, session);
        if (session.queue.length > 0) {
          this.kickSession(conversationKey);
          return;
        }
        if (!session.compacting && session.pendingSteeringMessages.length === 0 && !session.sdkSessionHandle) {
          this.sessions.delete(conversationKey);
        }
      });
  }

  private async processSession(
    conversationKey: string,
    session: ConversationSessionState,
  ) {
    while (session.queue.length > 0) {
      const job = session.queue.shift();
      if (!job) {
        continue;
      }

      try {
        session.activeJobKind = job.kind;
        session.activeTypingEligible = job.kind === "chat" ? job.typingEligible : false;
        this.refreshConversationActivity(conversationKey, session);
        if (job.kind === "assistant_message") {
          await this.appendAssistantMessage(job);
          job.resolve();
          continue;
        }

        const result = await this.processJob(job);
        this.requeueUnconsumedSteeringMessages(session);
        if (job.background) {
          await job.onBackgroundResponse?.(result);
          continue;
        }
        job.resolve(result);
      } catch (error) {
        if (job.kind === "chat") {
          this.requeueUnconsumedSteeringMessages(session);
        }
        if (job.kind === "chat" && job.background) {
          await job.onBackgroundResponse?.({
            mode: "immediate",
            message: error instanceof AgentRunStoppedError
              ? STOPPED_MESSAGE
              : error instanceof Error
                ? error.message
                : String(error),
            warnings: [],
          });
          continue;
        }
        if (job.kind === "chat" && error instanceof AgentRunStoppedError) {
          job.resolve({
            mode: "immediate",
            message: STOPPED_MESSAGE,
            warnings: [],
          });
          continue;
        }
        job.reject(error);
      } finally {
        session.activeJobKind = null;
        session.activeTypingEligible = false;
        this.refreshConversationActivity(conversationKey, session);
        if (job.kind === "chat" && session.activeAbortController === null) {
          session.stopRequested = false;
        }
      }
    }
  }

  cancelQueuedChatJobs(session: ConversationSessionState, message: string) {
    const remaining: QueuedConversationJob[] = [];
    for (const job of session.queue) {
      if (job.kind !== "chat") {
        remaining.push(job);
        continue;
      }

      if (job.background) {
        void job.onBackgroundResponse?.({
          mode: "immediate",
          message,
          warnings: [],
        });
        continue;
      }

      job.resolve({
        mode: "immediate",
        message,
        warnings: [],
      });
    }
    session.queue = remaining;
  }

  refreshConversationActivity(conversationKey: string, session: ConversationSessionState) {
    const nextActive = this.hasTypingEligibleWork(session);
    if (session.typingIndicatorActive === nextActive) {
      return;
    }
    session.typingIndicatorActive = nextActive;
    this.conversationActivityNotifier?.({
      conversationKey,
      active: nextActive,
    });
  }

  hasTypingEligibleWork(session: ConversationSessionState) {
    return session.compacting
      || session.activeTypingEligible
      || session.pendingSteeringMessages.some((entry) => entry.typingEligible)
      || session.queue.some((job) => job.kind === "chat" && job.typingEligible);
  }

  consumePendingSteeringMessages(session: ConversationSessionState) {
    const pending = session.pendingSteeringMessages;
    session.pendingSteeringMessages = [];
    return pending;
  }

  requeueUnconsumedSteeringMessages(session: ConversationSessionState) {
    if (session.pendingSteeringMessages.length === 0) {
      return;
    }

    const pending = this.consumePendingSteeringMessages(session);
    const newest = pending[pending.length - 1];
    if (!newest) {
      return;
    }
    session.queue.unshift({
      kind: "chat",
      conversationKey: newest.conversationKey,
      contextConversationKey: newest.contextConversationKey,
      content: combineQueuedChatContents(pending.map((entry) => entry.content)),
      systemContext: newest.systemContext,
      typingEligible: pending.some((entry) => entry.typingEligible),
      background: true,
      onBackgroundResponse: newest.onBackgroundResponse,
      onToolUse: newest.onToolUse,
      execution: newest.execution,
      resolve: () => {},
      reject: () => {},
    });
  }

  canSteerActiveRun(session: ConversationSessionState) {
    return session.processing && !session.compacting && !session.stopRequested && session.activeJobKind === "chat";
  }

  /**
   * Try to steer the active SDK session with an immediate-priority message.
   * Returns true if the steering was delivered to the SDK, false if no live
   * session is available (caller should fall back to pending steering).
   */
  steerActiveSession(session: ConversationSessionState, text: string): boolean {
    if (!this.canSteerActiveRun(session)) return false;
    const handle = session.sdkSessionHandle as { steer?: (text: string) => void; isAlive?: boolean } | undefined;
    if (!handle || handle.isAlive === false || typeof handle.steer !== "function") return false;
    const steerFn = handle.steer;
    return attempt(() => { steerFn(text); return true; }).ok ? true : false;
  }

  enqueueBackgroundChatJob(
    session: ConversationSessionState,
    params: {
      conversationKey: string;
      contextConversationKey?: string;
      content: ChatPromptContent;
      systemContext?: string;
      typingEligible: boolean;
      onBackgroundResponse?: (result: ChatReplyResult) => Promise<void>;
      onToolUse?: (event: AppProgressEvent) => Promise<void>;
      execution: ChatExecutionOptions;
    },
  ) {
    const lastJob = session.queue.at(-1);
    if (
      lastJob?.kind === "chat"
      && lastJob.background
      && lastJob.conversationKey === params.conversationKey
    ) {
      lastJob.content = combineQueuedChatContents([lastJob.content, params.content]);
      lastJob.contextConversationKey = params.contextConversationKey ?? lastJob.contextConversationKey;
      lastJob.systemContext = params.systemContext ?? lastJob.systemContext;
      lastJob.typingEligible = lastJob.typingEligible || params.typingEligible;
      lastJob.onBackgroundResponse = params.onBackgroundResponse ?? lastJob.onBackgroundResponse;
      lastJob.onToolUse = params.onToolUse ?? lastJob.onToolUse;
      lastJob.execution = params.execution;
      return;
    }

    session.queue.push({
      kind: "chat",
      conversationKey: params.conversationKey,
      contextConversationKey: params.contextConversationKey,
      content: params.content,
      systemContext: params.systemContext,
      typingEligible: params.typingEligible,
      background: true,
      onBackgroundResponse: params.onBackgroundResponse,
      onToolUse: params.onToolUse,
      execution: params.execution,
      resolve: () => {},
      reject: () => {},
    });
  }

  async runAbortableModelCall<T>(
    session: ConversationSessionState,
    run: (signal: AbortSignal) => Promise<T>,
  ) {
    this.throwIfStopRequested(session);
    const controller = new AbortController();
    session.activeAbortController = controller;
    try {
      return await run(controller.signal);
    } catch (error) {
      if (controller.signal.aborted || session.stopRequested) {
        throw new AgentRunStoppedError();
      }
      throw error;
    } finally {
      if (session.activeAbortController === controller) {
        session.activeAbortController = null;
      }
    }
  }

  throwIfStopRequested(session: ConversationSessionState): asserts session is ConversationSessionState {
    if (session.stopRequested) {
      throw new AgentRunStoppedError();
    }
  }

  /** Close all active SDK session handles (for process shutdown). */
  closeAll() {
    for (const session of this.sessions.values()) {
      this.closeSdkSessionHandle(session);
    }
  }

  private closeSdkSessionHandle(session: ConversationSessionState | undefined) {
    if (!session?.sdkSessionHandle) return;
    const handle = session.sdkSessionHandle as { close?: () => void };
    if (typeof handle.close === "function") {
      handle.close();
    }
    session.sdkSessionHandle = undefined;
  }
}

export { QUEUED_WHILE_COMPACTING_MESSAGE, STEERING_ACCEPTED_MESSAGE, BACKGROUND_ACCEPTED_MESSAGE, STOPPED_MESSAGE, QUEUED_STOPPED_MESSAGE };
