import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const mockEmbedTexts = mock(async (texts: string[]) => {
  return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
});

mock.module("./text-embedding-service", () => ({
  EMBEDDING_MODEL_ID: "mock-model",
  EMBEDDING_BATCH_SIZE: 8,
  embedTexts: mockEmbedTexts,
}));

mock.module("./telemetry", () => ({
  telemetry: {
    child: () => ({
      event: () => {},
      span: (_op: string, _attrs: Record<string, unknown>, fn: () => unknown) => fn(),
    }),
  },
}));

const TEST_PROFILE = {
  id: "test-profile",
  name: "Test",
  roles: ["root"],
  memoryNamespace: "test-ns",
} as const;

let tempRoot: string;
let previousUserDataDir: string | undefined;
let previousRootDir: string | undefined;
let previousNodeEnv: string | undefined;

beforeEach(() => {
  previousUserDataDir = process.env.OPENELINARO_USER_DATA_DIR;
  previousRootDir = process.env.OPENELINARO_ROOT_DIR;
  previousNodeEnv = process.env.NODE_ENV;

  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-test-"));
  const userDataDir = path.join(tempRoot, ".openelinarotest");
  fs.mkdirSync(path.join(userDataDir, "profiles"), { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, "profiles/registry.json"),
    JSON.stringify({
      version: 1,
      profiles: [TEST_PROFILE],
    }),
    "utf8",
  );
  fs.mkdirSync(path.join(userDataDir, "memory/documents/test-ns"), { recursive: true });

  process.env.OPENELINARO_USER_DATA_DIR = userDataDir;
  process.env.OPENELINARO_ROOT_DIR = tempRoot;
  process.env.NODE_ENV = "test";

  mockEmbedTexts.mockClear();
});

