import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-ai";
import type { ProjectRecord } from "../domain/projects";
import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  type ProfileRecord,
  ProfileRegistrySchema,
} from "../domain/profiles";
import { getRuntimeConfig } from "../config/runtime-config";
import { resolveRuntimePath, resolveServicePath, resolveUserDataPath } from "./runtime-root";
import { SecretStoreService } from "./secret-store-service";
import { telemetry } from "./telemetry";
import { DEFAULT_PROFILE_ID } from "../config/service-constants";
const SHARED_PROFILE_TMP_ROOT = path.join("/tmp", "openelinaro-profile-tmp");
const PROFILE_SSH_SECRET_PREFIX = "profile_ssh_keypair";

function getProfileRegistryPath() {
  return resolveUserDataPath("profiles/registry.json");
}

function getLegacyProfileKeysRoot() {
  return resolveUserDataPath("profiles/keys");
}

function getProfileSshSecretName(profileId: string) {
  return `${PROFILE_SSH_SECRET_PREFIX}_${profileId}`;
}

function getBundledProfileRegistryPath() {
  return resolveServicePath("profiles/registry.json");
}

function ensureUserProfileRegistry() {
  const targetPath = getProfileRegistryPath();
  if (fs.existsSync(targetPath)) {
    return targetPath;
  }

  const bundledPath = getBundledProfileRegistryPath();
  if (!fs.existsSync(bundledPath)) {
    throw new Error(`Bundled profile registry is missing: ${bundledPath}`);
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(bundledPath, targetPath);
  return targetPath;
}

function normalizeProfileId(value?: string) {
  const normalized = value?.trim();
  return normalized || DEFAULT_PROFILE_ID;
}

function ensureSharedProfileTempDirectory(profileId: string) {
  const root = SHARED_PROFILE_TMP_ROOT;
  const profileDir = path.join(root, profileId);
  fs.mkdirSync(root, { recursive: true, mode: 0o1777 });
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o1777 });
  fs.chmodSync(root, 0o1777);
  fs.chmodSync(profileDir, 0o1777);
  return profileDir;
}

export class ProfileService {
  private readonly activeProfileId: string;
  private readonly secrets = new SecretStoreService();

  constructor(activeProfileId?: string) {
    this.activeProfileId = normalizeProfileId(activeProfileId ?? getRuntimeConfig().core.profile.activeProfileId);
  }

  loadRegistry() {
    const raw = fs.readFileSync(ensureUserProfileRegistry(), "utf8");
    return ProfileRegistrySchema.parse(JSON.parse(raw));
  }

  saveRegistry(registry: ReturnType<ProfileService["loadRegistry"]>) {
    const validated = ProfileRegistrySchema.parse(registry);
    fs.mkdirSync(path.dirname(getProfileRegistryPath()), { recursive: true });
    fs.writeFileSync(getProfileRegistryPath(), `${JSON.stringify(validated, null, 2)}\n`);
    telemetry.event("profile.registry_saved", {
      entityType: "profile_registry",
      entityId: "default",
      profileCount: validated.profiles.length,
    });
  }

  getProfile(profileId: string): ProfileRecord {
    const profile = this.loadRegistry().profiles.find((entry) => entry.id === profileId);
    if (!profile) {
      throw new Error(`Unknown profile: ${profileId}`);
    }
    return profile;
  }

  getActiveProfile(): ProfileRecord {
    return this.getProfile(this.activeProfileId);
  }

  getLegacyProfileKeyDirectory(profile: Pick<ProfileRecord, "id"> | string) {
    const profileId = typeof profile === "string" ? profile : profile.id;
    return path.join(getLegacyProfileKeysRoot(), profileId);
  }

  getProfileKeyDirectory(profile: Pick<ProfileRecord, "id"> | string) {
    const profileId = typeof profile === "string" ? profile : profile.id;
    return resolveRuntimePath("runtime-ssh-keys", profileId);
  }

  getProfileSshPrivateKeyPath(profile: Pick<ProfileRecord, "id"> | string) {
    return path.join(this.getProfileKeyDirectory(profile), "id_ed25519");
  }

  getProfileSshPublicKeyPath(profile: Pick<ProfileRecord, "id"> | string) {
    return `${this.getProfileSshPrivateKeyPath(profile)}.pub`;
  }

  private loadStoredProfileSshKeyPair(profileId: string) {
    const secretName = getProfileSshSecretName(profileId);
    try {
      return {
        privateKey: this.secrets.resolveSecretRef(`${secretName}.privateKey`, profileId),
        publicKey: this.secrets.resolveSecretRef(`${secretName}.publicKey`, profileId),
        migrated: false,
        generated: false,
      };
    } catch {
      return null;
    }
  }

