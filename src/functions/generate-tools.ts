/**
 * Generates pi-ai Tool definitions + handler map from FunctionDefinitions.
 *
 * Replaces the old LangChain StructuredToolInterface generation.
 * Produces:
 * - pi-ai Tool[] (name + description + JSON Schema parameters) for the model API
 * - Handler map for tool execution by the agent loop
 */
import { z } from "zod";
import type { FunctionDefinition, FunctionContext } from "./define-function";
import type { Tool } from "../messages/types";
import type { ToolBuildContext } from "../tools/groups/tool-group-types";
import type { ToolContext } from "../tools/tool-registry";
import type { FeatureId } from "../services/feature-config-service";
import { TOOL_CALL_BEHAVIOR_SCHEMA } from "../tools/tool-output-pipeline";
import { createTraceSpan } from "../utils/telemetry-helpers";
import { telemetry } from "../services/infrastructure/telemetry";

const fnTelemetry = telemetry.child({ component: "function" });
const traceSpan = createTraceSpan(fnTelemetry);

/**
 * Optional extras that ToolRegistry injects into FunctionContext at call time.
 * These are callbacks that require the ToolRegistry instance (conversation-
 * lifecycle helpers, tool library accessors, etc.).
 */
export type FunctionContextExtras = Partial<Omit<FunctionContext, "services" | "toolContext" | "conversationKey">>;

/** The raw result type returned by a tool handler before formatting. */
export type ToolRawResult = string | number | boolean | null | Record<string, unknown> | Array<unknown>;

/**
 * A tool entry combining the pi-ai tool schema with its execution handler.
 * The handler returns the raw structured result; format converts it to a
 * human-readable string for the model.
 */
export interface PiToolEntry {
  /** pi-ai tool definition (name + description + JSON Schema parameters) for the model API. */
  tool: Tool;
  /** The execution handler. Receives parsed input, returns the raw structured result. */
  handler: (input: Record<string, unknown>) => Promise<ToolRawResult>;
  /** Format the raw result into a human-readable string for the model. */
  format: (result: ToolRawResult) => string;
}

/**
 * Convert a Zod schema to a JSON Schema object suitable for pi-ai's Tool parameters.
 * Pi-ai uses TypeBox TSchema which is structurally a JSON Schema object at runtime.
 */
function zodToToolParameters(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  // z.toJSONSchema produces a full JSON Schema with $schema, etc.
  // pi-ai just needs the object schema (type, properties, required).
  // Strip top-level $schema if present — pi-ai doesn't need it.
  const { $schema: _, ...rest } = jsonSchema;
  return rest;
}

/**
 * Convert a single FunctionDefinition into a PiToolEntry.
 * - Input schema extended with TOOL_CALL_BEHAVIOR_SCHEMA (silent flag)
 * - Handler wrapped in traceSpan for telemetry
 * - Receives services via closure over the ToolBuildContext getter
 */
export function generateAgentTool(
  def: FunctionDefinition,
  resolveServices: () => ToolBuildContext,
  resolveToolContext?: () => ToolContext | undefined,
  resolveExtras?: () => FunctionContextExtras,
): PiToolEntry | null {
  const surfaces = def.surfaces ?? ["api", "discord", "agent"];
  if (!surfaces.includes("agent")) return null;

  // Extend input schema with the silent control field, matching existing tool behavior
  let schema: z.ZodType;
  if (def.input instanceof z.ZodObject) {
    schema = def.input.extend(TOOL_CALL_BEHAVIOR_SCHEMA.shape);
  } else {
    schema = def.input;
  }

  const parameters = zodToToolParameters(schema);

  return {
    tool: {
      name: def.name,
      description: def.description,
      parameters: parameters as Tool["parameters"],
    },
    handler: async (input: Record<string, unknown>): Promise<ToolRawResult> => {
      return traceSpan(`tool.${def.name}`, async () => {
        const extras = resolveExtras?.() ?? {};
        const toolContext = resolveToolContext?.();
        const ctx: FunctionContext = {
          services: resolveServices(),
          toolContext,
          conversationKey: toolContext?.conversationKey,
          ...extras,
        };
        const parsed = def.input.parse(input);
        return await def.handler(parsed, ctx) as ToolRawResult;
      }, { attributes: input });
    },
    format: (result: ToolRawResult): string => def.format(result as Parameters<typeof def.format>[0]),
  };
}

/**
 * Convert all agent-surface FunctionDefinitions into PiToolEntry[].
 * Feature-gated functions are excluded when the gate is inactive.
 */
export function generateAgentTools(
  definitions: FunctionDefinition[],
  resolveServices: () => ToolBuildContext,
  resolveToolContext?: () => ToolContext | undefined,
  featureChecker?: (featureId: FeatureId) => boolean,
  resolveExtras?: () => FunctionContextExtras,
): PiToolEntry[] {
  const entries: PiToolEntry[] = [];
  for (const def of definitions) {
    if (def.featureGate && featureChecker && !featureChecker(def.featureGate)) continue;
    const entry = generateAgentTool(def, resolveServices, resolveToolContext, resolveExtras);
    if (entry) entries.push(entry);
  }
  return entries;
}
