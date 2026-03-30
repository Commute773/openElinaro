import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ProfileRecord } from "../../domain/profiles";
import { ProfileService } from "../profiles";
import { assertTestRuntimeRootIsIsolated, resolveRuntimePath } from "../runtime-root";
import { telemetry } from "../infrastructure/telemetry";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { MemoryService } from "../memory-service";

const structuredMemoryTelemetry = telemetry.child({ component: "structured_memory" });
const traceSpan = createTraceSpan(structuredMemoryTelemetry);

/**
 * Well-known memory categories. Each gets its own subdirectory under
 * `structured/` inside the profile's memory namespace.
 */
export const MEMORY_CATEGORIES = [
  "people",
  "projects",
  "topics",
  "decisions",
  "preferences",
  "tools",
  "incidents",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export type StructuredMemoryEntry = {
  category: MemoryCategory;
  slug: string;
  title: string;
  content: string;
};

export type StructuredMemoryIndex = {
  updatedAt: string;
  categories: Record<string, StructuredMemoryCategoryIndex>;
};

export type StructuredMemoryCategoryIndex = {
  entries: { slug: string; title: string; updatedAt: string }[];
};

const STRUCTURED_ROOT = "structured";
const INDEX_FILENAME = "INDEX.md";

function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function buildEntryFrontmatter(entry: { title: string; category: MemoryCategory; updatedAt: string }) {
  return [
    "---",
    `title: ${entry.title}`,
    `category: ${entry.category}`,
    `updated: ${entry.updatedAt}`,
    "---",
    "",
  ].join("\n");
}

function parseEntryFrontmatter(content: string): { title?: string; category?: string; updatedAt?: string; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { body: content };
  }
  const frontmatter = match[1] ?? "";
  const body = match[2] ?? "";
  const titleMatch = frontmatter.match(/^title:\s*(.+)$/m);
  const categoryMatch = frontmatter.match(/^category:\s*(.+)$/m);
  const updatedMatch = frontmatter.match(/^updated:\s*(.+)$/m);
  return {
    title: titleMatch?.[1]?.trim(),
    category: categoryMatch?.[1]?.trim(),
    updatedAt: updatedMatch?.[1]?.trim(),
    body: body.trim(),
  };
}

function buildCategoryIndexContent(category: string, entries: { slug: string; title: string; updatedAt: string }[]) {
  const sorted = [...entries].sort((a, b) => a.title.localeCompare(b.title));
  const lines = [
    `# ${category.charAt(0).toUpperCase() + category.slice(1)}`,
    "",
    ...sorted.map((entry) => `- [${entry.title}](${entry.slug}.md) — updated ${entry.updatedAt.split("T")[0]}`),
    "",
  ];
  return lines.join("\n");
}

