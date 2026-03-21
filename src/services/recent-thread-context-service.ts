import fs from "node:fs";
import path from "node:path";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { ProfileRecord } from "../domain/profiles";
import { ProfileService } from "./profile-service";
import { ProjectsService } from "./projects-service";
import { resolveRuntimePath, resolveUserDataPath } from "./runtime-root";

export const THREAD_START_CONTEXT_TOKEN_BUDGET = 5_000;
const APPROX_CHARS_PER_TOKEN = 4;
export const THREAD_START_CONTEXT_CHAR_BUDGET =
  THREAD_START_CONTEXT_TOKEN_BUDGET * APPROX_CHARS_PER_TOKEN;
const MAX_MEMORY_FILES = 3;
const MAX_DOC_FILES = 4;
const MAX_MEMORY_EXCERPT_CHARS = 1_400;
const MAX_DOC_EXCERPT_CHARS = 2_200;
const MIN_SECTION_REMAINING_CHARS = 300;

type RecentContextCandidate = {
  kind: "memory" | "doc";
  absolutePath: string;
  relativePath: string;
  modifiedAtMs: number;
  modifiedAt: string;
};

function approximateTokens(text: string) {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

function listMarkdownFiles(root: string) {
  const results: string[] = [];
  if (!fs.existsSync(root)) {
    return results;
  }

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(absolutePath);
      }
    }
  }

  return results;
}

function normalizeExcerpt(content: string, maxChars: number) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let insideFence = false;

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) {
      continue;
    }

    const normalized = line.trimEnd();
    if (!normalized.trim()) {
      if (kept.at(-1) !== "") {
        kept.push("");
      }
      continue;
    }

    kept.push(normalized);
    if (kept.join("\n").length >= maxChars) {
      break;
    }
  }

  const excerpt = kept.join("\n").trim();
  if (!excerpt) {
    return "";
  }
  if (excerpt.length <= maxChars) {
    return excerpt;
  }
  return `${excerpt.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function readExcerpt(absolutePath: string, maxChars: number) {
  try {
    const content = fs.readFileSync(absolutePath, "utf8");
    return normalizeExcerpt(content, maxChars);
  } catch {
    return "";
  }
}

function compareRecent(left: RecentContextCandidate, right: RecentContextCandidate) {
  return right.modifiedAtMs - left.modifiedAtMs;
}

function toRelativePath(root: string, absolutePath: string) {
  return path.relative(root, absolutePath) || path.basename(absolutePath);
}

function isReflectionIdentityPath(relativePath: string) {
  return relativePath.includes("/identity/") || relativePath.endsWith("/identity");
}

export function shouldIncludeRecentThreadContext(messages: BaseMessage[]) {
  return messages.every((message) => !(message instanceof HumanMessage));
}

export class RecentThreadContextService {
  constructor(
    private readonly profile: ProfileRecord,
    private readonly projects: ProjectsService,
    private readonly profiles = new ProfileService(profile.id),
    private readonly repoRoot = process.cwd(),
  ) {}

  buildThreadStartContext() {
    const candidates: RecentContextCandidate[] = [
      ...this.collectRecentMemoryCandidates(),
      ...this.collectRecentDocCandidates(),
    ].sort(compareRecent);

    if (candidates.length === 0) {
      return "";
    }

    const sections = [
      "## Thread-Start Recent Context",
      [
        "Bounded local catch-up snapshot from recent memory markdown and recent docs.",
        "Use it to understand what changed recently without loading the full archive.",
        `Approximate budget target: ${THREAD_START_CONTEXT_TOKEN_BUDGET} tokens.`,
      ].join(" "),
    ];
    let usedChars = sections.join("\n\n").length;

    for (const candidate of candidates) {
      const remainingChars = THREAD_START_CONTEXT_CHAR_BUDGET - usedChars;
      if (remainingChars < MIN_SECTION_REMAINING_CHARS) {
        break;
      }

      const excerpt = readExcerpt(
        candidate.absolutePath,
        Math.min(
          candidate.kind === "memory" ? MAX_MEMORY_EXCERPT_CHARS : MAX_DOC_EXCERPT_CHARS,
          Math.max(0, remainingChars - MIN_SECTION_REMAINING_CHARS),
        ),
      );
      if (!excerpt) {
        continue;
      }

      const section = [
        `### ${candidate.relativePath}`,
        `kind: ${candidate.kind}`,
        `updated_at: ${candidate.modifiedAt}`,
        excerpt,
      ].join("\n");
      sections.push(section);
      usedChars += section.length + 2;
    }

    const text = sections.join("\n\n").trim();
    if (approximateTokens(text) <= THREAD_START_CONTEXT_TOKEN_BUDGET) {
      return text;
    }

    return text.slice(0, THREAD_START_CONTEXT_CHAR_BUDGET).trimEnd();
  }

  private collectRecentMemoryCandidates() {
    const files: RecentContextCandidate[] = [];
    const memoryDocumentRoot = resolveRuntimePath("memory/documents");

    for (const absolutePath of listMarkdownFiles(memoryDocumentRoot)) {
      const relativePath = path.relative(memoryDocumentRoot, absolutePath);
      if (!this.profiles.canReadMemoryPath(this.profile, relativePath)) {
        continue;
      }
      if (isReflectionIdentityPath(relativePath.replaceAll("\\", "/"))) {
        continue;
      }

      const stat = fs.statSync(absolutePath);
      files.push({
        kind: "memory",
        absolutePath,
        relativePath: toRelativePath(this.repoRoot, absolutePath),
        modifiedAtMs: stat.mtimeMs,
        modifiedAt: stat.mtime.toISOString(),
      });
    }

    return files.sort(compareRecent).slice(0, MAX_MEMORY_FILES);
  }

  private collectRecentDocCandidates() {
    const docsRoot = path.resolve(this.repoRoot, "docs");
    const projectDocs = this.projects.listProjects({ status: "active" })
      .flatMap((project) =>
        Object.values(project.docs).map((docPath) => path.resolve(resolveUserDataPath(), docPath))
      )
      .filter((absolutePath) => fs.existsSync(absolutePath))
      .map((absolutePath) => {
        const stat = fs.statSync(absolutePath);
        return {
          kind: "doc" as const,
          absolutePath,
          relativePath: toRelativePath(this.repoRoot, absolutePath),
          modifiedAtMs: stat.mtimeMs,
          modifiedAt: stat.mtime.toISOString(),
        } satisfies RecentContextCandidate;
      })
      .sort(compareRecent)
      .slice(0, Math.max(0, MAX_DOC_FILES - 1));
    const repoDocs = listMarkdownFiles(docsRoot)
      .filter((absolutePath) => {
        const relativePath = path.relative(this.repoRoot, absolutePath);
        return !relativePath.startsWith(`docs${path.sep}research${path.sep}`);
      })
      .filter((absolutePath) => fs.existsSync(absolutePath))
      .map((absolutePath) => {
        const stat = fs.statSync(absolutePath);
        return {
          kind: "doc" as const,
          absolutePath,
          relativePath: toRelativePath(this.repoRoot, absolutePath),
          modifiedAtMs: stat.mtimeMs,
          modifiedAt: stat.mtime.toISOString(),
        } satisfies RecentContextCandidate;
      })
      .sort(compareRecent)
      .slice(0, 1);

    return [...projectDocs, ...repoDocs].sort(compareRecent).slice(0, MAX_DOC_FILES);
  }
}
