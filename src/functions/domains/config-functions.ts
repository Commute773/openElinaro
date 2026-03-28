/**
 * Config function definitions (model, secrets, config_edit, feature_manage).
 * Migrated from src/tools/groups/config-tools.ts.
 * These produce agent tools, API routes, and Discord commands from a single source.
 */
import fs from "node:fs";
import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";
import type { ModelProviderId, ActiveExtendedContextStatus } from "../../services/model-service";
import { SECRET_STORE_KINDS } from "../../services/secret-store-service";
import type { FeatureId } from "../../services/feature-config-service";
import { parseFeatureValue } from "../../services/feature-config-service";
import {
  formatRuntimeConfigValidationError,
  getRuntimeConfigPath,
  getRuntimeConfigValue,
  hasRuntimeConfigPath,
  saveRuntimeConfig,
  setRuntimeConfigValue,
  unsetRuntimeConfigValue,
  validateRuntimeConfigFile,
  validateRuntimeConfigText,
} from "../../config/runtime-config";
import { describeRuntimeConfigSchema } from "../../config/schema-introspect";
import { stringify as stringifyYaml } from "yaml";
import path from "node:path";

// ---------------------------------------------------------------------------
// Shared schemas (same as config-tools.ts)
// ---------------------------------------------------------------------------

const modelProviderSchema = z.enum(["openai-codex", "claude"]);
const thinkingLevelSchema = z.enum(["minimal", "low", "medium", "high", "xhigh"]);

const modelToolSchema = z.object({
  action: z.enum(["status", "list", "select", "set_thinking", "set_extended_context"]).optional(),
  provider: modelProviderSchema.optional(),
  modelId: z.string().min(1).optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
  enabled: z.boolean().optional(),
});

const secretKindSchema = z.enum(SECRET_STORE_KINDS);
const namedSecretSchema = z.object({
  name: z.string().min(1),
});
const importSecretFileSchema = z.object({
  name: z.string().min(1),
  sourcePath: z.string().min(1),
  kind: secretKindSchema.optional(),
});
const generateSecretPasswordSchema = z.object({
  name: z.string().min(1),
  fieldName: z.string().min(1).optional(),
  kind: secretKindSchema.optional(),
  length: z.number().int().min(8).max(256).optional(),
  includeLowercase: z.boolean().optional(),
  includeUppercase: z.boolean().optional(),
  includeDigits: z.boolean().optional(),
  includeSymbols: z.boolean().optional(),
  symbols: z.string().max(64).optional(),
});

const configEditSchema = z.object({
  action: z.enum(["get", "set", "unset", "validate", "replace", "schema"]),
  path: z.string().optional(),
  value: z.string().optional(),
  yaml: z.string().optional(),
  restart: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if ((value.action === "set" || value.action === "unset") && !value.path?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "path is required for set and unset actions.",
      path: ["path"],
    });
  }

  if (value.action === "set" && value.value === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "value is required for the set action.",
      path: ["value"],
    });
  }

  if (value.action === "replace" && value.yaml === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "yaml is required for the replace action.",
      path: ["yaml"],
    });
  }

  if (value.restart && !["set", "unset", "replace"].includes(value.action)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "restart is only supported for set, unset, and replace actions.",
      path: ["restart"],
    });
  }
});

