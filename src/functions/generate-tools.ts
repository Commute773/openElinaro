/**
 * Generates LangChain StructuredToolInterface instances from FunctionDefinitions.
 * These slot directly into the existing ToolRegistry wrapping/output pipeline.
 */
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { FunctionDefinition, FunctionContext } from "./define-function";
import type { ToolBuildContext } from "../tools/groups/tool-group-types";
import type { ToolContext } from "../tools/tool-registry";
import { TOOL_CALL_BEHAVIOR_SCHEMA } from "../tools/tool-output-pipeline";
import { createTraceSpan } from "../utils/telemetry-helpers";
import { telemetry } from "../services/telemetry";

const fnTelemetry = telemetry.child({ component: "function" });
const traceSpan = createTraceSpan(fnTelemetry);

/**
 * Convert a single FunctionDefinition into a StructuredToolInterface.
 * The generated tool follows the same contract as tools produced by defineTool():
 * - Input schema extended with TOOL_CALL_BEHAVIOR_SCHEMA (silent flag)
 * - Handler wrapped in traceSpan for telemetry
 * - Receives services via closure over the ToolBuildContext getter
 */
export function generateAgentTool(
  def: FunctionDefinition,
  resolveServices: () => ToolBuildContext,
  resolveToolContext?: () => ToolContext | undefined,
): StructuredToolInterface | null {
  const surfaces = def.surfaces ?? ["api", "discord", "agent"];
  if (!surfaces.includes("agent")) return null;

  // Extend input schema with the silent control field, matching existing tool behavior
  let schema: z.ZodType;
  if (def.input instanceof z.ZodObject) {
    schema = def.input.extend(TOOL_CALL_BEHAVIOR_SCHEMA.shape);
  } else {
    schema = def.input;
  }

  return tool(
    async (input: any) => {
      return traceSpan(`tool.${def.name}`, async () => {
        const ctx: FunctionContext = {
          services: resolveServices(),
          toolContext: resolveToolContext?.(),
          conversationKey: resolveToolContext?.()?.conversationKey,
        };
        return def.handler(input, ctx);
      }, { attributes: input });
    },
    {
      name: def.name,
      description: def.description,
      schema: schema as any,
    },
  ) as StructuredToolInterface;
}

/**
 * Convert all agent-surface FunctionDefinitions into StructuredToolInterface[].
 * Feature-gated functions are excluded when the gate is inactive.
 */
export function generateAgentTools(
  definitions: FunctionDefinition[],
  resolveServices: () => ToolBuildContext,
  resolveToolContext?: () => ToolContext | undefined,
  featureChecker?: (featureId: string) => boolean,
): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = [];
  for (const def of definitions) {
    if (def.featureGate && featureChecker && !featureChecker(def.featureGate)) continue;
    const t = generateAgentTool(def, resolveServices, resolveToolContext);
    if (t) tools.push(t);
  }
  return tools;
}
