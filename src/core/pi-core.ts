/**
 * Pi Core — AgentCore implementation using @mariozechner/pi-ai.
 *
 * This is the default core. It wraps pi-ai's completeSimple() in
 * the AgentCore interface. The harness provides all tools; the Pi
 * core has no native tools of its own.
 */
import {
  completeSimple,
  type AssistantMessage as PiAssistantMessage,
  type Context as PiContext,
  type Message as PiMessage,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
  type Tool as PiTool,
  type ToolCall as PiToolCall,
} from "@mariozechner/pi-ai";
import type {
  AgentCore,
  CoreManifest,
  CoreRunOptions,
  CoreRunResult,
  CoreAssistantMessage,
  CoreMessage,
  CoreToolCall,
} from "./types";
import {
  piAssistantMessageToCore,
  piToolResultMessageToCore,
  coreMessageToPi,
  coreToolCallToPi,
} from "./message-bridge";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export const PI_CORE_MANIFEST: CoreManifest = {
  id: "pi",
  nativeTools: [],
  nativeFeatures: [
    { feature: "agent_loop", mode: "core_owns" },
    { feature: "compaction", mode: "harness_owns" },
    { feature: "context_management", mode: "harness_owns" },
    { feature: "session_persistence", mode: "harness_owns" },
    { feature: "cost_tracking", mode: "harness_owns" },
    { feature: "streaming", mode: "harness_owns" },
    { feature: "permission_control", mode: "harness_owns" },
    { feature: "file_checkpointing", mode: "harness_owns" },
    { feature: "thinking", mode: "shared", integrationPoint: "reasoning_level" },
    { feature: "tool_result_summarization", mode: "harness_owns" },
  ],
  requires: {
    systemPrompt: true,
    messageHistory: true,
    toolExecution: true,
    toolDefinitions: true,
  },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PiCoreConfig {
  model: Model<any>;
  apiKey?: string;
  reasoning?: ThinkingLevel;
  providerOptions?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_MAX_STEPS = 25;

function extractToolCalls(message: PiAssistantMessage): PiToolCall[] {
  return message.content.filter(
    (block): block is PiToolCall => block.type === "toolCall",
  );
}

export class PiCore implements AgentCore {
  readonly manifest = PI_CORE_MANIFEST;

  constructor(private readonly config: PiCoreConfig) {}

  async run(options: CoreRunOptions): Promise<CoreRunResult> {
    const {
      systemPrompt,
      tools,
      executeTool,
      maxSteps = DEFAULT_MAX_STEPS,
      signal,
      onAssistantMessage,
      onToolResult,
    } = options;

    const { model, apiKey, reasoning, providerOptions } = this.config;

    // Convert core messages to pi-ai format for the model
    const allMessages: PiMessage[] = options.messages.map((m) =>
      coreMessageToPi(m, model.api),
    );

    // Convert core tool definitions to pi-ai Tool format
    const piTools: PiTool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as PiTool["parameters"],
    }));

    const newMessages: CoreMessage[] = [];
    let finalMessage: CoreAssistantMessage | undefined;

    for (let step = 0; step < maxSteps; step++) {
      signal?.throwIfAborted();

      const context: PiContext = {
        systemPrompt,
        messages: allMessages,
        tools: piTools.length > 0 ? piTools : undefined,
      };

      const streamOptions: SimpleStreamOptions = {
        signal,
        apiKey,
        reasoning,
        ...providerOptions,
      };

      const response = await completeSimple(model, context, streamOptions);
      allMessages.push(response);

      const coreResponse = piAssistantMessageToCore(response);
      newMessages.push(coreResponse);
      finalMessage = coreResponse;
      onAssistantMessage?.(coreResponse);

      // Report usage if hook is provided
      options.hooks?.onUsage?.(coreResponse.usage);

      const toolCalls = extractToolCalls(response);
      if (toolCalls.length === 0) {
        break;
      }

      // Execute all tool calls in this step
      for (const toolCall of toolCalls) {
        signal?.throwIfAborted();

        const coreToolCall: CoreToolCall = {
          type: "toolCall",
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
          thoughtSignature: toolCall.thoughtSignature,
        };

        const coreResult = await executeTool(coreToolCall, signal);
        newMessages.push(coreResult);

        // Convert back to pi-ai for the ongoing conversation
        const piResult = coreMessageToPi(coreResult, model.api);
        allMessages.push(piResult);

        onToolResult?.(coreResult);
      }
    }

    return {
      newMessages,
      finalMessage,
      steps: newMessages.filter((m) => m.role === "assistant").length,
    };
  }
}
