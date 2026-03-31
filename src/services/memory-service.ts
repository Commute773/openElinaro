import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ProfileRecord } from "../domain/profiles";
import { attemptOrAsync } from "../utils/result";
import { ProfileService } from "./profiles";
import { assertTestRuntimeRootIsIsolated, resolveRuntimePath } from "./runtime-root";

function getMemoryDocumentRoot() {
  return resolveRuntimePath("memory");
}

async function ensureDirectory(targetPath: string) {
  await mkdir(targetPath, { recursive: true });
}

function timestampForFilename(date: Date) {
  return date.toISOString().replaceAll(":", "-");
}

type WriteNoteParams = {
  content: string;
  subdirectory?: string;
  createdAt?: Date;
};

type UpsertMemoryDocumentParams = {
  relativePath: string;
  content: string;
};

/**
 * Lightweight memory file service.
 * Manages markdown documents in the runtime memory directory under profile namespaces.
 * Provides read, write, and delete operations without search or embedding infrastructure.
 */
export class MemoryService {
  constructor(
    private readonly profile: ProfileRecord,
    private readonly profiles = new ProfileService(profile.id),
  ) {}

  /** No-op for backward compatibility. */
  async ensureReady() {}

  async upsertProfileDocument(params: UpsertMemoryDocumentParams) {
    const relativePath = path.join(
      this.profiles.getWriteMemoryNamespace(this.profile),
      params.relativePath,
    );
    return this.upsertDocument({
      relativePath,
      content: params.content,
    });
  }

  async readProfileDocument(relativePath: string) {
    const namespacedPath = path.join(
      this.profiles.getWriteMemoryNamespace(this.profile),
      relativePath,
    );
    const targetPath = path.join(getMemoryDocumentRoot(), namespacedPath);
    return attemptOrAsync(() => Bun.file(targetPath).text(), null);
  }

  async deleteProfileDocument(relativePath: string) {
    const namespacedPath = path.join(
      this.profiles.getWriteMemoryNamespace(this.profile),
      relativePath,
    );
    return this.deleteDocument(namespacedPath);
  }

  async writeNote(params: WriteNoteParams) {
    const content = params.content.trim();
    if (!content) {
      return null;
    }

    const createdAt = params.createdAt ?? new Date();
    const filename = `${timestampForFilename(createdAt)}.md`;
    const targetDirectory = path.join(
      getMemoryDocumentRoot(),
      this.profiles.getWriteMemoryNamespace(this.profile),
      params.subdirectory ?? "",
    );
    const targetPath = path.join(targetDirectory, filename);
    const relativePath = path.relative(getMemoryDocumentRoot(), targetPath);
    await this.upsertDocument({
      relativePath,
      content: `${content}\n`,
    });
    return targetPath;
  }

  private async upsertDocument(params: UpsertMemoryDocumentParams) {
    const relativePath = path.normalize(params.relativePath).replaceAll("\\", "/");
    const content = params.content.trimEnd();
    if (!content.trim()) {
      throw new Error("memory document content is required");
    }

    const targetPath = path.join(getMemoryDocumentRoot(), relativePath);
    assertTestRuntimeRootIsIsolated("Memory store");
    await ensureDirectory(path.dirname(targetPath));
    await Bun.write(targetPath, `${content}\n`);
    return targetPath;
  }

  private async deleteDocument(relativePath: string) {
    const normalizedPath = path.normalize(relativePath).replaceAll("\\", "/");
    const targetPath = path.join(getMemoryDocumentRoot(), normalizedPath);
    const existed = await Bun.file(targetPath).exists();
    if (!existed) {
      return false;
    }

    assertTestRuntimeRootIsIsolated("Memory store");
    await rm(targetPath, { force: true });
    return true;
  }
}
