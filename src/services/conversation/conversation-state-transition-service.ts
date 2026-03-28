import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { generateText } from "ai";
import type { ProviderConnector } from "../../connectors/provider-connector";
import { ConversationCompactionService } from "./conversation-compaction-service";
import { type ConversationState, ConversationStore } from "./conversation-store";
import { toModelMessages } from "../ai-sdk-message-service";
import { MemoryService } from "../memory-service";
import { ModelService } from "../models/model-service";
import {
  composeSystemPrompt,
  SystemPromptService,
  type SystemPromptSnapshot,
} from "../system-prompt-service";
import { extractTextFromMessage } from "../message-content-service";
import { telemetry } from "../telemetry";

type ProgressReporter = (message: string) => Promise<void>;

export interface ConversationContinuationResult {
  conversation: ConversationState;
  summary: string;
  memoryFilePath: string | null;
}

export interface FreshConversationResult {
  conversation: ConversationState;
  openingLine: string;
  openingMessage: AIMessage;
  memoryFilePath: string | null;
  memoryFlushSkipped: boolean;
  systemPrompt: SystemPromptSnapshot;
}

export class ConversationStateTransitionService {
  private readonly compaction: ConversationCompactionService;

  constructor(
    private readonly connector: ProviderConnector,
    private readonly conversations: ConversationStore,
    memory: MemoryService,
    models: Pick<ModelService, "generateMemoryText">,
    private readonly systemPrompts: SystemPromptService,
  ) {
    this.compaction = new ConversationCompactionService(this.connector, memory, models);
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
        "Skipping durable memory flush and starting a brand new conversation.",
      );
    } else {
      await params.onProgress?.(
        "No prior conversation messages were found, so there was nothing to compact.",
      );
    }

    const openingMessage = await this.buildConversationOpening(
      params.conversationKey,
      activeSnapshot,
    );
    const openingLine = this.extractAssistantText(openingMessage)
      || this.fallbackConversationOpening();
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

  private extractAssistantText(message: AIMessage) {
    return extractTextFromMessage(message).trim();
  }

  private fallbackConversationOpening() {
    return "What do you want to work on next?";
  }

  private async buildConversationOpening(
    conversationKey: string,
    snapshot: SystemPromptSnapshot,
  ) {
    try {
      const response = await generateText({
        model: this.connector,
        system: composeSystemPrompt(
          snapshot.text,
        ).text,
        messages: toModelMessages([
          new HumanMessage(
            [
              "A fresh conversation was just created.",
              "Reply with exactly one short opening line.",
              "Invite the user to continue.",
              "Do not mention resets, memory, compaction, system prompts, or tools.",
            ].join(" "),
          ),
        ]),
        providerOptions: {
          openelinaro: {
            sessionId: `${conversationKey}:new:${Date.now()}`,
            conversationKey,
            usagePurpose: "conversation_opening",
          },
        },
      });
      const text = response.text.trim() || this.fallbackConversationOpening();
      return new AIMessage(text);
    } catch (error) {
      telemetry.event("conversation.transition.opening_generation_failed", {
        conversationKey,
        error: error instanceof Error ? error.message : String(error),
      }, {
        level: "warn",
        outcome: "error",
      });
      return new AIMessage(this.fallbackConversationOpening());
    }
  }
}
