import type { ChatPromptContent, AppProgressEvent } from "../../domain/assistant";
import { coreOwnsFeature, featureIsShared } from "../../core/tool-split";
import { chatPromptContentToString } from "./chat-helpers";

import type {
  ChatReplyResult,
  ChatExecutionOptions,
  ChatDependencies,
} from "./chat-types";
import {
  ChatSessionManager,
  QUEUED_WHILE_COMPACTING_MESSAGE,
  STEERING_ACCEPTED_MESSAGE,
  BACKGROUND_ACCEPTED_MESSAGE,
  STOPPED_MESSAGE,
  QUEUED_STOPPED_MESSAGE,
} from "./chat-session-manager";
import { ChatTurnRunner } from "./chat-turn-runner";

export type { ChatDependencies } from "./chat-types";

export class AgentChatService {
  private readonly sessionManager: ChatSessionManager;
  private readonly turnRunner: ChatTurnRunner;

  constructor(
    private readonly deps: ChatDependencies,
    private readonly superagentMode = false,
    conversationActivityNotifier?: (params: { conversationKey: string; active: boolean }) => void,
  ) {
    this.turnRunner = new ChatTurnRunner(deps, superagentMode);

    this.sessionManager = new ChatSessionManager({
      processJob: async (job) => {
        // Resolve the core early so we can check feature ownership
        const resolved = await this.deps.models.resolveModelForPurpose(job.execution.usagePurpose);
        const sessionState = this.sessionManager.getSession(job.conversationKey);
        const core = this.deps.coreFactory({
          modelConfig: {
            providerId: resolved.selection.providerId,
            modelId: resolved.selection.modelId,
            apiKey: resolved.apiKey,
            reasoning: resolved.selection.thinkingLevel,
            providerOptions: {
              sessionId: job.execution.providerSessionId ?? job.conversationKey,
              sdkSessionHandle: sessionState.sdkSessionHandle,
            },
            runtimeModel: resolved.runtimeModel,
          },
        });

        // Skip harness compaction when the core handles it
        const coreHandlesCompaction = coreOwnsFeature(core.manifest, "compaction")
          || featureIsShared(core.manifest, "compaction");
        if (!coreHandlesCompaction) {
          await this.turnRunner.compactIfNeeded(job, this.sessionManager.getSession(job.conversationKey));
        }
        return this.turnRunner.runTurn(job, core, resolved);
      },
      appendAssistantMessage: async (job) => {
        await this.turnRunner.appendAssistantMessage(job);
      },
      conversationActivityNotifier,
    });

    this.turnRunner.setSessionManager(this.sessionManager);
  }

  setTimezoneProvider(provider: () => string) {
    this.turnRunner.setTimezoneProvider(provider);
  }

  setConversationActivityNotifier(
    notifier?: (params: { conversationKey: string; active: boolean }) => void,
  ) {
    this.sessionManager.setConversationActivityNotifier(notifier);
  }

