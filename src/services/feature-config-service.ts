import { existsSync } from "node:fs";
import { parse } from "yaml";
import {
  getRuntimeConfig,
  getRuntimeConfigValue,
  saveRuntimeConfig,
  type RuntimeConfig,
} from "../config/runtime-config";
import {
  getLocalVoicePythonModules,
  getOpenBrowserPythonModules,
  getPythonRuntimeSetupCommand,
  getSharedPythonRuntimeStatus,
  getWebFetchPythonModules,
  resolvePythonScriptPath,
} from "./python-runtime";
import { SecretStoreService } from "./infrastructure/secret-store-service";
import { detectZigbeeRadio } from "./zigbee2mqtt-service";

export const FEATURE_IDS = [
  "calendar",
  "email",
  "communications",
  "webSearch",
  "webFetch",
  "openbrowser",
  "finance",
  "tickets",
  "localVoice",
  "media",
  "extensions",
  "zigbee2mqtt",
] as const;

export type FeatureId = (typeof FEATURE_IDS)[number];

export type FeatureStatus = {
  featureId: FeatureId;
  enabled: boolean;
  configured: boolean;
  active: boolean;
  missing: string[];
  notes: string[];
};

function hasSecretRef(secrets: SecretStoreService, secretRef: string | undefined, profileId = "root") {
  const ref = secretRef?.trim();
  if (!ref) {
    return false;
  }
  try {
    return Boolean(secrets.resolveSecretRef(ref, profileId).trim());
  } catch {
    return false;
  }
}

function getSharedPythonReadiness(requiredModules?: string[]) {
  const status = getSharedPythonRuntimeStatus({ requiredModules });
  const missing = [];
  if (!status.ready) {
    if (!status.interpreterReady) {
      missing.push(`shared Python runtime (${getPythonRuntimeSetupCommand()})`);
    }
    if (status.missingModules.length > 0) {
      missing.push(`shared Python modules -> ${status.missingModules.join(", ")}`);
    }
  }
  if (!status.requirementsPresent) {
    missing.push(`core.python.requirementsFile -> ${status.requirementsPath}`);
  }
  return {
    missing,
    notes: [`Shared Python venv: ${status.venvPath}`],
  };
}

export class FeatureConfigService {
  constructor(
    private readonly secrets = new SecretStoreService(),
  ) {}

  listStatuses() {
    return FEATURE_IDS.map((featureId) => this.getStatus(featureId));
  }

