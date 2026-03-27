import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { DEFAULT_FINANCE, FinanceConfigSchema } from "./finance-config";
import { resolveRuntimePath } from "../services/runtime-root";
import { migrateConfigFile } from "./config-migrations";

const MessageChannelSchema = z.enum(["sms", "mms", "whatsapp", "messenger", "viber"]);
const DEFAULT_CORE_PROFILE = { activeProfileId: "root" };
const DEFAULT_CORE_ASSISTANT = { displayName: "OpenElinaro" };
const DEFAULT_CORE_DISCORD = { botTokenSecretRef: "discord.botToken", guildIds: [] as string[] };
const DEFAULT_CORE_ONBOARDING = { bootstrapCompleted: false };
const DEFAULT_CORE_PYTHON = { venvPath: "python/.venv", requirementsFile: "python/requirements.txt" };
const DEFAULT_CORE_CACHE_MISS = {
  minInputTokens: 30_000,
  minMissTokens: 20_000,
  maxCacheReadRatio: 0.2,
  discordCooldownMs: 15 * 60 * 1_000,
};
const DEFAULT_CORE_SUBAGENT = {
  tmuxSession: "openelinaro",
  defaultTimeoutMs: 3_600_000,
  timeoutGraceMs: 30_000,
  sidecarSocketPath: "",
};
const DEFAULT_CORE_APP = {
  automaticConversationMemoryEnabled: true,
  heartbeatEnabled: true,
  docsIndexerEnabled: false,
  cacheMissMonitor: DEFAULT_CORE_CACHE_MISS,
  subagent: DEFAULT_CORE_SUBAGENT,
};
const DEFAULT_CORE_HTTP = { host: "0.0.0.0", port: 3000 };
const DEFAULT_CORE = {
  profile: DEFAULT_CORE_PROFILE,
  assistant: DEFAULT_CORE_ASSISTANT,
  discord: DEFAULT_CORE_DISCORD,
  onboarding: DEFAULT_CORE_ONBOARDING,
  python: DEFAULT_CORE_PYTHON,
  app: DEFAULT_CORE_APP,
  http: DEFAULT_CORE_HTTP,
};
const DEFAULT_CALENDAR = { enabled: false, icsUrl: "" };
const DEFAULT_EMAIL = {
  enabled: false,
  provider: "IMAP/SMTP",
  username: "",
  imapHost: "",
  imapPort: 993,
  imapSecure: true,
  imapMailbox: "INBOX",
  smtpHost: "",
  smtpPort: 465,
  smtpSecure: true,
  apiBaseUrl: "",
  passwordSecretRef: "email.password",
  apiKeySecretRef: "email.apiKey",
  timeoutMs: 20_000,
  maxBodyChars: 12_000,
  listLimit: 10,
};
const DEFAULT_COMMUNICATIONS_VONAGE = {
  applicationId: "",
  privateKeySecretRef: "vonage.private_key",
  signatureSecretRef: "vonage.signature_secret",
  defaultFromNumber: "",
  defaultMessageFrom: "",
  defaultMessageChannel: "sms" as const,
  voiceRegion: "",
  voiceApiBaseUrl: "https://api.nexmo.com",
  messagesApiBaseUrl: "https://api.nexmo.com",
  webhookBasePath: "/webhooks/vonage",
  secretProfileId: "root",
  voiceAnswerText: "The assistant is online, but live inbound calling is not configured yet. Please send a text message instead.",
};
const DEFAULT_COMMUNICATIONS_GEMINI = {
  apiKeySecretRef: "gemini.apiKey",
  secretProfileId: "root",
  model: "gemini-2.5-flash-native-audio-preview-12-2025",
  voiceName: "",
  prefixPaddingMs: 20,
  silenceDurationMs: 100,
};
const DEFAULT_COMMUNICATIONS = {
  enabled: false,
  publicBaseUrl: "",
  vonage: DEFAULT_COMMUNICATIONS_VONAGE,
  geminiLive: DEFAULT_COMMUNICATIONS_GEMINI,
};
const DEFAULT_WEB_SEARCH = { enabled: false, braveApiKeySecretRef: "" };
const DEFAULT_WEB_FETCH = { enabled: false, runnerScript: "" };
const DEFAULT_OPENBROWSER = { enabled: false, runnerScript: "", sessionIdleMs: 15 * 60_000 };
const DEFAULT_TICKETS = { enabled: false, apiUrl: "", tokenSecretRef: "", sshTarget: "", remotePort: 3011 };
const DEFAULT_LOCAL_LLM = { baseUrl: "http://127.0.0.1:8800/v1", model: "qwen3.5-35b-a3b" };
const DEFAULT_KOKORO = { baseUrl: "http://127.0.0.1:8801/v1", model: "kokoro", voiceName: "am_fenrir" };
const DEFAULT_LOCAL_VOICE = { enabled: false, localLlm: DEFAULT_LOCAL_LLM, kokoro: DEFAULT_KOKORO };
const DEFAULT_MEDIA = { enabled: false, roots: [] as string[] };
const DEFAULT_EXTENSIONS = { enabled: false };
const DEFAULT_ZIGBEE2MQTT = { enabled: false, serialPort: "", channel: 11 };
const DEFAULT_AUTONOMOUS_TIME = { enabled: false, promptPath: "assistant_context/autonomous-time.md" };
const DEFAULT_MODELS = {
  extendedContext: {
    "openai-codex/gpt-5.4": { extendedContextWindow: 1_050_000 },
  } as Record<string, { extendedContextWindow: number }>,
};
const DEFAULT_SERVICE = { user: "root", group: "root" };

