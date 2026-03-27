import crypto from "node:crypto";
import { rm, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ProfileRecord } from "../domain/profiles";
import { ProfileService } from "./profile-service";
import { assertTestRuntimeRootIsIsolated, resolveRuntimePath } from "./runtime-root";
import { telemetry } from "./telemetry";
import { createTraceSpan } from "../utils/telemetry-helpers";
import {
  buildDocumentFrequencies,
  countTerms,
  dotProduct,
  extractContextSnippet,
  rankHybridMatches,
  scoreBm25,
  tokenize,
} from "./hybrid-search";
import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_MODEL_ID,
  embedTexts,
} from "./text-embedding-service";

const INDEX_VERSION = 1;
const MAX_CHUNK_CHARS = 1_200;
const CHUNK_OVERLAP_CHARS = 180;
const memoryTelemetry = telemetry.child({ component: "memory" });

function getMemoryStoreRoot() {
  return resolveRuntimePath("memory");
}

function getMemoryDocumentRoot() {
  return path.join(getMemoryStoreRoot(), "documents");
}

const traceSpan = createTraceSpan(memoryTelemetry);

type MemoryDocumentRecord = {
  id: string;
  relativePath: string;
  sourcePath: string;
  copiedPath: string;
  hash: string;
  size: number;
  modifiedAt: string;
};

type MemoryChunkRecord = {
  id: string;
  documentId: string;
  relativePath: string;
  copiedPath: string;
  heading: string;
  text: string;
  vector: number[];
  tokenCount: number;
  termFrequencies: Record<string, number>;
};

type MemoryIndex = {
  version: number;
  builtAt: string;
  modelId: string;
  sourceRoot: string;
  documentRoot: string;
  documents: MemoryDocumentRecord[];
  chunks: MemoryChunkRecord[];
  documentFrequencies: Record<string, number>;
  averageChunkLength: number;
};

type MemorySearchResult = {
  chunk: MemoryChunkRecord;
  score: number;
  vectorScore: number;
  bm25Score: number;
};

export type MemorySearchMatch = {
  relativePath: string;
  copiedPath: string;
  heading: string;
  text: string;
  score: number;
  vectorScore: number;
  bm25Score: number;
};

type SearchParams = {
  query: string;
  limit?: number;
  pathPrefixes?: string[];
  excludePathPrefixes?: string[];
  minScore?: number;
};

type ReindexSummary = {
  sourceRoot: string;
  documentRoot: string;
  indexedDocuments: number;
  indexedChunks: number;
  modelId: string;
};

type WriteNoteParams = {
  content: string;
  subdirectory?: string;
  createdAt?: Date;
};

type UpsertMemoryDocumentParams = {
  relativePath: string;
  content: string;
};

export type EmbeddingBenchmarkSummary = {
  modelId: string;
  itemCount: number;
  charsPerItem: number;
  warmupMs: number;
  durationMs: number;
  itemsPerSecond: number;
  batchSize: number;
  vectorDimensions: number;
};

type MarkdownSegment = {
  heading: string;
  text: string;
};

function sha256(content: string) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function splitSegmentText(text: string) {
  const chunks: string[] = [];
  const normalized = text.trim();
  if (!normalized) {
    return chunks;
  }

  const step = Math.max(1, MAX_CHUNK_CHARS - CHUNK_OVERLAP_CHARS);
  let offset = 0;
  while (offset < normalized.length) {
    const nextOffset = Math.min(normalized.length, offset + MAX_CHUNK_CHARS);
    const window = normalized.slice(offset, nextOffset).trim();
    if (window) {
      chunks.push(window);
    }
    if (nextOffset >= normalized.length) {
      break;
    }
    offset += step;
  }

  return chunks;
}

