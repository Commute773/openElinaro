import type { CacheMissWarning } from "../services/cache-miss-monitor";
import type { InferencePromptDriftWarning } from "../services/inference-prompt-drift-monitor";
import type { ProfileRecord } from "../domain/profiles";
import { AccessControlService } from "../services/profiles";
import { ActiveModelConnector } from "../connectors/active-model-connector";
import { AgentChatService } from "../services/conversation/agent-chat-service";
import { AutonomousTimeService } from "../services/autonomous-time-service";
import { ConversationMemoryService } from "../services/conversation/conversation-memory-service";
import { ConversationStateTransitionService } from "../services/conversation/conversation-state-transition-service";
import type { ConversationStore } from "../services/conversation/conversation-store";
import { FilesystemService } from "../services/infrastructure/filesystem-service";
import { LocalFilesystemBackend } from "../services/filesystem-backend-local";
import { SshFilesystemBackend } from "../services/filesystem-backend-ssh";
import type { FinanceService } from "../services/finance-service";
import type { HealthTrackingService } from "../services/health-tracking-service";
import { MemoryService } from "../services/memory-service";
import { ModelService } from "../services/models/model-service";
import type { ProfileService } from "../services/profiles";
import { ProjectsService } from "../services/projects-service";
import { ReflectionService } from "../services/reflection-service";
import type { RoutinesService } from "../services/scheduling/routines-service";
import { ServiceContainer } from "../services/container";
import { ShellService } from "../services/infrastructure/shell-service";
import { SshShellBackend } from "../services/shell-backend-ssh";
import { LocalShellBackend } from "../services/shell-backend-local";
import { SoulService } from "../services/soul-service";
import type { SystemPromptService } from "../services/system-prompt-service";
import { ToolResolutionService } from "../services/tool-resolution-service";
import { ToolRegistry } from "../tools/tool-registry";
import { telemetry } from "../services/infrastructure/telemetry";
import { getRuntimeConfig } from "../config/runtime-config";

type ShellRuntime = Pick<
  ShellService,
  | "consumeConversationNotifications"
  | "exec"
  | "execVerification"
  | "launchBackground"
  | "listBackgroundJobs"
  | "readBackgroundOutput"
>;
type FilesystemRuntime = Pick<
  FilesystemService,
  "applyPatch" | "copyPath" | "deletePath" | "edit" | "glob" | "grep" | "listDir" | "mkdir" | "movePath" | "read" | "statPath" | "write"
>;

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