export const RuntimeConfigSchema = z.object({
  configVersion: z.number().int().nonnegative().default(0),
  core: z.object({
    profile: z.object({
      activeProfileId: z.string().min(1).default("root"),
    }).default(DEFAULT_CORE_PROFILE),
    assistant: z.object({
      displayName: z.string().min(1).default("OpenElinaro"),
    }).default(DEFAULT_CORE_ASSISTANT),
    discord: z.object({
      botTokenSecretRef: z.string().min(1).default("discord.botToken"),
      guildIds: z.array(z.string().min(1)).default([]),
    }).default(DEFAULT_CORE_DISCORD),
    onboarding: z.object({
      bootstrapCompleted: z.boolean().default(false),
    }).default(DEFAULT_CORE_ONBOARDING),
    python: z.object({
      venvPath: z.string().min(1).default("python/.venv"),
      requirementsFile: z.string().min(1).default("python/requirements.txt"),
    }).default(DEFAULT_CORE_PYTHON),
    app: z.object({
      automaticConversationMemoryEnabled: z.boolean().default(true),
      heartbeatEnabled: z.boolean().default(true),
      docsIndexerEnabled: z.boolean().default(false),
      cacheMissMonitor: z.object({
        minInputTokens: z.number().int().nonnegative().default(30_000),
        minMissTokens: z.number().int().nonnegative().default(20_000),
        maxCacheReadRatio: z.number().min(0).max(1).default(0.2),
        discordCooldownMs: z.number().int().nonnegative().default(15 * 60 * 1_000),
      }).default(DEFAULT_CORE_CACHE_MISS),
      subagent: z.object({
        tmuxSession: z.string().min(1).default("openelinaro"),
        defaultTimeoutMs: z.number().int().positive().default(3_600_000),
        timeoutGraceMs: z.number().int().nonnegative().default(30_000),
        sidecarSocketPath: z.string().default(""),
      }).default(DEFAULT_CORE_SUBAGENT),
    }).default(DEFAULT_CORE_APP),
    http: z.object({
      host: z.string().min(1).default("0.0.0.0"),
      port: z.number().int().positive().default(3000),
    }).default(DEFAULT_CORE_HTTP),
  }).default(DEFAULT_CORE),
  calendar: z.object({
    enabled: z.boolean().default(false),
    icsUrl: z.string().default(""),
  }).default(DEFAULT_CALENDAR),
  email: z.object({
    enabled: z.boolean().default(false),
    provider: z.string().default("IMAP/SMTP"),
    username: z.string().default(""),
    imapHost: z.string().default(""),
    imapPort: z.number().int().positive().default(993),
    imapSecure: z.boolean().default(true),
    imapMailbox: z.string().default("INBOX"),
    smtpHost: z.string().default(""),
    smtpPort: z.number().int().positive().default(465),
    smtpSecure: z.boolean().default(true),
    apiBaseUrl: z.string().default(""),
    passwordSecretRef: z.string().min(1).default("email.password"),
    apiKeySecretRef: z.string().min(1).default("email.apiKey"),
    timeoutMs: z.number().int().positive().default(20_000),
    maxBodyChars: z.number().int().positive().default(12_000),
    listLimit: z.number().int().positive().default(10),
  }).default(DEFAULT_EMAIL),
  communications: z.object({
    enabled: z.boolean().default(false),
    publicBaseUrl: z.string().default(""),
    vonage: z.object({
      applicationId: z.string().default(""),
      privateKeySecretRef: z.string().min(1).default("vonage.private_key"),
      signatureSecretRef: z.string().min(1).default("vonage.signature_secret"),
      defaultFromNumber: z.string().default(""),
      defaultMessageFrom: z.string().default(""),
      defaultMessageChannel: MessageChannelSchema.default("sms"),
      voiceRegion: z.string().default(""),
      voiceApiBaseUrl: z.string().default("https://api.nexmo.com"),
      messagesApiBaseUrl: z.string().default("https://api.nexmo.com"),
      webhookBasePath: z.string().min(1).default("/webhooks/vonage"),
      secretProfileId: z.string().min(1).default("root"),
      voiceAnswerText: z.string().default(
        "The assistant is online, but live inbound calling is not configured yet. Please send a text message instead.",
      ),
    }).default(DEFAULT_COMMUNICATIONS_VONAGE),
    geminiLive: z.object({
      apiKeySecretRef: z.string().min(1).default("gemini.apiKey"),
      secretProfileId: z.string().min(1).default("root"),
      model: z.string().min(1).default("gemini-2.5-flash-native-audio-preview-12-2025"),
      voiceName: z.string().default(""),
      prefixPaddingMs: z.number().int().nonnegative().default(20),
      silenceDurationMs: z.number().int().nonnegative().default(100),
    }).default(DEFAULT_COMMUNICATIONS_GEMINI),
  }).default(DEFAULT_COMMUNICATIONS),
  webSearch: z.object({
    enabled: z.boolean().default(false),
    braveApiKeySecretRef: z.string().default(""),
  }).default(DEFAULT_WEB_SEARCH),
  webFetch: z.object({
    enabled: z.boolean().default(false),
    runnerScript: z.string().default(""),
  }).default(DEFAULT_WEB_FETCH),
  openbrowser: z.object({
    enabled: z.boolean().default(false),
    runnerScript: z.string().default(""),
    sessionIdleMs: z.number().int().positive().default(15 * 60_000),
  }).default(DEFAULT_OPENBROWSER),
  finance: FinanceConfigSchema.default(DEFAULT_FINANCE),
  tickets: z.object({
    enabled: z.boolean().default(false),
    apiUrl: z.string().default(""),
    tokenSecretRef: z.string().default(""),
    sshTarget: z.string().default(""),
    remotePort: z.number().int().positive().default(3011),
  }).default(DEFAULT_TICKETS),
  localVoice: z.object({
    enabled: z.boolean().default(false),
    localLlm: z.object({
      baseUrl: z.string().default("http://127.0.0.1:8800/v1"),
      model: z.string().min(1).default("qwen3.5-35b-a3b"),
    }).default(DEFAULT_LOCAL_LLM),
    kokoro: z.object({
      baseUrl: z.string().default("http://127.0.0.1:8801/v1"),
      model: z.string().min(1).default("kokoro"),
      voiceName: z.string().min(1).default("am_fenrir"),
    }).default(DEFAULT_KOKORO),
  }).default(DEFAULT_LOCAL_VOICE),
  media: z.object({
    enabled: z.boolean().default(false),
    roots: z.array(z.string().min(1)).default([]),
  }).default(DEFAULT_MEDIA),
  extensions: z.object({
    enabled: z.boolean().default(false),
  }).default(DEFAULT_EXTENSIONS),
  zigbee2mqtt: z.object({
    enabled: z.boolean().default(false),
    serialPort: z.string().default(""),
    channel: z.number().int().min(11).max(26).default(11),
  }).default(DEFAULT_ZIGBEE2MQTT),
  autonomousTime: z.object({
    enabled: z.boolean().default(false),
    promptPath: z.string().min(1).default("assistant_context/autonomous-time.md"),
  }).default(DEFAULT_AUTONOMOUS_TIME),
  models: z.object({
    extendedContext: z.record(
      z.string().min(1),
      z.object({ extendedContextWindow: z.number().int().positive() }),
    ).default(DEFAULT_MODELS.extendedContext),
  }).default(DEFAULT_MODELS),
  service: z.object({
    user: z.string().min(1).default("root"),
    group: z.string().min(1).default("root"),
  }).default(DEFAULT_SERVICE),
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

let cachedConfig: RuntimeConfig | null = null;
let cachedConfigPath: string | null = null;

export function getRuntimeConfigPath() {
  return resolveRuntimePath("config.yaml");
}

function buildDefaultConfig() {
  return RuntimeConfigSchema.parse({});
}

export function validateRuntimeConfig(input: unknown) {
  return RuntimeConfigSchema.parse(input);
}

export function validateRuntimeConfigText(text: string) {
  const parsed = text.trim() ? parse(text) : {};
  return validateRuntimeConfig(parsed);
}

export function validateRuntimeConfigFile(configPath = ensureRuntimeConfigFile()) {
  const text = fs.readFileSync(configPath, "utf8");
  return validateRuntimeConfigText(text);
}

export function formatRuntimeConfigValidationError(error: unknown) {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => {
        const pathLabel = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `${pathLabel}: ${issue.message}`;
      })
      .join("\n");
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function ensureRuntimeConfigFile() {
  const configPath = getRuntimeConfigPath();
  if (fs.existsSync(configPath)) {
    return configPath;
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, stringify(buildDefaultConfig()), { mode: 0o600 });
  return configPath;
}

function loadFromDisk(configPath = ensureRuntimeConfigFile()) {
  migrateConfigFile(configPath);
  const validated = validateRuntimeConfigFile(configPath);
  cachedConfigPath = configPath;
  return validated;
}

export function getRuntimeConfig(): RuntimeConfig {
  const configPath = ensureRuntimeConfigFile();
  if (!cachedConfig || cachedConfigPath !== configPath) {
    cachedConfig = loadFromDisk(configPath);
  }
  return cachedConfig;
}

export function reloadRuntimeConfig() {
  cachedConfig = loadFromDisk();
  return cachedConfig;
}

export function saveRuntimeConfig(config: RuntimeConfig) {
  const configPath = ensureRuntimeConfigFile();
  const validated = validateRuntimeConfig(config);
  fs.writeFileSync(configPath, stringify(validated), { mode: 0o600 });
  cachedConfig = validated;
  cachedConfigPath = configPath;
  return validated;
}

function splitPathSegments(pathExpression: string) {
  return pathExpression
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

export function hasRuntimeConfigPath(pathExpression: string) {
  const segments = splitPathSegments(pathExpression);
  if (segments.length === 0) {
    return false;
  }

  let current: unknown = buildDefaultConfig();
  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !(segment in current)) {
      return false;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return true;
}

export function getRuntimeConfigValue(pathExpression: string): unknown {
  const segments = splitPathSegments(pathExpression);
  let current: unknown = getRuntimeConfig();
  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !(segment in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function setRuntimeConfigValue(pathExpression: string, value: unknown) {
  const segments = splitPathSegments(pathExpression);
  if (segments.length === 0) {
    throw new Error("Config path cannot be empty.");
  }

  const next = structuredClone(getRuntimeConfig()) as Record<string, unknown>;
  let cursor: Record<string, unknown> = next;
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments.at(-1)!] = value;
  return saveRuntimeConfig(validateRuntimeConfig(next));
}

export function unsetRuntimeConfigValue(pathExpression: string) {
  const segments = splitPathSegments(pathExpression);
  if (segments.length === 0) {
    throw new Error("Config path cannot be empty.");
  }

  const next = structuredClone(getRuntimeConfig()) as Record<string, unknown>;
  let cursor: Record<string, unknown> = next;
  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      return getRuntimeConfig();
    }
    cursor = existing as Record<string, unknown>;
  }
  delete cursor[segments.at(-1)!];
  return saveRuntimeConfig(validateRuntimeConfig(next));
}
