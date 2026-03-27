// TODO: Migrate from node:fs to Bun.file() per CLAUDE.md conventions.
// Kept as node:fs because SecretStoreService methods are called synchronously
// from auth, profile, CLI, bot startup, and feature-config callers across 20+ files.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getLocalEnv } from "../config/local-env";
import { assertTestRuntimeRootIsIsolated, resolveRuntimePath } from "./runtime-root";
import { telemetry } from "./telemetry";
import { DEFAULT_PROFILE_ID as DEFAULT_SECRET_STORE_PROFILE_ID } from "../config/service-constants";
import { timestamp as nowIso } from "../utils/timestamp";

export const SECRET_STORE_KINDS = ["generic", "payment_card", "password"] as const;
export type SecretStoreKind = (typeof SECRET_STORE_KINDS)[number];

export type SecretStoreListEntry = {
  name: string;
  kind: SecretStoreKind;
  fields: string[];
  updatedAt: string;
};

export type SecretStoreStatus = {
  configured: boolean;
  profileId: string;
  storePath: string;
  secretCount: number;
  keySource: "internal";
};

export type ProviderAuthSecret =
  | {
      provider: "openai-codex";
      type: "oauth";
      credentials: Record<string, unknown>;
      updatedAt: string;
    }
  | {
      provider: "claude";
      type: "token";
      token: string;
      updatedAt: string;
    };

type LegacySecretEnvelope = {
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  ciphertext: string;
};

type LegacySecretStoreEntry = {
  kind: SecretStoreKind;
  fields: string[];
  updatedAt: string;
  envelope: LegacySecretEnvelope;
};

type PlainSecretStoreEntry = {
  kind: SecretStoreKind;
  fields: Record<string, string>;
  updatedAt: string;
};

type SecretStoreEntry = PlainSecretStoreEntry | LegacySecretStoreEntry;

type SecretStoreShape = {
  version: 2;
  profiles: Record<
    string,
    {
      secrets: Record<string, SecretStoreEntry>;
      auth: Partial<Record<ProviderAuthSecret["provider"], ProviderAuthSecret>>;
    }
  >;
};

const SECRET_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SECRET_FIELD_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const MAX_SECRET_FIELDS = 64;
const MAX_SECRET_VALUE_LENGTH = 4_096;
const SECRET_STORE_SALT = "openelinaro-secret-store-v1";
const DEFAULT_PASSWORD_LENGTH = 24;
const PASSWORD_CHARSETS = {
  lowercase: "abcdefghijkmnopqrstuvwxyz",
  uppercase: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digits: "23456789",
  symbols: "!@#$%^&*()-_=+[]{}:,.?",
} as const;

export class MissingLegacySecretStoreKeyError extends Error {
  readonly code = "SECRET_STORE_KEY_MISSING";

  constructor() {
    super(
      "A legacy encrypted secret store was found. Set OPENELINARO_SECRET_KEY or OPENELINARO_SECRET_KEY_FILE once to migrate it into the unified secret store.",
    );
    this.name = "MissingLegacySecretStoreKeyError";
  }
}

export class MissingSecretStoreKeyError extends MissingLegacySecretStoreKeyError {}


function getSecretStorePath() {
  return resolveRuntimePath("secret-store.json");
}

function ensureStoreDir() {
  fs.mkdirSync(path.dirname(getSecretStorePath()), { recursive: true });
}

function emptyStore(): SecretStoreShape {
  return {
    version: 2,
    profiles: {},
  };
}