function chunkMarkdown(document: MemoryDocumentRecord, content: string): Omit<MemoryChunkRecord, "vector">[] {
  const lines = content.split(/\r?\n/);
  const segments: MarkdownSegment[] = [];
  const defaultHeading = path.basename(document.relativePath, path.extname(document.relativePath));
  let activeHeading = defaultHeading;
  let buffer: string[] = [];

  const flushBuffer = () => {
    const text = buffer.join("\n").trim();
    if (text) {
      segments.push({ heading: activeHeading, text });
    }
    buffer = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (headingMatch) {
      flushBuffer();
      activeHeading = headingMatch[1] ?? defaultHeading;
      continue;
    }

    if (!line.trim()) {
      flushBuffer();
      continue;
    }

    buffer.push(line);
  }
  flushBuffer();

  const chunks: Omit<MemoryChunkRecord, "vector">[] = [];
  const sourceSegments = segments.length > 0 ? segments : [{ heading: defaultHeading, text: content.trim() }];
  let chunkIndex = 0;

  for (const segment of sourceSegments) {
    for (const body of splitSegmentText(segment.text)) {
      const text = `${segment.heading}\n\n${body}`.trim();
      const tokens = tokenize(text);
      chunks.push({
        id: `${document.id}#${chunkIndex + 1}`,
        documentId: document.id,
        relativePath: document.relativePath,
        copiedPath: document.copiedPath,
        heading: segment.heading,
        text,
        tokenCount: tokens.length,
        termFrequencies: countTerms(tokens),
      });
      chunkIndex += 1;
    }
  }

  return chunks;
}

function buildBenchmarkEmbeddingText(index: number, charsPerItem: number) {
  const seed = [
    `benchmark item ${index + 1}`,
    "memory embedding throughput sample",
    "local markdown retrieval chunk",
    "deterministic repeated text for stable measurement",
  ].join(" ");
  let text = seed;
  while (text.length < charsPerItem) {
    text += ` ${seed}`;
  }
  return text.slice(0, charsPerItem);
}

function formatSearchResults(query: string, results: MemorySearchResult[]) {
  if (results.length === 0) {
    return `No memory hits found for "${query}".`;
  }

  return [
    `Memory hits for "${query}":`,
    ...results.map(
      (result, index) =>
        [
          `${index + 1}. ${result.chunk.relativePath}`,
          `heading: ${result.chunk.heading}`,
          `scores: hybrid=${result.score.toFixed(4)} vector=${result.vectorScore.toFixed(4)} bm25=${result.bm25Score.toFixed(4)}`,
          `excerpt: ${extractContextSnippet(result.chunk.text, query, 130)}`,
        ].join("\n"),
    ),
  ].join("\n\n");
}

async function ensureDirectory(targetPath: string) {
  await mkdir(targetPath, { recursive: true });
}

async function resolveAbsolutePath(targetPath: string) {
  return path.isAbsolute(targetPath) ? path.normalize(targetPath) : path.resolve(targetPath);
}

function timestampForFilename(date: Date) {
  return date.toISOString().replaceAll(":", "-");
}

function createEmptyIndex(documentRoot: string): MemoryIndex {
  return {
    version: INDEX_VERSION,
    builtAt: new Date().toISOString(),
    modelId: EMBEDDING_MODEL_ID,
    sourceRoot: documentRoot,
    documentRoot,
    documents: [],
    chunks: [],
    documentFrequencies: {},
    averageChunkLength: 0,
  };
}

async function removeMissingCopiedDocuments(keptRelativePaths: Set<string>) {
  const memoryDocumentRoot = getMemoryDocumentRoot();
  await ensureDirectory(memoryDocumentRoot);
  const glob = new Bun.Glob("**/*");
  for await (const relativePath of glob.scan({ cwd: memoryDocumentRoot, onlyFiles: false })) {
    const absolutePath = path.join(memoryDocumentRoot, relativePath);
    const fileStat = await stat(absolutePath).catch(() => null);
    if (!fileStat?.isFile()) {
      continue;
    }
    if (keptRelativePaths.has(relativePath)) {
      continue;
    }
    await rm(absolutePath, { force: true });
  }
}

export class MemoryService {
  private index: MemoryIndex | null = null;
  private initializePromise: Promise<MemoryIndex> | null = null;

  constructor(
    private readonly profile: ProfileRecord,
    private readonly profiles = new ProfileService(profile.id),
  ) {}

  ensureReady() {
    return this.loadOrBuildIndex();
  }

