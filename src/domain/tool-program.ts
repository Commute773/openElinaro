import type { AgentToolScope } from "./tool-catalog";
import type { ToolProgramArtifactRecord } from "../services/tool-program-artifact-service";

export interface ToolProgramAvailableTool {
  name: string;
  description: string;
  examples: string[];
  domains: string[];
}

export interface ToolProgramToolCallRecord {
  name: string;
  artifactPath?: string;
  preview: string;
}

export interface ToolProgramRunReport {
  scope: AgentToolScope;
  summary: string;
  allowedTools: string[];
  toolCalls: ToolProgramToolCallRecord[];
  logs: string[];
  artifacts: ToolProgramArtifactRecord[];
  manifestPath: string;
}

export type ToolProgramWorkerRequest =
  | {
      type: "run";
      runId: string;
      objective: string;
      code: string;
      scope: AgentToolScope;
      allowedTools: string[];
      availableTools: ToolProgramAvailableTool[];
      timeoutMs: number;
    }
  | {
      type: "invoke_tool_result";
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "invoke_tool_result";
      id: string;
      ok: false;
      error: string;
    };

export type ToolProgramWorkerResponse =
  | {
      type: "invoke_tool";
      id: string;
      name: string;
      input: unknown;
    }
  | {
      type: "telemetry_event";
      name: string;
      level?: "debug" | "info" | "warn" | "error";
      message?: string;
      outcome?: "ok" | "error" | "cancelled" | "timeout" | "rejected";
      attributes?: Record<string, unknown>;
    }
  | {
      type: "complete";
      report: ToolProgramRunReport;
    }
  | {
      type: "error";
      error: string;
    };
