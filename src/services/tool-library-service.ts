import type { AgentToolScope } from "../domain/tool-catalog";

export interface ToolLibraryDefinition {
  id: string;
  description: string;
  toolNames: readonly string[];
  scopes?: readonly AgentToolScope[];
}

export const TOOL_LIBRARY_DEFINITIONS: readonly ToolLibraryDefinition[] = [
  {
    id: "project_work",
    description: "Projects, jobs, and current work focus.",
    toolNames: ["job_list", "job_get", "work_summary", "project_list", "project_get"],
  },
  {
    id: "profiles",
    description: "Launchable profiles and profile defaults.",
    toolNames: ["profile_list_launchable", "profile_set_defaults"],
  },
  {
    id: "planning",
    description: "Routines, todos, alarms, timers, and routine state changes.",
    toolNames: [
      "routine_check",
      "routine_list",
      "routine_get",
      "routine_add",
      "routine_update",
      "routine_delete",
      "routine_done",
      "routine_undo_done",
      "routine_snooze",
      "routine_skip",
      "routine_pause",
      "routine_resume",
      "set_alarm",
      "set_timer",
      "alarm_list",
      "alarm_cancel",
    ],
  },
  {
    id: "model_control",
    description: "Inspect or change the active model, thinking level, and extended context.",
    toolNames: ["model"],
  },
  {
    id: "memory",
    description: "Conversation history, memory search, imports, and reindexing.",
    toolNames: ["conversation_search", "memory_search", "memory_import", "memory_reindex"],
  },
  {
    id: "observability",
    description: "Telemetry, usage, context budgeting, and benchmarking.",
    toolNames: ["context", "usage_summary", "telemetry_query", "benchmark"],
  },
  {
    id: "web_research",
    description: "Web search and fetch for current-source research.",
    toolNames: ["web_search", "web_fetch"],
  },
  {
    id: "browser_automation",
    description: "Rendered browser automation for interactive web tasks.",
    toolNames: ["openbrowser"],
  },
  {
    id: "media",
    description: "Local media discovery and playback control.",
    toolNames: [
      "media_list",
      "media_list_speakers",
      "media_play",
      "media_pause",
      "media_stop",
      "media_set_volume",
      "media_status",
    ],
  },
  {
    id: "finance",
    description: "Finance summary, budgeting, history, review, import, management, and forecast.",
    toolNames: [
      "finance_summary",
      "finance_budget",
      "finance_history",
      "finance_review",
      "finance_import",
      "finance_manage",
      "finance_forecast",
    ],
  },
  {
    id: "health",
    description: "Health summaries, history, and structured check-ins.",
    toolNames: ["health_summary", "health_history", "health_log_checkin"],
  },
  {
    id: "email",
    description: "Mailbox status, listing, reading, and sending email.",
    toolNames: ["email"],
  },
  {
    id: "communications",
    description: "Live AI phone calls, call records, call control, and messaging.",
    toolNames: [
      "communications_status",
      "make_phone_call",
      "call_list",
      "call_get",
      "call_control",
      "message_send",
      "message_list",
      "message_get",
    ],
  },
  {
    id: "tickets",
    description: "Elinaro ticket listing, inspection, creation, and updates.",
    toolNames: ["tickets_list", "tickets_get", "tickets_create", "tickets_update"],
  },
  {
    id: "secrets",
    description: "Secret metadata, secret import, password generation, and deletion.",
    toolNames: ["secret_list", "secret_import_file", "secret_generate_password", "secret_delete"],
  },
  {
    id: "config",
    description: "Runtime config and feature management.",
    toolNames: ["config_edit", "feature_manage"],
  },
  {
    id: "shell",
    description: "Shell execution and background shell job inspection.",
    toolNames: ["exec_command", "exec_status", "exec_output"],
  },
  {
    id: "filesystem_read",
    description: "File and directory inspection, globbing, and content search.",
    toolNames: ["read_file", "list_dir", "glob", "grep", "stat_path"],
  },
  {
    id: "filesystem_write",
    description: "File edits, patch application, and path mutations.",
    toolNames: [
      "write_file",
      "edit_file",
      "apply_patch",
      "mkdir",
      "move_path",
      "copy_path",
      "delete_path",
    ],
  },
  {
    id: "service_ops",
    description: "Service version checks, changelog review, healthchecks, updates, and rollback.",
    toolNames: [
      "service_version",
      "service_changelog_since_version",
      "service_healthcheck",
      "update_preview",
      "update",
      "service_rollback",
    ],
  },
  {
    id: "coding_agents",
    description: "Background coding-agent launch, status, and cancellation.",
    toolNames: [
      "launch_agent",
      "cancel_agent",
      "agent_status",
    ],
  },
  {
    id: "lights",
    description: "Smart light control: status, color, temperature, brightness, on/off, pairing, and renaming.",
    toolNames: [
      "lights_status",
      "lights_inspect",
      "lights_set",
      "lights_read",
      "lights_on",
      "lights_off",
      "lights_pair",
      "lights_rename",
    ],
  },
] as const;

export function getToolLibraryDefinitions() {
  return TOOL_LIBRARY_DEFINITIONS;
}

export function getPromptToolLibraries() {
  return TOOL_LIBRARY_DEFINITIONS.filter((library) => !library.scopes || library.scopes.includes("chat"));
}