  async importFromDirectory(sourcePath: string) {
    return traceSpan(
      "memory.import",
      async () => {
        const resolvedSource = await resolveAbsolutePath(sourcePath);
        const sourceStat = await stat(resolvedSource).catch(() => null);
        if (!sourceStat?.isDirectory()) {
          throw new Error(`Memory source directory not found: ${resolvedSource}`);
        }

        const memoryDocumentRoot = getMemoryDocumentRoot();
        await ensureDirectory(memoryDocumentRoot);
        const importedRelativePaths = new Set<string>();
        const glob = new Bun.Glob("**/*.md");
        for await (const relativePath of glob.scan({ cwd: resolvedSource, onlyFiles: true })) {
          const fromPath = path.join(resolvedSource, relativePath);
          const toPath = path.join(
            memoryDocumentRoot,
            this.profiles.getWriteMemoryNamespace(this.profile),
            relativePath,
          );
          const content = await Bun.file(fromPath).text();
          await ensureDirectory(path.dirname(toPath));
          await Bun.write(toPath, content);
          importedRelativePaths.add(
            path.join(this.profiles.getWriteMemoryNamespace(this.profile), relativePath),
          );
        }
        const index = await this.loadOrBuildIndex(true);
        return {
          sourceRoot: resolvedSource,
          documentRoot: index.documentRoot,
          indexedDocuments: index.documents.length,
          indexedChunks: index.chunks.length,
          modelId: index.modelId,
        } satisfies ReindexSummary;
      },
      {
        attributes: {
          sourcePath,
        },
      },
    );
  }

  async reindex() {
    const index = await this.loadOrBuildIndex(true);
    return {
      sourceRoot: index.sourceRoot,
      documentRoot: index.documentRoot,
      indexedDocuments: index.documents.length,
      indexedChunks: index.chunks.length,
      modelId: index.modelId,
    } satisfies ReindexSummary;
  }

  async search(params: SearchParams) {
    return traceSpan(
      "memory.search",
      async () => {
        const query = params.query.trim();
        if (!query) {
          throw new Error("query is required");
        }

        const index = await this.loadOrBuildIndex();
        if (index.chunks.length === 0) {
          return `Memory index is empty. Local document root: ${index.documentRoot}`;
        }
        const rankedResults = await this.searchMatches(params);

        return formatSearchResults(query, rankedResults);
      },
      {
        attributes: {
          queryLength: params.query.length,
          limit: params.limit ?? 5,
        },
      },
    );
  }

  async searchMatches(params: SearchParams): Promise<MemorySearchResult[]> {
    const query = params.query.trim();
    if (!query) {
      throw new Error("query is required");
    }

    const index = await this.loadOrBuildIndex();
    const filteredChunks = this.filterChunks(index, params.pathPrefixes, params.excludePathPrefixes);
    if (filteredChunks.length === 0) {
      return [];
    }

    const queryTokens = tokenize(query);
    let queryVector: number[] = [];
    try {
      [queryVector = []] = await embedTexts([query]);
    } catch (error) {
      memoryTelemetry.event(
        "memory.search.embedding_failed",
        {
          error: error instanceof Error ? error.message : String(error),
          modelId: EMBEDDING_MODEL_ID,
        },
        { level: "warn", outcome: "error" },
      );
    }

    const vectorScores = filteredChunks.map((chunk) => dotProduct(queryVector, chunk.vector));
    const bm25Scores = filteredChunks.map((chunk) =>
      scoreBm25({
        documentLength: chunk.tokenCount,
        averageDocumentLength: index.averageChunkLength,
        totalDocuments: filteredChunks.length,
        queryTokens,
        termFrequencies: chunk.termFrequencies,
        documentFrequencies: index.documentFrequencies,
      })
    );

    const limit = Math.min(Math.max(params.limit ?? 5, 1), 10);
    return rankHybridMatches({
      items: filteredChunks,
      vectorScores,
      bm25Scores,
    })
      .map((result) => ({
        chunk: result.item,
        score: result.score,
        vectorScore: result.vectorScore,
        bm25Score: result.bm25Score,
      }))
      .filter((result) => result.score >= (params.minScore ?? Number.NEGATIVE_INFINITY))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  async searchStructured(params: SearchParams): Promise<MemorySearchMatch[]> {
    const matches = await this.searchMatches(params);
    return matches.map((result) => ({
      relativePath: result.chunk.relativePath,
      copiedPath: result.chunk.copiedPath,
      heading: result.chunk.heading,
      text: result.chunk.text,
      score: result.score,
      vectorScore: result.vectorScore,
      bm25Score: result.bm25Score,
    }));
  }

  async writeNote(params: WriteNoteParams) {
    return traceSpan(
      "memory.write_note",
      async () => {
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
      },
      {
        attributes: {
          subdirectory: params.subdirectory,
        },
      },
    );
  }

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
    return Bun.file(targetPath).text().catch(() => null);
  }

  async deleteProfileDocument(relativePath: string) {
    const namespacedPath = path.join(
      this.profiles.getWriteMemoryNamespace(this.profile),
      relativePath,
    );
    return this.deleteDocument(namespacedPath);
  }

