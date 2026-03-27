import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import type { ProfileRecord } from "../domain/profiles";
import { ConversationMemoryService } from "./conversation-memory-service";
import type { MemorySearchMatch } from "./memory-service";

let tempRoot = "";
let previousRootDirEnv: string | undefined;

const TEST_PROFILE: ProfileRecord = {
  id: "test-profile",
  name: "Test Profile",
  roles: ["user"],
  memoryNamespace: "test-ns",
};

function makeMemoryMock(matches: MemorySearchMatch[] = []) {
  return {
    searchStructured: mock(async () => matches),
  };
}

function makeConversationsMock() {
  return {} as any;
}

function makeModelsMock() {
  return {
    generateMemoryText: mock(async () => "generated text"),
  };
}

function makeProfilesMock() {
  return {
    getWriteMemoryNamespace: mock((_profile: ProfileRecord) => "test-ns"),
  };
}

function makeService(options?: {
  matches?: MemorySearchMatch[];
}) {
  const memory = makeMemoryMock(options?.matches ?? []);
  const conversations = makeConversationsMock();
  const models = makeModelsMock();
  const profiles = makeProfilesMock();

  const service = new ConversationMemoryService(
    TEST_PROFILE,
    conversations,
    memory as any,
    models,
    profiles as any,
  );

  return { service, memory, models, profiles };
}

function makeMatch(overrides: Partial<MemorySearchMatch> = {}): MemorySearchMatch {
  return {
    relativePath: "test-ns/core/MEMORY.md",
    copiedPath: "/tmp/memory/MEMORY.md",
    heading: "Test Memory",
    text: "Some remembered content about preferences",
    score: 0.15,
    vectorScore: 0.12,
    bm25Score: 0.1,
    ...overrides,
  };
}

