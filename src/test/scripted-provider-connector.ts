import type {
  Message,
  AssistantMessage,
  TextContent,
  ToolCall,
} from "../messages/types";
import { assistantTextMessage, extractAssistantText } from "../messages/types";

/**
 * Scripted test request — the information tests receive about an incoming model call.
 * Replaces the old ProviderConnector-based ScriptedConnectorRequest.
 */
export type ScriptedConnectorRequest = {
  sessionId?: string;
  conversationKey?: string;
  usagePurpose?: string;
  systemPrompt: string;
  messages: Message[];
};

/**
 * Handler function type for scripted test connectors.
 */
export type ScriptedHandler = (request: ScriptedConnectorRequest) => AssistantMessage | Promise<AssistantMessage>;

/**
 * A lightweight scripted model connector for tests.
 *
 * Tests provide a handler that receives the conversation state and returns
 * a Pi AssistantMessage. This replaces the old ScriptedProviderConnector
 * that implemented the deleted ProviderConnector / AI SDK v3 interface.
 */
export class ScriptedProviderConnector {
  readonly providerId: string;
  readonly modelId: string;

  constructor(
    private readonly handler: ScriptedHandler,
    options?: {
      providerId?: string;
      modelId?: string;
    },
  ) {
    this.providerId = options?.providerId ?? "scripted-test";
    this.modelId = options?.modelId ?? "scripted-model";
  }

  /**
   * Invoke the scripted handler with a test request.
   */
  async generate(request: ScriptedConnectorRequest): Promise<AssistantMessage> {
    return this.handler(request);
  }
}

/**
 * Helper to build an AssistantMessage from plain text (replaces `new AIMessage("text")`).
 */
export function scriptedAssistantMessage(text: string): AssistantMessage {
  return assistantTextMessage(text, {
    api: "scripted",
    provider: "scripted-test",
    model: "scripted-model",
  });
}