  async benchmarkEmbedding(params?: {
    itemCount?: number;
    charsPerItem?: number;
  }): Promise<EmbeddingBenchmarkSummary> {
    const itemCount = Math.min(Math.max(params?.itemCount ?? 64, 8), 512);
    const charsPerItem = Math.min(Math.max(params?.charsPerItem ?? 480, 64), 4_000);

    return traceSpan(
      "memory.benchmark_embedding",
      async () => {
        const warmupInput = [buildBenchmarkEmbeddingText(0, charsPerItem)];
        const warmupStartedAt = process.hrtime.bigint();
        const warmupVectors = await embedTexts(warmupInput);
        const warmupEndedAt = process.hrtime.bigint();

        const benchmarkTexts = Array.from({ length: itemCount }, (_, index) =>
          buildBenchmarkEmbeddingText(index, charsPerItem)
        );
        const benchmarkStartedAt = process.hrtime.bigint();
        const vectors = await embedTexts(benchmarkTexts);
        const benchmarkEndedAt = process.hrtime.bigint();
        if (vectors.length !== benchmarkTexts.length) {
          throw new Error(
            `Embedding benchmark produced ${vectors.length} vectors for ${benchmarkTexts.length} inputs.`,
          );
        }

        const durationMs = Number(benchmarkEndedAt - benchmarkStartedAt) / 1_000_000;
        const itemsPerSecond = itemCount / Math.max(durationMs / 1_000, Number.EPSILON);
        return {
          modelId: EMBEDDING_MODEL_ID,
          itemCount,
          charsPerItem,
          warmupMs: Number(((Number(warmupEndedAt - warmupStartedAt)) / 1_000_000).toFixed(2)),
          durationMs: Number(durationMs.toFixed(2)),
          itemsPerSecond: Number(itemsPerSecond.toFixed(2)),
          batchSize: EMBEDDING_BATCH_SIZE,
          vectorDimensions: vectors[0]?.length ?? warmupVectors[0]?.length ?? 0,
        };
      },
      {
        attributes: {
          itemCount,
          charsPerItem,
        },
      },
    );
  }

  private async loadOrBuildIndex(force = false): Promise<MemoryIndex> {
    if (!force && this.index) {
      return this.index;
    }
    if (!force && this.initializePromise) {
      return this.initializePromise;
    }

    const job = traceSpan("memory.index.build", async () => {
      if (!force) {
        const existing = await this.readExistingIndex();
        if (existing) {
          this.index = existing;
          return existing;
        }
      }

      const built = await this.buildIndex();
      this.index = built;
      await this.persistIndex(built);
      return built;
    });

    this.initializePromise = job;
    try {
      return await job;
    } finally {
      this.initializePromise = null;
    }
  }

  private filterChunks(index: MemoryIndex, pathPrefixes?: string[], excludePathPrefixes?: string[]) {
    const normalizedPrefixes = pathPrefixes?.map((entry) => entry.trim()).filter(Boolean) ?? [];
    const normalizedExcludes = excludePathPrefixes?.map((entry) => entry.trim()).filter(Boolean) ?? [];
    return index.chunks.filter((chunk) => {
      if (
        normalizedExcludes.some((prefix) =>
          chunk.relativePath === prefix || chunk.relativePath.startsWith(`${prefix}/`)
        )
      ) {
        return false;
      }
      if (normalizedPrefixes.length === 0) {
        return true;
      }
      return normalizedPrefixes.some((prefix) =>
        chunk.relativePath === prefix || chunk.relativePath.startsWith(`${prefix}/`)
      );
    });
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

    const nextIndex = await this.buildIncrementalIndexForPath(relativePath);
    this.index = nextIndex;
    await this.persistIndex(nextIndex);
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
    const index = await this.loadOrBuildIndex();
    const nextIndex = this.rebuildIndexSnapshot({
      documents: index.documents.filter((document) => document.relativePath !== normalizedPath),
      chunks: index.chunks.filter((chunk) => chunk.relativePath !== normalizedPath),
      documentRoot: index.documentRoot,
    });
    this.index = nextIndex;
    await this.persistIndex(nextIndex);
    return true;
  }