function buildMainIndexContent(index: StructuredMemoryIndex) {
  const lines = [
    "# Structured Memory",
    "",
    `Last updated: ${index.updatedAt.split("T")[0]}`,
    "",
  ];

  for (const [category, categoryIndex] of Object.entries(index.categories)) {
    if (categoryIndex.entries.length === 0) continue;
    const label = category.charAt(0).toUpperCase() + category.slice(1);
    lines.push(`## ${label}`);
    lines.push("");
    for (const entry of categoryIndex.entries.sort((a, b) => a.title.localeCompare(b.title))) {
      lines.push(`- [${entry.title}](${category}/${entry.slug}.md)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export class StructuredMemoryManager {
  private readonly profiles: ProfileService;

  constructor(
    private readonly profile: ProfileRecord,
    private readonly memory: MemoryService,
    profiles?: ProfileService,
  ) {
    this.profiles = profiles ?? new ProfileService(profile.id);
  }

  /**
   * Return the filesystem path for the structured memory root inside the
   * profile's memory namespace.
   */
  private getStructuredRoot() {
    const namespace = this.profiles.getWriteMemoryNamespace(this.profile);
    const memoryDocRoot = resolveRuntimePath("memory");
    return path.join(memoryDocRoot, namespace, STRUCTURED_ROOT);
  }

  private getCategoryDir(category: MemoryCategory) {
    return path.join(this.getStructuredRoot(), category);
  }

  private getEntryPath(category: MemoryCategory, slug: string) {
    return path.join(this.getCategoryDir(category), `${slug}.md`);
  }

  /**
   * Read an existing entry, or return null if it doesn't exist.
   */
  async readEntry(category: MemoryCategory, slug: string): Promise<{ title: string; body: string; raw: string } | null> {
    const entryPath = this.getEntryPath(category, slug);
    try {
      const raw = await Bun.file(entryPath).text();
      const parsed = parseEntryFrontmatter(raw);
      return {
        title: parsed.title ?? slug,
        body: parsed.body,
        raw,
      };
    } catch {
      return null;
    }
  }

  /**
   * List all entries in a category.
   */
  async listCategory(category: MemoryCategory): Promise<{ slug: string; title: string }[]> {
    const categoryDir = this.getCategoryDir(category);
    try {
      const files = await readdir(categoryDir);
      const entries: { slug: string; title: string }[] = [];
      for (const file of files) {
        if (!file.endsWith(".md") || file === INDEX_FILENAME) continue;
        const slug = file.replace(/\.md$/, "");
        const content = await Bun.file(path.join(categoryDir, file)).text().catch(() => null);
        const parsed = content ? parseEntryFrontmatter(content) : { title: undefined, body: "" };
        entries.push({ slug, title: parsed.title ?? slug });
      }
      return entries;
    } catch {
      return [];
    }
  }

  /**
   * Write or update a structured memory entry.
   */
  async upsertEntry(params: {
    category: MemoryCategory;
    slug?: string;
    title: string;
    content: string;
  }): Promise<{ category: MemoryCategory; slug: string; path: string }> {
    return traceSpan(
      "structured_memory.upsert_entry",
      async () => {
        const slug = params.slug ?? slugify(params.title);
        const now = new Date().toISOString();
        const entryPath = this.getEntryPath(params.category, slug);

        assertTestRuntimeRootIsIsolated("Structured memory");
        await mkdir(path.dirname(entryPath), { recursive: true });

        const fullContent = buildEntryFrontmatter({
          title: params.title,
          category: params.category,
          updatedAt: now,
        }) + params.content.trim() + "\n";

        await Bun.write(entryPath, fullContent);

        // Update the category index and main index
        await this.rebuildCategoryIndex(params.category);
        await this.rebuildMainIndex();

        // Trigger reindex in the memory service so hybrid search picks up changes
        this.memory.reindex().catch((error) => {
          structuredMemoryTelemetry.event(
            "structured_memory.reindex_failed",
            { error: error instanceof Error ? error.message : String(error) },
            { level: "warn", outcome: "error" },
          );
        });

        structuredMemoryTelemetry.event("structured_memory.entry_upserted", {
          category: params.category,
          slug,
          title: params.title,
          contentLength: params.content.length,
        });

        return { category: params.category, slug, path: entryPath };
      },
      {
        attributes: {
          category: params.category,
          title: params.title,
        },
      },
    );
  }

  /**
   * Delete a structured memory entry.
   */
  async deleteEntry(category: MemoryCategory, slug: string): Promise<boolean> {
    const entryPath = this.getEntryPath(category, slug);
    const exists = await Bun.file(entryPath).exists();
    if (!exists) return false;

    assertTestRuntimeRootIsIsolated("Structured memory");
    await rm(entryPath, { force: true });
    await this.rebuildCategoryIndex(category);
    await this.rebuildMainIndex();
    return true;
  }

  /**
   * Scan all categories and build the full in-memory index.
   */
  async buildFullIndex(): Promise<StructuredMemoryIndex> {
    const now = new Date().toISOString();
    const categories: Record<string, StructuredMemoryCategoryIndex> = {};

    for (const category of MEMORY_CATEGORIES) {
      const entries = await this.listCategory(category);
      const enriched = await Promise.all(
        entries.map(async (entry) => {
          const entryPath = this.getEntryPath(category, entry.slug);
          const fileStat = await stat(entryPath).catch(() => null);
          return {
            slug: entry.slug,
            title: entry.title,
            updatedAt: fileStat?.mtime?.toISOString() ?? now,
          };
        }),
      );
      if (enriched.length > 0) {
        categories[category] = { entries: enriched };
      }
    }

    return { updatedAt: now, categories };
  }

  /**
   * Rebuild the INDEX.md for a single category.
   */
  private async rebuildCategoryIndex(category: MemoryCategory) {
    const entries = await this.listCategory(category);
    if (entries.length === 0) return;

    const enriched = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = this.getEntryPath(category, entry.slug);
        const fileStat = await stat(entryPath).catch(() => null);
        return {
          slug: entry.slug,
          title: entry.title,
          updatedAt: fileStat?.mtime?.toISOString() ?? new Date().toISOString(),
        };
      }),
    );

    const content = buildCategoryIndexContent(category, enriched);
    const indexPath = path.join(this.getCategoryDir(category), INDEX_FILENAME);
    await Bun.write(indexPath, content);
  }

  /**
   * Rebuild the top-level structured memory INDEX.md.
   */
  private async rebuildMainIndex() {
    const index = await this.buildFullIndex();
    const content = buildMainIndexContent(index);
    const indexPath = path.join(this.getStructuredRoot(), INDEX_FILENAME);
    await mkdir(path.dirname(indexPath), { recursive: true });
    await Bun.write(indexPath, content);
  }

  /** Utility: generate a slug from a display name. */
  static slugify(name: string) {
    return slugify(name);
  }
}