  getStatus(featureId: FeatureId): FeatureStatus {
    const config = getRuntimeConfig();
    switch (featureId) {
      case "calendar": {
        const enabled = config.calendar.enabled;
        const configured = Boolean(config.calendar.icsUrl.trim());
        return {
          featureId,
          enabled,
          configured,
          active: enabled && configured,
          missing: configured ? [] : ["calendar.icsUrl"],
          notes: ["Read-only ICS calendar sync."],
        };
      }
      case "email": {
        const enabled = config.email.enabled;
        const configured = Boolean(
          config.email.username.trim()
            && config.email.imapHost.trim()
            && config.email.smtpHost.trim()
            && hasSecretRef(this.secrets, config.email.passwordSecretRef)
            && hasSecretRef(this.secrets, config.email.apiKeySecretRef),
        );
        const missing = [];
        if (!config.email.username.trim()) missing.push("email.username");
        if (!config.email.imapHost.trim()) missing.push("email.imapHost");
        if (!config.email.smtpHost.trim()) missing.push("email.smtpHost");
        if (!hasSecretRef(this.secrets, config.email.passwordSecretRef)) missing.push(config.email.passwordSecretRef || "email.passwordSecretRef");
        if (!hasSecretRef(this.secrets, config.email.apiKeySecretRef)) missing.push(config.email.apiKeySecretRef || "email.apiKeySecretRef");
        return { featureId, enabled, configured, active: enabled && configured, missing, notes: ["Mailbox send/receive tools."] };
      }
      case "communications": {
        const enabled = config.communications.enabled;
        const configured = Boolean(
          config.communications.publicBaseUrl.trim()
            && config.communications.vonage.applicationId.trim()
            && hasSecretRef(this.secrets, config.communications.vonage.privateKeySecretRef, config.communications.vonage.secretProfileId),
        );
        const missing = [];
        if (!config.communications.publicBaseUrl.trim()) missing.push("communications.publicBaseUrl");
        if (!config.communications.vonage.applicationId.trim()) missing.push("communications.vonage.applicationId");
        if (!hasSecretRef(this.secrets, config.communications.vonage.privateKeySecretRef, config.communications.vonage.secretProfileId)) {
          missing.push(config.communications.vonage.privateKeySecretRef || "communications.vonage.privateKeySecretRef");
        }
        return { featureId, enabled, configured, active: enabled && configured, missing, notes: ["Vonage calls/messages and Gemini live phone bridge."] };
      }
      case "webSearch": {
        const enabled = config.webSearch.enabled;
        const configured = hasSecretRef(this.secrets, config.webSearch.braveApiKeySecretRef);
        return {
          featureId,
          enabled,
          configured,
          active: enabled && configured,
          missing: configured ? [] : [config.webSearch.braveApiKeySecretRef || "webSearch.braveApiKeySecretRef"],
          notes: ["Brave Search API integration."],
        };
      }
      case "webFetch": {
        const enabled = config.webFetch.enabled;
        const python = getSharedPythonReadiness(getWebFetchPythonModules());
        const missing = [...python.missing];
        const runnerScript = resolvePythonScriptPath(config.webFetch.runnerScript, "scripts/crawl4ai_fetch_runner.py");
        if (!existsSync(runnerScript)) missing.push(`webFetch.runnerScript -> ${runnerScript}`);
        const configured = missing.length === 0;
        return {
          featureId,
          enabled,
          configured,
          active: enabled && configured,
          missing,
          notes: [...python.notes, "Crawl4AI-backed page fetch tool."],
        };
      }
      case "openbrowser": {
        const enabled = config.openbrowser.enabled;
        const python = getSharedPythonReadiness(getOpenBrowserPythonModules());
        const missing = [...python.missing];
        const runnerScript = resolvePythonScriptPath(config.openbrowser.runnerScript, "scripts/openbrowser_runner.py");
        if (!existsSync(runnerScript)) missing.push(`openbrowser.runnerScript -> ${runnerScript}`);
        const configured = missing.length === 0;
        return {
          featureId,
          enabled,
          configured,
          active: enabled && configured,
          missing,
          notes: [...python.notes, "Interactive browser automation."],
        };
      }
      case "finance": {
        const enabled = config.finance.enabled;
        const missing = [];
        if (!config.finance.dbPath.trim()) missing.push("finance.dbPath");
        if (!config.finance.forecastConfigPath.trim()) missing.push("finance.forecastConfigPath");
        const configured = missing.length === 0;
        return {
          featureId,
          enabled,
          configured,
          active: enabled && configured,
          missing,
          notes: ["Local finance database, import defaults, and forecast template."],
        };
      }
      case "tickets": {
        const enabled = config.tickets.enabled;
        const configured = Boolean(
          (config.tickets.apiUrl.trim() || config.tickets.sshTarget.trim())
            && hasSecretRef(this.secrets, config.tickets.tokenSecretRef),
        );
        const missing = [];
        if (!config.tickets.apiUrl.trim() && !config.tickets.sshTarget.trim()) missing.push("tickets.apiUrl|tickets.sshTarget");
        if (!hasSecretRef(this.secrets, config.tickets.tokenSecretRef)) missing.push(config.tickets.tokenSecretRef || "tickets.tokenSecretRef");
        return { featureId, enabled, configured, active: enabled && configured, missing, notes: ["Elinaro tickets API integration."] };
      }
      case "localVoice": {
        const enabled = config.localVoice.enabled;
        const python = getSharedPythonReadiness(getLocalVoicePythonModules());
        const missing = [...python.missing];
        const llmScript = resolvePythonScriptPath(undefined, "scripts/mlx_cache_server.py");
        const kokoroScript = resolvePythonScriptPath(undefined, "scripts/kokoro_server.py");
        if (!existsSync(llmScript)) missing.push(`localVoice.localLlm.script -> ${llmScript}`);
        if (!existsSync(kokoroScript)) missing.push(`localVoice.kokoro.script -> ${kokoroScript}`);
        if (process.platform !== "darwin") missing.push("localVoice requires a Darwin host for MLX sidecars");
        const configured = missing.length === 0;
        return {
          featureId,
          enabled,
          configured,
          active: enabled && configured,
          missing,
          notes: [...python.notes, "Local LLM/Kokoro sidecars."],
        };
      }
      case "media": {
        const enabled = config.media.enabled;
        const configured = config.media.roots.length > 0;
        return {
          featureId,
          enabled,
          configured,
          active: enabled && configured,
          missing: configured ? [] : ["media.roots"],
          notes: ["Local media playback tools."],
        };
      }
      case "extensions": {
        const enabled = config.extensions.enabled;
        return {
          featureId,
          enabled,
          configured: true,
          active: enabled,
          missing: [],
          notes: ["User-installed extension modules."],
        };
      }
      case "zigbee2mqtt": {
        const enabled = config.zigbee2mqtt.enabled;
        const hasRadio = Boolean(config.zigbee2mqtt.serialPort.trim()) || detectZigbeeRadio() !== null;
        const missing: string[] = [];
        if (!hasRadio) missing.push("zigbee2mqtt.serialPort (no USB radio detected)");
        return {
          featureId,
          enabled,
          configured: hasRadio,
          active: enabled && hasRadio,
          missing,
          notes: ["Direct Zigbee device control via USB coordinator radio."],
        };
      }
    }
  }

  isActive(featureId: FeatureId) {
    return this.getStatus(featureId).active;
  }

  applyChanges(input: {
    featureId: FeatureId;
    enabled?: boolean;
    values?: Record<string, unknown>;
  }) {
    const config = structuredClone(getRuntimeConfig()) as RuntimeConfig;
    const featureBlock = config[input.featureId];
    if (typeof input.enabled === "boolean") {
      featureBlock.enabled = input.enabled;
    }
    for (const [key, value] of Object.entries(input.values ?? {})) {
      const segments = key.split(".").filter(Boolean);
      let cursor: Record<string, unknown> = featureBlock as unknown as Record<string, unknown>;
      for (const segment of segments.slice(0, -1)) {
        const current = cursor[segment];
        if (!current || typeof current !== "object" || Array.isArray(current)) {
          cursor[segment] = {};
        }
        cursor = cursor[segment] as Record<string, unknown>;
      }
      cursor[segments.at(-1) ?? key] = value;
    }
    return saveRuntimeConfig(config);
  }

  renderStatusReport() {
    return this.listStatuses().map((status) =>
      [
        `${status.featureId}: ${status.active ? "active" : status.enabled ? "enabled but incomplete" : "disabled"}`,
        status.missing.length > 0 ? `missing: ${status.missing.join(", ")}` : "",
        ...status.notes,
      ].filter(Boolean).join(" | ")
    ).join("\n");
  }
}

export function parseFeatureValue(raw: string) {
  if (raw === "") {
    return "";
  }
  try {
    return parse(raw);
  } catch {
    return raw;
  }
}

export function getFeatureConfigValue(pathExpression: string) {
  return getRuntimeConfigValue(pathExpression);
}