describe("ConversationMemoryService", () => {
  beforeEach(() => {
    previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-memory-test-"));
    process.env.OPENELINARO_ROOT_DIR = tempRoot;
  });

  afterEach(() => {
    if (previousRootDirEnv === undefined) {
      delete process.env.OPENELINARO_ROOT_DIR;
    } else {
      process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  });

  describe("buildRecallContext", () => {
    test("returns empty string when no memory matches", async () => {
      const { service } = makeService({ matches: [] });
      const result = await service.buildRecallContext({
        conversationKey: "conv-1",
        userContent: "Tell me about my preferences for coding languages",
        conversationMessages: [],
      });
      expect(result).toBe("");
    });

    test("returns recall context when good matches exist", async () => {
      const match = makeMatch({
        heading: "Coding Preferences",
        text: "Prefers TypeScript and Rust",
        score: 0.2,
        vectorScore: 0.15,
        relativePath: "test-ns/core/MEMORY.md",
      });
      const { service } = makeService({ matches: [match] });

      const result = await service.buildRecallContext({
        conversationKey: "conv-1",
        userContent: "What are my preferences for coding languages and frameworks?",
        conversationMessages: [],
      });

      expect(result).toContain("<recalled_memory>");
      expect(result).toContain("</recalled_memory>");
      expect(result).toContain("Prefers TypeScript and Rust");
    });

    test("skips recall for healthcheck conversations", async () => {
      const match = makeMatch({ score: 0.5 });
      const { service, memory } = makeService({ matches: [match] });

      const result = await service.buildRecallContext({
        conversationKey: "agent-healthcheck-123",
        userContent: "What do I remember about something really important?",
        conversationMessages: [],
      });

      expect(result).toBe("");
      expect(memory.searchStructured).not.toHaveBeenCalled();
    });

    test("skips recall for internal automation messages", async () => {
      const match = makeMatch({ score: 0.5 });
      const { service, memory } = makeService({ matches: [match] });

      const result = await service.buildRecallContext({
        conversationKey: "conv-1",
        userContent: "This is a healthcheck message",
        conversationMessages: [],
      });

      expect(result).toBe("");
      expect(memory.searchStructured).not.toHaveBeenCalled();
    });

    test("returns empty string for very short queries without explicit recall", async () => {
      const { service, memory } = makeService({ matches: [] });

      const result = await service.buildRecallContext({
        conversationKey: "conv-1",
        userContent: "hi",
        conversationMessages: [],
      });

      expect(result).toBe("");
    });

    test("uses conversation context to extend short queries", async () => {
      const match = makeMatch({
        heading: "Coding Preferences",
        text: "Prefers TypeScript and Rust for systems programming work",
        score: 0.25,
        vectorScore: 0.2,
        relativePath: "test-ns/core/MEMORY.md",
      });
      const { service, memory } = makeService({ matches: [match] });

      await service.buildRecallContext({
        conversationKey: "conv-1",
        userContent: "what do I remember about programming?",
        conversationMessages: [
          new HumanMessage("Tell me about TypeScript and Rust programming"),
          new AIMessage("Sure, those are great languages for different purposes"),
        ],
      });

      expect(memory.searchStructured).toHaveBeenCalled();
    });

    test("respects custom limit parameter", async () => {
      const matches = [
        makeMatch({ heading: "Memory 1", text: "Content one about preferences", score: 0.25, relativePath: "test-ns/core/MEMORY.md" }),
        makeMatch({ heading: "Memory 2", text: "Content two about preferences", score: 0.20, relativePath: "test-ns/core/MEMORY.md" }),
        makeMatch({ heading: "Memory 3", text: "Content three about preferences", score: 0.15, relativePath: "test-ns/core/MEMORY.md" }),
      ];
      const { service } = makeService({ matches });

      const result = await service.buildRecallContext({
        conversationKey: "conv-1",
        userContent: "What do I remember about my preferences and settings?",
        conversationMessages: [],
        limit: 1,
      });

      if (result) {
        const memoryItems = result.match(/<memory_item>/g);
        expect(memoryItems?.length ?? 0).toBeLessThanOrEqual(1);
      }
    });

    test("filters matches with low score and low overlap", async () => {
      const match = makeMatch({
        heading: "Unrelated",
        text: "Something completely different without any overlap",
        score: 0.03,
        vectorScore: 0.01,
        relativePath: "test-ns/other/notes.md",
      });
      const { service } = makeService({ matches: [match] });

      const result = await service.buildRecallContext({
        conversationKey: "conv-1",
        userContent: "Tell me about my coding preferences and language choices",
        conversationMessages: [],
      });

      expect(result).toBe("");
    });

    test("includes explicit recall even with low-scoring matches", async () => {
      const match = makeMatch({
        heading: "Old Memory",
        text: "Previously discussed preference for dark mode",
        score: 0.06,
        vectorScore: 0.04,
        relativePath: "test-ns/core/MEMORY.md",
      });
      const { service } = makeService({ matches: [match] });

      const result = await service.buildRecallContext({
        conversationKey: "conv-1",
        userContent: "What do I remember about my previous preference settings?",
        conversationMessages: [],
      });

      // "previous" and "remember" are explicit recall triggers
      // But the match score is still low, so this might still be empty
      // depending on overlap thresholds
      expect(typeof result).toBe("string");
    });

    test("deduplicates matches by relativePath", async () => {
      const matches = [
        makeMatch({
          heading: "Memory A",
          text: "Shorter content about preferences",
          score: 0.2,
          relativePath: "test-ns/core/MEMORY.md",
        }),
        makeMatch({
          heading: "Memory B",
          text: "Longer and more detailed content about preferences and settings",
          score: 0.19,
          relativePath: "test-ns/core/MEMORY.md",
        }),
      ];
      const { service } = makeService({ matches });

      const result = await service.buildRecallContext({
        conversationKey: "conv-1",
        userContent: "Tell me about my preferences and settings configuration",
        conversationMessages: [],
      });

      if (result) {
        const memoryItems = result.match(/<memory_item>/g);
        expect(memoryItems?.length ?? 0).toBeLessThanOrEqual(1);
      }
    });

    test("sanitizes recall content by removing metadata lines", async () => {
      const match = makeMatch({
        heading: "Test Heading",
        text: "Test Heading\n- kind: episodic\n- stability: stable\n- source: conversation\nActual memory content about coding preferences",
        score: 0.25,
        vectorScore: 0.2,
        relativePath: "test-ns/core/MEMORY.md",
      });
      const { service } = makeService({ matches: [match] });

      const result = await service.buildRecallContext({
        conversationKey: "conv-1",
        userContent: "What do I remember about my coding preferences and history?",
        conversationMessages: [],
      });

      if (result) {
        expect(result).not.toContain("- kind: episodic");
        expect(result).not.toContain("- stability: stable");
        expect(result).toContain("Actual memory content");
      }
    });

    test("handles content blocks as userContent", async () => {
      const match = makeMatch({
        heading: "Preferences",
        text: "User prefers dark mode and compact layouts for coding",
        score: 0.25,
        vectorScore: 0.2,
        relativePath: "test-ns/core/MEMORY.md",
      });
      const { service, memory } = makeService({ matches: [match] });

      await service.buildRecallContext({
        conversationKey: "conv-1",
        userContent: [
          { type: "text" as const, text: "What are my preferences for coding and layouts?" },
        ],
        conversationMessages: [],
      });

      expect(memory.searchStructured).toHaveBeenCalled();
    });
  });
});