  private loadLegacyProfileSshKeyPair(profileId: string) {
    const privateKeyPath = path.join(this.getLegacyProfileKeyDirectory(profileId), "id_ed25519");
    const publicKeyPath = `${privateKeyPath}.pub`;
    if (!fs.existsSync(privateKeyPath) || !fs.existsSync(publicKeyPath)) {
      return null;
    }
    return {
      privateKey: fs.readFileSync(privateKeyPath, "utf8"),
      publicKey: fs.readFileSync(publicKeyPath, "utf8"),
      migrated: true,
      generated: false,
    };
  }

  private generateProfileSshKeyPair(profileId: string) {
    const tmpRoot = fs.mkdtempSync(path.join(ensureSharedProfileTempDirectory(profileId), "ssh-keygen-"));
    const privateKeyPath = path.join(tmpRoot, "id_ed25519");
    execFileSync("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-f",
      privateKeyPath,
      "-N",
      "",
      "-C",
      `openelinaro-${profileId}`,
    ]);
    const publicKeyPath = `${privateKeyPath}.pub`;
    const keyPair = {
      privateKey: fs.readFileSync(privateKeyPath, "utf8"),
      publicKey: fs.readFileSync(publicKeyPath, "utf8"),
      migrated: false,
      generated: true,
    };
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    return keyPair;
  }

  private ensureStoredProfileSshKeyPair(profileId: string) {
    const existing = this.loadStoredProfileSshKeyPair(profileId);
    if (existing) {
      return existing;
    }

    const next = this.loadLegacyProfileSshKeyPair(profileId) ?? this.generateProfileSshKeyPair(profileId);
    this.secrets.saveSecret({
      name: getProfileSshSecretName(profileId),
      kind: "generic",
      profileId,
      fields: {
        privateKey: next.privateKey,
        publicKey: next.publicKey,
      },
    });
    if (next.migrated) {
      fs.rmSync(this.getLegacyProfileKeyDirectory(profileId), { recursive: true, force: true });
      telemetry.event("profile.ssh_keypair_migrated", {
        profileId,
        entityType: "profile_ssh_keypair",
        entityId: profileId,
      });
    } else if (next.generated) {
      telemetry.event("profile.ssh_keypair_generated", {
        profileId,
        entityType: "profile_ssh_keypair",
        entityId: profileId,
      });
    }
    return next;
  }

  ensureProfileSshKeyPair(profile: Pick<ProfileRecord, "id"> | string) {
    const profileId = typeof profile === "string" ? profile : profile.id;
    const keyPair = this.ensureStoredProfileSshKeyPair(profileId);
    const privateKeyPath = this.getProfileSshPrivateKeyPath(profileId);
    const publicKeyPath = this.getProfileSshPublicKeyPath(profileId);
    fs.mkdirSync(this.getProfileKeyDirectory(profileId), { recursive: true, mode: 0o700 });
    fs.writeFileSync(privateKeyPath, keyPair.privateKey, { mode: 0o600 });
    fs.writeFileSync(publicKeyPath, keyPair.publicKey, { mode: 0o644 });
    fs.chmodSync(privateKeyPath, 0o600);
    fs.chmodSync(publicKeyPath, 0o644);
    return {
      privateKeyPath,
      publicKeyPath,
      generated: keyPair.generated,
      migrated: keyPair.migrated,
    };
  }

  buildProfileShellEnvironment(profile: ProfileRecord) {
    const { privateKeyPath, publicKeyPath } = this.ensureProfileSshKeyPair(profile);
    const shellUser = this.getShellUser(profile);
    const sharedTmpDir = ensureSharedProfileTempDirectory(profile.id);
    const execution = this.getExecution(profile);
    return {
      GIT_SSH_COMMAND: `ssh -i ${privateKeyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
      OPENELINARO_PROFILE_ID: profile.id,
      OPENELINARO_PROFILE_EXECUTION_KIND: execution?.kind ?? "local",
      TMPDIR: sharedTmpDir,
      TMP: sharedTmpDir,
      TEMP: sharedTmpDir,
      ...(shellUser ? { OPENELINARO_PROFILE_SHELL_USER: shellUser } : {}),
      ...(execution?.kind === "ssh"
        ? {
            OPENELINARO_PROFILE_SSH_HOST: execution.host,
            OPENELINARO_PROFILE_SSH_USER: execution.user,
            ...(execution.port ? { OPENELINARO_PROFILE_SSH_PORT: String(execution.port) } : {}),
            ...(execution.defaultCwd
              ? { OPENELINARO_PROFILE_DEFAULT_CWD: execution.defaultCwd }
              : {}),
          }
        : {}),
      ...(profile.pathRoots?.length
        ? { OPENELINARO_PROFILE_PATH_ROOTS: profile.pathRoots.join(":") }
        : {}),
      OPENELINARO_PROFILE_MAX_SUBAGENT_DEPTH: String(this.getMaxSubagentDepth(profile)),
    };
  }

  listProfiles() {
    return this.loadRegistry().profiles;
  }

  updateProfile(profileId: string, updater: (profile: ProfileRecord) => ProfileRecord) {
    const registry = this.loadRegistry();
    const index = registry.profiles.findIndex((entry) => entry.id === profileId);
    if (index < 0) {
      throw new Error(`Unknown profile: ${profileId}`);
    }

    const current = registry.profiles[index];
    if (!current) {
      throw new Error(`Unknown profile: ${profileId}`);
    }
    const next = updater(current);
    registry.profiles[index] = next;
    this.saveRegistry(registry);
    telemetry.event("profile.updated", {
      profileId: next.id,
      entityType: "profile",
      entityId: next.id,
    });
    return next;
  }

  setProfileDefaultModel(profileId: string, params: {
    defaultModelId: string;
    preferredProvider?: ProfileRecord["preferredProvider"];
  }) {
    return this.updateProfile(profileId, (profile) => ({
      ...profile,
      preferredProvider: params.preferredProvider ?? profile.preferredProvider,
      defaultModelId: params.defaultModelId,
    }));
  }

  setProfileDefaults(profileId: string, params: {
    preferredProvider?: ProfileRecord["preferredProvider"];
    defaultModelId?: string;
    defaultThinkingLevel?: ThinkingLevel;
  }) {
    return this.updateProfile(profileId, (profile) => ({
      ...profile,
      preferredProvider: params.preferredProvider ?? profile.preferredProvider,
      defaultModelId: params.defaultModelId ?? profile.defaultModelId,
      defaultThinkingLevel: params.defaultThinkingLevel ?? profile.defaultThinkingLevel,
    }));
  }

  getShellUser(profile: Pick<ProfileRecord, "shellUser">) {
    const value = profile.shellUser?.trim();
    return value || undefined;
  }

  getExecution(profile: Pick<ProfileRecord, "execution">) {
    return profile.execution;
  }

  isSshExecutionProfile(profile: Pick<ProfileRecord, "execution">) {
    return profile.execution?.kind === "ssh";
  }

  getPathRoots(profile: Pick<ProfileRecord, "pathRoots" | "execution">) {
    const roots = profile.pathRoots?.map((entry) => entry.trim()).filter(Boolean) ?? [];
    if (roots.length > 0) {
      return roots;
    }
    if (profile.execution?.kind === "ssh" && profile.execution.defaultCwd?.trim()) {
      return [profile.execution.defaultCwd.trim()];
    }
    return [];
  }

  getDefaultToolCwd(profile: Pick<ProfileRecord, "execution" | "pathRoots">) {
    if (profile.execution?.kind === "ssh") {
      return profile.execution.defaultCwd?.trim() || this.getPathRoots(profile)[0];
    }
    return process.cwd();
  }

  canUseShellTools(profile: ProfileRecord) {
    return this.isRootProfile(profile) || Boolean(this.getShellUser(profile)) || this.isSshExecutionProfile(profile);
  }

  getMaxSubagentDepth(profile: Pick<ProfileRecord, "maxSubagentDepth">) {
    return profile.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
  }

  canLaunchSubagents(profile: ProfileRecord, currentDepth = 0) {
    return currentDepth < this.getMaxSubagentDepth(profile);
  }

  getSubagentBinaryPath(profile: Pick<ProfileRecord, "subagentPaths">, provider: "claude" | "codex"): string | undefined {
    return profile.subagentPaths?.[provider];
  }

  resolveSubagentProvider(profile: ProfileRecord): "claude" | "codex" {
    if (profile.subagentPreferredProvider === "claude" && profile.subagentPaths?.claude) return "claude";
    if (profile.subagentPreferredProvider === "openai-codex" && profile.subagentPaths?.codex) return "codex";
    if (profile.subagentPaths?.claude) return "claude";
    if (profile.subagentPaths?.codex) return "codex";
    throw new Error(`No subagent binary configured for profile ${profile.id}. Set subagentPaths in the profile registry.`);
  }

  listLaunchableProfiles(source: ProfileRecord, currentDepth = 0) {
    if (!this.canLaunchSubagents(source, currentDepth)) {
      return [];
    }
    return this.listProfiles().filter((target) => this.canSpawnProfile(source, target));
  }

  isRootProfile(profile: Pick<ProfileRecord, "roles">) {
    return profile.roles.includes("root");
  }

  canAccessProject(profile: Pick<ProfileRecord, "roles">, project: Pick<ProjectRecord, "allowedRoles">) {
    if (this.isRootProfile(profile)) {
      return true;
    }
    return project.allowedRoles.some((role) => profile.roles.includes(role));
  }

  filterProjects(profile: Pick<ProfileRecord, "roles">, projects: ProjectRecord[]) {
    if (this.isRootProfile(profile)) {
      return projects;
    }
    return projects.filter((project) => this.canAccessProject(profile, project));
  }

  getAccessibleMemoryNamespaces(profile: ProfileRecord) {
    if (this.isRootProfile(profile)) {
      return null;
    }
    return Array.from(new Set(profile.roles));
  }

  getWriteMemoryNamespace(profile: ProfileRecord) {
    if (this.isRootProfile(profile)) {
      return profile.memoryNamespace;
    }
    return profile.memoryNamespace;
  }

  canReadMemoryPath(profile: ProfileRecord, relativePath: string) {
    const namespaces = this.getAccessibleMemoryNamespaces(profile);
    if (!namespaces) {
      return true;
    }
    return namespaces.some((namespace) =>
      relativePath === namespace || relativePath.startsWith(`${namespace}/`)
    );
  }

  canSpawnProfile(source: ProfileRecord, target: ProfileRecord) {
    if (this.isRootProfile(source)) {
      return true;
    }
    return target.roles.every((role) => source.roles.includes(role));
  }

  assertCanSpawnProfile(source: ProfileRecord, target: ProfileRecord) {
    if (this.canSpawnProfile(source, target)) {
      return;
    }
    throw new Error(
      `Profile ${source.id} with roles [${source.roles.join(", ")}] cannot launch profile ${target.id} with roles [${target.roles.join(", ")}].`,
    );
  }

  buildAssistantContext(profile: ProfileRecord) {
    const root = this.isRootProfile(profile);
    const privateKeyPath = this.getProfileSshPrivateKeyPath(profile);
    const publicKeyPath = this.getProfileSshPublicKeyPath(profile);
    const execution = this.getExecution(profile);
    return [
      `Profile: ${profile.id}`,
      `Roles: ${profile.roles.join(", ")}`,
      root
        ? "Permissions: root profile, unrestricted. Skip role/project/memory checks."
        : `Permissions: project access limited to allowedRoles matching [${profile.roles.join(", ")}]; memory access limited to namespaces [${this.getAccessibleMemoryNamespaces(profile)?.join(", ") ?? ""}].`,
      execution?.kind === "ssh"
        ? `Execution backend: ssh ${execution.user}@${execution.host}${execution.port ? `:${execution.port}` : ""}${execution.defaultCwd ? ` cwd=${execution.defaultCwd}` : ""}`
        : "Execution backend: local",
      this.getShellUser(profile)
        ? `Shell user: ${this.getShellUser(profile)}`
        : this.isSshExecutionProfile(profile)
          ? "Shell user: remote login user"
          : root
            ? "Shell user: current process user"
            : "Shell user: unavailable",
      this.getPathRoots(profile).length > 0
        ? `Allowed path roots: ${this.getPathRoots(profile).join(", ")}`
        : "",
      `Max subagent depth: ${this.getMaxSubagentDepth(profile)}`,
      `SSH key material: secret-store-backed; runtime paths ${privateKeyPath} | ${publicKeyPath}`,
      profile.preferredProvider ? `Preferred model provider: ${profile.preferredProvider}` : "",
      profile.defaultModelId ? `Default model: ${profile.defaultModelId}` : "",
      profile.toolSummarizerProvider ? `Tool summarizer provider: ${profile.toolSummarizerProvider}` : "",
      profile.toolSummarizerModelId ? `Tool summarizer model: ${profile.toolSummarizerModelId}` : "",
      profile.memoryProvider ? `Memory provider: ${profile.memoryProvider}` : "",
      profile.memoryModelId ? `Memory model: ${profile.memoryModelId}` : "",
      profile.defaultThinkingLevel ? `Default thinking level: ${profile.defaultThinkingLevel}` : "",
      profile.maxContextTokens ? `Artificial max context window: ${profile.maxContextTokens}` : "",
      profile.subagentPreferredProvider
        ? `Subagent preferred model provider: ${profile.subagentPreferredProvider}`
        : "",
      profile.subagentDefaultModelId ? `Subagent default model: ${profile.subagentDefaultModelId}` : "",
      profile.subagentPaths?.claude ? `Subagent Claude binary: ${profile.subagentPaths.claude}` : "",
      profile.subagentPaths?.codex ? `Subagent Codex binary: ${profile.subagentPaths.codex}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
}

export function getDefaultProfileId() {
  return DEFAULT_PROFILE_ID;
}
