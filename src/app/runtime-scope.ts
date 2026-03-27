import type { CacheMissWarning } from "../services/cache-miss-monitor";
import type { InferencePromptDriftWarning } from "../services/inference-prompt-drift-monitor";
import type { ProfileRecord } from "../domain/profiles";
import { AccessControlService } from "../services/access-control-service";
import { ActiveModelConnector } from "../connectors/active-model-connector";
import { AgentChatService } from "../services/agent-chat-service";
import { AutonomousTimeService } from "../services/autonomous-time-service";
import { ConversationMemoryService } from "../services/conversation-memory-service";
import { ConversationStateTransitionService } from "../services/conversation-state-transition-service";
import type { ConversationStore } from "../services/conversation-store";
import { FilesystemService } from "../services/filesystem-service";
import type { FinanceService } from "../services/finance-service";
import type { HealthTrackingService } from "../services/health-tracking-service";
import { MemoryService } from "../services/memory-service";
import { ModelService } from "../services/model-service";
import type { ProfileService } from "../services/profile-service";
import { ProjectsService } from "../services/projects-service";
import { ReflectionService } from "../services/reflection-service";
import type { RoutinesService } from "../services/routines-service";
import { ShellService } from "../services/shell-service";
import { SoulService } from "../services/soul-service";
import { SshFilesystemService } from "../services/ssh-filesystem-service";
import { SshShellService } from "../services/ssh-shell-service";
import type { SystemPromptService } from "../services/system-prompt-service";
import { ToolResolutionService } from "../services/tool-resolution-service";
import { ToolRegistry } from "../tools/tool-registry";
import { telemetry } from "../services/telemetry";
import { getRuntimeConfig } from "../config/runtime-config";
import type { ShellRuntime as BaseShellRuntime, FilesystemRuntime } from "../tools/groups/tool-group-types";

type ShellRuntime = BaseShellRuntime & Pick<ShellService, "execVerification">;

export type RuntimeScope = {
  profile: ProfileRecord;
  access: AccessControlService;
  projects: ProjectsService;
  models: ModelService;
  memory: MemoryService;
  conversationMemory: ConversationMemoryService;
  reflection: ReflectionService;
  autonomousTime: AutonomousTimeService;
  connector: ActiveModelConnector;
  shell: ShellRuntime;
  transitions: ConversationStateTransitionService;
  routineTools: ToolRegistry;
  toolResolver: ToolResolutionService;
  chat: AgentChatService;
};

function isAutomaticConversationMemoryDisabled() {
  return getRuntimeConfig().core.app.automaticConversationMemoryEnabled === false;
}

