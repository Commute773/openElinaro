import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { getRuntimeConfig } from "../config/runtime-config";
import { buildAssistantIdentityPromptContext, getAssistantDisplayName } from "../config/runtime-identity";
import { FeatureConfigService, type FeatureId } from "./feature-config-service";
import { getPromptToolLibraries } from "./tool-library-service";
import {
  formatUserDataRelativePath,
  getUniversalSystemPromptRoot,
  getUserSystemPromptRoot,
} from "./runtime-user-content";
import { resolveRuntimePath } from "./runtime-root";
import { timestamp } from "../utils/timestamp";

const SYSTEM_PROMPT_EXTENSION = ".md";
export const MAX_SYSTEM_PROMPT_CHARS = 100_000;

/**
 * Default agent prompts used on fresh installs when the operator has not yet
 * created any files in `~/.openelinaro/system_prompt/`. These live in code so
 * they ship with the app and stay version-controlled alongside the runtime.
 */
export const DEFAULT_AGENT_PROMPTS: readonly DefaultAgentPrompt[] = [
  {
    fileName: "00-foundation.md",
    content: [
      "# Foundation",
      "",
      "You are a local-first personal assistant.",
      "",
      "- Be genuinely useful, not performatively helpful. Skip canned niceties and filler.",
      "- Be direct, competent, and warm when it is real. Personality is good; fake softness is not.",
      "- Have views and make judgments. Say what you think, including likely failure modes.",
      "- Be resourceful before asking. Read files, inspect local state, search docs or memory, then ask only if still blocked.",
      "- Do not claim actions were taken unless a tool call or runtime action actually completed them.",
      "- Continuity does not live only in the current thread. Treat local docs, memory, projects, and runtime state as the durable background.",
    ].join("\n"),
  },
] as const;

export interface DefaultAgentPrompt {
  fileName: string;
  content: string;
}

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
  content?: string;
};

async function listSystemPromptSources(root: string, displayPath: (fileName: string) => string) {
  if (!existsSync(root)) {
    return [] as SystemPromptSource[];
  }
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(SYSTEM_PROMPT_EXTENSION))
    .map((entry) => ({
      absolutePath: path.join(root, entry.name),
      fileName: entry.name,
      displayPath: displayPath(entry.name),
    }));
}

/**
 * Build virtual sources from in-code default agent prompts.
 * These have no file on disk — the content is embedded.
 */
function getDefaultAgentSources(): SystemPromptSource[] {
  return DEFAULT_AGENT_PROMPTS.map((prompt) => ({
    absolutePath: "",
    fileName: prompt.fileName,
    displayPath: `(default) ${prompt.fileName}`,
    content: prompt.content,
  }));
}

/**
 * Assemble system prompt sources from three layers:
 *
 * 1. **Universal** (`system_prompt/universal/`): Platform prompts that apply to
 *    every agent — operating model, docs-and-reload guidance, etc. These are
 *    always included and cannot be overridden by the operator.
 *
 * 2. **Operator** (`~/.openelinaro/system_prompt/`): Agent-specific prompts
 *    managed by the operator — identity, user profile, personality, etc.
 *    These are appended alongside universal prompts. Operator files whose
 *    filename collides with a universal file are skipped (universal wins) to
 *    prevent accidental duplication after migration from the old flat layout.
 *
 * 3. **Defaults** (in-code): Bundled default agent prompts used only when the
 *    operator has not provided any prompts of their own (fresh install).
 *
 * All sources are sorted alphabetically by filename and compiled into the
 * final prompt text.
 */