  private async readExistingIndex() {
    try {
      const raw = await Bun.file(this.getIndexPath()).text();
      const parsed = JSON.parse(raw) as MemoryIndex;
      if (parsed.version !== INDEX_VERSION || parsed.modelId !== EMBEDDING_MODEL_ID) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private async persistIndex(index: MemoryIndex) {
    assertTestRuntimeRootIsIsolated("Memory store");
    await ensureDirectory(getMemoryStoreRoot());
    await Bun.write(this.getIndexPath(), `${JSON.stringify(index, null, 2)}\n`);
  }

  private rebuildIndexSnapshot(params: {
    documents: MemoryDocumentRecord[];
    chunks: MemoryChunkRecord[];
    documentRoot: string;
  }): MemoryIndex {
    const documents = [...params.documents].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const chunks = [...params.chunks].sort((left, right) => left.id.localeCompare(right.id));
    const totalChunkLength = chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0);
    return {
      version: INDEX_VERSION,
      builtAt: new Date().toISOString(),
      modelId: EMBEDDING_MODEL_ID,
      sourceRoot: params.documentRoot,
      documentRoot: params.documentRoot,
      documents,
      chunks,
      documentFrequencies: buildDocumentFrequencies(chunks.map((chunk) => chunk.termFrequencies)),
      averageChunkLength: chunks.length > 0 ? totalChunkLength / chunks.length : 0,
    };
  }

  private async buildIncrementalIndexForPath(relativePath: string) {
    const index = await this.loadOrBuildIndex();
    const targetPath = path.join(getMemoryDocumentRoot(), relativePath);
    const content = await Bun.file(targetPath).text();
    const fileStat = await stat(targetPath);
    const document = this.createDocumentRecord(relativePath, targetPath, content, fileStat);
    const chunks = await this.embedChunkRecords(chunkMarkdown(document, content));

    return this.rebuildIndexSnapshot({
      documents: index.documents
        .filter((entry) => entry.relativePath !== relativePath)
        .concat(document),
      chunks: index.chunks
        .filter((entry) => entry.relativePath !== relativePath)
        .concat(chunks),
      documentRoot: index.documentRoot,
    });
  }

  private createDocumentRecord(
    relativePath: string,
    copiedPath: string,
    content: string,
    stat: { size: number; mtime: Date },
  ): MemoryDocumentRecord {
    return {
      id: relativePath,
      relativePath,
      sourcePath: copiedPath,
      copiedPath,
      hash: sha256(content),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  }

  private async embedChunkRecords(chunkBases: Omit<MemoryChunkRecord, "vector">[]) {
    let vectors: number[][] = [];
    if (chunkBases.length > 0) {
      try {
        vectors = await embedTexts(chunkBases.map((chunk) => chunk.text));
      } catch (error) {
        memoryTelemetry.event(
          "memory.index.embedding_failed",
          {
            error: error instanceof Error ? error.message : String(error),
            modelId: EMBEDDING_MODEL_ID,
            chunkCount: chunkBases.length,
          },
          { level: "warn", outcome: "error" },
        );
        vectors = chunkBases.map(() => []);
      }
    }

    return chunkBases.map((chunk, index) => ({
      ...chunk,
      vector: vectors[index] ?? [],
    }));
  }

  private async buildIndex(): Promise<MemoryIndex> {
    const memoryDocumentRoot = getMemoryDocumentRoot();
    await ensureDirectory(memoryDocumentRoot);

    const documentRootExists = await stat(memoryDocumentRoot)
      .then((s) => s.isDirectory())
      .catch(() => false);

    if (!documentRootExists) {
      return createEmptyIndex(memoryDocumentRoot);
    }

    const documents: MemoryDocumentRecord[] = [];
    const glob = new Bun.Glob("**/*.md");
    for await (const relativePath of glob.scan({ cwd: memoryDocumentRoot, onlyFiles: true })) {
      if (!this.profiles.canReadMemoryPath(this.profile, relativePath)) {
        continue;
      }
      const copiedPath = path.join(memoryDocumentRoot, relativePath);
      const content = await Bun.file(copiedPath).text();
      const fileStat = await stat(copiedPath);

      documents.push(this.createDocumentRecord(relativePath, copiedPath, content, fileStat));
    }

    const chunkBases: Omit<MemoryChunkRecord, "vector">[] = [];
    for (const document of documents) {
      const content = await Bun.file(document.copiedPath).text();
      chunkBases.push(...chunkMarkdown(document, content));
    }
    const chunks = await this.embedChunkRecords(chunkBases);
    return this.rebuildIndexSnapshot({
      documents,
      chunks,
      documentRoot: memoryDocumentRoot,
    });
  }

  private getIndexPath() {
    return path.join(getMemoryStoreRoot(), `index.${this.profile.id}.json`);
  }
}
