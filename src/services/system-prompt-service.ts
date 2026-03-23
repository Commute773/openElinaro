import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRuntimeConfig } from "../config/runtime-config";
import { buildAssistantIdentityPromptContext, getAssistantDisplayName } from "../config/runtime-identity";
import { FeatureConfigService, type FeatureId } from "./feature-config-service";
import { getPromptToolLibraries } from "./tool-library-service";
import {
  formatUserDataRelativePath,
  getRepoSystemPromptRoot,
  getUserSystemPromptRoot,
} from "./runtime-user-content";
import { timestamp } from "../utils/timestamp";

const SYSTEM_PROMPT_EXTENSION = ".md";
export const MAX_SYSTEM_PROMPT_CHARS = 100_000;
function buildFallbackSystemPrompt() {
  return [
    `You are ${getAssistantDisplayName()}, a concise personal assistant.`,
    "Be direct and helpful.",
    "Use tools when they are the correct way to inspect or update state.",
    "Do not claim to have performed actions unless they were completed through a tool call.",
  ].join(" ");
}

export interface SystemPromptSnapshot {
  text: string;
  version: string;
  files: string[];
  root: string;
  loadedAt: string;
  charCount: number;
}

export interface ComposedSystemPrompt {
  text: string;
  charCount: number;
  capped: boolean;
  originalCharCount: number;
}

type SystemPromptSource = {
  absolutePath: string;
  fileName: string;
  displayPath: string;
};

function listSystemPromptSources(root: string, displayPath: (fileName: string) => string) {
  if (!fs.existsSync(root)) {
    return [] as SystemPromptSource[];
  }
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(SYSTEM_PROMPT_EXTENSION))
    .map((entry) => ({
      absolutePath: path.join(root, entry.name),
      fileName: entry.name,
      displayPath: displayPath(entry.name),
    }));
}

function getSystemPromptSources() {
  const userPromptRoot = getUserSystemPromptRoot();
  fs.mkdirSync(userPromptRoot, { recursive: true });

  const repoSources = listSystemPromptSources(
    getRepoSystemPromptRoot(),
    (fileName) => path.posix.join("system_prompt", fileName),
  );
  const userSources = listSystemPromptSources(
    userPromptRoot,
    (fileName) => formatUserDataRelativePath("system_prompt", fileName),
  );

  const mergedByFileName = new Map<string, SystemPromptSource>();
  for (const source of repoSources) {
    mergedByFileName.set(source.fileName, source);
  }
  for (const source of userSources) {
    mergedByFileName.set(source.fileName, source);
  }

  return Array.from(mergedByFileName.values())
    .sort((left, right) => left.fileName.localeCompare(right.fileName));
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function formatPromptList(values: string[]) {
  return values.length > 0 ? values.join(", ") : "none";
}

const FEATURE_TOOL_LIBRARY: Record<FeatureId, string> = {
  calendar: "planning",
  email: "email",
  communications: "communications",
  webSearch: "web_research",
  webFetch: "web_research",
  openbrowser: "browser_automation",
  finance: "finance",
  tickets: "tickets",
  localVoice: "",
  media: "media",
  extensions: "",
};

function buildRuntimeOverviewPrompt() {
  const config = getRuntimeConfig();
  const featureConfig = new FeatureConfigService();
  const statuses = featureConfig.listStatuses();
  const toolLibraries = getPromptToolLibraries();
  const configPath = formatUserDataRelativePath("config.yaml");
  const secretStorePath = formatUserDataRelativePath("secret-store.json");
  const coreToggles = [
    `automatic conversation memory ${config.core.app.automaticConversationMemoryEnabled ? "on" : "off"}`,
    `docs indexer ${config.core.app.docsIndexerEnabled ? "on" : "off"}`,
  ].join("; ");

  const featureLines = statuses.map((s) => {
    const status = s.active ? "active" : s.enabled ? "enabled but not configured" : "off";
    const library = FEATURE_TOOL_LIBRARY[s.featureId];
    const libraryNote = library ? ` (library: ${library})` : "";
    return `  ${s.featureId}: ${status}${libraryNote}`;
  });

  return [
    "## Runtime",
    "Runtime: OpenElinaro local-first agent runtime.",
    `Core toggles: ${coreToggles}.`,
    "Feature status (only active features have their tools available):",
    ...featureLines,
    "Tools for non-active features are completely hidden. Do not attempt to use tools from disabled features.",
    `To inspect or enable features, use \`feature_manage\` (\`action=status\` then \`action=apply\`) or update ${configPath} and ${secretStorePath}. Run \`bun run setup:python\` for Python-backed features.`,
    "Tool libraries load latent tool groups into the active run. Use `load_tool_library` with one library id when the tool you need is not already visible.",
    `Available tool libraries: ${toolLibraries.map((library) => `${library.id} (${library.description})`).join("; ")}.`,
  ].join("\n");
}

function compileFiles(files: SystemPromptSource[]) {
  const runtimeOverview = buildRuntimeOverviewPrompt();
  const identityContext = buildAssistantIdentityPromptContext();
  if (files.length === 0) {
    return `${runtimeOverview}\n\n${buildFallbackSystemPrompt()}\n\n${identityContext}`;
  }

  const compiled = files
    .map((file) => {
      const content = fs.readFileSync(file.absolutePath, "utf8").trim();
      return `<!-- ${file.displayPath} -->\n${content}`;
    })
    .join("\n\n");
  return `${runtimeOverview}\n\n${compiled}\n\n${identityContext}`;
}

function capSystemPrompt(text: string): ComposedSystemPrompt {
  const originalCharCount = text.length;
  const capped = originalCharCount > MAX_SYSTEM_PROMPT_CHARS;
  return {
    text: capped ? text.slice(0, MAX_SYSTEM_PROMPT_CHARS) : text,
    charCount: Math.min(originalCharCount, MAX_SYSTEM_PROMPT_CHARS),
    capped,
    originalCharCount,
  };
}

export function composeSystemPrompt(basePrompt: string, runtimeContext?: string): ComposedSystemPrompt {
  const normalizedContext = runtimeContext?.trim();
  if (!normalizedContext) {
    return capSystemPrompt(basePrompt);
  }
  return capSystemPrompt(`${basePrompt}\n\n## Runtime Context\n${normalizedContext}`);
}

export function formatSystemPromptWarning(prompt: ComposedSystemPrompt) {
  if (!prompt.capped) {
    return undefined;
  }
  return [
    `Warning: the system prompt exceeded ${MAX_SYSTEM_PROMPT_CHARS.toLocaleString()} characters and was truncated.`,
    `Original length: ${prompt.originalCharCount.toLocaleString()} characters.`,
    `Sent length: ${prompt.charCount.toLocaleString()} characters.`,
  ].join(" ");
}

export class SystemPromptService {
  load(): SystemPromptSnapshot {
    const sources = getSystemPromptSources();
    const files = sources.map((source) => source.displayPath);
    const text = compileFiles(sources);

    return {
      text,
      version: sha256(JSON.stringify({
        files,
        text,
      })),
      files,
      root: getUserSystemPromptRoot(),
      loadedAt: timestamp(),
      charCount: text.length,
    };
  }
}
