/**
 * Aggregates all domain function builders.
 * Each builder receives ToolBuildContext and returns FunctionDefinition[].
 */
import type { FunctionDomainBuilder } from "../define-function";
import { buildRoutineFunctions } from "./routine-functions";
import { buildFinanceFunctions } from "./finance-functions";
import { buildHealthFunctions } from "./health-functions";
import { buildCommunicationFunctions } from "./communication-functions";
import { buildProjectFunctions } from "./project-functions";
import { buildMemoryFunctions } from "./memory-functions";
import { buildSystemFunctions } from "./system-functions";
import { buildWebFunctions } from "./web-functions";
import { buildMediaFunctions } from "./media-functions";
import { buildConfigFunctions } from "./config-functions";
import { buildServiceFunctions } from "./service-functions";
import { buildShellFunctions } from "./shell-functions";
import { buildFilesystemFunctions } from "./filesystem-functions";
import { buildZigbee2MqttFunctions } from "./zigbee2mqtt-functions";

/**
 * All domain builders. Subagent and conversation-lifecycle tools remain
 * in the legacy tool group system for now (they require dynamic context).
 */
export const ALL_FUNCTION_BUILDERS: FunctionDomainBuilder[] = [
  buildRoutineFunctions,
  buildFinanceFunctions,
  buildHealthFunctions,
  buildCommunicationFunctions,
  buildProjectFunctions,
  buildMemoryFunctions,
  buildSystemFunctions,
  buildWebFunctions,
  buildMediaFunctions,
  buildConfigFunctions,
  buildServiceFunctions,
  buildShellFunctions,
  buildFilesystemFunctions,
  buildZigbee2MqttFunctions,
];