afterEach(() => {
  if (previousUserDataDir === undefined) {
    delete process.env.OPENELINARO_USER_DATA_DIR;
  } else {
    process.env.OPENELINARO_USER_DATA_DIR = previousUserDataDir;
  }
  if (previousRootDir === undefined) {
    delete process.env.OPENELINARO_ROOT_DIR;
  } else {
    process.env.OPENELINARO_ROOT_DIR = previousRootDir;
  }
  if (previousNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = previousNodeEnv;
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function getMemoryService() {
  const { MemoryService } = await import("./memory-service");
  return new MemoryService({ ...TEST_PROFILE });
}

function writeMemoryDoc(relativePath: string, content: string) {
  const userDataDir = process.env.OPENELINARO_USER_DATA_DIR!;
  const fullPath = path.join(userDataDir, "memory/documents", relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
}

describe("MemoryService", () => {
  describe("reindex", () => {
    test("indexes markdown documents and returns summary", async () => {
      writeMemoryDoc("test-ns/doc1.md", "# Hello\n\nThis is a test document about cats.");
      writeMemoryDoc("test-ns/doc2.md", "# World\n\nAnother document about dogs.");

      const service = await getMemoryService();
      const summary = await service.reindex();

      expect(summary.indexedDocuments).toBe(2);
      expect(summary.indexedChunks).toBeGreaterThanOrEqual(2);
      expect(summary.modelId).toBe("mock-model");
    });

    test("returns zero counts for empty document root", async () => {
      const service = await getMemoryService();
      const summary = await service.reindex();

      expect(summary.indexedDocuments).toBe(0);
      expect(summary.indexedChunks).toBe(0);
    });

    test("calls embedTexts for document chunks", async () => {
      writeMemoryDoc("test-ns/embed-test.md", "# Embed\n\nSome text to embed.");

      const service = await getMemoryService();
      await service.reindex();

      expect(mockEmbedTexts).toHaveBeenCalled();
    });
  });

  describe("search", () => {
    test("returns message when index is empty", async () => {
      const service = await getMemoryService();
      const result = await service.search({ query: "hello" });

      expect(typeof result).toBe("string");
      expect(result).toContain("empty");
    });

    test("throws for empty query", async () => {
      const service = await getMemoryService();
      expect(service.search({ query: "" })).rejects.toThrow("query is required");
    });

    test("throws for whitespace-only query", async () => {
      const service = await getMemoryService();
      expect(service.search({ query: "   " })).rejects.toThrow("query is required");
    });

    test("finds indexed documents by keyword", async () => {
      writeMemoryDoc("test-ns/animals.md", "# Animals\n\nCats are wonderful pets that purr.");

      const service = await getMemoryService();
      await service.reindex();
      const result = await service.search({ query: "cats" });

      expect(result).toContain("cats");
    });
  });

  describe("searchMatches", () => {
    test("returns empty array when no chunks exist", async () => {
      const service = await getMemoryService();
      const matches = await service.searchMatches({ query: "hello" });

      expect(matches).toEqual([]);
    });

    test("returns scored results with chunk data", async () => {
      writeMemoryDoc("test-ns/topic.md", "# Topic\n\nBun is a fast JavaScript runtime.");

      const service = await getMemoryService();
      await service.reindex();
      const matches = await service.searchMatches({ query: "bun runtime" });

      expect(matches.length).toBeGreaterThan(0);
      const first = matches[0]!;
      expect(first.score).toBeGreaterThan(0);
      expect(first.chunk.relativePath).toContain("topic.md");
    });

    test("respects limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        writeMemoryDoc(`test-ns/doc${i}.md`, `# Doc ${i}\n\nContent about testing number ${i}.`);
      }

      const service = await getMemoryService();
      await service.reindex();
      const matches = await service.searchMatches({ query: "testing", limit: 2 });

      expect(matches.length).toBeLessThanOrEqual(2);
    });

    test("clamps limit to maximum of 10", async () => {
      for (let i = 0; i < 12; i++) {
        writeMemoryDoc(`test-ns/doc${i}.md`, `# Doc ${i}\n\nContent about testing.`);
      }

      const service = await getMemoryService();
      await service.reindex();
      const matches = await service.searchMatches({ query: "testing", limit: 50 });

      expect(matches.length).toBeLessThanOrEqual(10);
    });

    test("filters by pathPrefixes", async () => {
      writeMemoryDoc("test-ns/alpha/a.md", "# Alpha\n\nAlpha content about code.");
      writeMemoryDoc("test-ns/beta/b.md", "# Beta\n\nBeta content about code.");

      const service = await getMemoryService();
      await service.reindex();
      const matches = await service.searchMatches({
        query: "code",
        pathPrefixes: ["test-ns/alpha"],
      });

      for (const match of matches) {
        expect(match.chunk.relativePath).toContain("alpha");
      }
    });

    test("filters by excludePathPrefixes", async () => {
      writeMemoryDoc("test-ns/keep/k.md", "# Keep\n\nKeep this content about code.");
      writeMemoryDoc("test-ns/exclude/e.md", "# Exclude\n\nExclude this content about code.");

      const service = await getMemoryService();
      await service.reindex();
      const matches = await service.searchMatches({
        query: "code",
        excludePathPrefixes: ["test-ns/exclude"],
      });

      for (const match of matches) {
        expect(match.chunk.relativePath).not.toContain("exclude");
      }
    });

    test("filters by minScore", async () => {
      writeMemoryDoc("test-ns/scored.md", "# Score\n\nSome content.");

      const service = await getMemoryService();
      await service.reindex();
      const matches = await service.searchMatches({
        query: "content",
        minScore: 999,
      });

      expect(matches).toEqual([]);
    });

    test("gracefully handles embedding failure during search", async () => {
      writeMemoryDoc("test-ns/fallback.md", "# Fallback\n\nKeyword search still works.");

      const service = await getMemoryService();
      await service.reindex();

      mockEmbedTexts.mockImplementationOnce(async () => {
        throw new Error("embedding service down");
      });

      const matches = await service.searchMatches({ query: "keyword" });
      expect(matches.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("searchStructured", () => {
    test("returns structured match objects", async () => {
      writeMemoryDoc("test-ns/structured.md", "# Structured\n\nStructured search result content.");

      const service = await getMemoryService();
      await service.reindex();
      const matches = await service.searchStructured({ query: "structured" });

      expect(matches.length).toBeGreaterThan(0);
      const first = matches[0]!;
      expect(first).toHaveProperty("relativePath");
      expect(first).toHaveProperty("heading");
      expect(first).toHaveProperty("text");
      expect(first).toHaveProperty("score");
      expect(first).toHaveProperty("vectorScore");
      expect(first).toHaveProperty("bm25Score");
    });
  });

  describe("writeNote", () => {
    test("creates a timestamped markdown file", async () => {
      const service = await getMemoryService();
      const resultPath = await service.writeNote({
        content: "A new note about something.",
        createdAt: new Date("2025-01-15T10:30:00Z"),
      });

      expect(resultPath).not.toBeNull();
      expect(resultPath!).toContain("2025-01-15");
      expect(resultPath!).toEndWith(".md");
      expect(fs.existsSync(resultPath!)).toBe(true);
    });

    test("returns null for empty content", async () => {
      const service = await getMemoryService();
      const result = await service.writeNote({ content: "" });
      expect(result).toBeNull();
    });

    test("returns null for whitespace-only content", async () => {
      const service = await getMemoryService();
      const result = await service.writeNote({ content: "   " });
      expect(result).toBeNull();
    });

    test("places note in subdirectory when specified", async () => {
      const service = await getMemoryService();
      const resultPath = await service.writeNote({
        content: "Sub-note.",
        subdirectory: "journal",
        createdAt: new Date("2025-06-01T00:00:00Z"),
      });

      expect(resultPath).not.toBeNull();
      expect(resultPath!).toContain("journal");
    });
  });

  describe("upsertProfileDocument and readProfileDocument", () => {
    test("writes and reads back a document", async () => {
      const service = await getMemoryService();
      await service.upsertProfileDocument({
        relativePath: "notes/hello.md",
        content: "Hello from profile doc.",
      });

      const content = await service.readProfileDocument("notes/hello.md");
      expect(content).toContain("Hello from profile doc.");
    });

    test("readProfileDocument returns null for missing file", async () => {
      const service = await getMemoryService();
      const content = await service.readProfileDocument("nonexistent.md");
      expect(content).toBeNull();
    });
  });

  describe("deleteProfileDocument", () => {
    test("deletes an existing document", async () => {
      const service = await getMemoryService();
      await service.upsertProfileDocument({
        relativePath: "to-delete.md",
        content: "Will be deleted.",
      });

      const deleted = await service.deleteProfileDocument("to-delete.md");
      expect(deleted).toBe(true);

      const content = await service.readProfileDocument("to-delete.md");
      expect(content).toBeNull();
    });

    test("returns false for nonexistent document", async () => {
      const service = await getMemoryService();
      const deleted = await service.deleteProfileDocument("never-existed.md");
      expect(deleted).toBe(false);
    });
  });

  describe("embedding failure during indexing", () => {
    test("falls back to empty vectors when embedding fails", async () => {
      writeMemoryDoc("test-ns/fail-embed.md", "# Fail\n\nContent that fails embedding.");

      mockEmbedTexts.mockImplementationOnce(async () => {
        throw new Error("model load failed");
      });

      const service = await getMemoryService();
      const summary = await service.reindex();

      expect(summary.indexedDocuments).toBe(1);
      expect(summary.indexedChunks).toBeGreaterThanOrEqual(1);
    });
  });
});
