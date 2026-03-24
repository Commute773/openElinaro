import fs from "node:fs";
import path from "node:path";
import { getRuntimeConfig } from "../config/runtime-config";
import { getLocalTimezone } from "./local-time-service";
import { assertTestRuntimeRootIsIsolated, getRuntimeRootDir, resolveRuntimePath } from "./runtime-root";
import { telemetry } from "./telemetry";

type DocsSection = "assistant" | "research" | "other";

export interface DocsIndexEntry {
  path: string;
  title: string;
  section: DocsSection;
  inboundReferences: string[];
}

export interface DocsIndexReport {
  generatedAt: string;
  rootDir: string;
  docs: DocsIndexEntry[];
  orphanDocs: string[];
  missingDocTargets: Array<{
    source: string;
    target: string;
  }>;
  managedFiles: string[];
  changedFiles: string[];
  repoSnapshot: {
    topLevelPaths: string[];
  };
}

type DocsInventory = {
  docs: Array<{
    path: string;
    title: string;
    section: DocsSection;
  }>;
  managedFiles: string[];
};

const docsIndexTelemetry = telemetry.child({ component: "docs" });
const DOCS_INDEX_ENV_KEY = "core.app.docsIndexerEnabled";
const REPORT_PATH = resolveRuntimePath("docs-index.json");
const BLOCK_START_PREFIX = "<!-- docs-index:start:";
const BLOCK_END_PREFIX = "<!-- docs-index:end:";
const ASSISTANT_CORE_DOCS = [
  "docs/assistant/repo-layout.md",
  "docs/assistant/architecture-decisions.md",
  "docs/assistant/runtime-domain-model.md",
  "docs/assistant/projects.md",
  "docs/assistant/memory.md",
  "docs/assistant/observability.md",
  "docs/assistant/reflection.md",
  "docs/assistant/tickets.md",
  "docs/assistant/media.md",
] as const;
const ASSISTANT_BEHAVIOR_DOCS = [
  "docs/assistant/decision-support.md",
  "docs/assistant/openclaw-migration.md",
] as const;
const ASSISTANT_OPERATOR_DOCS = [
  "docs/assistant/tool-use-playbook.md",
  "docs/assistant/harness-smoke-tests.md",
] as const;
const TOP_LEVEL_REPO_PATHS = [
  "src",
  "system_prompt",
  "profiles",
  "docs",
  "scripts",
  "projects",
  "README.md",
  "AGENTS.md",
] as const;

function walkMarkdownFiles(directoryPath: string): string[] {
  if (!fs.existsSync(directoryPath)) {
    return [];
  }

  const results: string[] = [];
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolutePath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMarkdownFiles(absolutePath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(absolutePath);
    }
  }
  return results;
}

function readMarkdownTitle(filePath: string) {
  const text = fs.readFileSync(filePath, "utf8");
  const heading = text.match(/^#\s+(.+)$/m);
  return heading?.[1]?.trim() || path.basename(filePath);
}

function toPosixPath(value: string) {
  return value.split(path.sep).join("/");
}

function stripMarkdownAnchor(target: string) {
  return target.split("#")[0]?.split("?")[0]?.trim() || "";
}

function isExternalMarkdownTarget(target: string) {
  return /^[a-z]+:/i.test(target) || target.startsWith("//") || target.startsWith("#");
}

function resolveMarkdownTarget(rootDir: string, sourcePath: string, href: string) {
  const stripped = stripMarkdownAnchor(href);
  if (!stripped || isExternalMarkdownTarget(stripped) || !stripped.endsWith(".md")) {
    return null;
  }

  const sourceDirectory = path.dirname(path.join(rootDir, sourcePath));
  return toPosixPath(path.relative(rootDir, path.resolve(sourceDirectory, stripped)));
}

function extractMarkdownTargets(rootDir: string, sourcePath: string, content: string) {
  const matches = content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g);
  return Array.from(matches, (match) => resolveMarkdownTarget(rootDir, sourcePath, match[1] ?? ""))
    .filter((value): value is string => Boolean(value));
}

function renderMarkdownLinks(fromPath: string, docPaths: string[], docTitleMap: Map<string, string>) {
  return docPaths
    .map((docPath) => {
      const relativeTarget = toPosixPath(path.relative(path.dirname(fromPath), docPath)) || path.basename(docPath);
      return `[${docTitleMap.get(docPath) ?? docPath}](${relativeTarget})`;
    })
    .join(", ");
}

function renderPathList(docPaths: string[]) {
  return docPaths.map((docPath) => `- \`${docPath}\``).join("\n");
}

function replaceManagedBlock(content: string, blockId: string, body: string) {
  const startMarker = `${BLOCK_START_PREFIX}${blockId} -->`;
  const endMarker = `${BLOCK_END_PREFIX}${blockId} -->`;
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`Missing docs-index block markers for ${blockId}.`);
  }

  const before = content.slice(0, startIndex + startMarker.length);
  const after = content.slice(endIndex);
  return `${before}\n${body}\n${after}`;
}

