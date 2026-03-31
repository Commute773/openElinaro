import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { ConfigurationError, NotFoundError } from "../../domain/errors";
import type { ThinkingLevel } from "../../messages/types";
import type { ProfileRecord, ProfileRegistry } from "../../domain/profiles";
import { ProfileRegistrySchema } from "../../domain/profiles";
import { getRuntimeConfig } from "../../config/runtime-config";
import { resolveRuntimePath, resolveServicePath, resolveUserDataPath } from "../runtime-root";
import { SecretStoreService } from "../infrastructure/secret-store-service";
import { telemetry } from "../infrastructure/telemetry";
import { DEFAULT_PROFILE_ID } from "../../config/service-constants";
import { attemptOr } from "../../utils/result";

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
  if (existsSync(targetPath)) {
    return targetPath;
  }

  const bundledPath = getBundledProfileRegistryPath();
  if (!existsSync(bundledPath)) {
    throw new NotFoundError("Bundled profile registry", bundledPath);
  }

  mkdirSync(path.dirname(targetPath), { recursive: true });
  copyFileSync(bundledPath, targetPath);
  return targetPath;
}

function normalizeProfileId(value?: string) {
  const normalized = value?.trim();
  return normalized || DEFAULT_PROFILE_ID;
}

function ensureSharedProfileTempDirectory(profileId: string) {
  const root = SHARED_PROFILE_TMP_ROOT;
  const profileDir = path.join(root, profileId);
  mkdirSync(root, { recursive: true, mode: 0o1777 });
  mkdirSync(profileDir, { recursive: true, mode: 0o1777 });
  chmodSync(root, 0o1777);
  chmodSync(profileDir, 0o1777);
  return profileDir;
}

/**
 * Single-profile service. Each OpenElinaro install is one identity.
 * The profile registry still exists on disk for backwards compatibility
 * but only the active profile is used.
 */
export class ProfileService {
  private readonly activeProfileId: string;
  private readonly secrets: SecretStoreService;

  constructor(activeProfileId?: string, secrets?: SecretStoreService) {
    this.activeProfileId = normalizeProfileId(activeProfileId ?? getRuntimeConfig().core.profile.activeProfileId);
    this.secrets = secrets ?? new SecretStoreService();
  }

  loadRegistry(): ProfileRegistry {
    const raw = readFileSync(ensureUserProfileRegistry(), "utf8");
    return ProfileRegistrySchema.parse(JSON.parse(raw));
  }

  saveRegistry(registry: ProfileRegistry) {
    const validated = ProfileRegistrySchema.parse(registry);
    mkdirSync(path.dirname(getProfileRegistryPath()), { recursive: true });
    writeFileSync(getProfileRegistryPath(), `${JSON.stringify(validated, null, 2)}\n`);
    telemetry.event("profile.registry_saved", {
      entityType: "profile_registry",
      entityId: "default",
      profileCount: validated.profiles.length,
    });
  }

  getProfile(profileId: string): ProfileRecord {
    const profile = this.loadRegistry().profiles.find((entry) => entry.id === profileId);
    if (!profile) {
      throw new NotFoundError("Profile", profileId);
    }
    return profile;
  }

  getActiveProfile(): ProfileRecord {
    return this.getProfile(this.activeProfileId);
  }

