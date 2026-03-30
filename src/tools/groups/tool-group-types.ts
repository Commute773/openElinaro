import type { FinanceService } from "../../services/finance-service";
import type { HealthTrackingService } from "../../services/health-tracking-service";
import type { RoutinesService } from "../../services/scheduling/routines-service";
import type { MemoryService } from "../../services/memory-service";
import type { ModelService, ActiveExtendedContextStatus } from "../../services/models/model-service";
import type { ProjectsService } from "../../services/projects-service";
import type { MediaService } from "../../services/media-service";
import type { EmailService } from "../../services/email-service";
import type { VonageService } from "../../services/vonage-service";
import type { GeminiLivePhoneService } from "../../services/gemini-live-phone-service";
import type { AlarmService } from "../../services/alarm-service";
import type { AccessControlService } from "../../services/profiles";
import type { OpenBrowserService } from "../../services/openbrowser-service";
import type { SecretStoreService } from "../../services/infrastructure/secret-store-service";
import type { WebFetchService } from "../../services/web-fetch-service";
import type { WebSearchService } from "../../services/web-search-service";
import type { WorkPlanningService } from "../../services/work-planning-service";
import type { TelemetryQueryService } from "../../services/telemetry-query-service";
import type { DeploymentVersionService } from "../../services/deployment-version-service";
import type { FeatureConfigService } from "../../services/feature-config-service";
import type { ConversationStore } from "../../services/conversation/conversation-store";
import type { FilesystemService } from "../../services/infrastructure/filesystem-service";
import type { ShellService } from "../../services/infrastructure/shell-service";
import type {
  ElinaroTicketsService,
} from "../../services/elinaro-tickets-service";
import type { RuntimePlatform } from "../../services/infrastructure/runtime-platform";
import type { PhoneCallBackend } from "../../services/phone-call-backends";
import type { Zigbee2MqttService } from "../../services/zigbee2mqtt-service";
import type { SystemPromptService } from "../../services/system-prompt-service";
import type { ConversationStateTransitionService } from "../../services/conversation/conversation-state-transition-service";
import type { ReflectionService } from "../../services/reflection-service";
import type { ToolResultStore } from "../../services/tool-result-store";
import type { PeerClient } from "../../instance/peer-client";
import type { PeerRegistry } from "../../instance/peer-registry";

export type ShellRuntime = Pick<
  ShellService,
  "consumeConversationNotifications" | "exec" | "launchBackground" | "listBackgroundJobs" | "readBackgroundOutput"
>;

export type FilesystemRuntime = Pick<
  FilesystemService,
  "applyPatch" | "copyPath" | "deletePath" | "edit" | "glob" | "grep" | "listDir" | "mkdir" | "movePath" | "read" | "statPath" | "write"
>;

export type TicketsRuntime = Pick<
  ElinaroTicketsService,
  "isConfigured" | "getConfigurationError" | "listTickets" | "getTicket" | "createTicket" | "updateTicket"
>;

/**
 * Shared context passed to each tool group builder.
 * Contains only the service dependencies that tool handlers need.
 */
export interface ToolBuildContext {
  routines: RoutinesService;
  projects: ProjectsService;
  models: ModelService;
  conversations: ConversationStore;
  memory: MemoryService;
  access: AccessControlService;
  finance: FinanceService;
  health: HealthTrackingService;
  shell: ShellRuntime;
  filesystem: FilesystemRuntime;
  email: EmailService;
  vonage: VonageService;
  geminiLivePhone: GeminiLivePhoneService;
  media: MediaService | null;
  alarms: AlarmService;
  tickets: TicketsRuntime;
  openbrowser: OpenBrowserService;
  secrets: SecretStoreService;
  webFetch: WebFetchService;
  workPlanning: WorkPlanningService;
  telemetryQuery: TelemetryQueryService;
  deploymentVersion: DeploymentVersionService;
  featureConfig: FeatureConfigService;
  zigbee2mqtt: Zigbee2MqttService;
  runtimePlatform: RuntimePlatform;
  resolvePhoneCallBackend: (requestedBackend?: string) => PhoneCallBackend;
  createWebSearchService: () => WebSearchService | null;
  requestManagedServiceRestart: (source: "config_edit" | "feature_manage" | "manual") => Promise<string>;
  systemPrompts: SystemPromptService;
  transitions: ConversationStateTransitionService;
  reflection: Pick<ReflectionService, "runExplicitReflection"> | undefined;
  toolResults: ToolResultStore;
  peerClient: PeerClient | undefined;
  peerRegistry: PeerRegistry | undefined;
}

export function formatDurationMs(durationMs: number | null) {
  if (durationMs === null) {
    return "n/a";
  }
  if (durationMs >= 1_000) {
    return `${(durationMs / 1_000).toFixed(2)}s`;
  }
  return `${durationMs.toFixed(2)}ms`;
}

export function renderShellExecResult(result: Awaited<ReturnType<ShellRuntime["exec"]>>) {
  return [
    `$ ${result.command}`,
    `cwd: ${result.cwd}`,
    `effectiveUser: ${result.effectiveUser}`,
    `timeoutMs: ${result.timeoutMs}`,
    `sudo: ${result.sudo ? "yes" : "no"}`,
    `exitCode: ${result.exitCode}`,
    result.stdout ? `stdout:\n${result.stdout}` : "stdout:\n",
    result.stderr ? `stderr:\n${result.stderr}` : "stderr:\n",
  ].join("\n");
}

export function formatTokenCount(value: number | undefined) {
  return value === undefined ? "n/a" : new Intl.NumberFormat("en-US").format(value);
}

export function renderExtendedContextStatus(status: ActiveExtendedContextStatus) {
  if (!status.supported) {
    return [
      "Extended context: unsupported",
      `Active model: ${status.providerId}/${status.modelId}`,
    ];
  }

  return [
    `Extended context: ${status.enabled ? "enabled" : "disabled"}`,
    `Active model: ${status.providerId}/${status.modelId}`,
    `Configured context window: ${formatTokenCount(status.activeContextWindow)} tokens`,
    `Standard window: ${formatTokenCount(status.standardContextWindow)} tokens`,
    `Extended window: ${formatTokenCount(status.extendedContextWindow)} tokens`,
  ];
}
