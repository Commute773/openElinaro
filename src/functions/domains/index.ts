/**
 * Aggregates all domain function builders.
 * Each builder receives ToolBuildContext and returns FunctionDefinition[].
 */
import type { FunctionDomainBuilder } from "../define-function";

/**
 * All domain builders. Add new domain builders here as they are migrated
 * from the legacy tool group pattern.
 */
export const ALL_FUNCTION_BUILDERS: FunctionDomainBuilder[] = [
  // Migrated domains will be added here:
  // routineFunctions,
  // financeFunctions,
  // etc.
];
