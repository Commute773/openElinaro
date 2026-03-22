import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AIMessage } from "@langchain/core/messages";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ScriptedProviderConnector } from "../test/scripted-provider-connector";

const repoRoot = process.cwd();

let tempRoot = "";
let previousCwd = "";
let previousRootDirEnv: string | undefined;

let authStore: typeof import("../auth/store");
let profilesModule: typeof import("../services/profile-service");
let projectsModule: typeof import("../services/projects-service");
let accessModule: typeof import("../services/access-control-service");
let workspaceModule: typeof import("../services/project-workspace-service");
let routinesModule: typeof import("../services/routines-service");
let conversationsModule: typeof import("../services/conversation-store");
let systemPromptsModule: typeof import("../services/system-prompt-service");
let memoryModule: typeof import("../services/memory-service");
let modelsModule: typeof import("../services/model-service");
let transitionsModule: typeof import("../services/conversation-state-transition-service");
let toolRegistryModule: typeof import("../tools/tool-registry");
let toolAuthModule: typeof import("../services/tool-authorization-service");

function writeTestProfileRegistry() {
  fs.mkdirSync(".openelinarotest/profiles", { recursive: true });
  fs.writeFileSync(
    ".openelinarotest/profiles/registry.json",
    `${JSON.stringify({
      version: 1,
      profiles: [
        {
          id: "root",
          name: "Root",
          roles: ["root"],
          memoryNamespace: "root",
          preferredProvider: "openai-codex",
          defaultModelId: "gpt-5.4",
          maxSubagentDepth: 1,
        },
        {
          id: "restricted",
          name: "Restricted",
          roles: ["restricted"],
          memoryNamespace: "restricted",
          shellUser: "restricted",
          preferredProvider: "claude",
          defaultModelId: "claude-sonnet-4-5",
          maxSubagentDepth: 1,
        },
      ],
    }, null, 2)}\n`,
  );
}

function writeTestProjectRegistry() {
  fs.mkdirSync(".openelinarotest/projects/telecorder", { recursive: true });
  fs.mkdirSync(".openelinarotest/projects/root-only", { recursive: true });
  fs.writeFileSync(
    ".openelinarotest/projects/registry.json",
    `${JSON.stringify({
      version: 1,
      jobs: [
        {
          id: "restricted",
          name: "Restricted",
          status: "active",
          priority: "high",
          summary: "Restricted client work.",
        },
      ],
      projects: [
        {
          id: "telecorder",
          name: "Telecorder",
          status: "active",
          jobId: "restricted",
          priority: "high",
          allowedRoles: ["restricted"],
          workspacePath: path.join(tempRoot, ".openelinarotest", "projects/telecorder/workspace"),
          summary: "Restricted project.",
          currentState: "Available to restricted.",
          state: "Telecorder should be accessible only to restricted-aware profiles.",
          future: "Telecorder should exercise role-gated project and memory access safely.",
          nextFocus: ["Ship role-gated access."],
          structure: ["workspace/: clone root"],
          tags: ["restricted"],
          docs: {
            readme: "projects/telecorder/README.md",
          },
        },
        {
          id: "root-only",
          name: "Root Only",
          status: "active",
          priority: "medium",
          allowedRoles: [],
          workspacePath: path.join(tempRoot, ".openelinarotest", "projects/root-only/workspace"),
          summary: "Root-only project.",
          currentState: "Restricted.",
          state: "Root-only test project for access control coverage.",
          future: "Remain hidden from restricted profiles.",
          nextFocus: ["Stay hidden from non-root profiles."],
          structure: ["workspace/: clone root"],
          tags: ["root"],
          docs: {
            readme: "projects/root-only/README.md",
          },
        },
      ],
    }, null, 2)}\n`,
  );
}

