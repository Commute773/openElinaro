import {
  tool,
  type StructuredToolInterface,
  type ToolParams,
  type ToolRunnableConfig,
} from "@langchain/core/tools";
import type { z } from "zod";
import type { RunnableFunc } from "@langchain/core/runnables";
import type { ToolName } from "../services/tool-authorization-service";

/**
 * Typed wrapper around langchain's `tool()` that:
 *
 * 1. Preserves full schema → input type inference (ZodObject v3).
 * 2. Enforces the tool name is a known `ToolName` at compile time.
 *
 * This ensures that adding a new tool without a corresponding auth
 * declaration is caught at compile time instead of crashing at startup.
 */
export function defineTool<
  SchemaT extends z.ZodObject<z.ZodRawShape>,
  SchemaOutputT = z.output<SchemaT>,
>(
  func: RunnableFunc<SchemaOutputT, unknown, ToolRunnableConfig>,
  fields: ToolParams & {
    name: ToolName;
    description?: string;
    schema?: SchemaT;
  },
): StructuredToolInterface {
  return tool(func as Parameters<typeof tool>[0], fields as Parameters<typeof tool>[1]) as StructuredToolInterface;
}

/** Re-export the ToolName type so callers can reference it. */
export type { ToolName };
