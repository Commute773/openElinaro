import type { StructuredToolInterface } from "@langchain/core/tools";
import type { FinanceService } from "../../services/finance-service";
import type { HealthTrackingService } from "../../services/health-tracking-service";
import type { RoutinesService } from "../../services/routines-service";
import type { MemoryService } from "../../services/memory-service";
import type { ModelService } from "../../services/model-service";
import type { ProjectsService } from "../../services/projects-service";
import type { MediaService } from "../../services/media-service";
import type { EmailService } from "../../services/email-service";
import type { VonageService } from "../../services/vonage-service";
import type { GeminiLivePhoneService } from "../../services/gemini-live-phone-service";
import type { AlarmService } from "../../services/alarm-service";
import type { AccessControlService } from "../../services/access-control-service";
import type { OpenBrowserService } from "../../services/openbrowser-service";
import type { SecretStoreService } from "../../services/secret-store-service";
import type { WebFetchService } from "../../services/web-fetch-service";
import type { WebSearchService } from "../../services/web-search-service";
import type { WorkPlanningService } from "../../services/work-planning-service";
import type { TelemetryQueryService } from "../../services/telemetry-query-service";
import type { DeploymentVersionService } from "../../services/deployment-version-service";
import type { FeatureConfigService } from "../../services/feature-config-service";
import type { ConversationStore } from "../../services/conversation-store";
import type { FilesystemService } from "../../services/filesystem-service";
import type { ShellService } from "../../services/shell-service";
import type {
  ElinaroTicketsService,
} from "../../services/elinaro-tickets-service";
import type { RuntimePlatform } from "../../services/runtime-platform";
import type { PhoneCallBackend } from "../../services/phone-call-backends";

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
  runtimePlatform: RuntimePlatform;
  resolvePhoneCallBackend: (requestedBackend?: string) => PhoneCallBackend;
  createWebSearchService: () => WebSearchService | null;
  requestManagedServiceRestart: (source: "config_edit" | "feature_manage") => Promise<string>;
}
