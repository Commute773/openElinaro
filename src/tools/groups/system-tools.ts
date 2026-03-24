import fs from "node:fs";
import path from "node:path";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { MediaKind } from "../../services/media-service";
import type { ModelProviderId, ActiveExtendedContextStatus } from "../../services/model-service";
import { SECRET_STORE_KINDS } from "../../services/secret-store-service";
import { isRunningInsideManagedService } from "../../services/runtime-platform";
import type { FeatureId } from "../../services/feature-config-service";
import { parseFeatureValue } from "../../services/feature-config-service";
import {
  formatRuntimeConfigValidationError,
  getRuntimeConfig,
  getRuntimeConfigPath,
  getRuntimeConfigValue,
  hasRuntimeConfigPath,
  saveRuntimeConfig,
  setRuntimeConfigValue,
  unsetRuntimeConfigValue,
  validateRuntimeConfigFile,
  validateRuntimeConfigText,
} from "../../config/runtime-config";
import { stringify as stringifyYaml } from "yaml";
import {
  DEFAULT_WEB_SEARCH_LANGUAGE,
  DEFAULT_WEB_SEARCH_UI_LANG,
} from "../../services/tool-defaults";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { telemetry } from "../../services/telemetry";
import type { ToolBuildContext, ShellRuntime } from "./tool-group-types";
import type { RuntimePlatform } from "../../services/runtime-platform";
import { renderShellExecResult } from "./shell-tools";

const toolTelemetry = telemetry.child({ component: "tool" });
const traceSpan = createTraceSpan(toolTelemetry);

const responseFormatSchema = z.enum(["text", "json"]);
const modelProviderSchema = z.enum(["openai-codex", "claude"]);
const thinkingLevelSchema = z.enum(["minimal", "low", "medium", "high", "xhigh"]);

const modelToolSchema = z.object({
  action: z.enum(["status", "list", "select", "set_thinking", "set_extended_context"]).optional(),
  provider: modelProviderSchema.optional(),
  modelId: z.string().min(1).optional(),
  thinkingLevel: thinkingLevelSchema.optional(),
  enabled: z.boolean().optional(),
});