function localDateParts(reference: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(reference);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error(`Unable to resolve local date in timezone ${timezone}.`);
  }
  return { year, month, day };
}

function resolveTimezoneOffsetMinutes(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const token = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
  const match = token.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
  if (!match) {
    return 0;
  }
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number.parseInt(match[2] ?? "0", 10);
  const minutes = Number.parseInt(match[3] ?? "0", 10);
  return sign * (hours * 60 + minutes);
}

export class DocsIndexService {
  constructor(
    private readonly rootDir = getRuntimeRootDir(),
    private readonly reportPath = REPORT_PATH,
  ) {}

  isEnabled() {
    return getRuntimeConfig().core.app.docsIndexerEnabled;
  }

  getNextScheduledRunAt(reference = new Date(), timezone = getLocalTimezone()) {
    const nextReference = new Date(reference.getTime() + 24 * 60 * 60 * 1000);
    const nextDate = localDateParts(nextReference, timezone);
    const nextUtc = Date.UTC(
      Number.parseInt(nextDate.year, 10),
      Number.parseInt(nextDate.month, 10) - 1,
      Number.parseInt(nextDate.day, 10),
      0,
      0,
      0,
      0,
    );
    return new Date(nextUtc - resolveTimezoneOffsetMinutes(nextReference, timezone) * 60_000);
  }

