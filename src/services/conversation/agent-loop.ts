/**
 * Minimal multi-step agent loop using pi-ai's complete().
 *
 * Replaces the Vercel AI SDK's generateText() + stepCountIs() pattern.
 * The loop calls the model, executes any returned tool calls, and repeats
 * until the model stops issuing tool calls or the step limit is reached.
 */
import {
  complete,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type Tool,
  type ToolCall,
  type ProviderStreamOptions,
} from "@mariozechner/pi-ai";
import type { ToolResultMessage } from "../../messages/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolExecutor = (
  toolCall: ToolCall,
  signal?: AbortSignal,
) => Promise<ToolResultMessage>;

export interface AgentLoopOptions {
  model: Model<any>;
  systemPrompt: string;
  messages: Message[];
  tools: Tool[];
  executeTool: ToolExecutor;
  maxSteps?: number;
  signal?: AbortSignal;
  apiKey?: string;
  /** Called after each assistant message (including intermediate tool-calling steps). */
  onAssistantMessage?: (message: AssistantMessage) => void;
  /** Called after each tool result. */
  onToolResult?: (result: ToolResultMessage) => void;
  /** Extra provider-specific options passed to pi-ai's complete(). */
  providerOptions?: Record<string, unknown>;
}

export interface AgentLoopResult {
  /** All new messages produced during this loop (assistant + tool results). */
  newMessages: Message[];
  /** The final assistant message (the one without tool calls, or the last one at step limit). */
  finalMessage: AssistantMessage | undefined;
  /** Number of model round-trips executed. */
  steps: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_MAX_STEPS = 25;

function extractToolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter(
    (block): block is ToolCall => block.type === "toolCall",
  );
}

export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const {
    model,
    systemPrompt,
    tools,
    executeTool,
    maxSteps = DEFAULT_MAX_STEPS,
    signal,
    apiKey,
    onAssistantMessage,
    onToolResult,
    providerOptions,
  } = options;

  const allMessages: Message[] = [...options.messages];
  const newMessages: Message[] = [];
  let finalMessage: AssistantMessage | undefined;

  for (let step = 0; step < maxSteps; step++) {
    signal?.throwIfAborted();

    const context: Context = {
      systemPrompt,
      messages: allMessages,
      tools: tools.length > 0 ? tools : undefined,
    };

    const streamOptions: ProviderStreamOptions = {
      signal,
      apiKey,
      ...providerOptions,
    };

    const response = await complete(model, context, streamOptions);
    allMessages.push(response);
    newMessages.push(response);
    finalMessage = response;
    onAssistantMessage?.(response);

    const toolCalls = extractToolCalls(response);
    if (toolCalls.length === 0) {
      break;
    }

    // Execute all tool calls in this step
    for (const toolCall of toolCalls) {
      signal?.throwIfAborted();
      const result = await executeTool(toolCall, signal);
      allMessages.push(result);
      newMessages.push(result);
      onToolResult?.(result);
    }
  }

  return {
    newMessages,
    finalMessage,
    steps: newMessages.filter((m) => m.role === "assistant").length,
  };
}