function normalizeSecretName(name: string) {
  const trimmed = name.trim();
  if (!SECRET_NAME_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid secret name "${name}". Use 1-64 chars from letters, numbers, "_" or "-".`,
    );
  }
  return trimmed;
}

function normalizeSecretFieldName(name: string) {
  const trimmed = name.trim();
  if (!SECRET_FIELD_PATTERN.test(trimmed)) {
    throw new Error(
      `Invalid secret field "${name}". Use 1-64 chars from letters, numbers, "_" or "-".`,
    );
  }
  return trimmed;
}

function normalizeSecretFields(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Secret payload must be a flat JSON object.");
  }

  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > MAX_SECRET_FIELDS) {
    throw new Error(`Secret payload must contain between 1 and ${MAX_SECRET_FIELDS} fields.`);
  }

  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim();
    normalizeSecretFieldName(key);
    if (Array.isArray(rawValue) || (rawValue && typeof rawValue === "object")) {
      throw new Error(`Secret field "${key}" must be a scalar, not nested JSON.`);
    }
    const normalizedValue = rawValue === null ? "" : String(rawValue);
    if (normalizedValue.length > MAX_SECRET_VALUE_LENGTH) {
      throw new Error(`Secret field "${key}" exceeds the ${MAX_SECRET_VALUE_LENGTH}-character limit.`);
    }
    normalized[key] = normalizedValue;
  }

  return normalized;
}

function parseSecretRef(secretRef: string) {
  const trimmed = secretRef.trim();
  const separator = trimmed.indexOf(".");
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new Error(
      `Invalid secretRef "${secretRef}". Use the format "secretName.fieldName".`,
    );
  }

  const fieldName = trimmed.slice(separator + 1).trim();
  normalizeSecretFieldName(fieldName);

  return {
    secretName: normalizeSecretName(trimmed.slice(0, separator)),
    fieldName,
  };
}

function readLegacyKeyMaterial() {
  const direct = getLocalEnv("OPENELINARO_SECRET_KEY");
  if (direct) {
    return direct;
  }

  const filePath = getLocalEnv("OPENELINARO_SECRET_KEY_FILE");
  if (!filePath) {
    return null;
  }

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Secret key file not found: ${resolved}`);
  }
  return fs.readFileSync(resolved, "utf8").trim();
}

function requireLegacyKey() {
  const material = readLegacyKeyMaterial();
  if (!material) {
    throw new MissingLegacySecretStoreKeyError();
  }
  return crypto.scryptSync(material, SECRET_STORE_SALT, 32);
}

function isLegacyEntry(entry: SecretStoreEntry): entry is LegacySecretStoreEntry {
  return "envelope" in entry;
}

