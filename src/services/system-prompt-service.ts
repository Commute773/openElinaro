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
import { getRuntimeRootDir, getServiceRootDir, getUserDataRootDir, resolveRuntimePath } from "./runtime-root";
import { timestamp } from "../utils/timestamp";
import { attemptOrAsync } from "../utils/result";

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
 * Assemble system prompt sources from three layers:
 *
 * 1. **Universal** (`system_prompt/universal/`): Platform prompts that ship
 *    with the app. Sorted by filename, always included first.
 *
 * 2. **Core** (`system_prompt/cores/{coreId}.md`): Core-specific prompt,
 *    included when a coreId is provided. Contains tool guidance that varies
 *    between agent cores (e.g., PiCore has filesystem/shell tool names,
 *    tool library guidance, browser interaction patterns; ClaudeSdkCore
 *    doesn't need these since the SDK provides its own).
 *
 * 3. **Custom** (`~/.openelinaro/system_prompt/`): Operator-managed prompts.
 *    Sorted by filename, appended after universal. Optional and additive.
 *
 * No merge logic, no override filtering, no in-code defaults.
 */
async function getSystemPromptSources(coreId?: string) {
  const customPromptRoot = getUserSystemPromptRoot();
  await mkdir(customPromptRoot, { recursive: true });

  const universalSources = (await listSystemPromptSources(
    getUniversalSystemPromptRoot(),
    (fileName) => path.posix.join("system_prompt", "universal", fileName),
  )).sort((a, b) => a.fileName.localeCompare(b.fileName));

  // Core-specific prompt: a single file matching the core ID.
  const coreSources: SystemPromptSource[] = [];
  if (coreId) {
    const corePromptPath = path.join(getUniversalSystemPromptRoot(), "..", "cores", `${coreId}.md`);
    if (existsSync(corePromptPath)) {
      coreSources.push({
        absolutePath: corePromptPath,
        fileName: `${coreId}.md`,
        displayPath: path.posix.join("system_prompt", "cores", `${coreId}.md`),
      });
    }
  }

  const customSources = (await listSystemPromptSources(
    customPromptRoot,
    (fileName) => formatUserDataRelativePath("system_prompt", fileName),
  )).sort((a, b) => a.fileName.localeCompare(b.fileName));

  return [...universalSources, ...coreSources, ...customSources];
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

function buildEnvironmentSection() {
  const userDataDir = getUserDataRootDir();
  const runtimeRootDir = getRuntimeRootDir();
  const serviceRootDir = getServiceRootDir();
  const isManagedService = Boolean(process.env.OPENELINARO_SERVICE_ROOT_DIR?.trim());
  const serviceIsSameAsCodebase = path.resolve(serviceRootDir) === path.resolve(runtimeRootDir);

  const lines = [
    "## Environment",
    "",
    `**Workspace** (\`${userDataDir}\`): All mutable state — config, memory, conversations, auth, projects, routines, logs. This is where you live. Read from and write to paths here for anything that persists across conversations.`,
    "",
    `**Codebase** (\`${runtimeRootDir}\`): The source repository that defines the runtime — \`src/\`, \`system_prompt/\`, \`profiles/\`, \`projects/\` (bundled defaults). System prompt files, tool definitions, domain logic, and platform docs all live here.`,
    "",
  ];

  if (serviceIsSameAsCodebase) {
    lines.push(
      `**Deployed service**: Running directly from the codebase. Code changes here take effect on restart.`,
    );
  } else {
    lines.push(
      `**Deployed service** (\`${serviceRootDir}\`): The installed/deployed copy of the runtime that is actually executing. This is separate from the codebase — changes to the codebase do not affect the running service until explicitly deployed via \`/update\`.`,
    );
  }

  if (isManagedService) {
    lines.push(
      "",
      "This is a managed deployment. The codebase is the development checkout; the service root is the deployed release. Use `service_version` to check deployed state.",
    );
  }

  return lines.join("\n");
}

function buildRuntimeOverviewPrompt(coreId?: string) {
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

  // Tool library names are useful context for all cores, but the
  // load_tool_library instruction is only relevant for cores that use it
  // (i.e., not claude-sdk which has its own tool loading).
  const isClaudeSdk = coreId === "claude-sdk";
  const includeToolLibraryGuidance = !isClaudeSdk;

  // Features the Claude SDK provides natively — skip them from the prompt.
  const CLAUDE_SDK_NATIVE_FEATURES: Set<FeatureId> = new Set(["webSearch", "webFetch"]);

  const featureLines = statuses
    .filter((s) => !(isClaudeSdk && CLAUDE_SDK_NATIVE_FEATURES.has(s.featureId)))
    .map((s) => {
      const status = s.active ? "active" : s.enabled ? "enabled but not configured" : "off";
      const library = FEATURE_TOOL_LIBRARY[s.featureId];
      const libraryNote = includeToolLibraryGuidance && library ? ` (library: ${library})` : "";
      return `  ${s.featureId}: ${status}${libraryNote}`;
    });

  const lines = [
    buildEnvironmentSection(),
    "",
    "## Runtime",
    "Runtime: OpenElinaro local-first agent runtime.",
    `Core toggles: ${coreToggles}.`,
    "Feature status (only active features have their tools available):",
    ...featureLines,
    "Tools for non-active features are completely hidden. Do not attempt to use tools from disabled features.",
    `To inspect or enable features, use \`feature_manage\` (\`action=status\` then \`action=apply\`) or update ${configPath} and ${secretStorePath}. Run \`bun run setup:python\` for Python-backed features.`,
  ];

  if (includeToolLibraryGuidance) {
    lines.push(
      "Tool libraries load latent tool groups into the active run. Use `load_tool_library` with one library id when the tool you need is not already visible.",
      `Available tool libraries: ${toolLibraries.map((library) => `${library.id} (${library.description})`).join("; ")}.`,
    );
  }

  return lines.join("\n");
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
  const namespaces = await attemptOrAsync(() => readdir(memoryRoot, { withFileTypes: true }), []);
  const nsDir = namespaces.find((e) => e.isDirectory() && !e.name.startsWith("."));
  if (!nsDir) return null;

  const nsPath = path.join(memoryRoot, nsDir.name);

  // Read MEMORY.md (core memory index)
  const coreMemoryPath = path.join(nsPath, "core", "MEMORY.md");
  const coreMemory = await attemptOrAsync(
    async () => (await Bun.file(coreMemoryPath).text()).trim(),
    // Try root-level MEMORY.md as fallback
    await attemptOrAsync(
      async () => (await Bun.file(path.join(nsPath, "MEMORY.md")).text()).trim(),
      "",
    ),
  );

  // Build file tree
  const tree: string[] = [];
  async function walk(dir: string, prefix: string) {
    const entries = await attemptOrAsync(() => readdir(dir, { withFileTypes: true }), []);
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
      `Read any file below (under ${memoryDir}/) when its topic is relevant to the conversation.`,
      tree.join("\n"),
    );
  }

  return sections.join("\n\n");
}

async function compileFiles(files: SystemPromptSource[], coreId?: string) {
  const runtimeOverview = buildRuntimeOverviewPrompt(coreId);
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
  async load(coreId?: string): Promise<SystemPromptSnapshot> {
    const sources = await getSystemPromptSources(coreId);
    const files = sources.map((source) => source.displayPath);
    const text = await compileFiles(sources, coreId);

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