/** Service container keys used by the runtime scope composition root. */
const K = {
  profile: "profile",
  shellEnvironment: "shellEnvironment",
  projects: "projects",
  access: "access",
  models: "models",
  memory: "memory",
  conversationMemory: "conversationMemory",
  soul: "soul",
  reflection: "reflection",
  autonomousTime: "autonomousTime",
  connector: "connector",
  shellBackend: "shellBackend",
  shell: "shell",
  filesystemBackend: "filesystemBackend",
  filesystem: "filesystem",
  transitions: "transitions",
  routineTools: "routineTools",
  toolResolver: "toolResolver",
  chat: "chat",
} as const;

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

  const c = new ServiceContainer();

  c.register<ProfileRecord>(K.profile, () => profiles.getProfile(profileId));

  c.register(K.shellEnvironment, () =>
    profiles.buildProfileShellEnvironment(c.resolve<ProfileRecord>(K.profile)),
  );

  c.register<ProjectsService>(K.projects, () =>
    appTelemetry.instrumentMethods(
      new ProjectsService(c.resolve<ProfileRecord>(K.profile), profiles),
      { component: "projects", profileId },
    ),
  );

  c.register<AccessControlService>(K.access, () =>
    appTelemetry.instrumentMethods(
      new AccessControlService(
        c.resolve<ProfileRecord>(K.profile),
        profiles,
        c.resolve<ProjectsService>(K.projects),
      ),
      { component: "access_control", profileId },
    ),
  );

  c.register<ModelService>(K.models, () => {
    const profile = c.resolve<ProfileRecord>(K.profile);
    const subagentDefaults = mode === "subagent"
      ? {
          providerId: profile.subagentPreferredProvider ?? profile.preferredProvider,
          modelId: profile.subagentDefaultModelId ?? profile.defaultModelId,
          thinkingLevel: "high" as const,
        }
      : undefined;
    return new ModelService(profile, {
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
  });

  c.register<MemoryService>(K.memory, () =>
    new MemoryService(c.resolve<ProfileRecord>(K.profile), profiles),
  );

  c.register<ConversationMemoryService>(K.conversationMemory, () =>
    new ConversationMemoryService(
      c.resolve<ProfileRecord>(K.profile),
      conversations,
      c.resolve<MemoryService>(K.memory),
      c.resolve<ModelService>(K.models),
      profiles,
    ),
  );

  c.register<SoulService>(K.soul, () =>
    new SoulService(
      c.resolve<ProfileRecord>(K.profile),
      routines,
      c.resolve<MemoryService>(K.memory),
      c.resolve<ModelService>(K.models),
    ),
  );

  c.register<ReflectionService>(K.reflection, () =>
    new ReflectionService(
      c.resolve<ProfileRecord>(K.profile),
      routines,
      conversations,
      c.resolve<MemoryService>(K.memory),
      c.resolve<ModelService>(K.models),
      c.resolve<SoulService>(K.soul),
    ),
  );

  c.register<AutonomousTimeService>(K.autonomousTime, () =>
    new AutonomousTimeService(c.resolve<ProfileRecord>(K.profile), routines),
  );

  c.register<ActiveModelConnector>(K.connector, () => {
    const connector = new ActiveModelConnector(c.resolve<ModelService>(K.models));
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
    return connector;
  });

  c.register(K.shellBackend, () => {
    const profile = c.resolve<ProfileRecord>(K.profile);
    const isSsh = profiles.isSshExecutionProfile(profile);
    return isSsh
      ? new SshShellBackend(profile, c.resolve<AccessControlService>(K.access), c.resolve(K.shellEnvironment))
      : new LocalShellBackend(c.resolve(K.shellEnvironment));
  });

  c.register<ShellRuntime>(K.shell, () =>
    new ShellService(c.resolve(K.shellBackend), c.resolve<AccessControlService>(K.access)),
  );

  c.register(K.filesystemBackend, () => {
    const profile = c.resolve<ProfileRecord>(K.profile);
    const isSsh = profiles.isSshExecutionProfile(profile);
    return isSsh
      ? new SshFilesystemBackend(profile, c.resolve<ShellRuntime>(K.shell) as ShellService)
      : new LocalFilesystemBackend();
  });

  c.register<FilesystemRuntime>(K.filesystem, () =>
    new FilesystemService(c.resolve(K.filesystemBackend), c.resolve<AccessControlService>(K.access)),
  );

  c.register<ConversationStateTransitionService>(K.transitions, () =>
    appTelemetry.instrumentMethods(
      new ConversationStateTransitionService(
        c.resolve<ActiveModelConnector>(K.connector),
        conversations,
        c.resolve<MemoryService>(K.memory),
        c.resolve<ModelService>(K.models),
        systemPrompts,
      ),
      { component: "conversation_transition", profileId },
    ),
  );

  c.register<ToolRegistry>(K.routineTools, () =>
    new ToolRegistry(
      routines,
      c.resolve<ProjectsService>(K.projects),
      c.resolve<ModelService>(K.models),
      conversations,
      c.resolve<MemoryService>(K.memory),
      systemPrompts,
      c.resolve<ConversationStateTransitionService>(K.transitions),
      ctx.createSubagentController(profileId),
      c.resolve<AccessControlService>(K.access),
      c.resolve<ShellRuntime>(K.shell),
      c.resolve<FilesystemRuntime>(K.filesystem),
      finance,
      health,
      c.resolve<ReflectionService>(K.reflection),
    ),
  );

  c.register<ToolResolutionService>(K.toolResolver, () =>
    appTelemetry.instrumentMethods(
      new ToolResolutionService(c.resolve<ToolRegistry>(K.routineTools)),
      { component: "tool_resolution", profileId },
    ),
  );

  c.register<AgentChatService>(K.chat, () => {
    const automaticConversationMemoryDisabled = isAutomaticConversationMemoryDisabled();
    const profile = c.resolve<ProfileRecord>(K.profile);
    const chat = new AgentChatService(
      {
        connector: c.resolve<ActiveModelConnector>(K.connector),
        routineTools: c.resolve<ToolRegistry>(K.routineTools),
        toolResolver: c.resolve<ToolResolutionService>(K.toolResolver),
        transitions: c.resolve<ConversationStateTransitionService>(K.transitions),
        conversations,
        systemPrompts,
        models: c.resolve<ModelService>(K.models),
        memory: mode === "subagent" || automaticConversationMemoryDisabled
          ? undefined
          : c.resolve<ConversationMemoryService>(K.conversationMemory),
        reflection: c.resolve<ReflectionService>(K.reflection),
      },
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
    return chat;
  });

  // Resolve all public-facing services to build the RuntimeScope.
  return {
    profile: c.resolve<ProfileRecord>(K.profile),
    access: c.resolve<AccessControlService>(K.access),
    projects: c.resolve<ProjectsService>(K.projects),
    models: c.resolve<ModelService>(K.models),
    memory: c.resolve<MemoryService>(K.memory),
    conversationMemory: c.resolve<ConversationMemoryService>(K.conversationMemory),
    reflection: c.resolve<ReflectionService>(K.reflection),
    autonomousTime: c.resolve<AutonomousTimeService>(K.autonomousTime),
    connector: c.resolve<ActiveModelConnector>(K.connector),
    shell: c.resolve<ShellRuntime>(K.shell),
    transitions: c.resolve<ConversationStateTransitionService>(K.transitions),
    routineTools: c.resolve<ToolRegistry>(K.routineTools),
    toolResolver: c.resolve<ToolResolutionService>(K.toolResolver),
    chat: c.resolve<AgentChatService>(K.chat),
  };
}
