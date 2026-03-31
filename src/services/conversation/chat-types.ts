import type { AppProgressEvent, ChatPromptContent } from "../../domain/assistant";
import type { ConversationStore } from "./conversation-store";
import type { ConversationStateTransitionService } from "./conversation-state-transition-service";
import type { ModelService } from "../models/model-service";
import type { SystemPromptService } from "../system-prompt-service";
import type { ToolRegistry } from "../../functions/tool-registry";
import type { ToolResolutionService } from "../tool-resolution-service";
import type { AutonomousTimeService } from "../autonomous-time-service";
import type { MemoryManagementAgent } from "../memory/memory-management-agent";
import type { CoreFactory } from "../../core/types";

export type ChatReplyResult = {
  mode: "immediate" | "accepted";
  message: string;
  warnings?: string[];
};

export type ChatExecutionOptions = {
  contextConversationKey?: string;
  persistConversation: boolean;
  enableMemoryRecall: boolean;
  enableCompaction: boolean;
  includeBackgroundExecNotifications: boolean;
  providerSessionId?: string;
  usagePurpose: string;
};

export type QueuedChatJob = {
  kind: "chat";
  conversationKey: string;
  contextConversationKey?: string;
  content: ChatPromptContent;
  systemContext?: string;
  typingEligible: boolean;
  background: boolean;
  onBackgroundResponse?: (result: ChatReplyResult) => Promise<void>;
  onToolUse?: (event: AppProgressEvent) => Promise<void>;
  execution: ChatExecutionOptions;
  resolve: (result: ChatReplyResult) => void;
  reject: (error: unknown) => void;
};

export type QueuedAssistantMessageJob = {
  kind: "assistant_message";
  conversationKey: string;
  message: string;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export type QueuedConversationJob = QueuedChatJob | QueuedAssistantMessageJob;

export type PendingSteeringMessage = {
  conversationKey: string;
  contextConversationKey?: string;
  content: ChatPromptContent;
  systemContext?: string;
  typingEligible: boolean;
  onBackgroundResponse?: (result: ChatReplyResult) => Promise<void>;
  onToolUse?: (event: AppProgressEvent) => Promise<void>;
  execution: ChatExecutionOptions;
};

export type ConversationSessionState = {
  processing: boolean;
  compacting: boolean;
  queue: QueuedConversationJob[];
  activatedToolNames: Set<string>;
  pendingSteeringMessages: PendingSteeringMessage[];
  activeJobKind: QueuedConversationJob["kind"] | null;
  activeTypingEligible: boolean;
  activeAbortController: AbortController | null;
  stopRequested: boolean;
  typingIndicatorActive: boolean;
  /** Opaque handle to a persistent SDK session for reuse across turns. */
  sdkSessionHandle?: unknown;
};

export type ChatDependencies = {
  routineTools: ToolRegistry;
  toolResolver: ToolResolutionService;
  transitions: ConversationStateTransitionService;
  conversations: ConversationStore;
  systemPrompts: SystemPromptService;
  models: ModelService;
  autonomousTime?: Pick<AutonomousTimeService, "queueCompactionReflection">;
  structuredMemory?: Pick<MemoryManagementAgent, "processTranscript">;
  coreFactory: CoreFactory;
};