const webSearchSchema = z.object({
  query: z.string().min(1),
  count: z.number().int().min(1).max(10).optional(),
  country: z.string().min(2).max(2).optional(),
  language: z.string()
    .min(2)
    .max(16)
    .describe(`Defaults to ${DEFAULT_WEB_SEARCH_LANGUAGE}. Omit unless overriding.`)
    .optional(),
  ui_lang: z.string()
    .min(2)
    .max(16)
    .describe(`Defaults to ${DEFAULT_WEB_SEARCH_UI_LANG}. Omit unless overriding.`)
    .optional(),
  freshness: z.enum(["day", "week", "month", "year"]).optional(),
  date_after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  date_before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const webFetchSchema = z.object({
  url: z.string().url(),
  format: z.enum(["text", "markdown", "html"]).optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  maxChars: z.number().int().min(500).max(40_000).optional(),
});

const mediaKindSchema = z.enum(["song", "ambience"]);

const mediaListSchema = z.object({
  query: z.string().min(1).optional(),
  kind: mediaKindSchema.or(z.literal("all")).optional(),
  tags: z.array(z.string().min(1)).max(12).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const mediaSpeakerSchema = z.object({
  speaker: z.string().min(1).optional(),
});

const mediaPlaySchema = z.object({
  query: z.string().min(1),
  speaker: z.string().min(1).optional(),
  kind: mediaKindSchema.optional(),
  volume: z.number().int().min(0).max(130).optional(),
  loop: z.boolean().optional(),
});

const mediaVolumeSchema = z.object({
  volume: z.number().int().min(0).max(130),
  speaker: z.string().min(1).optional(),
});

function parseOpenBrowserActionsInput(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return value;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

const openBrowserViewportSchema = z.object({
  width: z.number().int().min(200).max(4_000),
  height: z.number().int().min(200).max(4_000),
});

const openBrowserActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("navigate"),
    url: z.string().url(),
    waitMs: z.number().int().min(0).max(15_000).optional(),
  }),
  z.object({
    type: z.literal("wait"),
    ms: z.number().int().min(0).max(15_000),
  }),
  z.object({
    type: z.literal("mouse_move"),
    x: z.number().int().min(0).max(10_000),
    y: z.number().int().min(0).max(10_000),
    steps: z.number().int().min(1).max(100).optional(),
  }),
  z.object({
    type: z.literal("mouse_click"),
    x: z.number().int().min(0).max(10_000),
    y: z.number().int().min(0).max(10_000),
    button: z.enum(["left", "middle", "right"]).optional(),
    clickCount: z.number().int().min(1).max(3).optional(),
  }),
  z.object({
    type: z.literal("press"),
    key: z.string().min(1).max(64),
  }),
  z.object({
    type: z.literal("type"),
    text: z.union([
      z.string().max(10_000),
      z.object({
        secretRef: z.string().min(1),
      }),
    ]),
    submit: z.boolean().optional(),
    delayMs: z.number().int().min(0).max(1_000).optional(),
  }),
  z.object({
    type: z.literal("evaluate"),
    expression: z.string().min(1),
    args: z.array(z.unknown()).max(8).optional(),
    captureResult: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("screenshot"),
    path: z.string().min(1).optional(),
    format: z.enum(["png", "jpeg", "webp"]).optional(),
    quality: z.number().int().min(0).max(100).optional(),
  }),
]);

const openBrowserSchema = z.object({
  startUrl: z.string().url().optional(),
  headless: z.boolean().optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  cwd: z.string().optional(),
  artifactDir: z.string().optional(),
  sessionKey: z.string().min(1).optional(),
  resetSession: z.boolean().optional(),
  viewport: openBrowserViewportSchema.optional(),
  actions: z.preprocess(
    parseOpenBrowserActionsInput,
    z.array(openBrowserActionSchema).min(1).max(25),
  ),
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
  action: z.enum(["get", "set", "unset", "validate", "replace"]),
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

const benchmarkSchema = z.object({
  prompt: z.string().min(1).optional(),
  maxTokens: z.number().int().min(32).max(1_024).optional(),
  embeddingItems: z.number().int().min(8).max(512).optional(),
  embeddingChars: z.number().int().min(64).max(4_000).optional(),
});

const serviceActionSchema = z.object({
  timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
  conversationKey: z.string().min(1).optional(),
});

const serviceChangelogSinceVersionSchema = z.object({
  sinceVersion: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).superRefine((value, ctx) => {
  if (!value.sinceVersion && !value.version) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide sinceVersion or version.",
      path: ["sinceVersion"],
    });
  }
});

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

function formatDurationMs(durationMs: number | null) {
  if (durationMs === null) {
    return "n/a";
  }
  if (durationMs >= 1_000) {
    return `${(durationMs / 1_000).toFixed(2)}s`;
  }
  return `${durationMs.toFixed(2)}ms`;
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

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildServiceCommand(
  action: "update" | "rollback" | "healthcheck",
  timeoutMs: number,
  options?: { conversationKey?: string },
) {
  const rootDir = process.env.OPENELINARO_ROOT_DIR?.trim() || process.cwd();
  if (action === "healthcheck") {
    const healthcheckPath = path.resolve(rootDir, "src/cli/healthcheck.ts");
    return `${shellQuote(process.execPath)} ${shellQuote(healthcheckPath)} --timeout-ms=${timeoutMs}`;
  }

  const detached = isRunningInsideManagedService();
  const scriptPath = path.resolve(
    rootDir,
    "scripts",
    detached ? `service-${action}-detached.sh` : `service-${action}.sh`,
  );

  const envParts = [
    `OPENELINARO_HEALTHCHECK_TIMEOUT_MS=${shellQuote(String(timeoutMs))}`,
    `OPENELINARO_AGENT_SERVICE_CONTROL=${shellQuote("1")}`,
  ];
  const passthroughEnv = [
    "OPENELINARO_ROOT_DIR",
    "OPENELINARO_SERVICE_ROOT_DIR",
    "OPENELINARO_USER_DATA_DIR",
    "OPENELINARO_SERVICE_USER",
    "OPENELINARO_SERVICE_GROUP",
    "OPENELINARO_SERVICE_LABEL",
    "OPENELINARO_SYSTEMD_UNIT_PATH",
  ] as const;
  for (const envName of passthroughEnv) {
    const envValue = process.env[envName]?.trim();
    if (envValue) {
      envParts.push(`${envName}=${shellQuote(envValue)}`);
    }
  }
  if (options?.conversationKey?.trim()) {
    envParts.push(
      `OPENELINARO_NOTIFY_DISCORD_USER_ID=${shellQuote(options.conversationKey.trim())}`,
    );
  }

  return [
    ...envParts,
    shellQuote(scriptPath),
  ].join(" ");
}

function buildGitLatestTagCommand() {
  const rootDir = process.env.OPENELINARO_ROOT_DIR?.trim() || process.cwd();
  return `${["git", "-C", rootDir, "tag", "-l", "v*", "--sort=-version:refname"].map((arg) => shellQuote(arg)).join(" ")} | head -n1 | sed 's/^v//'`;
}

function buildGitPullCommand() {
  const rootDir = process.env.OPENELINARO_ROOT_DIR?.trim() || process.cwd();
  return [
    ["git", "-C", rootDir, "fetch", "--tags", "origin"].map((arg) => shellQuote(arg)).join(" "),
    ["git", "-C", rootDir, "pull", "--ff-only"].map((arg) => shellQuote(arg)).join(" "),
  ].join(" && ");
}

function buildPythonSetupCommand() {
  const rootDir = process.env.OPENELINARO_ROOT_DIR?.trim() || process.cwd();
  const setupPath = path.resolve(rootDir, "src", "cli", "setup-python.ts");
  return `${shellQuote(process.execPath)} ${shellQuote(setupPath)}`;
}

function describeServiceTransition(action: "update" | "rollback") {
  if (!isRunningInsideManagedService()) {
    return "";
  }

  return [
    "",
    `IMPORTANT: the ${action} has been SCHEDULED but is NOT complete yet. The service will restart in approximately 10-15 seconds. Do NOT tell the user the ${action} is finished or attempt any actions that depend on it. The user will receive an "update complete" Discord DM once the new version is running and verified.`,
  ].join("\n");
}

function requiresPrivilegedServiceControl(runtimePlatform: RuntimePlatform, action: "update" | "rollback" | "healthcheck" | "restart") {
  return runtimePlatform.serviceManager === "systemd" && action !== "healthcheck";
}

export function buildSystemTools(ctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = [];

  // Model tool
  tools.push(
    tool(
      async (input) =>
        traceSpan(
          "tool.model",
          async () => {
            const active = ctx.models.getActiveModel();
            const action = input.action
              ?? (input.modelId ? "select" : input.thinkingLevel ? "set_thinking" : input.enabled !== undefined ? "set_extended_context" : "status");

            if (action === "status") {
              return [
                `Active model: ${active.providerId}/${active.modelId}`,
                `Thinking: ${active.thinkingLevel}`,
                ...renderExtendedContextStatus(ctx.models.getActiveExtendedContextStatus()),
                "Actions: status, list, select, set_thinking, set_extended_context",
              ].join("\n");
            }

            if (action === "list") {
              const provider = (input.provider ?? active.providerId) as ModelProviderId;
              const models = await ctx.models.listProviderModels(provider);
              if (models.length === 0) {
                return `No models were returned for provider ${provider}.`;
              }

              return [
                `Provider: ${ctx.models.getProviderLabel(provider)}`,
                provider === active.providerId ? `Thinking: ${active.thinkingLevel}` : "",
                provider === active.providerId
                  ? renderExtendedContextStatus(ctx.models.getActiveExtendedContextStatus()).join("\n")
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
              const selected = await ctx.models.selectActiveModel(provider, input.modelId.trim());
              return [
                `Active model set to ${selected.providerId}/${selected.modelId}.`,
                `Thinking: ${ctx.models.getActiveModel().thinkingLevel}.`,
                ...renderExtendedContextStatus(ctx.models.getActiveExtendedContextStatus()),
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
              const updated = ctx.models.setThinkingLevel(input.thinkingLevel);
              return [
                `Thinking level set to ${updated.thinkingLevel}.`,
                `Active model: ${updated.providerId}/${updated.modelId}`,
                ...renderExtendedContextStatus(ctx.models.getActiveExtendedContextStatus()),
              ].join("\n");
            }

            if (input.enabled === undefined) {
              throw new Error("enabled is required for action=set_extended_context.");
            }
            const updated = ctx.models.setExtendedContextEnabled(input.enabled);
            return [
              `Extended context ${updated.extendedContextEnabled ? "enabled" : "disabled"}.`,
              ...renderExtendedContextStatus(ctx.models.getActiveExtendedContextStatus()),
            ].join("\n");
          },
          { attributes: input },
        ),
      {
        name: "model",
        description:
          "Inspect or change model settings. Use action=status, list, select, set_thinking, or set_extended_context.",
        schema: modelToolSchema,
      },
    ),
  );

  // Web search (feature-gated)
  if (ctx.featureConfig.isActive("webSearch")) {
    tools.push(
      tool(
        async (input) =>
          traceSpan(
            "tool.web_search",
            async () => {
              const webSearch = ctx.createWebSearchService();
              if (!webSearch) {
                throw new Error(
                  "Brave web search is not configured. Enable the webSearch feature and provide the configured secret ref.",
                );
              }
              return webSearch.searchBrave(input);
            },
            { attributes: input },
          ),
        {
          name: "web_search",
          description:
            `Search the web using Brave Search API. Returns titles, URLs, and snippets for quick research. Defaults to English search (${DEFAULT_WEB_SEARCH_LANGUAGE}) and UI locale ${DEFAULT_WEB_SEARCH_UI_LANG}; omit those args unless overriding.`,
          schema: webSearchSchema,
        },
      ),
    );
  }

  // Web fetch (feature-gated)
  if (ctx.featureConfig.isActive("webFetch")) {
    tools.push(
      tool(
        async (input) =>
          traceSpan(
            "tool.web_fetch",
            async () => ctx.webFetch.fetch(input),
            { attributes: input },
          ),
        {
          name: "web_fetch",
          description:
            "Fetch a URL through Crawl4AI and return AI-friendly page content as markdown, text, or html. Use this for reading a specific page after discovery with web_search; prefer openbrowser only when interactive browser control is required.",
          schema: webFetchSchema,
        },
      ),
    );
  }

  // Media tools (platform & feature-gated)
  if (ctx.media && ctx.featureConfig.isActive("media")) {
    const media = ctx.media;
    tools.push(
      tool(
        async (input) =>
          traceSpan(
            "tool.media_list",
            async () => {
              const result = media.listMedia({
                query: input.query,
                kind: input.kind as MediaKind | "all" | undefined,
                tags: input.tags,
                limit: input.limit,
              });
              if (result.items.length === 0) {
                return "No media matched.";
              }
              return [
                `Media matches: ${result.total} total (${result.counts.songs} songs, ${result.counts.ambience} ambience).`,
                ...result.items.map((item) =>
                  `- [${item.id}] ${item.title} | ${item.kind} | tags: ${item.tags.join(", ")} | source: ${item.source}`
                ),
              ].join("\n");
            },
            { attributes: input },
          ),
        {
          name: "media_list",
          description:
            "List tagged local media from the runtime media/ library. Use this to inspect songs, ambience, ids, and tags before playback.",
          schema: mediaListSchema,
        },
      ),
      tool(
        async () =>
          traceSpan(
            "tool.media_list_speakers",
            async () => {
              const speakers = await media.listSpeakers();
              if (speakers.length === 0) {
                return "No speakers detected.";
              }
              return speakers.map((speaker) =>
                `- ${speaker.id}: ${speaker.name} | device=${speaker.deviceName} | transport=${speaker.transport} | available=${speaker.available ? "yes" : "no"}${speaker.isCurrentOutput ? " | current output" : ""}`
              ).join("\n");
            },
          ),
        {
          name: "media_list_speakers",
          description:
            "List known output speakers and whether they are currently available. Includes configured aliases such as bedroom/B06HD.",
          schema: z.object({}),
        },
      ),
      tool(
        async (input) =>
          traceSpan(
            "tool.media_play",
            async () => {
              const result = await media.play({
                query: input.query,
                speaker: input.speaker,
                kind: input.kind as MediaKind | undefined,
                volume: input.volume,
                loop: input.loop,
              });
              return [
                `Playing ${result.item.title}.`,
                `Speaker: ${result.speaker.name} (${result.speaker.id})`,
                `Kind: ${result.item.kind}`,
                `Volume: ${result.volume}`,
                `Loop: ${result.loop ? "on" : "off"}`,
                `Tags: ${result.item.tags.join(", ")}`,
              ].join("\n");
            },
            { attributes: input },
          ),
        {
          name: "media_play",
          description:
            "Play a tagged local media item on a specific speaker. Resolves media by id, title, tag, or direct file path.",
          schema: mediaPlaySchema,
        },
      ),
      tool(
        async (input) =>
          traceSpan(
            "tool.media_pause",
            async () => {
              const status = await media.pause(input.speaker);
              return `Paused ${status.media?.title ?? "current audio"} on ${status.speaker.name}.`;
            },
            { attributes: input },
          ),
        {
          name: "media_pause",
          description: "Pause the currently playing audio on a speaker.",
          schema: mediaSpeakerSchema,
        },
      ),
      tool(
        async (input) =>
          traceSpan(
            "tool.media_stop",
            async () => {
              const status = await media.stop(input.speaker);
              return `Stopped playback on ${status.speaker.name}.`;
            },
            { attributes: input },
          ),
        {
          name: "media_stop",
          description: "Stop the currently playing audio on a speaker.",
          schema: mediaSpeakerSchema,
        },
      ),
      tool(
        async (input) =>
          traceSpan(
            "tool.media_set_volume",
            async () => {
              const status = await media.setVolume(input.volume, input.speaker);
              return `Volume set to ${status.volume ?? input.volume} on ${status.speaker.name}.`;
            },
            { attributes: input },
          ),
        {
          name: "media_set_volume",
          description: "Set the mpv playback volume for the active media player on a speaker.",
          schema: mediaVolumeSchema,
        },
      ),
      tool(
        async (input) =>
          traceSpan(
            "tool.media_status",
            async () => {
              const status = await media.getStatus(input.speaker);
              if (status.state === "stopped") {
                return `${status.speaker.name} is stopped.`;
              }
              return [
                `${status.speaker.name} is ${status.state}.`,
                `Track: ${status.media?.title ?? status.path ?? "unknown"}`,
                `Kind: ${status.media?.kind ?? "unknown"}`,
                `Volume: ${status.volume ?? "unknown"}`,
                status.media ? `Tags: ${status.media.tags.join(", ")}` : undefined,
              ].filter(Boolean).join("\n");
            },
            { attributes: input },
          ),
        {
          name: "media_status",
          description: "Show what is currently playing on a speaker, including pause state and volume.",
          schema: mediaSpeakerSchema,
        },
      ),
    );
  }

  // OpenBrowser (feature-gated)
  if (ctx.featureConfig.isActive("openbrowser")) {
    tools.push(
      tool(
        async (input) =>
          traceSpan(
            "tool.openbrowser",
            async () => ctx.openbrowser.run(input),
            {
              attributes: {
                startUrl: input.startUrl,
                actionCount: input.actions.length,
                headless: input.headless ?? true,
              },
            },
          ),
        {
          name: "openbrowser",
          description:
            "Run local browser automation with OpenBrowser. In an active agent thread, this reuses the same live browser session by default so later calls continue on the current page/tab unless resetSession is true. Occasionally inspect the page visually with screenshots so you confirm what the browser is actually showing, especially before or after important interactions. For user input, aggressively prefer real interaction: use coordinate-based mouse_click plus the dedicated type action instead of evaluate helpers that call element.click(), form.submit(), element.value=, or other DOM-mutation shortcuts. Treat DOM mutation as a fallback only when normal interaction fails, and verify field state with screenshots or explicit input.value checks rather than body.innerText alone. For stored credentials or cards, call secret_list first, then pass secret refs like { secretRef: \"prepaid_card.number\" } inside action args so the runtime resolves them server-side.",
          schema: openBrowserSchema,
        },
      ),
    );
  }

  // Secret management
  tools.push(
    tool(
      async () =>
        traceSpan(
          "tool.secret_list",
          async () => {
            const status = ctx.secrets.getStatus();
            const entries = ctx.secrets.listSecrets();
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
        ),
      {
        name: "secret_list",
        description:
          "List encrypted local secret names and field names for the active root profile. Use this before openbrowser so you can pass refs like { secretRef: \"name.field\" } without ever returning raw secret values.",
        schema: z.object({}),
      },
    ),
    tool(
      async (input) =>
        traceSpan(
          "tool.secret_import_file",
          async () => {
            const saved = ctx.secrets.importSecretFromFile(input);
            return `Stored ${saved.name} for profile ${saved.profileId} with fields: ${saved.fields.join(", ")}.`;
          },
          { attributes: { name: input.name, kind: input.kind, sourcePath: input.sourcePath } },
        ),
      {
        name: "secret_import_file",
        description:
          "Import a flat JSON object from a local file into the encrypted secret store. Use this instead of putting secret values in chat, then reference the stored fields from openbrowser with { secretRef: \"name.field\" }.",
        schema: importSecretFileSchema,
      },
    ),
    tool(
      async (input) =>
        traceSpan(
          "tool.secret_generate_password",
          async () => {
            const saved = ctx.secrets.generateAndStorePassword(input);
            return [
              `Generated and stored a ${saved.generatedLength}-character password.`,
              `Secret: ${saved.name}`,
              `Field: ${saved.fieldName}`,
              `Kind: ${saved.kind}`,
              `Profile: ${saved.profileId}`,
              `Preserved fields: ${saved.preservedFieldCount}`,
            ].join("\n");
          },
          {
            attributes: {
              name: input.name,
              fieldName: input.fieldName,
              kind: input.kind,
              length: input.length,
              includeLowercase: input.includeLowercase,
              includeUppercase: input.includeUppercase,
              includeDigits: input.includeDigits,
              includeSymbols: input.includeSymbols,
              customSymbolCount: input.symbols?.length,
            },
          },
        ),
      {
        name: "secret_generate_password",
        description:
          "Generate a strong password server-side and store it in the encrypted secret store without returning the raw password.",
        schema: generateSecretPasswordSchema,
      },
    ),
    tool(
      async (input) =>
        traceSpan(
          "tool.secret_delete",
          async () => {
            const existed = ctx.secrets.deleteSecret(input.name);
            return existed ? `Deleted secret ${input.name}.` : `Secret ${input.name} was already missing.`;
          },
          { attributes: { name: input.name } },
        ),
      {
        name: "secret_delete",
        description: "Delete one stored secret from the encrypted local secret store.",
        schema: namedSecretSchema,
      },
    ),
  );

  // Config edit
  tools.push(
    tool(
      async (input) =>
        traceSpan(
          "tool.config_edit",
          async () => {
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
              lines.push(await ctx.requestManagedServiceRestart("config_edit"));
            }

            return lines.join("\n");
          },
          { attributes: input },
        ),
      {
        name: "config_edit",
        description:
          "Read, validate, or edit ~/.openelinaro/config.yaml. Supports whole-file reads, path-based set/unset operations, whole-file replacement, schema validation, and optional managed-service restart only after validation succeeds.",
        schema: configEditSchema,
      },
    ),
  );

  // Feature management
  tools.push(
    tool(
      async (input) =>
        traceSpan(
          "tool.feature_manage",
          async () => {
            if (input.action === "status") {
              if (!input.featureId) {
                return ctx.featureConfig.renderStatusReport();
              }
              const status = ctx.featureConfig.getStatus(input.featureId as FeatureId);
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
            ctx.featureConfig.applyChanges({
              featureId: input.featureId as FeatureId,
              enabled: input.enabled,
              values,
            });
            if (input.preparePython) {
              await ctx.shell.exec({
                command: buildPythonSetupCommand(),
                timeoutMs: 20 * 60_000,
              });
            }
            const status = ctx.featureConfig.getStatus(input.featureId as FeatureId);
            const shouldRestart = input.restart ?? true;
            const lines = [
              `Saved ${input.featureId} feature config.`,
              input.preparePython ? "Shared Python runtime setup completed." : "",
              `Status: ${status.active ? "active" : status.enabled ? "enabled but incomplete" : "disabled"}`,
              status.missing.length > 0 ? `Missing: ${status.missing.join(", ")}` : "Missing: none",
            ];

            if (shouldRestart) {
              lines.push(await ctx.requestManagedServiceRestart("feature_manage"));
            }

            return lines.join("\n");
          },
          { attributes: input },
        ),
      {
        name: "feature_manage",
        description:
          "Inspect or update one optional feature block in ~/.openelinaro/config.yaml. Use action=status to see feature readiness, or action=apply to enable/disable a feature, write config values, optionally prepare the shared Python runtime, and restart the managed service by default so new tools activate immediately. Set restart=false only when you intentionally want to defer that restart.",
        schema: z.object({
          action: z.enum(["status", "apply"]),
          featureId: z.enum(["calendar", "email", "communications", "webSearch", "webFetch", "openbrowser", "finance", "tickets", "localVoice", "media"]).optional(),
          enabled: z.boolean().optional(),
          values: z.record(z.string(), z.string()).optional(),
          preparePython: z.boolean().optional(),
          restart: z.boolean().optional(),
        }),
      },
    ),
  );

  // Benchmark
  tools.push(
    tool(
      async (input) =>
        traceSpan(
          "tool.benchmark",
          async () => {
            const modelBenchmark = await ctx.models.benchmarkActiveModel({
              prompt: input.prompt,
              maxTokens: input.maxTokens,
            });
            const embeddingBenchmark = await ctx.memory.benchmarkEmbedding({
              itemCount: input.embeddingItems,
              charsPerItem: input.embeddingChars,
            });

            return [
              "Benchmark results:",
              "",
              `Active model: ${modelBenchmark.providerId}/${modelBenchmark.modelId}`,
              `Thinking: ${ctx.models.getActiveModel().thinkingLevel}`,
              `TTFT: ${formatDurationMs(modelBenchmark.ttftMs)}`,
              `TPS: ${modelBenchmark.tokensPerSecond?.toFixed(2) ?? "n/a"} output tok/s`,
              `Output tokens: ${modelBenchmark.outputTokens} (${modelBenchmark.outputTokenSource})`,
              `Output size: ${modelBenchmark.contentChars} chars`,
              `Generation window: ${formatDurationMs(modelBenchmark.generationLatencyMs)}`,
              `Total latency: ${formatDurationMs(modelBenchmark.totalLatencyMs)}`,
              `Stop reason: ${modelBenchmark.stopReason}`,
              `Prompt length: ${modelBenchmark.prompt.length} chars`,
              `Max tokens cap: ${modelBenchmark.maxTokens}`,
              "",
              `Memory embedding model: ${embeddingBenchmark.modelId}`,
              `Embedding throughput: ${embeddingBenchmark.itemsPerSecond.toFixed(2)} items/s`,
              `Items benchmarked: ${embeddingBenchmark.itemCount}`,
              `Chars per item: ${embeddingBenchmark.charsPerItem}`,
              `Embedding batch size: ${embeddingBenchmark.batchSize}`,
              `Vector dimensions: ${embeddingBenchmark.vectorDimensions}`,
              `Warmup: ${formatDurationMs(embeddingBenchmark.warmupMs)}`,
              `Benchmark duration: ${formatDurationMs(embeddingBenchmark.durationMs)}`,
            ].join("\n");
          },
          { attributes: input },
        ),
      {
        name: "benchmark",
        description:
          "Run a live benchmark for the currently active chat model and the local memory embedding model, reporting TTFT, TPS, and embedding items per second.",
        schema: benchmarkSchema,
      },
    ),
  );

  // Service/deployment tools
  const runUpdatePreview = async (input: z.infer<typeof serviceActionSchema>, operation: string) =>
    traceSpan(
      operation,
      async () => {
        const timeoutMs = input.timeoutMs ?? 60_000;
        const pullResult = await ctx.shell.exec({
          command: buildGitPullCommand(),
          timeoutMs: timeoutMs + 30_000,
        });
        if (pullResult.exitCode !== 0) {
          return `Failed to sync latest version:\n${renderShellExecResult(pullResult)}`;
        }
        const tagResult = await ctx.shell.exec({
          command: buildGitLatestTagCommand(),
          timeoutMs: 10_000,
        });
        const latestTagVersion = tagResult.stdout?.trim() ?? "";
        try {
          return ctx.deploymentVersion.formatAvailableUpdate(latestTagVersion);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return [
            "Fetched tags, but could not determine available update.",
            `Reason: ${detail}`,
          ].join("\n");
        }
      },
      { attributes: input },
    );

  const runUpdate = async (input: z.infer<typeof serviceActionSchema>, operation: string) =>
    traceSpan(
      operation,
      async () => {
        const timeoutMs = input.timeoutMs ?? 60_000;
        // Pull latest tagged version into the source checkout first
        const pullResult = await ctx.shell.exec({
          command: buildGitPullCommand(),
          timeoutMs: timeoutMs + 30_000,
        });
        if (pullResult.exitCode !== 0) {
          return `Failed to pull latest version:\n${renderShellExecResult(pullResult)}`;
        }
        const tagResult = await ctx.shell.exec({
          command: buildGitLatestTagCommand(),
          timeoutMs: 10_000,
        });
        const latestTagVersion = tagResult.exitCode === 0 ? tagResult.stdout?.trim() ?? "" : "";
        if (!ctx.deploymentVersion.hasPreparedUpdate()) {
          return ctx.deploymentVersion.formatPreparedUpdate(latestTagVersion);
        }
        const result = await ctx.shell.exec({
          command: buildServiceCommand("update", timeoutMs, {
            conversationKey: input.conversationKey,
          }),
          timeoutMs: timeoutMs + 180_000,
          sudo: requiresPrivilegedServiceControl(ctx.runtimePlatform, "update"),
        });
        return `${renderShellExecResult(result)}${describeServiceTransition("update")}`;
      },
      { attributes: input },
    );

  tools.push(
    tool(
      async () =>
        traceSpan(
          "tool.service_version",
          async () => ctx.deploymentVersion.formatSummary(),
        ),
      {
        name: "service_version",
        description:
          "Show the stamped deploy version and current release metadata for this runtime.",
        schema: z.object({}),
      },
    ),
    tool(
      async (input) =>
        traceSpan(
          "tool.service_changelog_since_version",
          async () => ctx.deploymentVersion.formatChangelogSinceVersion(
            input.sinceVersion ?? input.version ?? "",
            { limit: input.limit },
          ),
          { attributes: input },
        ),
      {
        name: "service_changelog_since_version",
        description:
          "Show deploy changelog entries whose version is numerically newer than a requested version from the current runtime's DEPLOYMENTS.md metadata.",
        schema: serviceChangelogSinceVersionSchema,
      },
    ),
    tool(
      async (input) =>
        traceSpan(
          "tool.service_healthcheck",
          async () => {
            const timeoutMs = input.timeoutMs ?? 60_000;
            const result = await ctx.shell.exec({
              command: buildServiceCommand("healthcheck", timeoutMs),
              timeoutMs: timeoutMs + 15_000,
              sudo: requiresPrivilegedServiceControl(ctx.runtimePlatform, "healthcheck"),
            });
            return renderShellExecResult(result);
          },
          { attributes: input },
        ),
      {
        name: "service_healthcheck",
        description:
          "Run the live managed-service healthcheck by sending a simulated message to the main agent and waiting up to one minute for HEALTHCHECK_OK.",
        schema: serviceActionSchema,
      },
    ),
    tool(
      async (input) => runUpdatePreview(input, "tool.update_preview"),
      {
        name: "update_preview",
        description:
          "Sync the source checkout without deploying. Shows pending deploy notes after pulling.",
        schema: serviceActionSchema,
      },
    ),
    tool(
      async (input) => runUpdate(input, "tool.update"),
      {
        name: "update",
        description:
          "Deploy the already prepared source version into the local managed installation and verify it with the service healthcheck.",
        schema: serviceActionSchema,
      },
    ),
    tool(
      async (input) =>
        traceSpan(
          "tool.service_rollback",
          async () => {
            const timeoutMs = input.timeoutMs ?? 60_000;
            const result = await ctx.shell.exec({
              command: buildServiceCommand("rollback", timeoutMs, {
                conversationKey: input.conversationKey,
              }),
              timeoutMs: timeoutMs + 180_000,
              sudo: requiresPrivilegedServiceControl(ctx.runtimePlatform, "rollback"),
            });
            return `${renderShellExecResult(result)}${describeServiceTransition("rollback")}`;
          },
          { attributes: input },
        ),
      {
        name: "service_rollback",
        description:
          "Roll the managed service back to the previously deployed release and verify the restored agent with the same simulated healthcheck.",
        schema: serviceActionSchema,
      },
    ),
    tool(
      async () =>
        traceSpan(
          "tool.restart",
          async () => ctx.requestManagedServiceRestart("manual"),
        ),
      {
        name: "restart",
        description:
          "Restart the managed service process. The current process will exit and the service manager will start a fresh instance. Running background agents will resume automatically after restart.",
        schema: z.object({}),
      },
    ),
  );

  return tools;
}