async function getSystemPromptSources() {
  const userPromptRoot = getUserSystemPromptRoot();
  await mkdir(userPromptRoot, { recursive: true });

  const universalSources = await listSystemPromptSources(
    getUniversalSystemPromptRoot(),
    (fileName) => path.posix.join("system_prompt", "universal", fileName),
  );

  const universalFileNames = new Set(universalSources.map((s) => s.fileName));

  const rawOperatorSources = await listSystemPromptSources(
    userPromptRoot,
    (fileName) => formatUserDataRelativePath("system_prompt", fileName),
  );

  // Skip operator files that collide with universal filenames. These are
  // stale overrides from the old flat layout where operator files could
  // replace repo files. Under the new model universal prompts are
  // authoritative and cannot be overridden.
  const operatorSources = rawOperatorSources.filter(
    (source) => !universalFileNames.has(source.fileName),
  );

  // If the operator has no agent-specific prompts at all, include the
  // in-code defaults so a fresh install still gets a usable foundation.
  const defaultSources = operatorSources.length === 0
    ? getDefaultAgentSources()
    : [];

  const allSources = [...universalSources, ...defaultSources, ...operatorSources];
  return allSources.sort((left, right) => left.fileName.localeCompare(right.fileName));
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
  zigbee2mqtt: "lights",
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

const MEMORY_SKIP_DIRS = new Set(["identity", "compactions"]);

/**
 * Build a memory section for the system prompt.
 * Includes the full MEMORY.md content and a file tree of all structured
 * memory files so the agent knows what exists and can read_file to recall.
 */
async function buildMemorySection(): Promise<string | null> {
  const memoryRoot = resolveRuntimePath("memory");
  // Find the first namespace directory (e.g. "root")
  const namespaces = await readdir(memoryRoot, { withFileTypes: true }).catch(() => []);
  const nsDir = namespaces.find((e) => e.isDirectory() && !e.name.startsWith("."));
  if (!nsDir) return null;

  const nsPath = path.join(memoryRoot, nsDir.name);

  // Read MEMORY.md (core memory index)
  let coreMemory = "";
  const coreMemoryPath = path.join(nsPath, "core", "MEMORY.md");
  try {
    coreMemory = (await Bun.file(coreMemoryPath).text()).trim();
  } catch {
    // Try root-level MEMORY.md as fallback
    try {
      coreMemory = (await Bun.file(path.join(nsPath, "MEMORY.md")).text()).trim();
    } catch {
      // no core memory
    }
  }

  // Build file tree
  const tree: string[] = [];
  async function walk(dir: string, prefix: string) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sorted) {
      if (entry.name.startsWith(".") || entry.name === "INDEX.md") continue;
      if (entry.isDirectory()) {
        if (MEMORY_SKIP_DIRS.has(entry.name)) continue;
        tree.push(`${prefix}${entry.name}/`);
        await walk(path.join(dir, entry.name), prefix + "  ");
      } else if (entry.name.endsWith(".md")) {
        tree.push(`${prefix}${entry.name}`);
      }
    }
  }
  await walk(nsPath, "  ");

  if (!coreMemory && tree.length === 0) return null;

  const memoryDir = formatUserDataRelativePath(`memory/${nsDir.name}`);
  const sections: string[] = ["## Memory"];

  if (coreMemory) {
    sections.push("### Core Memory", coreMemory);
  }

  if (tree.length > 0) {
    sections.push(
      "### Memory Files",
      `Use \`read_file\` on any file below (under ${memoryDir}/) when its topic is relevant to the conversation.`,
      tree.join("\n"),
    );
  }

  return sections.join("\n\n");
}

async function readSourceContent(source: SystemPromptSource): Promise<string> {
  if (source.content !== undefined) {
    return source.content.trim();
  }
  return (await Bun.file(source.absolutePath).text()).trim();
}

async function compileFiles(files: SystemPromptSource[]) {
  const runtimeOverview = buildRuntimeOverviewPrompt();
  const identityContext = buildAssistantIdentityPromptContext();
  const memorySection = await buildMemorySection();

  const parts = [runtimeOverview];

  if (files.length === 0) {
    parts.push(buildFallbackSystemPrompt());
  } else {
    const compiled = (await Promise.all(files
      .map(async (file) => {
        const content = await readSourceContent(file);
        return `<!-- ${file.displayPath} -->\n${content}`;
      })))
      .join("\n\n");
    parts.push(compiled);
  }

  if (memorySection) {
    parts.push(memorySection);
  }

  parts.push(identityContext);
  return parts.join("\n\n");
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
  async load(): Promise<SystemPromptSnapshot> {
    const sources = await getSystemPromptSources();
    const files = sources.map((source) => source.displayPath);
    const text = await compileFiles(sources);

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