  sync() {
    assertTestRuntimeRootIsIsolated("Docs index");
    const inventory = this.collectInventory();
    const changedFiles = this.writeManagedFiles(inventory);
    const report = this.buildReport(inventory, changedFiles);
    fs.mkdirSync(path.dirname(this.reportPath), { recursive: true });
    fs.writeFileSync(this.reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    docsIndexTelemetry.event("docs.sync.completed", {
      rootDir: this.rootDir,
      changedFiles,
      orphanDocs: report.orphanDocs.length,
      missingDocTargets: report.missingDocTargets.length,
    });
    return report;
  }

  private collectInventory(): DocsInventory {
    const docsRoot = path.join(this.rootDir, "docs");
    const docs = walkMarkdownFiles(docsRoot)
      .map((absolutePath) => {
        const relativePath = toPosixPath(path.relative(this.rootDir, absolutePath));
        const section: DocsSection = relativePath.startsWith("docs/assistant/")
          ? "assistant"
          : relativePath.startsWith("docs/research/")
            ? "research"
            : "other";
        return {
          path: relativePath,
          title: readMarkdownTitle(absolutePath),
          section,
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));

    return {
      docs,
      managedFiles: [
        "AGENTS.md",
        "docs/README.md",
        "docs/assistant/README.md",
        "docs/research/README.md",
        "system_prompt/universal/40-docs-and-reload.md",
      ],
    };
  }

  private writeManagedFiles(inventory: DocsInventory) {
    const docTitleMap = new Map(inventory.docs.map((entry) => [entry.path, entry.title]));
    const assistantDocs = inventory.docs
      .filter((entry) => entry.section === "assistant" && entry.path !== "docs/assistant/README.md")
      .map((entry) => entry.path);
    const researchDocs = inventory.docs
      .filter((entry) => entry.section === "research" && entry.path !== "docs/research/README.md")
      .map((entry) => entry.path);
    const otherDocs = inventory.docs
      .filter((entry) => entry.section === "other" && entry.path !== "docs/README.md")
      .map((entry) => entry.path);
    const assistantCoreDocs = ASSISTANT_CORE_DOCS.filter((entry) => assistantDocs.includes(entry));
    const assistantBehaviorDocs = ASSISTANT_BEHAVIOR_DOCS.filter((entry) => assistantDocs.includes(entry));
    const assistantOperatorDocs = ASSISTANT_OPERATOR_DOCS.filter((entry) => assistantDocs.includes(entry));
    const assistantAdditionalDocs = assistantDocs.filter((entry) =>
      !assistantCoreDocs.includes(entry as typeof ASSISTANT_CORE_DOCS[number])
      && !assistantBehaviorDocs.includes(entry as typeof ASSISTANT_BEHAVIOR_DOCS[number])
      && !assistantOperatorDocs.includes(entry as typeof ASSISTANT_OPERATOR_DOCS[number])
    );
    const changedFiles: string[] = [];

    const updates = new Map<string, string>([
      ["AGENTS.md", replaceManagedBlock(
        fs.readFileSync(path.join(this.rootDir, "AGENTS.md"), "utf8"),
        "doc-entrypoints",
        [
          "- [docs/README.md](docs/README.md)",
          "- [docs/assistant/README.md](docs/assistant/README.md)",
          "- [docs/research/README.md](docs/research/README.md)",
        ].join("\n"),
      )],
      ["docs/README.md", replaceManagedBlock(
        fs.readFileSync(path.join(this.rootDir, "docs/README.md"), "utf8"),
        "inventory",
        [
          `- Assistant docs index: ${renderMarkdownLinks("docs/README.md", ["docs/assistant/README.md"], docTitleMap)}`,
          `- Research notes index: ${renderMarkdownLinks("docs/README.md", ["docs/research/README.md"], docTitleMap)}`,
          `- Other repo docs: ${otherDocs.length > 0 ? renderMarkdownLinks("docs/README.md", otherDocs, docTitleMap) : "none"}`,
          `- Coverage snapshot: ${inventory.docs.length} docs indexed.`,
        ].join("\n"),
      )],
      ["docs/assistant/README.md", replaceManagedBlock(
        fs.readFileSync(path.join(this.rootDir, "docs/assistant/README.md"), "utf8"),
        "inventory",
        [
          `- Core maps: ${renderMarkdownLinks("docs/assistant/README.md", [...assistantCoreDocs], docTitleMap)}`,
          `- Agent behavior: ${renderMarkdownLinks("docs/assistant/README.md", [...assistantBehaviorDocs], docTitleMap)}`,
          `- Operator and validation docs: ${renderMarkdownLinks("docs/assistant/README.md", [...assistantOperatorDocs], docTitleMap)}`,
          `- Additional assistant docs: ${assistantAdditionalDocs.length > 0 ? renderMarkdownLinks("docs/assistant/README.md", assistantAdditionalDocs, docTitleMap) : "none"}`,
        ].join("\n"),
      )],
      ["docs/research/README.md", replaceManagedBlock(
        fs.readFileSync(path.join(this.rootDir, "docs/research/README.md"), "utf8"),
        "inventory",
        researchDocs.length > 0
          ? researchDocs
            .map((docPath) => `- ${renderMarkdownLinks("docs/research/README.md", [docPath], docTitleMap)}`)
            .join("\n")
          : "- none",
      )],
      ["system_prompt/universal/40-docs-and-reload.md", replaceManagedBlock(
        fs.readFileSync(path.join(this.rootDir, "system_prompt/universal/40-docs-and-reload.md"), "utf8"),
        "assistant-docs",
        renderPathList(["docs/assistant/README.md", ...assistantDocs]),
      )],
    ]);

    for (const [relativePath, nextContent] of updates.entries()) {
      const absolutePath = path.join(this.rootDir, relativePath);
      const currentContent = fs.readFileSync(absolutePath, "utf8");
      if (currentContent === nextContent) {
        continue;
      }
      fs.writeFileSync(absolutePath, nextContent, "utf8");
      changedFiles.push(relativePath);
    }

    return changedFiles.sort((left, right) => left.localeCompare(right));
  }

  private buildReport(inventory: DocsInventory, changedFiles: string[]): DocsIndexReport {
    const markdownSources = [
      ...inventory.docs.map((entry) => entry.path),
      "AGENTS.md",
      "README.md",
      "system_prompt/universal/40-docs-and-reload.md",
    ]
      .filter((relativePath, index, values) => values.indexOf(relativePath) === index)
      .filter((relativePath) => fs.existsSync(path.join(this.rootDir, relativePath)));
    const inboundRefs = new Map<string, string[]>();
    const missingDocTargets = new Map<string, { source: string; target: string }>();

    for (const sourcePath of markdownSources) {
      const content = fs.readFileSync(path.join(this.rootDir, sourcePath), "utf8");
      for (const targetPath of extractMarkdownTargets(this.rootDir, sourcePath, content)) {
        if (targetPath.startsWith("docs/")) {
          if (inventory.docs.some((entry) => entry.path === targetPath)) {
            const refs = inboundRefs.get(targetPath) ?? [];
            refs.push(sourcePath);
            inboundRefs.set(targetPath, refs);
          } else {
            const key = `${sourcePath}:${targetPath}`;
            missingDocTargets.set(key, { source: sourcePath, target: targetPath });
          }
        }
      }
    }

    const docs = inventory.docs.map((entry) => ({
      ...entry,
      inboundReferences: (inboundRefs.get(entry.path) ?? []).sort((left, right) => left.localeCompare(right)),
    }));
    const orphanDocs = docs
      .filter((entry) => entry.inboundReferences.length === 0)
      .map((entry) => entry.path)
      .sort((left, right) => left.localeCompare(right));

    return {
      generatedAt: new Date().toISOString(),
      rootDir: this.rootDir,
      docs,
      orphanDocs,
      missingDocTargets: Array.from(missingDocTargets.values()).sort((left, right) =>
        `${left.source}:${left.target}`.localeCompare(`${right.source}:${right.target}`),
      ),
      managedFiles: inventory.managedFiles,
      changedFiles,
      repoSnapshot: {
        topLevelPaths: TOP_LEVEL_REPO_PATHS
          .filter((entry) => fs.existsSync(path.join(this.rootDir, entry)))
          .map((entry) => entry),
      },
    };
  }
}

export { DOCS_INDEX_ENV_KEY, REPORT_PATH as DOCS_INDEX_REPORT_PATH };