const featureManageSchema = z.object({
  action: z.enum(["status", "apply"]),
  featureId: z.enum(["calendar", "email", "communications", "webSearch", "webFetch", "openbrowser", "finance", "tickets", "localVoice", "media"]).optional(),
  enabled: z.boolean().optional(),
  values: z.record(z.string(), z.string()).optional(),
  preparePython: z.boolean().optional(),
  restart: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Helpers (same as config-tools.ts)
// ---------------------------------------------------------------------------

export function formatTokenCount(value: number | undefined) {
  return value === undefined ? "n/a" : new Intl.NumberFormat("en-US").format(value);
}

export function renderExtendedContextStatus(status: ActiveExtendedContextStatus) {
  if (!status.supported) {
    return [
      "Extended context: unsupported",
      `Active model: ${status.providerId}/${status.modelId}`,
    ];
  }

  return [
    `Extended context: ${status.enabled ? "enabled" : "disabled"}`,
    `Active model: ${status.providerId}/${status.modelId}`,
    `Configured context window: ${formatTokenCount(status.activeContextWindow)} tokens`,
    `Standard window: ${formatTokenCount(status.standardContextWindow)} tokens`,
    `Extended window: ${formatTokenCount(status.extendedContextWindow)} tokens`,
  ];
}

function formatConfigValue(value: unknown) {
  return stringifyYaml(value).trimEnd();
}

function assertKnownRuntimeConfigPath(pathExpression: string) {
  const normalized = pathExpression.trim();
  if (!normalized) {
    throw new Error("Config path cannot be empty.");
  }
  if (!hasRuntimeConfigPath(normalized)) {
    throw new Error(`Unknown config path: ${normalized}`);
  }
  return normalized;
}

function buildPythonSetupCommand() {
  const rootDir = process.env.OPENELINARO_ROOT_DIR?.trim() || process.cwd();
  const setupPath = path.resolve(rootDir, "src", "cli", "setup-python.ts");
  return `${shellQuote(process.execPath)} ${shellQuote(setupPath)}`;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Config auth defaults
// ---------------------------------------------------------------------------

const CONFIG_AUTH_ANYONE = { access: "anyone" as const, behavior: "uniform" as const };
const CONFIG_AUTH_ROOT = { access: "root" as const, behavior: "uniform" as const };
const CONFIG_SCOPES: ("chat" | "direct")[] = ["chat", "direct"];
const CONFIG_DOMAINS = ["config", "system"];

// ---------------------------------------------------------------------------
// Domain builder
// ---------------------------------------------------------------------------

export const buildConfigFunctions: FunctionDomainBuilder = (ctx) => [
  // -----------------------------------------------------------------------
  // model
  // -----------------------------------------------------------------------
  defineFunction({
    name: "model",
    description:
      "Inspect or change model settings. Use action=status, list, select, set_thinking, or set_extended_context.",
    input: modelToolSchema,
    handler: async (input, fnCtx) => {
      const active = await fnCtx.services.models.getActiveModel();
      const action = input.action
        ?? (input.modelId ? "select" : input.thinkingLevel ? "set_thinking" : input.enabled !== undefined ? "set_extended_context" : "status");

      if (action === "status") {
        return [
          `Active model: ${active.providerId}/${active.modelId}`,
          `Thinking: ${active.thinkingLevel}`,
          ...renderExtendedContextStatus(await fnCtx.services.models.getActiveExtendedContextStatus()),
          "Actions: status, list, select, set_thinking, set_extended_context",
        ].join("\n");
      }

      if (action === "list") {
        const provider = (input.provider ?? active.providerId) as ModelProviderId;
        const models = await fnCtx.services.models.listProviderModels(provider);
        if (models.length === 0) {
          return `No models were returned for provider ${provider}.`;
        }

        return [
          `Provider: ${fnCtx.services.models.getProviderLabel(provider)}`,
          provider === active.providerId ? `Thinking: ${active.thinkingLevel}` : "",
          provider === active.providerId
            ? renderExtendedContextStatus(await fnCtx.services.models.getActiveExtendedContextStatus()).join("\n")
            : "",
          ...models.map((model) =>
            [
              `- ${model.modelId}`,
              model.name !== model.modelId ? `(${model.name})` : "",
              model.active ? "[active]" : "",
              model.supported ? "" : "[unsupported by runtime]",
              model.contextWindow ? `context=${model.contextWindow}` : "",
              model.maxOutputTokens ? `max_output=${model.maxOutputTokens}` : "",
            ]
              .filter(Boolean)
              .join(" "),
          ),
        ].filter(Boolean).join("\n");
      }

      if (action === "select") {
        if (!input.modelId?.trim()) {
          throw new Error("modelId is required for action=select.");
        }
        const provider = (input.provider ?? active.providerId) as ModelProviderId;
        const selected = await fnCtx.services.models.selectActiveModel(provider, input.modelId.trim());
        return [
          `Active model set to ${selected.providerId}/${selected.modelId}.`,
          `Thinking: ${(await fnCtx.services.models.getActiveModel()).thinkingLevel}.`,
          ...renderExtendedContextStatus(await fnCtx.services.models.getActiveExtendedContextStatus()),
          selected.contextWindow ? `Context window: ${selected.contextWindow} tokens.` : "",
          selected.maxOutputTokens ? `Max output: ${selected.maxOutputTokens} tokens.` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }

      if (action === "set_thinking") {
        if (!input.thinkingLevel) {
          throw new Error("thinkingLevel is required for action=set_thinking.");
        }
        const updated = await fnCtx.services.models.setThinkingLevel(input.thinkingLevel);
        return [
          `Thinking level set to ${updated.thinkingLevel}.`,
          `Active model: ${updated.providerId}/${updated.modelId}`,
          ...renderExtendedContextStatus(await fnCtx.services.models.getActiveExtendedContextStatus()),
        ].join("\n");
      }

      if (input.enabled === undefined) {
        throw new Error("enabled is required for action=set_extended_context.");
      }
      const updated = await fnCtx.services.models.setExtendedContextEnabled(input.enabled);
      return [
        `Extended context ${updated.extendedContextEnabled ? "enabled" : "disabled"}.`,
        ...renderExtendedContextStatus(await fnCtx.services.models.getActiveExtendedContextStatus()),
      ].join("\n");
    },
    auth: CONFIG_AUTH_ANYONE,
    domains: CONFIG_DOMAINS,
    agentScopes: CONFIG_SCOPES,
    examples: ["list models for the current provider", "set thinking high on the active model"],
    mutatesState: true,
  }),

  // -----------------------------------------------------------------------
  // secret_list
  // -----------------------------------------------------------------------
  defineFunction({
    name: "secret_list",
    description:
      "List encrypted local secret names and field names for the active root profile. Use this before openbrowser so you can pass refs like { secretRef: \"name.field\" } without ever returning raw secret values.",
    input: z.object({}),
    handler: async (_input, fnCtx) => {
      const status = fnCtx.services.secrets.getStatus();
      const entries = fnCtx.services.secrets.listSecrets();
      if (entries.length === 0) {
        return [
          `Secret store profile: ${status.profileId}`,
          `Configured: ${status.configured ? "yes" : "no"} (${status.keySource})`,
          "Stored secrets: none",
          "Use `bun src/cli/secrets.ts set-json <name> [kind] < secret.json`, `secret_import_file`, or `secret_generate_password` to add one.",
        ].join("\n");
      }
      return [
        `Secret store profile: ${status.profileId}`,
        `Configured: ${status.configured ? "yes" : "no"} (${status.keySource})`,
        `Stored secrets: ${entries.length}`,
        "",
        ...entries.map((entry) =>
          `${entry.name} | kind=${entry.kind} | fields=${entry.fields.join(",")} | updated=${entry.updatedAt}`
        ),
      ].join("\n");
    },
    auth: { access: "root" as const, behavior: "uniform" as const, note: "Lists local secret-store metadata for the active root profile without revealing secret values." },
    domains: CONFIG_DOMAINS,
    agentScopes: CONFIG_SCOPES,
    examples: ["list stored browser secrets", "show available secret field names"],
    untrustedOutput: {
      sourceType: "other",
      sourceName: "local encrypted secret metadata",
      notes: "This tool only returns secret names, field names, and timestamps. It never returns raw secret values.",
    },
  }),

  // -----------------------------------------------------------------------
  // secret_import_file
  // -----------------------------------------------------------------------
  defineFunction({
    name: "secret_import_file",
    description:
      "Import a flat JSON object from a local file into the encrypted secret store. Use this instead of putting secret values in chat, then reference the stored fields from openbrowser with { secretRef: \"name.field\" }.",
    input: importSecretFileSchema,
    handler: async (input, fnCtx) => {
      const saved = fnCtx.services.secrets.importSecretFromFile(input);
      return `Stored ${saved.name} for profile ${saved.profileId} with fields: ${saved.fields.join(", ")}.`;
    },
    auth: { access: "root" as const, behavior: "uniform" as const, note: "Imports a flat JSON secret payload from a local file into the local secret store." },
    domains: CONFIG_DOMAINS,
    agentScopes: CONFIG_SCOPES,
    examples: ["import a prepaid card json file", "store browser payment details from disk"],
    mutatesState: true,
    readsWorkspace: true,
    untrustedOutput: {
      sourceType: "filesystem",
      sourceName: "local secret import file",
      notes: "Secret import reads a local operator-provided JSON file and stores encrypted values without echoing them back.",
    },
  }),

  // -----------------------------------------------------------------------
  // secret_generate_password
  // -----------------------------------------------------------------------
  defineFunction({
    name: "secret_generate_password",
    description:
      "Generate a strong password server-side and store it in the encrypted secret store without returning the raw password.",
    input: generateSecretPasswordSchema,
    handler: async (input, fnCtx) => {
      const saved = fnCtx.services.secrets.generateAndStorePassword(input);
      return [
        `Generated and stored a ${saved.generatedLength}-character password.`,
        `Secret: ${saved.name}`,
        `Field: ${saved.fieldName}`,
        `Kind: ${saved.kind}`,
        `Profile: ${saved.profileId}`,
        `Preserved fields: ${saved.preservedFieldCount}`,
      ].join("\n");
    },
    auth: { access: "root" as const, behavior: "uniform" as const, note: "Generates a strong password server-side and stores it in the local secret store without returning the raw password." },
    domains: CONFIG_DOMAINS,
    agentScopes: CONFIG_SCOPES,
    examples: ["generate a password for github_credentials", "rotate app_login.password"],
    mutatesState: true,
    untrustedOutput: {
      sourceType: "other",
      sourceName: "local encrypted secret metadata",
      notes: "Password generation happens server-side and only returns metadata about where the password was stored.",
    },
  }),

  // -----------------------------------------------------------------------
  // secret_delete
  // -----------------------------------------------------------------------
  defineFunction({
    name: "secret_delete",
    description: "Delete one stored secret from the encrypted local secret store.",
    input: namedSecretSchema,
    handler: async (input, fnCtx) => {
      const existed = fnCtx.services.secrets.deleteSecret(input.name);
      return existed ? `Deleted secret ${input.name}.` : `Secret ${input.name} was already missing.`;
    },
    auth: { access: "root" as const, behavior: "uniform" as const, note: "Deletes one stored secret from the local secret store." },
    domains: CONFIG_DOMAINS,
    agentScopes: CONFIG_SCOPES,
    examples: ["delete prepaid_card", "remove a stored secret"],
    mutatesState: true,
    untrustedOutput: {
      sourceType: "other",
      sourceName: "local encrypted secret metadata",
      notes: "Deletes one stored secret without returning secret values.",
    },
  }),

  // -----------------------------------------------------------------------
  // config_edit
  // -----------------------------------------------------------------------
  defineFunction({
    name: "config_edit",
    description:
      "Read, validate, inspect schema, or edit ~/.openelinaro/config.yaml. Actions: get (read value at path or whole file), schema (describe types, constraints, defaults at a path or the whole root — use to discover available config paths before setting values), set/unset (path-based mutations), replace (whole-file), validate (check syntax and schema). All mutations are validated against the schema before saving. Optional managed-service restart after mutations.",
    input: configEditSchema,
    handler: async (input, fnCtx) => {
      if (input.action === "get") {
        if (!input.path?.trim()) {
          return fs.readFileSync(getRuntimeConfigPath(), "utf8").trimEnd();
        }
        const pathExpression = assertKnownRuntimeConfigPath(input.path);
        return formatConfigValue(getRuntimeConfigValue(pathExpression));
      }

      if (input.action === "validate") {
        try {
          if (input.yaml !== undefined) {
            validateRuntimeConfigText(input.yaml);
            return "Provided config YAML is valid.";
          }
          validateRuntimeConfigFile();
          return "Current config.yaml is valid.";
        } catch (error) {
          throw new Error(formatRuntimeConfigValidationError(error));
        }
      }

      if (input.action === "schema") {
        return describeRuntimeConfigSchema(input.path);
      }

      const lines: string[] = [];

      if (input.action === "replace") {
        try {
          const validated = validateRuntimeConfigText(input.yaml ?? "");
          saveRuntimeConfig(validated);
        } catch (error) {
          throw new Error(formatRuntimeConfigValidationError(error));
        }
        lines.push(`Saved ${getRuntimeConfigPath()}.`);
      } else if (input.action === "set") {
        const pathExpression = assertKnownRuntimeConfigPath(input.path ?? "");
        try {
          setRuntimeConfigValue(pathExpression, parseFeatureValue(input.value ?? ""));
        } catch (error) {
          throw new Error(formatRuntimeConfigValidationError(error));
        }
        lines.push(`Saved ${pathExpression}.`);
        lines.push(`Value:\n${formatConfigValue(getRuntimeConfigValue(pathExpression))}`);
      } else if (input.action === "unset") {
        const pathExpression = assertKnownRuntimeConfigPath(input.path ?? "");
        try {
          unsetRuntimeConfigValue(pathExpression);
        } catch (error) {
          throw new Error(formatRuntimeConfigValidationError(error));
        }
        lines.push(`Unset ${pathExpression}.`);
        lines.push(`Effective value:\n${formatConfigValue(getRuntimeConfigValue(pathExpression))}`);
      }

      lines.push("Validation: passed.");

      if (input.restart) {
        lines.push(await fnCtx.services.requestManagedServiceRestart("config_edit"));
      }

      return lines.join("\n");
    },
    auth: { access: "root" as const, behavior: "uniform" as const, note: "Reads and edits ~/.openelinaro/config.yaml, validates the result against the runtime schema, and may restart the managed service." },
    domains: CONFIG_DOMAINS,
    agentScopes: CONFIG_SCOPES,
    mutatesState: true,
    untrustedOutput: {
      sourceType: "other",
      sourceName: "local runtime config",
      notes: "Reads and writes ~/.openelinaro/config.yaml, validates the result against the runtime schema, and may request a managed-service restart.",
    },
  }),

  // -----------------------------------------------------------------------
  // feature_manage
  // -----------------------------------------------------------------------
  defineFunction({
    name: "feature_manage",
    description:
      "Inspect or update one optional feature block in ~/.openelinaro/config.yaml. Use action=status to see feature readiness, or action=apply to enable/disable a feature, write config values, optionally prepare the shared Python runtime, and restart the managed service by default so new tools activate immediately. Set restart=false only when you intentionally want to defer that restart.",
    input: featureManageSchema,
    handler: async (input, fnCtx) => {
      if (input.action === "status") {
        if (!input.featureId) {
          return fnCtx.services.featureConfig.renderStatusReport();
        }
        const status = fnCtx.services.featureConfig.getStatus(input.featureId as FeatureId);
        return [
          `${status.featureId}: ${status.active ? "active" : status.enabled ? "enabled but incomplete" : "disabled"}`,
          status.missing.length > 0 ? `missing: ${status.missing.join(", ")}` : "missing: none",
          ...status.notes,
        ].join("\n");
      }

      if (!input.featureId) {
        throw new Error("featureId is required for feature activation changes.");
      }

      const values = Object.fromEntries(
        Object.entries(input.values ?? {}).map(([key, value]) => [key, parseFeatureValue(value)]),
      );
      fnCtx.services.featureConfig.applyChanges({
        featureId: input.featureId as FeatureId,
        enabled: input.enabled,
        values,
      });
      if (input.preparePython) {
        await fnCtx.services.shell.exec({
          command: buildPythonSetupCommand(),
          timeoutMs: 20 * 60_000,
        });
      }
      const status = fnCtx.services.featureConfig.getStatus(input.featureId as FeatureId);
      const shouldRestart = input.restart ?? true;
      const lines = [
        `Saved ${input.featureId} feature config.`,
        input.preparePython ? "Shared Python runtime setup completed." : "",
        `Status: ${status.active ? "active" : status.enabled ? "enabled but incomplete" : "disabled"}`,
        status.missing.length > 0 ? `Missing: ${status.missing.join(", ")}` : "Missing: none",
      ];

      if (shouldRestart) {
        lines.push(await fnCtx.services.requestManagedServiceRestart("feature_manage"));
      }

      return lines.join("\n");
    },
    auth: { access: "root" as const, behavior: "uniform" as const, note: "Reads and writes optional feature config blocks and may restart the managed service." },
    domains: CONFIG_DOMAINS,
    agentScopes: CONFIG_SCOPES,
    mutatesState: true,
    untrustedOutput: {
      sourceType: "other",
      sourceName: "local feature config",
      notes: "Reads and writes feature blocks in ~/.openelinaro/config.yaml and may request a managed-service restart.",
    },
  }),
];
