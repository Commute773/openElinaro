import fs from "node:fs";
import path from "node:path";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import { getDefaultProfileId } from "../services/profile-service";
import { resolveRuntimePath } from "../services/runtime-root";
import { type ProviderAuthSecret, SecretStoreService } from "../services/secret-store-service";
import { telemetry } from "../services/telemetry";
import { timestamp } from "../utils/timestamp";

export type ProviderId = "openai-codex" | "claude";

export type ProviderAuthStatus = {
  profileId: string;
  codex: boolean;
  claude: boolean;
  any: boolean;
};

type CodexCredential = Extract<ProviderAuthSecret, { provider: "openai-codex" }>;
type ClaudeCredential = Extract<ProviderAuthSecret, { provider: "claude" }>;

type LegacyAuthStoreShape = {
  version?: number;
  providers?: Partial<{
    "openai-codex": CodexCredential;
    claude: ClaudeCredential;
  }>;
  profiles?: Record<
    string,
    {
      providers: Partial<{
        "openai-codex": CodexCredential;
        claude: ClaudeCredential;
      }>;
    }
  >;
};

const secrets = new SecretStoreService();

function getLegacyAuthStorePath() {
  return resolveRuntimePath("auth-store.json");
}

function assertAuthStoreWritesAreIsolated() {
  if (process.env.NODE_ENV === "test" && !process.env.OPENELINARO_ROOT_DIR?.trim()) {
    throw new Error(
      "Auth store writes are blocked during tests unless OPENELINARO_ROOT_DIR is set to an isolated root.",
    );
  }
}

function readLegacyStore(): LegacyAuthStoreShape | null {
  const authStorePath = getLegacyAuthStorePath();
  if (!fs.existsSync(authStorePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(authStorePath, "utf8")) as LegacyAuthStoreShape;
}

function getLegacyProfileProviders(store: LegacyAuthStoreShape, profileId: string) {
  if (store.profiles) {
    return store.profiles[profileId]?.providers ?? {};
  }

  return profileId === getDefaultProfileId()
    ? store.providers ?? {}
    : {};
}

function migrateLegacyProfileIfNeeded(profileId: string) {
  const legacyStore = readLegacyStore();
  if (!legacyStore) {
    return;
  }

  const providers = getLegacyProfileProviders(legacyStore, profileId);
  let migrated = false;

  const legacyCodex = providers["openai-codex"];
  if (
    legacyCodex &&
    typeof legacyCodex.credentials?.access === "string" &&
    legacyCodex.credentials.access.trim().length > 0 &&
    !secrets.getProviderAuth("openai-codex", profileId)
  ) {
    secrets.saveProviderAuth({
      provider: "openai-codex",
      type: "oauth",
      credentials: legacyCodex.credentials,
      updatedAt: legacyCodex.updatedAt ?? timestamp(),
    }, profileId);
    migrated = true;
  }

  const legacyClaude = providers.claude;
  if (
    legacyClaude &&
    typeof legacyClaude.token === "string" &&
    legacyClaude.token.trim().length > 0 &&
    !secrets.getProviderAuth("claude", profileId)
  ) {
    secrets.saveProviderAuth({
      provider: "claude",
      type: "token",
      token: legacyClaude.token,
      updatedAt: legacyClaude.updatedAt ?? timestamp(),
    }, profileId);
    migrated = true;
  }

  if (!migrated) {
    return;
  }

  assertAuthStoreWritesAreIsolated();
  fs.rmSync(getLegacyAuthStorePath(), { force: true });
  telemetry.event("auth.legacy_store_migrated", {
    profileId,
    entityType: "auth_credentials",
    entityId: profileId,
  });
}

function hasUsableCodexCredentials(value: CodexCredential | null | undefined) {
  return Boolean(
    value?.credentials &&
      typeof (value.credentials as OAuthCredentials).access === "string" &&
      (value.credentials as OAuthCredentials).access.trim().length > 0,
  );
}

function hasUsableClaudeToken(value: ClaudeCredential | null | undefined) {
  return Boolean(typeof value?.token === "string" && value.token.trim().length > 0);
}

function getStoredCodexCredential(profileId: string) {
  migrateLegacyProfileIfNeeded(profileId);
  const value = secrets.getProviderAuth("openai-codex", profileId);
  return value?.provider === "openai-codex" ? value : null;
}

function getStoredClaudeCredential(profileId: string) {
  migrateLegacyProfileIfNeeded(profileId);
  const value = secrets.getProviderAuth("claude", profileId);
  return value?.provider === "claude" ? value : null;
}

export function getCodexCredentials(profileId = getDefaultProfileId()): OAuthCredentials | null {
  return (getStoredCodexCredential(profileId)?.credentials as OAuthCredentials | undefined) ?? null;
}

export function saveCodexCredentials(
  credentials: OAuthCredentials,
  profileId = getDefaultProfileId(),
) {
  secrets.saveProviderAuth({
    provider: "openai-codex",
    type: "oauth",
    credentials,
    updatedAt: timestamp(),
  }, profileId);
  telemetry.event("auth.codex_credentials_saved", {
    profileId,
    provider: "openai-codex",
    entityType: "auth_credentials",
    entityId: profileId,
  });
}

export function saveClaudeSetupToken(token: string, profileId = getDefaultProfileId()) {
  secrets.saveProviderAuth({
    provider: "claude",
    type: "token",
    token,
    updatedAt: timestamp(),
  }, profileId);
  telemetry.event("auth.claude_token_saved", {
    profileId,
    provider: "claude",
    entityType: "auth_credentials",
    entityId: profileId,
  });
}

export function getClaudeSetupToken(profileId = getDefaultProfileId()): string | null {
  return getStoredClaudeCredential(profileId)?.token ?? null;
}

export function hasProviderAuth(provider: ProviderId, profileId = getDefaultProfileId()): boolean {
  return provider === "openai-codex"
    ? hasUsableCodexCredentials(getStoredCodexCredential(profileId))
    : hasUsableClaudeToken(getStoredClaudeCredential(profileId));
}

export function hasAnyProviderAuth(profileId = getDefaultProfileId()): boolean {
  return hasUsableCodexCredentials(getStoredCodexCredential(profileId))
    || hasUsableClaudeToken(getStoredClaudeCredential(profileId));
}

export function getAuthStatus(profileId = getDefaultProfileId()): ProviderAuthStatus {
  const codex = hasUsableCodexCredentials(getStoredCodexCredential(profileId));
  const claude = hasUsableClaudeToken(getStoredClaudeCredential(profileId));
  return {
    profileId,
    codex,
    claude,
    any: codex || claude,
  };
}

export function getAuthStatusLines(profileId = getDefaultProfileId()): string[] {
  const status = getAuthStatus(profileId);
  return [
    `profile: ${status.profileId}`,
    `codex: ${status.codex ? "configured" : "missing"}`,
    `claude: ${status.claude ? "configured" : "missing"}`,
  ];
}
