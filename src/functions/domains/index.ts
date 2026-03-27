/**
 * Aggregates all domain function builders.
 * Each builder receives ToolBuildContext and returns FunctionDefinition[].
 */
import type { FunctionDomainBuilder } from "../define-function";
import { buildRoutineFunctions } from "./routine-functions";

/**
 * All domain builders. Add new domain builders here as they are migrated
 * from the legacy tool group pattern.
 */
export const ALL_FUNCTION_BUILDERS: FunctionDomainBuilder[] = [
  buildRoutineFunctions,
];