function resetTestState() {
  fs.rmSync(".openelinarotest", { recursive: true, force: true });
  writeTestProfileRegistry();
  writeTestProjectRegistry();
  for (const relativePath of [
    ".openelinarotest/auth-store.json",
    ".openelinarotest/model-state.json",
    ".openelinarotest/conversations.json",
    ".openelinarotest/routines.json",
    ".openelinarotest/session-todos.json",
  ]) {
    fs.rmSync(relativePath, { force: true });
  }
  fs.mkdirSync(".openelinarotest/memory/documents/restricted", { recursive: true });
  fs.mkdirSync(".openelinarotest/memory/documents/root", { recursive: true });
}

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?test=${Date.now()}-${Math.random()}`) as Promise<T>;
}

function initGitRepo(repoRoot: string) {
  fs.mkdirSync(repoRoot, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "OpenElinaro Test"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "tests@example.com"], { cwd: repoRoot, stdio: "ignore" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });
}

beforeAll(async () => {
  previousCwd = process.cwd();
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-profile-test-"));
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  process.env.OPENELINARO_ROOT_DIR = tempRoot;
  process.chdir(tempRoot);

  writeTestProfileRegistry();
  writeTestProjectRegistry();

  authStore = await importFresh("src/auth/store.ts");
  profilesModule = await importFresh("src/services/profile-service.ts");
  projectsModule = await importFresh("src/services/projects-service.ts");
  accessModule = await importFresh("src/services/access-control-service.ts");
  workspaceModule = await importFresh("src/services/project-workspace-service.ts");
  routinesModule = await importFresh("src/services/routines-service.ts");
  conversationsModule = await importFresh("src/services/conversation-store.ts");
  systemPromptsModule = await importFresh("src/services/system-prompt-service.ts");
  memoryModule = await importFresh("src/services/memory-service.ts");
  modelsModule = await importFresh("src/services/model-service.ts");
  transitionsModule = await importFresh("src/services/conversation-state-transition-service.ts");
  toolRegistryModule = await importFresh("src/tools/tool-registry.ts");
  toolAuthModule = await importFresh("src/services/tool-authorization-service.ts");
});

beforeEach(() => {
  resetTestState();
});

afterAll(() => {
  process.chdir(previousCwd);
  if (previousRootDirEnv === undefined) {
    delete process.env.OPENELINARO_ROOT_DIR;
  } else {
    process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("profile-scoped auth and permissions", () => {
  test("stores provider auth separately per profile", () => {
    authStore.saveClaudeSetupToken("root-token", "root");
    authStore.saveClaudeSetupToken("restricted-token", "restricted");

    expect(authStore.getClaudeSetupToken("root")).toBe("root-token");
    expect(authStore.getClaudeSetupToken("restricted")).toBe("restricted-token");
    expect(authStore.getAuthStatusLines("restricted")).toContain("profile: restricted");
    expect(authStore.hasProviderAuth("claude", "root")).toBe(true);
    expect(authStore.hasProviderAuth("claude", "restricted")).toBe(true);
  });

  test("treats partial auth entries without secrets as missing", async () => {
    authStore.saveClaudeSetupToken("", "restricted");

    expect(authStore.hasProviderAuth("claude", "restricted")).toBe(false);
    expect(authStore.getAuthStatusLines("restricted")).toContain("claude: missing");
  });

  test("creates distinct ssh keypairs and shell env per profile", () => {
    const profileService = new profilesModule.ProfileService("root");
    const root = profileService.getProfile("root");
    const restricted = profileService.getProfile("restricted");

    const rootKeys = profileService.ensureProfileSshKeyPair(root);
    const restrictedKeys = profileService.ensureProfileSshKeyPair(restricted);

    expect(fs.existsSync(rootKeys.privateKeyPath)).toBe(true);
    expect(fs.existsSync(rootKeys.publicKeyPath)).toBe(true);
    expect(fs.existsSync(restrictedKeys.privateKeyPath)).toBe(true);
    expect(fs.existsSync(restrictedKeys.publicKeyPath)).toBe(true);
    expect(rootKeys.privateKeyPath).toContain(`${path.sep}.openelinarotest${path.sep}runtime-ssh-keys${path.sep}root${path.sep}`);
    expect(restrictedKeys.privateKeyPath).toContain(`${path.sep}.openelinarotest${path.sep}runtime-ssh-keys${path.sep}restricted${path.sep}`);
    expect(rootKeys.privateKeyPath).not.toBe(restrictedKeys.privateKeyPath);
    expect(fs.readFileSync(rootKeys.publicKeyPath, "utf8")).not.toBe(
      fs.readFileSync(restrictedKeys.publicKeyPath, "utf8"),
    );
    const secretStoreText = fs.readFileSync(path.join(tempRoot, ".openelinarotest/secret-store.json"), "utf8");
    expect(secretStoreText).toContain("profile_ssh_keypair_root");
    expect(secretStoreText).toContain("profile_ssh_keypair_restricted");

    const rootEnv = profileService.buildProfileShellEnvironment(root);
    const restrictedEnv = profileService.buildProfileShellEnvironment(restricted);

    expect(rootEnv.OPENELINARO_PROFILE_ID).toBe("root");
    expect(restrictedEnv.OPENELINARO_PROFILE_ID).toBe("restricted");
    expect(rootEnv.GIT_SSH_COMMAND).toContain(rootKeys.privateKeyPath);
    expect(restrictedEnv.GIT_SSH_COMMAND).toContain(restrictedKeys.privateKeyPath);
    expect(restrictedEnv.OPENELINARO_PROFILE_SHELL_USER).toBe("restricted");
    expect(restrictedEnv.OPENELINARO_PROFILE_MAX_SUBAGENT_DEPTH).toBe("1");
    expect(rootEnv.TMPDIR).toBe("/tmp/openelinaro-profile-tmp/root");
    expect(restrictedEnv.TMPDIR).toBe("/tmp/openelinaro-profile-tmp/restricted");
    expect(restrictedEnv.TMP).toBe(restrictedEnv.TMPDIR);
    expect(restrictedEnv.TEMP).toBe(restrictedEnv.TMPDIR);
  });

  test("allows SSH-backed profiles to use shell tools within configured remote roots", () => {
    writeTestProfileRegistry();
    const profileService = new profilesModule.ProfileService("root");
    const registry = profileService.loadRegistry();
    registry.profiles.push({
      id: "remote",
      name: "Remote",
      roles: ["remote"],
      memoryNamespace: "remote",
      pathRoots: ["/Users/remote"],
      execution: {
        kind: "ssh",
        host: "192.168.2.42",
        user: "remote",
        defaultCwd: "/Users/remote",
      },
      preferredProvider: "claude",
      defaultModelId: "claude-sonnet-4-5",
      maxSubagentDepth: 1,
    });
    profileService.saveRegistry(registry);

    const remoteProfileService = new profilesModule.ProfileService("remote");
    const remote = remoteProfileService.getActiveProfile();
    const projects = new projectsModule.ProjectsService(remote, remoteProfileService);
    const access = new accessModule.AccessControlService(remote, remoteProfileService, projects);

    expect(remoteProfileService.canUseShellTools(remote)).toBe(true);
    expect(access.assertPathAccess("/Users/remote/project")).toBe("/Users/remote/project");
    expect(() => access.assertPathAccess(path.join(tempRoot, "README.md"))).toThrow(
      "outside the allowed workspace roots",
    );
  });

  test("resolves per-profile workspace overrides for SSH-backed profiles", () => {
    writeTestProfileRegistry();
    const profileService = new profilesModule.ProfileService("root");
    const registry = profileService.loadRegistry();
    registry.profiles.push({
      id: "remote",
      name: "Remote",
      roles: ["remote"],
      memoryNamespace: "remote",
      pathRoots: ["/Users/remote"],
      execution: {
        kind: "ssh",
        host: "192.168.2.42",
        user: "remote",
        defaultCwd: "/Users/remote",
      },
      preferredProvider: "claude",
      defaultModelId: "claude-sonnet-4-5",
      maxSubagentDepth: 1,
    });
    profileService.saveRegistry(registry);

    fs.writeFileSync(
      ".openelinarotest/projects/registry.json",
      `${JSON.stringify({
        version: 1,
        projects: [
          {
            id: "telecorder",
            name: "Telecorder",
            status: "active",
            allowedRoles: ["remote"],
            workspacePath: path.join(tempRoot, ".openelinarotest", "projects/telecorder/workspace"),
            workspaceOverrides: {
              remote: "/Users/remote/telecorder",
            },
            summary: "SSH project.",
            currentState: "Remote workspace available.",
            state: "SSH-backed project fixture for workspace override tests.",
            future: "Use the remote path consistently for remote.",
            nextFocus: ["Use the remote path."],
            structure: ["workspace/: clone root"],
            tags: ["remote"],
            docs: {
              readme: "projects/telecorder/README.md",
            },
            priority: "medium",
          },
        ],
      }, null, 2)}\n`,
    );

    const remoteProfileService = new profilesModule.ProfileService("remote");
    const remote = remoteProfileService.getActiveProfile();
    const projects = new projectsModule.ProjectsService(remote, remoteProfileService);
    const access = new accessModule.AccessControlService(remote, remoteProfileService, projects);
    const project = projects.getProject("telecorder");
    expect(project).toBeDefined();
    expect(projects.resolveWorkspacePath(project!)).toBe("/Users/remote/telecorder");
    expect(access.assertPathAccess("/Users/remote/telecorder/src")).toBe("/Users/remote/telecorder/src");
  });

  test("allows a permitted profile to access its managed linked worktree", () => {
    const profileService = new profilesModule.ProfileService("restricted");
    const profile = profileService.getActiveProfile();
    const projects = new projectsModule.ProjectsService(profile, profileService);
    const access = new accessModule.AccessControlService(profile, profileService, projects);
    const workspaceRoot = path.join(tempRoot, ".openelinarotest", "projects/telecorder/workspace");
    initGitRepo(workspaceRoot);

    const workspaceService = new workspaceModule.ProjectWorkspaceService();
    const managedWorkspace = workspaceService.ensureIsolatedWorkspace({
      cwd: workspaceRoot,
      runId: "run-managed-telecorder",
      goal: "Check managed worktree permissions",
      profileId: "restricted",
    });

    expect(managedWorkspace).toBeTruthy();
    expect(access.assertPathAccess(path.join(managedWorkspace!.workspaceCwd, "README.md"))).toBe(
      path.join(managedWorkspace!.workspaceCwd, "README.md"),
    );
  });

  test("resolves local relative paths against OPENELINARO_ROOT_DIR instead of cwd", () => {
    writeTestProfileRegistry();
    const rootProfileService = new profilesModule.ProfileService("root");
    const root = rootProfileService.getActiveProfile();
    const projects = new projectsModule.ProjectsService(root, rootProfileService);
    const access = new accessModule.AccessControlService(root, rootProfileService, projects);

    const previous = process.cwd();
    const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-relative-cwd-"));
    process.chdir(otherCwd);

    try {
      expect(access.assertPathAccess("docs/openelinaro-todos.md")).toBe(
        path.join(tempRoot, "docs/openelinaro-todos.md"),
      );
    } finally {
      process.chdir(previous);
      fs.rmSync(otherCwd, { recursive: true, force: true });
    }
  });

  test("filters projects by role", () => {
    writeTestProjectRegistry();
    const profileService = new profilesModule.ProfileService("restricted");
    const restricted = profileService.getActiveProfile();
    const root = profileService.getProfile("root");

    const restrictedProjects = new projectsModule.ProjectsService(restricted, profileService);
    const rootProjects = new projectsModule.ProjectsService(root, profileService);

    expect(restrictedProjects.listProjects().map((project) => project.id)).toEqual(["telecorder"]);
    expect(rootProjects.listProjects().map((project) => project.id)).toContain("telecorder");
  });

  test("lists the profiles each active profile can launch subagents under", async () => {
    writeTestProfileRegistry();
    const rootProfileService = new profilesModule.ProfileService("root");
    const root = rootProfileService.getActiveProfile();
    expect(rootProfileService.listLaunchableProfiles(root).map((profile) => profile.id)).toEqual([
      "root",
      "restricted",
    ]);

    const restrictedProfileService = new profilesModule.ProfileService("restricted");
    const restricted = restrictedProfileService.getActiveProfile();
    expect(
      restrictedProfileService.listLaunchableProfiles(restricted).map((profile) => profile.id),
    ).toEqual(["restricted"]);

    const projects = new projectsModule.ProjectsService(restricted, restrictedProfileService);
    const access = new accessModule.AccessControlService(restricted, restrictedProfileService, projects);
    const routines = new routinesModule.RoutinesService();
    const conversations = new conversationsModule.ConversationStore();
    const systemPrompts = new systemPromptsModule.SystemPromptService();
    const memory = new memoryModule.MemoryService(restricted, restrictedProfileService);
    const models = new modelsModule.ModelService(restricted);
    const fakeConnector = new ScriptedProviderConnector(() => new AIMessage("stub"), {
      providerId: "test",
    });
    const transitions = new transitionsModule.ConversationStateTransitionService(
      fakeConnector,
      conversations,
      memory,
      models,
      systemPrompts,
    );
    const registry = new toolRegistryModule.ToolRegistry(
      routines,
      projects,
      models,
      conversations,
      memory,
      systemPrompts,
      transitions,
      {
        launchCodingAgent: () =>
          ({
            id: "run-1",
            kind: "coding-agent",
            profileId: "restricted",
            goal: "goal",
            status: "queued",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            executionLog: [],
            taskReports: [],
          }),
        resumeCodingAgent: () => {
          throw new Error("not used in this test");
        },
        steerCodingAgent: () => {
          throw new Error("not used in this test");
        },
        cancelCodingAgent: () => {
          throw new Error("not used in this test");
        },
        getWorkflowRun: () => undefined,
        listWorkflowRuns: () => [],
      },
      access,
    );

    const result = await registry.invokeRaw("profile_list_launchable", { format: "json" });
    const currentRestricted = new profilesModule.ProfileService("restricted").getProfile("restricted");
    expect(result).toEqual({
      activeProfileId: "restricted",
      profiles: [
        {
          id: "restricted",
          name: "Restricted",
          roles: ["restricted"],
          memoryNamespace: "restricted",
          shellUser: "restricted",
          executionKind: "local",
          executionTarget: null,
          pathRoots: [],
          preferredProvider: "claude",
          defaultModelId: currentRestricted.defaultModelId,
          defaultThinkingLevel: "low",
          auth: {
            profileId: "restricted",
            codex: false,
            claude: false,
            any: false,
          },
          maxSubagentDepth: 1,
        },
      ],
      count: 1,
    });
  });

  test("updates a launchable profile default model through the dedicated tool", async () => {
    writeTestProfileRegistry();
    authStore.saveClaudeSetupToken("restricted-token", "restricted");

    const rootProfileService = new profilesModule.ProfileService("root");
    const root = rootProfileService.getActiveProfile();
    const projects = new projectsModule.ProjectsService(root, rootProfileService);
    const access = new accessModule.AccessControlService(root, rootProfileService, projects);
    const routines = new routinesModule.RoutinesService();
    const conversations = new conversationsModule.ConversationStore();
    const systemPrompts = new systemPromptsModule.SystemPromptService();
    const memory = new memoryModule.MemoryService(root, rootProfileService);
    const models = new modelsModule.ModelService(root);
    const fakeConnector = new ScriptedProviderConnector(() => new AIMessage("stub"), {
      providerId: "test",
    });
    const transitions = new transitionsModule.ConversationStateTransitionService(
      fakeConnector,
      conversations,
      memory,
      models,
      systemPrompts,
    );
    const registry = new toolRegistryModule.ToolRegistry(
      routines,
      projects,
      models,
      conversations,
      memory,
      systemPrompts,
      transitions,
      {
        launchCodingAgent: () =>
          ({
            id: "run-1",
            kind: "coding-agent",
            profileId: "root",
            goal: "goal",
            status: "queued",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            executionLog: [],
            taskReports: [],
          }),
        resumeCodingAgent: () => {
          throw new Error("not used in this test");
        },
        steerCodingAgent: () => {
          throw new Error("not used in this test");
        },
        cancelCodingAgent: () => {
          throw new Error("not used in this test");
        },
        getWorkflowRun: () => undefined,
        listWorkflowRuns: () => [],
      },
      access,
    );

    const originalResolveProviderModel = modelsModule.ModelService.prototype.resolveProviderModel;
    modelsModule.ModelService.prototype.resolveProviderModel = async function resolveProviderModel() {
      return {
        providerId: "claude",
        modelId: "claude-opus-4-6-20260301",
        name: "Claude Opus 4.6",
        supported: true,
        active: false,
      };
    };

    try {
      const result = await registry.invokeRaw("profile_set_defaults", {
        profileId: "restricted",
        modelId: "opus 4 6",
      });

      expect(result).toContain("Updated profile restricted.");
      expect(result).toContain('Resolved "opus 4 6" to claude-opus-4-6-20260301.');

      const updated = new profilesModule.ProfileService("root").getProfile("restricted");
      expect(updated.preferredProvider).toBe("claude");
      expect(updated.defaultModelId).toBe("claude-opus-4-6-20260301");
    } finally {
      modelsModule.ModelService.prototype.resolveProviderModel = originalResolveProviderModel;
    }
  });

  test("auto-detects the provider from a unique model alias when profile input omits provider", async () => {
    writeTestProfileRegistry();
    authStore.saveCodexCredentials({
      access: "root-codex-access",
      refresh: "root-codex-refresh",
      expires: Date.now() + 60_000,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, "root");
    authStore.saveClaudeSetupToken("root-claude-token", "root");

    const rootProfileService = new profilesModule.ProfileService("root");
    const root = rootProfileService.getActiveProfile();
    const projects = new projectsModule.ProjectsService(root, rootProfileService);
    const access = new accessModule.AccessControlService(root, rootProfileService, projects);
    const routines = new routinesModule.RoutinesService();
    const conversations = new conversationsModule.ConversationStore();
    const systemPrompts = new systemPromptsModule.SystemPromptService();
    const memory = new memoryModule.MemoryService(root, rootProfileService);
    const models = new modelsModule.ModelService(root);
    const fakeConnector = new ScriptedProviderConnector(() => new AIMessage("stub"), {
      providerId: "test",
    });
    const transitions = new transitionsModule.ConversationStateTransitionService(
      fakeConnector,
      conversations,
      memory,
      models,
      systemPrompts,
    );
    const registry = new toolRegistryModule.ToolRegistry(
      routines,
      projects,
      models,
      conversations,
      memory,
      systemPrompts,
      transitions,
      {
        launchCodingAgent: () =>
          ({
            id: "run-1",
            kind: "coding-agent",
            profileId: "root",
            goal: "goal",
            status: "queued",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            executionLog: [],
            taskReports: [],
          }),
        resumeCodingAgent: () => {
          throw new Error("not used in this test");
        },
        steerCodingAgent: () => {
          throw new Error("not used in this test");
        },
        cancelCodingAgent: () => {
          throw new Error("not used in this test");
        },
        getWorkflowRun: () => undefined,
        listWorkflowRuns: () => [],
      },
      access,
    );

    const originalResolveProviderModel = modelsModule.ModelService.prototype.resolveProviderModel;
    modelsModule.ModelService.prototype.resolveProviderModel = async function resolveProviderModel(providerId, requestedModelId) {
      if (providerId === "openai-codex") {
        throw new Error(`Model not found in the live catalog: ${requestedModelId}`);
      }

      return {
        providerId: "claude",
        modelId: "claude-opus-4-6-20260301",
        name: "Claude Opus 4.6",
        supported: true,
        active: false,
      };
    };

    try {
      const result = await registry.invokeRaw("profile_set_defaults", {
        profileId: "root",
        modelId: "opus",
      });

      expect(result).toContain("Updated profile root.");
      expect(result).toContain('Resolved "opus" to claude-opus-4-6-20260301.');

      const updated = new profilesModule.ProfileService("root").getProfile("root");
      expect(updated.preferredProvider).toBe("claude");
      expect(updated.defaultModelId).toBe("claude-opus-4-6-20260301");
    } finally {
      modelsModule.ModelService.prototype.resolveProviderModel = originalResolveProviderModel;
    }
  });

  test("updates launchable profile thinking defaults and syncs stored selections", async () => {
    writeTestProfileRegistry();
    authStore.saveClaudeSetupToken("restricted-token", "restricted");

    const rootProfileService = new profilesModule.ProfileService("root");
    const root = rootProfileService.getActiveProfile();
    const projects = new projectsModule.ProjectsService(root, rootProfileService);
    const access = new accessModule.AccessControlService(root, rootProfileService, projects);
    const routines = new routinesModule.RoutinesService();
    const conversations = new conversationsModule.ConversationStore();
    const systemPrompts = new systemPromptsModule.SystemPromptService();
    const memory = new memoryModule.MemoryService(root, rootProfileService);
    const models = new modelsModule.ModelService(root);
    const fakeConnector = new ScriptedProviderConnector(() => new AIMessage("stub"), {
      providerId: "test",
    });
    const transitions = new transitionsModule.ConversationStateTransitionService(
      fakeConnector,
      conversations,
      memory,
      models,
      systemPrompts,
    );
    const registry = new toolRegistryModule.ToolRegistry(
      routines,
      projects,
      models,
      conversations,
      memory,
      systemPrompts,
      transitions,
      {
        launchCodingAgent: () =>
          ({
            id: "run-1",
            kind: "coding-agent",
            profileId: "root",
            goal: "goal",
            status: "queued",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            executionLog: [],
            taskReports: [],
          }),
        resumeCodingAgent: () => {
          throw new Error("not used in this test");
        },
        steerCodingAgent: () => {
          throw new Error("not used in this test");
        },
        cancelCodingAgent: () => {
          throw new Error("not used in this test");
        },
        getWorkflowRun: () => undefined,
        listWorkflowRuns: () => [],
      },
      access,
    );

    const originalResolveProviderModel = modelsModule.ModelService.prototype.resolveProviderModel;
    modelsModule.ModelService.prototype.resolveProviderModel = async function resolveProviderModel() {
      return {
        providerId: "claude",
        modelId: "claude-opus-4-6-20260301",
        name: "Claude Opus 4.6",
        supported: true,
        active: false,
      };
    };

    try {
      const staleProfile = rootProfileService.getProfile("restricted");
      new modelsModule.ModelService(staleProfile, {
        selectionStoreKey: "restricted",
      }).setStoredSelectionDefaults({
        providerId: "openai-codex",
        modelId: "gpt-5.4",
        thinkingLevel: "minimal",
      });
      new modelsModule.ModelService(staleProfile, {
        selectionStoreKey: "restricted:subagent",
        defaultSelectionOverride: {
          providerId: staleProfile.subagentPreferredProvider ?? staleProfile.preferredProvider,
          modelId: staleProfile.subagentDefaultModelId ?? staleProfile.defaultModelId,
        },
      }).setStoredSelectionDefaults({
        providerId: "openai-codex",
        modelId: "gpt-5.4",
        thinkingLevel: "minimal",
      });

      const result = await registry.invokeRaw("profile_set_defaults", {
        profileId: "restricted",
        modelId: "opus 4 6",
        thinkingLevel: "high",
      });

      expect(result).toContain("Updated profile restricted.");
      expect(result).toContain("Default thinking level: high.");

      const updated = new profilesModule.ProfileService("root").getProfile("restricted");
      expect(updated.preferredProvider).toBe("claude");
      expect(updated.defaultModelId).toBe("claude-opus-4-6-20260301");
      expect(updated.defaultThinkingLevel).toBe("high");

      expect(new modelsModule.ModelService(updated, {
        selectionStoreKey: "restricted",
      }).getActiveModel()).toMatchObject({
        providerId: "claude",
        modelId: "claude-opus-4-6-20260301",
        thinkingLevel: "high",
      });

      expect(new modelsModule.ModelService(updated, {
        selectionStoreKey: "restricted:subagent",
        defaultSelectionOverride: {
          providerId: updated.subagentPreferredProvider ?? updated.preferredProvider,
          modelId: updated.subagentDefaultModelId ?? updated.defaultModelId,
        },
      }).getActiveModel()).toMatchObject({
        providerId: "claude",
        modelId: "claude-opus-4-6-20260301",
        thinkingLevel: "high",
      });
    } finally {
      modelsModule.ModelService.prototype.resolveProviderModel = originalResolveProviderModel;
    }
  });

  test("enforces tool and path restrictions for non-root profiles", () => {
    writeTestProjectRegistry();
    const profileService = new profilesModule.ProfileService("restricted");
    const restricted = profileService.getActiveProfile();
    const projects = new projectsModule.ProjectsService(restricted, profileService);
    const access = new accessModule.AccessControlService(restricted, profileService, projects);

    expect(access.canUseTool("project_list")).toBe(true);
    expect(access.canUseTool("exec_command")).toBe(true);
    expect(() =>
      access.assertPathAccess(path.join(tempRoot, ".openelinarotest/projects/telecorder/README.md"))
    ).not.toThrow();
    expect(() =>
      access.assertPathAccess(path.join(tempRoot, ".openelinarotest/projects/root-only/README.md"))
    ).toThrow(/not accessible|outside the allowed workspace roots/);
    expect(profileService.canReadMemoryPath(restricted, "restricted/note.md")).toBe(true);
    expect(profileService.canReadMemoryPath(restricted, "root/note.md")).toBe(false);
  });

  test("disables subagent launches when the current depth already meets the profile limit", () => {
    writeTestProfileRegistry();
    const profileService = new profilesModule.ProfileService("restricted");
    const restricted = profileService.getActiveProfile();
    const projects = new projectsModule.ProjectsService(restricted, profileService);
    const access = new accessModule.AccessControlService(restricted, profileService, projects);

    expect(profileService.getMaxSubagentDepth(restricted)).toBe(1);
    expect(access.listLaunchableProfiles(0).map((profile) => profile.id)).toEqual(["restricted"]);
    expect(access.listLaunchableProfiles(1)).toEqual([]);
  });

  test("requires auth declarations for all tools and exposes them in the catalog", () => {
    const profileService = new profilesModule.ProfileService("restricted");
    const restricted = profileService.getActiveProfile();
    const projects = new projectsModule.ProjectsService(restricted, profileService);
    const access = new accessModule.AccessControlService(restricted, profileService, projects);
    const routines = new routinesModule.RoutinesService();
    const conversations = new conversationsModule.ConversationStore();
    const systemPrompts = new systemPromptsModule.SystemPromptService();
    const memory = new memoryModule.MemoryService(restricted, profileService);
    const models = new modelsModule.ModelService(restricted);
    const fakeConnector = new ScriptedProviderConnector(() => new AIMessage("stub"), {
      providerId: "test",
    });
    const transitions = new transitionsModule.ConversationStateTransitionService(
      fakeConnector,
      conversations,
      memory,
      models,
      systemPrompts,
    );
    const registry = new toolRegistryModule.ToolRegistry(
      routines,
      projects,
      models,
      conversations,
      memory,
      systemPrompts,
      transitions,
      {
        launchCodingAgent: () =>
          ({
            id: "run-1",
            kind: "coding-agent",
            profileId: "restricted",
            goal: "goal",
            status: "queued",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            executionLog: [],
            taskReports: [],
          }),
        resumeCodingAgent: () => {
          throw new Error("not used in this test");
        },
        steerCodingAgent: () => {
          throw new Error("not used in this test");
        },
        cancelCodingAgent: () => {
          throw new Error("not used in this test");
        },
        getWorkflowRun: () => undefined,
        listWorkflowRuns: () => [],
      },
      access,
    );

    expect(() =>
      toolAuthModule.assertToolAuthorizationCoverage([
        ...toolRegistryModule.ROUTINE_TOOL_NAMES,
        "model_context_usage",
      ])
    ).not.toThrow();

    const catalog = registry.getToolCatalog();
    expect(catalog.every((card) => card.authorization.access === "anyone" || card.authorization.access === "root")).toBe(true);
    expect(catalog.some((card) => card.name === "exec_command")).toBe(true);
    expect(catalog.find((card) => card.name === "project_list")?.authorization.behavior).toBe("role-sensitive");
  });
});