  async reply(params: {
    conversationKey: string;
    contextConversationKey?: string;
    content: ChatPromptContent;
    systemContext?: string;
    onBackgroundResponse?: (result: ChatReplyResult) => Promise<void>;
    onToolUse?: (event: AppProgressEvent) => Promise<void>;
    typingEligible?: boolean;
    background?: boolean;
    persistConversation?: boolean;
    enableMemoryIngestion?: boolean;
    enableCompaction?: boolean;
    includeBackgroundExecNotifications?: boolean;
    providerSessionId?: string;
    usagePurpose?: string;
  }): Promise<ChatReplyResult> {
    const session = this.sessionManager.getSession(params.conversationKey);
    const typingEligible = params.typingEligible ?? true;
    const execution: ChatExecutionOptions = {
      contextConversationKey: params.contextConversationKey,
      persistConversation: params.persistConversation ?? true,
      enableMemoryRecall: params.enableMemoryIngestion ?? true,
      enableCompaction: params.enableCompaction ?? true,
      includeBackgroundExecNotifications: params.includeBackgroundExecNotifications ?? true,
      providerSessionId: params.providerSessionId,
      usagePurpose: params.usagePurpose ?? "chat_turn",
    };
    if (params.background) {
      this.sessionManager.enqueueBackgroundChatJob(session, {
        conversationKey: params.conversationKey,
        contextConversationKey: params.contextConversationKey,
        content: params.content,
        systemContext: params.systemContext,
        typingEligible,
        onBackgroundResponse: params.onBackgroundResponse,
        onToolUse: params.onToolUse,
        execution,
      });
      this.sessionManager.refreshConversationActivity(params.conversationKey, session);
      this.sessionManager.kickSession(params.conversationKey);
      return {
        mode: "accepted",
        message: BACKGROUND_ACCEPTED_MESSAGE,
      };
    }
    if (session.compacting) {
      this.sessionManager.enqueueBackgroundChatJob(session, {
        conversationKey: params.conversationKey,
        contextConversationKey: params.contextConversationKey,
        content: params.content,
        systemContext: params.systemContext,
        typingEligible,
        onBackgroundResponse: params.onBackgroundResponse,
        onToolUse: params.onToolUse,
        execution,
      });
      this.sessionManager.refreshConversationActivity(params.conversationKey, session);
      return {
        mode: "accepted",
        message: QUEUED_WHILE_COMPACTING_MESSAGE,
      };
    }

    if (this.sessionManager.canSteerActiveRun(session)) {
      // Try immediate SDK steering via priority message first
      const steeringText = chatPromptContentToString(params.content);
      if (steeringText && this.sessionManager.steerActiveSession(session, steeringText)) {
        return {
          mode: "accepted",
          message: STEERING_ACCEPTED_MESSAGE,
        };
      }
      // Fall back to pending steering for next turn
      session.pendingSteeringMessages.push({
        conversationKey: params.conversationKey,
        contextConversationKey: params.contextConversationKey,
        content: params.content,
        systemContext: params.systemContext,
        typingEligible,
        onBackgroundResponse: params.onBackgroundResponse,
        onToolUse: params.onToolUse,
        execution,
      });
      this.sessionManager.refreshConversationActivity(params.conversationKey, session);
      return {
        mode: "accepted",
        message: STEERING_ACCEPTED_MESSAGE,
      };
    }

    return new Promise<ChatReplyResult>((resolve, reject) => {
      session.queue.push({
        kind: "chat",
        conversationKey: params.conversationKey,
        contextConversationKey: params.contextConversationKey,
        content: params.content,
        systemContext: params.systemContext,
        typingEligible,
        background: false,
        onBackgroundResponse: params.onBackgroundResponse,
        onToolUse: params.onToolUse,
        execution,
        resolve,
        reject,
      });
      this.sessionManager.refreshConversationActivity(params.conversationKey, session);
      this.sessionManager.kickSession(params.conversationKey);
    });
  }

  stopConversation(conversationKey: string) {
    const session = this.sessionManager.getExistingSession(conversationKey);
    if (!session) {
      return {
        stopped: false,
        message: "No active agent is running for this conversation.",
      };
    }

    const hadActiveWork =
      session.processing
      || session.compacting
      || session.activeAbortController !== null
      || session.queue.some((job) => job.kind === "chat")
      || session.pendingSteeringMessages.length > 0;

    if (!hadActiveWork) {
      return {
        stopped: false,
        message: "No active agent is running for this conversation.",
      };
    }

    session.stopRequested = true;
    session.pendingSteeringMessages = [];
    session.activeAbortController?.abort();
    this.sessionManager.cancelQueuedChatJobs(session, QUEUED_STOPPED_MESSAGE);
    this.sessionManager.refreshConversationActivity(conversationKey, session);
    if (!session.processing && !session.compacting && session.queue.length === 0) {
      this.sessionManager.deleteSession(conversationKey);
    }

    return {
      stopped: hadActiveWork,
      message: hadActiveWork
        ? STOPPED_MESSAGE
        : "No active agent is running for this conversation.",
    };
  }

  async recordAssistantMessage(params: {
    conversationKey: string;
    message: string;
  }): Promise<void> {
    const message = params.message.trim();
    if (!message) {
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const session = this.sessionManager.getSession(params.conversationKey);
      session.queue.push({
        kind: "assistant_message",
        conversationKey: params.conversationKey,
        message,
        resolve,
        reject,
      });
      this.sessionManager.kickSession(params.conversationKey);
    });
  }
}