function decryptLegacyFields(entry: LegacySecretStoreEntry) {
  const key = requireLegacyKey();
  const decipher = crypto.createDecipheriv(
    entry.envelope.algorithm,
    key,
    Buffer.from(entry.envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(entry.envelope.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(entry.envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return normalizeSecretFields(JSON.parse(plaintext));
}

function normalizeStoreShape(store: unknown): SecretStoreShape {
  if (!store || typeof store !== "object") {
    return emptyStore();
  }

  const parsed = store as {
    version?: number;
    profiles?: Record<string, { secrets?: Record<string, SecretStoreEntry>; auth?: Partial<Record<ProviderAuthSecret["provider"], ProviderAuthSecret>> }>;
  };

  const profiles: SecretStoreShape["profiles"] = {};
  for (const [profileId, profileValue] of Object.entries(parsed.profiles ?? {})) {
    profiles[profileId] = {
      secrets: profileValue?.secrets ?? {},
      auth: profileValue?.auth ?? {},
    };
  }

  return {
    version: 2,
    profiles,
  };
}

function readStore(): SecretStoreShape {
  ensureStoreDir();
  const storePath = getSecretStorePath();
  if (!fs.existsSync(storePath)) {
    return emptyStore();
  }

  const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as unknown;
  return normalizeStoreShape(parsed);
}

function writeStore(store: SecretStoreShape) {
  assertTestRuntimeRootIsIsolated("Secret store");
  ensureStoreDir();
  fs.writeFileSync(getSecretStorePath(), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function getProfileStore(store: SecretStoreShape, profileId: string) {
  store.profiles[profileId] ??= { secrets: {}, auth: {} };
  return store.profiles[profileId]!;
}

function materializeSecretFields(entry: SecretStoreEntry) {
  if (isLegacyEntry(entry)) {
    return decryptLegacyFields(entry);
  }
  return normalizeSecretFields(entry.fields);
}

function upgradeLegacyProfileSecrets(profileStore: ReturnType<typeof getProfileStore>) {
  let changed = false;
  for (const [name, entry] of Object.entries(profileStore.secrets)) {
    if (!isLegacyEntry(entry)) {
      continue;
    }
    profileStore.secrets[name] = {
      kind: entry.kind,
      fields: materializeSecretFields(entry),
      updatedAt: entry.updatedAt,
    };
    changed = true;
  }
  return changed;
}

function randomInt(maxExclusive: number) {
  return crypto.randomInt(0, maxExclusive);
}

function randomChar(source: string) {
  return source[randomInt(source.length)] ?? "";
}

function shuffleString(value: string) {
  const chars = value.split("");
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [chars[index], chars[swapIndex]] = [chars[swapIndex]!, chars[index]!];
  }
  return chars.join("");
}

export class SecretStoreService {
  private loadSecretEntry(name: string, profileId = DEFAULT_SECRET_STORE_PROFILE_ID) {
    const normalizedName = normalizeSecretName(name);
    const store = readStore();
    const profileStore = getProfileStore(store, profileId);
    return {
      name: normalizedName,
      entry: profileStore.secrets[normalizedName] ?? null,
    };
  }

  getStatus(profileId = DEFAULT_SECRET_STORE_PROFILE_ID): SecretStoreStatus {
    const store = readStore();
    const profileStore = getProfileStore(store, profileId);
    return {
      configured: true,
      profileId,
      storePath: getSecretStorePath(),
      secretCount: Object.keys(profileStore.secrets).length,
      keySource: "internal",
    };
  }

  listSecrets(profileId = DEFAULT_SECRET_STORE_PROFILE_ID): SecretStoreListEntry[] {
    const store = readStore();
    const profileStore = getProfileStore(store, profileId);
    return Object.entries(profileStore.secrets)
      .map(([name, entry]) => ({
        name,
        kind: entry.kind,
        fields: isLegacyEntry(entry) ? [...entry.fields] : Object.keys(entry.fields).sort(),
        updatedAt: entry.updatedAt,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  saveSecret(input: {
    name: string;
    fields: Record<string, string>;
    kind?: SecretStoreKind;
    profileId?: string;
  }) {
    const name = normalizeSecretName(input.name);
    const kind = input.kind ?? "generic";
    if (!SECRET_STORE_KINDS.includes(kind)) {
      throw new Error(`Invalid secret kind "${kind}".`);
    }
    const profileId = input.profileId ?? DEFAULT_SECRET_STORE_PROFILE_ID;
    const fields = normalizeSecretFields(input.fields);
    const store = readStore();
    const profileStore = getProfileStore(store, profileId);
    upgradeLegacyProfileSecrets(profileStore);
    profileStore.secrets[name] = {
      kind,
      fields,
      updatedAt: nowIso(),
    };
    writeStore(store);
    telemetry.event("secret.store_saved", {
      entityType: "secret_store",
      entityId: `${profileId}:${name}`,
      profileId,
      secretName: name,
      secretKind: kind,
      fieldCount: Object.keys(fields).length,
    });
    return {
      name,
      kind,
      profileId,
      fields: Object.keys(fields).sort(),
    };
  }

  generateAndStorePassword(input: {
    name: string;
    fieldName?: string;
    kind?: SecretStoreKind;
    profileId?: string;
    length?: number;
    includeLowercase?: boolean;
    includeUppercase?: boolean;
    includeDigits?: boolean;
    includeSymbols?: boolean;
    symbols?: string;
  }) {
    const fieldName = normalizeSecretFieldName(input.fieldName ?? "password");
    const length = input.length ?? DEFAULT_PASSWORD_LENGTH;
    if (!Number.isInteger(length) || length < 8 || length > 256) {
      throw new Error("Generated password length must be an integer between 8 and 256.");
    }

    const profileId = input.profileId ?? DEFAULT_SECRET_STORE_PROFILE_ID;
    const { name, entry } = this.loadSecretEntry(input.name, profileId);
    const kind = input.kind ?? entry?.kind ?? "password";
    if (!SECRET_STORE_KINDS.includes(kind)) {
      throw new Error(`Invalid secret kind "${kind}".`);
    }

    const requestedSets = [
      input.includeLowercase !== false ? PASSWORD_CHARSETS.lowercase : "",
      input.includeUppercase !== false ? PASSWORD_CHARSETS.uppercase : "",
      input.includeDigits !== false ? PASSWORD_CHARSETS.digits : "",
      input.includeSymbols === false
        ? ""
        : (input.symbols?.length ? input.symbols : PASSWORD_CHARSETS.symbols),
    ].filter((value) => value.length > 0);

    if (requestedSets.length === 0) {
      throw new Error("Password generation needs at least one enabled character set.");
    }
    if (length < requestedSets.length) {
      throw new Error(`Password length ${length} is too short for ${requestedSets.length} required character sets.`);
    }

    const allChars = requestedSets.join("");
    const requiredChars = requestedSets.map((charset) => randomChar(charset));
    const remainingChars = Array.from({ length: length - requiredChars.length }, () => randomChar(allChars));
    const password = shuffleString([...requiredChars, ...remainingChars].join(""));

    const existingFields = entry ? materializeSecretFields(entry) : {};
    existingFields[fieldName] = password;
    const saved = this.saveSecret({
      name,
      kind,
      profileId,
      fields: existingFields,
    });

    telemetry.event("secret.password_generated", {
      entityType: "secret_store",
      entityId: `${profileId}:${name}`,
      profileId,
      secretName: name,
      secretKind: kind,
      fieldName,
      passwordLength: length,
      charsetCount: requestedSets.length,
    });

    return {
      ...saved,
      fieldName,
      generatedLength: length,
      preservedFieldCount: Math.max(0, saved.fields.length - 1),
    };
  }

  importSecretFromFile(input: {
    name: string;
    sourcePath: string;
    kind?: SecretStoreKind;
    profileId?: string;
  }) {
    const resolvedPath = path.resolve(input.sourcePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Secret source file not found: ${resolvedPath}`);
    }
    const parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8")) as unknown;
    return this.saveSecret({
      name: input.name,
      kind: input.kind,
      profileId: input.profileId,
      fields: normalizeSecretFields(parsed),
    });
  }

  deleteSecret(name: string, profileId = DEFAULT_SECRET_STORE_PROFILE_ID) {
    const normalizedName = normalizeSecretName(name);
    const store = readStore();
    const profileStore = getProfileStore(store, profileId);
    const existed = Boolean(profileStore.secrets[normalizedName]);
    delete profileStore.secrets[normalizedName];
    writeStore(store);
    telemetry.event("secret.store_deleted", {
      entityType: "secret_store",
      entityId: `${profileId}:${normalizedName}`,
      profileId,
      secretName: normalizedName,
      existed,
    });
    return existed;
  }

  resolveSecretRef(secretRef: string, profileId = DEFAULT_SECRET_STORE_PROFILE_ID) {
    const { secretName, fieldName } = parseSecretRef(secretRef);
    const store = readStore();
    const profileStore = getProfileStore(store, profileId);
    const entry = profileStore.secrets[secretName];
    if (!entry) {
      throw new Error(`Secret "${secretName}" was not found for profile ${profileId}.`);
    }
    const fields = materializeSecretFields(entry);
    if (!(fieldName in fields)) {
      throw new Error(`Secret "${secretName}" does not include field "${fieldName}".`);
    }
    if (isLegacyEntry(entry)) {
      profileStore.secrets[secretName] = {
        kind: entry.kind,
        fields,
        updatedAt: entry.updatedAt,
      };
      writeStore(store);
    }
    return fields[fieldName] ?? "";
  }

  getProviderAuth(
    provider: ProviderAuthSecret["provider"],
    profileId = DEFAULT_SECRET_STORE_PROFILE_ID,
  ): ProviderAuthSecret | null {
    const store = readStore();
    const profileStore = getProfileStore(store, profileId);
    return profileStore.auth[provider] ?? null;
  }

  saveProviderAuth(
    auth: ProviderAuthSecret,
    profileId = DEFAULT_SECRET_STORE_PROFILE_ID,
  ) {
    const store = readStore();
    const profileStore = getProfileStore(store, profileId);
    profileStore.auth[auth.provider] = auth;
    writeStore(store);
    telemetry.event("secret.provider_auth_saved", {
      entityType: "secret_store",
      entityId: `${profileId}:${auth.provider}`,
      profileId,
      provider: auth.provider,
    });
  }

  deleteProviderAuth(
    provider: ProviderAuthSecret["provider"],
    profileId = DEFAULT_SECRET_STORE_PROFILE_ID,
  ) {
    const store = readStore();
    const profileStore = getProfileStore(store, profileId);
    const existed = Boolean(profileStore.auth[provider]);
    delete profileStore.auth[provider];
    writeStore(store);
    return existed;
  }
}

export function readSecretJsonFromStdin() {
  return normalizeSecretFields(JSON.parse(fs.readFileSync(0, "utf8")));
}
