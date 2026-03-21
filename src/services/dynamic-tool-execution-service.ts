import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { stringifyToolErrorEnvelope } from "./tool-error-service";

function stringifyResult(result: unknown) {
  if (typeof result === "string") {
    return result;
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export async function executeLatestToolCalls(
  messages: BaseMessage[],
  tools: StructuredToolInterface[],
  options?: {
    beforeEach?: (toolCall: NonNullable<AIMessage["tool_calls"]>[number]) => Promise<void> | void;
  },
): Promise<ToolMessage[]> {
  const latest = messages.at(-1);
  if (!(latest instanceof AIMessage) || !latest.tool_calls?.length) {
    return [];
  }

  const toolsByName = new Map(tools.map((entry) => [entry.name, entry]));
  const results: ToolMessage[] = [];
  for (const toolCall of latest.tool_calls) {
    await options?.beforeEach?.(toolCall);
    const selected = toolsByName.get(toolCall.name);
    if (!selected) {
      results.push(
        new ToolMessage({
          tool_call_id: toolCall.id ?? toolCall.name,
          name: toolCall.name,
          status: "error",
          content: stringifyToolErrorEnvelope(
            toolCall.name,
            `Tool not available in the current visible bundle: ${toolCall.name}`,
          ),
        }),
      );
      continue;
    }

    try {
      const result = await (selected as { invoke: (arg: unknown) => Promise<unknown> }).invoke(toolCall.args);
      results.push(
        new ToolMessage({
          tool_call_id: toolCall.id ?? toolCall.name,
          name: toolCall.name,
          content: stringifyResult(result),
          status: "success",
        }),
      );
    } catch (error) {
      results.push(
        new ToolMessage({
          tool_call_id: toolCall.id ?? toolCall.name,
          name: toolCall.name,
          status: "error",
          content: stringifyToolErrorEnvelope(toolCall.name, error),
        }),
      );
    }
  }

  return results;
}
