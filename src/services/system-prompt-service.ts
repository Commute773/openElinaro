import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRuntimeConfig } from "../config/runtime-config";
import { buildAssistantIdentityPromptContext, getAssistantDisplayName } from "../config/runtime-identity";
import { FEATURE_IDS } from "./feature-config-service";
import {
  formatUserDataRelativePath,
  getRepoSystemPromptRoot,
  getUserSystemPromptRoot,
} from "./runtime-user-content";

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

function timestamp() {
  return new Date().toISOString();
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

function buildRuntimeOverviewPrompt() {
  const config = getRuntimeConfig();
  const enabledFeatures = FEATURE_IDS.filter((featureId) => config[featureId].enabled);
  const disabledFeatures = FEATURE_IDS.filter((featureId) => !config[featureId].enabled);
  const configPath = formatUserDataRelativePath("config.yaml");
  const secretStorePath = formatUserDataRelativePath("secret-store.json");
  const coreToggles = [
    `automatic conversation memory ${config.core.app.automaticConversationMemoryEnabled ? "on" : "off"}`,
    `docs indexer ${config.core.app.docsIndexerEnabled ? "on" : "off"}`,
  ].join("; ");

  return [
    "## Runtime",
    "Runtime: OpenElinaro local-first agent runtime.",
    `Core toggles: ${coreToggles}.`,
    `Optional features enabled in config: ${formatPromptList(enabledFeatures)}.`,
    `Optional features disabled in config: ${formatPromptList(disabledFeatures)}.`,
    "Optional feature tools stay hidden until the feature is enabled and fully configured.",
    `To inspect or enable features, use \`feature_manage\` (\`action=status\` then \`action=apply\`) or update ${configPath} and ${secretStorePath}. Run \`bun run setup:python\` for Python-backed features.`,
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