  updateProfile(profileId: string, updater: (profile: ProfileRecord) => ProfileRecord) {
    const registry = this.loadRegistry();
    const index = registry.profiles.findIndex((entry) => entry.id === profileId);
    if (index < 0) {
      throw new NotFoundError("Profile", profileId);
    }

    const current = registry.profiles[index];
    if (!current) {
      throw new NotFoundError("Profile", profileId);
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

  // ---------------------------------------------------------------------------
  // SSH key management
  // ---------------------------------------------------------------------------

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
    return attemptOr(
      () => ({
        privateKey: this.secrets.resolveSecretRef(`${secretName}.privateKey`, profileId),
        publicKey: this.secrets.resolveSecretRef(`${secretName}.publicKey`, profileId),
        migrated: false,
        generated: false,
      }),
      null,
    );
  }

  private loadLegacyProfileSshKeyPair(profileId: string) {
    const privateKeyPath = path.join(this.getLegacyProfileKeyDirectory(profileId), "id_ed25519");
    const publicKeyPath = `${privateKeyPath}.pub`;
    if (!existsSync(privateKeyPath) || !existsSync(publicKeyPath)) {
      return null;
    }
    return {
      privateKey: readFileSync(privateKeyPath, "utf8"),
      publicKey: readFileSync(publicKeyPath, "utf8"),
      migrated: true,
      generated: false,
    };
  }

  private generateProfileSshKeyPair(profileId: string) {
    const tmpRoot = mkdtempSync(path.join(ensureSharedProfileTempDirectory(profileId), "ssh-keygen-"));
    const privateKeyPath = path.join(tmpRoot, "id_ed25519");
    execFileSync("ssh-keygen", [
      "-q", "-t", "ed25519", "-f", privateKeyPath, "-N", "", "-C", `openelinaro-${profileId}`,
    ]);
    const publicKeyPath = `${privateKeyPath}.pub`;
    const keyPair = {
      privateKey: readFileSync(privateKeyPath, "utf8"),
      publicKey: readFileSync(publicKeyPath, "utf8"),
      migrated: false,
      generated: true,
    };
    rmSync(tmpRoot, { recursive: true, force: true });
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
      rmSync(this.getLegacyProfileKeyDirectory(profileId), { recursive: true, force: true });
      telemetry.event("profile.ssh_keypair_migrated", { profileId, entityType: "profile_ssh_keypair", entityId: profileId });
    } else if (next.generated) {
      telemetry.event("profile.ssh_keypair_generated", { profileId, entityType: "profile_ssh_keypair", entityId: profileId });
    }
    return next;
  }

  ensureProfileSshKeyPair(profile: Pick<ProfileRecord, "id"> | string) {
    const profileId = typeof profile === "string" ? profile : profile.id;
    const keyPair = this.ensureStoredProfileSshKeyPair(profileId);
    const privateKeyPath = this.getProfileSshPrivateKeyPath(profileId);
    const publicKeyPath = this.getProfileSshPublicKeyPath(profileId);
    mkdirSync(this.getProfileKeyDirectory(profileId), { recursive: true, mode: 0o700 });
    writeFileSync(privateKeyPath, keyPair.privateKey, { mode: 0o600 });
    writeFileSync(publicKeyPath, keyPair.publicKey, { mode: 0o644 });
    chmodSync(privateKeyPath, 0o600);
    chmodSync(publicKeyPath, 0o644);
    return { privateKeyPath, publicKeyPath, generated: keyPair.generated, migrated: keyPair.migrated };
  }

  // ---------------------------------------------------------------------------
  // Shell / execution environment
  // ---------------------------------------------------------------------------

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
            ...(execution.defaultCwd ? { OPENELINARO_PROFILE_DEFAULT_CWD: execution.defaultCwd } : {}),
          }
        : {}),
      ...(profile.pathRoots?.length
        ? { OPENELINARO_PROFILE_PATH_ROOTS: profile.pathRoots.join(":") }
        : {}),
    };
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

  getWriteMemoryNamespace(profile: ProfileRecord) {
    return profile.memoryNamespace;
  }

  buildAssistantContext(profile: ProfileRecord) {
    const execution = this.getExecution(profile);
    return [
      `Profile: ${profile.id}`,
      execution?.kind === "ssh"
        ? `Execution backend: ssh ${execution.user}@${execution.host}${execution.port ? `:${execution.port}` : ""}${execution.defaultCwd ? ` cwd=${execution.defaultCwd}` : ""}`
        : "Execution backend: local",
      this.getShellUser(profile) ? `Shell user: ${this.getShellUser(profile)}` : "",
      this.getPathRoots(profile).length > 0
        ? `Allowed path roots: ${this.getPathRoots(profile).join(", ")}`
        : "",
      `SSH key material: secret-store-backed; runtime paths ${this.getProfileSshPrivateKeyPath(profile)} | ${this.getProfileSshPublicKeyPath(profile)}`,
      profile.preferredProvider ? `Preferred model provider: ${profile.preferredProvider}` : "",
      profile.defaultModelId ? `Default model: ${profile.defaultModelId}` : "",
      profile.defaultThinkingLevel ? `Default thinking level: ${profile.defaultThinkingLevel}` : "",
      profile.maxContextTokens ? `Artificial max context window: ${profile.maxContextTokens}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
}

export function getDefaultProfileId() {
  return DEFAULT_PROFILE_ID;
}
