import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import { getRuntimeConfig } from "../config/runtime-config";
import { buildAssistantIdentityPromptContext } from "../config/runtime-identity";
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
 * Assemble system prompt sources from two layers:
 *
 * 1. **Universal** (`system_prompt/universal/`): Platform prompts that ship
 *    with the app. Sorted by filename, always included first.
 *
 * 2. **Custom** (`~/.openelinaro/system_prompt/`): Operator-managed prompts.
 *    Sorted by filename, appended after universal. Optional and additive.
 *
 * No merge logic, no override filtering, no in-code defaults.
 */
async function getSystemPromptSources() {
  const customPromptRoot = getUserSystemPromptRoot();
  await mkdir(customPromptRoot, { recursive: true });

  const universalSources = (await listSystemPromptSources(
    getUniversalSystemPromptRoot(),
    (fileName) => path.posix.join("system_prompt", "universal", fileName),
  )).sort((a, b) => a.fileName.localeCompare(b.fileName));

  const customSources = (await listSystemPromptSources(
    customPromptRoot,
    (fileName) => formatUserDataRelativePath("system_prompt", fileName),
  )).sort((a, b) => a.fileName.localeCompare(b.fileName));

  return [...universalSources, ...customSources];
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
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

async function compileFiles(files: SystemPromptSource[]) {
  const runtimeOverview = buildRuntimeOverviewPrompt();
  const identityContext = buildAssistantIdentityPromptContext();
  const memorySection = await buildMemorySection();

  const parts = [runtimeOverview];

  if (files.length > 0) {
    const compiled = (await Promise.all(files
      .map(async (file) => {
        const content = (await Bun.file(file.absolutePath).text()).trim();
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
