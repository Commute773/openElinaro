import type { AssistantMessage } from "../../messages/types";
import {
  assistantTextMessage,
  extractAssistantText,
  userMessage,
} from "../../messages/types";
import { ConversationCompactionService } from "./conversation-compaction-service";
import { type ConversationState, ConversationStore } from "./conversation-store";
import { MemoryService } from "../memory-service";
import { ModelService } from "../models/model-service";
import {
  composeSystemPrompt,
  SystemPromptService,
  type SystemPromptSnapshot,
} from "../system-prompt-service";
import { telemetry } from "../infrastructure/telemetry";
import { tryCatchAsync } from "../../utils/result";
import type { AppProgressEvent } from "../../domain/assistant";

type ProgressReporter = (event: AppProgressEvent) => Promise<void>;

export interface ConversationContinuationResult {
  conversation: ConversationState;
  summary: string;
  memoryFilePath: string | null;
}

export interface FreshConversationResult {
  conversation: ConversationState;
  openingLine: string;
  openingMessage: AssistantMessage;
  memoryFilePath: string | null;
  memoryFlushSkipped: boolean;
  systemPrompt: SystemPromptSnapshot;
}

export class ConversationStateTransitionService {
  private readonly compaction: ConversationCompactionService;

  constructor(
    private readonly models: ModelService,
    private readonly conversations: ConversationStore,
    memory: MemoryService,
    private readonly systemPrompts: SystemPromptService,
  ) {
    this.compaction = new ConversationCompactionService(this.models, memory);
  }

  async compactForContinuation(params: {
    conversationKey: string;
    onProgress?: ProgressReporter;
    signal?: AbortSignal;
  }): Promise<ConversationContinuationResult> {
    const fallbackSnapshot = await this.systemPrompts.load();
    const conversation = await this.conversations.ensureSystemPrompt(
      params.conversationKey,
      fallbackSnapshot,
    );
    const compacted = await this.compaction.compact({
      conversationKey: params.conversationKey,
      systemPrompt: composeSystemPrompt(
        conversation.systemPrompt?.text ?? fallbackSnapshot.text,
      ).text,
      messages: conversation.messages,
      onProgress: params.onProgress,
      signal: params.signal,
    });
    const savedConversation = await this.saveConversationState(
      params.conversationKey,
      conversation.messages.length,
      compacted.messages,
      conversation.systemPrompt ?? fallbackSnapshot,
    );

    return {
      conversation: savedConversation,
      summary: compacted.summary,
      memoryFilePath: compacted.memoryFilePath ?? null,
    };
  }

  async startFreshConversation(params: {
    conversationKey: string;
    onProgress?: ProgressReporter;
    flushMemory?: boolean;
  }): Promise<FreshConversationResult> {
    const snapshot = await this.systemPrompts.load();
    const conversation = await this.conversations.ensureSystemPrompt(
      params.conversationKey,
      snapshot,
    );
    const activeSnapshot = conversation.systemPrompt ?? snapshot;
    const flushMemory = params.flushMemory ?? true;

    let memoryFilePath: string | null = null;
    if (flushMemory && conversation.messages.length > 0) {
      const compacted = await this.compaction.compact({
        conversationKey: params.conversationKey,
        systemPrompt: composeSystemPrompt(
          activeSnapshot.text,
        ).text,
        messages: conversation.messages,
        onProgress: params.onProgress,
      });
      memoryFilePath = compacted.memoryFilePath ?? null;
    } else if (!flushMemory && conversation.messages.length > 0) {
      await params.onProgress?.(
        { type: "status", message: "Skipping durable memory flush and starting a brand new conversation." },
      );
    } else {
      await params.onProgress?.(
        { type: "status", message: "No prior conversation messages were found, so there was nothing to compact." },
      );
    }

    const openingMessage = await this.buildConversationOpening(
      params.conversationKey,
      activeSnapshot,
    );
    const openingLine = extractAssistantText(openingMessage).trim()
      || this.fallbackConversationOpeningText();
    const savedConversation = await this.saveConversationState(
      params.conversationKey,
      conversation.messages.length,
      [openingMessage],
      activeSnapshot,
    );

    return {
      conversation: savedConversation,
      openingLine,
      openingMessage,
      memoryFilePath,
      memoryFlushSkipped: !flushMemory,
      systemPrompt: activeSnapshot,
    };
  }

  private async saveConversationState(
    conversationKey: string,
    rollbackCount: number,
    messages: ConversationState["messages"],
    systemPrompt: SystemPromptSnapshot,
  ) {
    return this.conversations.rollbackAndAppend(conversationKey, rollbackCount, messages, {
      systemPrompt,
    });
  }

  private fallbackConversationOpeningText(): string {
    return "What do you want to work on next?";
  }

  private fallbackConversationOpening(): AssistantMessage {
    return assistantTextMessage("What do you want to work on next?");
  }

  private async buildConversationOpening(
    _conversationKey: string,
    _snapshot: SystemPromptSnapshot,
  ): Promise<AssistantMessage> {
    // TODO: Rebuild conversation opening generation using a short-lived Claude Agent SDK instance.
    return this.fallbackConversationOpening();
  }
}