export function createRuntimeScope(ctx: {
  profileId: string;
  mode: "interactive" | "subagent";
  appTelemetry: typeof telemetry;
  profiles: ProfileService;
  activeProfile: ProfileRecord;
  routines: RoutinesService;
  conversations: ConversationStore;
  systemPrompts: SystemPromptService;
  finance: FinanceService;
  health: HealthTrackingService;
  onCacheMissWarning?: (warning: CacheMissWarning) => Promise<void> | void;
  onPromptDriftWarning?: (warning: InferencePromptDriftWarning) => Promise<void> | void;
  onConversationActivityChange?: (params: {
    conversationKey: string;
    active: boolean;
  }) => Promise<void> | void;
  createSubagentController: (profileId: string) => ReturnType<any>;
}): RuntimeScope {
  const {
    profileId,
    mode,
    appTelemetry,
    profiles,
    routines,
    conversations,
    systemPrompts,
    finance,
    health,
  } = ctx;

  const profile = profiles.getProfile(profileId);
  const shellEnvironment = profiles.buildProfileShellEnvironment(profile);
  const projects = appTelemetry.instrumentMethods(
    new ProjectsService(profile, profiles),
    { component: "projects", profileId },
  );
  const access = appTelemetry.instrumentMethods(
    new AccessControlService(profile, profiles, projects),
    { component: "access_control", profileId },
  );
  const subagentDefaults = mode === "subagent"
    ? {
        providerId: profile.subagentPreferredProvider ?? profile.preferredProvider,
        modelId: profile.subagentDefaultModelId ?? profile.defaultModelId,
        thinkingLevel: "high" as const,
      }
    : undefined;
  const models = new ModelService(profile, {
    onCacheMissWarning: (warning) => {
      if (!ctx.onCacheMissWarning) {
        return;
      }

      void Promise.resolve(ctx.onCacheMissWarning(warning)).catch((error) => {
        appTelemetry.recordError(error, {
          profileId,
          conversationKey: warning.conversationKey,
          operation: "app.cache_miss_warning_notifier",
        });
      });
    },
    selectionStoreKey: mode === "subagent" ? `${profile.id}:subagent` : profile.id,
    defaultSelectionOverride: subagentDefaults,
  });
  const memory = new MemoryService(profile, profiles);
  const conversationMemory = new ConversationMemoryService(
    profile,
    conversations,
    memory,
    models,
    profiles,
  );
  const soul = new SoulService(
    profile,
    routines,
    memory,
    models,
  );
  const reflection = new ReflectionService(
    profile,
    routines,
    conversations,
    memory,
    models,
    soul,
  );
  const autonomousTime = new AutonomousTimeService(profile, routines);
  const automaticConversationMemoryDisabled = isAutomaticConversationMemoryDisabled();
  const connector = new ActiveModelConnector(models);
  if (ctx.onPromptDriftWarning) {
    connector.setPromptDriftWarningCallback((warning) => {
      void Promise.resolve(ctx.onPromptDriftWarning!(warning)).catch((error) => {
        appTelemetry.recordError(error, {
          profileId,
          sessionId: warning.sessionId,
          operation: "app.prompt_drift_warning_notifier",
        });
      });
    });
  }
  const shell: ShellRuntime = profiles.isSshExecutionProfile(profile)
    ? new SshShellService(profile, access, shellEnvironment)
    : new ShellService(access, shellEnvironment);
  const filesystem: FilesystemRuntime = profiles.isSshExecutionProfile(profile)
    ? new SshFilesystemService(profile, shell as SshShellService, access)
    : new FilesystemService(access);
  const transitions = appTelemetry.instrumentMethods(
    new ConversationStateTransitionService(
      connector,
      conversations,
      memory,
      models,
      systemPrompts,
    ),
    { component: "conversation_transition", profileId },
  );
  const routineTools = new ToolRegistry(
    routines,
    projects,
    models,
    conversations,
    memory,
    systemPrompts,
    transitions,
    ctx.createSubagentController(profileId),
    access,
    shell,
    filesystem,
    finance,
    health,
    reflection,
  );
  const toolResolver = appTelemetry.instrumentMethods(
    new ToolResolutionService(routineTools),
    { component: "tool_resolution", profileId },
  );
  const chat = new AgentChatService(
    connector,
    routineTools,
    toolResolver,
    transitions,
    conversations,
    systemPrompts,
    models,
    mode === "subagent" || automaticConversationMemoryDisabled ? undefined : conversationMemory,
    reflection,
    mode === "interactive" && profile.id === "root",
    ctx.onConversationActivityChange
      ? (params) => {
          void Promise.resolve(ctx.onConversationActivityChange?.(params)).catch((error) => {
            appTelemetry.recordError(error, {
              conversationKey: params.conversationKey,
              active: params.active,
              operation: "app.conversation_activity_notifier",
            });
          });
        }
      : undefined,
  );
  chat.setTimezoneProvider(() => routines.getTimezone());

  return {
    profile,
    access,
    projects,
    models,
    memory,
    conversationMemory,
    reflection,
    autonomousTime,
    connector,
    shell,
    transitions,
    routineTools,
    toolResolver,
    chat,
  };
}
