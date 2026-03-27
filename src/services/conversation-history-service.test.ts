import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ConversationHistoryService } from "./conversation-history-service";

let tempRoot = "";
let previousRootDirEnv: string | undefined;

function stubEmbedTexts(texts: string[]): Promise<number[][]> {
  return Promise.resolve(texts.map(() => [0, 0, 0]));
}

describe("ConversationHistoryService", () => {
  beforeEach(() => {
    previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-history-test-"));
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

  function makeService(profileId = "test-profile") {
    return new ConversationHistoryService({
      embedTexts: stubEmbedTexts,
      profileId,
    });
  }

  function getJournalPath(profileId = "test-profile") {
    return path.join(tempRoot, ".openelinarotest", "conversation-history", `events.${profileId}.jsonl`);
  }

  describe("recordAppendedMessages", () => {
    test("creates a journal file with messages", () => {
      const service = makeService();
      service.recordAppendedMessages({
        conversationKey: "conv-1",
        messages: [new HumanMessage("hello"), new AIMessage("hi there")],
        startingIndex: 0,
        occurredAt: "2025-01-01T00:00:00Z",
      });

      expect(fs.existsSync(getJournalPath())).toBe(true);

      const lines = fs.readFileSync(getJournalPath(), "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);

      const entry1 = JSON.parse(lines[0]!);
      expect(entry1.kind).toBe("message");
      expect(entry1.conversationKey).toBe("conv-1");
      expect(entry1.role).toBe("user");
      expect(entry1.text).toBe("hello");
      expect(entry1.messageIndex).toBe(1);

      const entry2 = JSON.parse(lines[1]!);
      expect(entry2.role).toBe("assistant");
      expect(entry2.text).toBe("hi there");
      expect(entry2.messageIndex).toBe(2);
    });

    test("does nothing when messages array is empty", () => {
      const service = makeService();
      service.recordAppendedMessages({
        conversationKey: "conv-1",
        messages: [],
        startingIndex: 0,
        occurredAt: "2025-01-01T00:00:00Z",
      });

      expect(fs.existsSync(getJournalPath())).toBe(false);
    });

    test("maps message types to correct roles", () => {
      const service = makeService();
      service.recordAppendedMessages({
        conversationKey: "conv-1",
        messages: [
          new HumanMessage("from user"),
          new AIMessage("from assistant"),
          new SystemMessage("from system"),
        ],
        startingIndex: 0,
        occurredAt: "2025-01-01T00:00:00Z",
      });

      const lines = fs.readFileSync(getJournalPath(), "utf8").trim().split("\n");

      expect(JSON.parse(lines[0]!).role).toBe("user");
      expect(JSON.parse(lines[1]!).role).toBe("assistant");
      expect(JSON.parse(lines[2]!).role).toBe("system");
    });

    test("uses startingIndex offset for messageIndex", () => {
      const service = makeService();
      service.recordAppendedMessages({
        conversationKey: "conv-1",
        messages: [new HumanMessage("msg")],
        startingIndex: 5,
        occurredAt: "2025-01-01T00:00:00Z",
      });

      const line = fs.readFileSync(getJournalPath(), "utf8").trim();
      expect(JSON.parse(line).messageIndex).toBe(6);
    });
  });

  describe("recordRollback", () => {
    test("writes a rollback entry to the journal", () => {
      const service = makeService();
      service.recordRollback({
        conversationKey: "conv-1",
        removedCount: 3,
        occurredAt: "2025-01-01T00:00:00Z",
      });

      const line = fs.readFileSync(getJournalPath(), "utf8").trim();
      const entry = JSON.parse(line);
      expect(entry.kind).toBe("rollback");
      expect(entry.removedCount).toBe(3);
      expect(entry.conversationKey).toBe("conv-1");
    });

    test("does nothing when removedCount is zero", () => {
      const service = makeService();
      service.recordRollback({
        conversationKey: "conv-1",
        removedCount: 0,
        occurredAt: "2025-01-01T00:00:00Z",
      });

      expect(fs.existsSync(getJournalPath())).toBe(false);
    });

    test("does nothing when removedCount is negative", () => {
      const service = makeService();
      service.recordRollback({
        conversationKey: "conv-1",
        removedCount: -1,
        occurredAt: "2025-01-01T00:00:00Z",
      });

      expect(fs.existsSync(getJournalPath())).toBe(false);
    });
  });

  describe("search", () => {
    test("returns empty archive message when no messages recorded", async () => {
      const service = makeService();
      const result = await service.search({ query: "hello" });
      expect(result).toContain("empty");
    });

    test("throws when query is empty", async () => {
      const service = makeService();
      await expect(service.search({ query: "" })).rejects.toThrow("query is required");
      await expect(service.search({ query: "   " })).rejects.toThrow("query is required");
    });

    test("returns search results for matching messages", async () => {
      const service = makeService();
      service.recordAppendedMessages({
        conversationKey: "conv-1",
        messages: [
          new HumanMessage("Tell me about graph databases"),
          new AIMessage("Graph databases store nodes and edges"),
        ],
        startingIndex: 0,
        occurredAt: "2025-01-01T00:00:00Z",
      });

      const result = await service.search({ query: "graph databases" });
      expect(result).toContain("graph");
      expect(result).toContain("conv-1");
    });

    test("respects the limit parameter", async () => {
      const service = makeService();
      for (let i = 0; i < 10; i++) {
        service.recordAppendedMessages({
          conversationKey: `conv-${i}`,
          messages: [new HumanMessage(`Message about topic alpha ${i}`)],
          startingIndex: 0,
          occurredAt: `2025-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
        });
      }

      const result = await service.search({ query: "topic alpha", limit: 2 });
      const hitLines = result.split("\n").filter((line: string) => line.match(/^\d+\./));
      expect(hitLines.length).toBeLessThanOrEqual(2);
    });
  });

  describe("listRecentMessages", () => {
    test("returns empty array when no messages", async () => {
      const service = makeService();
      const result = await service.listRecentMessages();
      expect(result).toEqual([]);
    });

    test("returns messages sorted by most recent first", async () => {
      const service = makeService();
      service.recordAppendedMessages({
        conversationKey: "conv-1",
        messages: [new HumanMessage("first message")],
        startingIndex: 0,
        occurredAt: "2025-01-01T00:00:00Z",
      });
      service.recordAppendedMessages({
        conversationKey: "conv-2",
        messages: [new HumanMessage("second message")],
        startingIndex: 0,
        occurredAt: "2025-01-02T00:00:00Z",
      });

      const result = await service.listRecentMessages();
      expect(result.length).toBe(2);
      expect(result[0]!.conversationKey).toBe("conv-2");
      expect(result[1]!.conversationKey).toBe("conv-1");
    });

    test("filters by conversationKey", async () => {
      const service = makeService();
      service.recordAppendedMessages({
        conversationKey: "conv-1",
        messages: [new HumanMessage("in conv 1")],
        startingIndex: 0,
        occurredAt: "2025-01-01T00:00:00Z",
      });
      service.recordAppendedMessages({
        conversationKey: "conv-2",
        messages: [new HumanMessage("in conv 2")],
        startingIndex: 0,
        occurredAt: "2025-01-02T00:00:00Z",
      });

      const result = await service.listRecentMessages({ conversationKey: "conv-1" });
      expect(result).toHaveLength(1);
      expect(result[0]!.text).toBe("in conv 1");
    });

    test("filters by since timestamp", async () => {
      const service = makeService();
      service.recordAppendedMessages({
        conversationKey: "conv-1",
        messages: [new HumanMessage("old message")],
        startingIndex: 0,
        occurredAt: "2025-01-01T00:00:00Z",
      });
      service.recordAppendedMessages({
        conversationKey: "conv-2",
        messages: [new HumanMessage("new message")],
        startingIndex: 0,
        occurredAt: "2025-06-01T00:00:00Z",
      });

      const result = await service.listRecentMessages({ since: "2025-03-01T00:00:00Z" });
      expect(result).toHaveLength(1);
      expect(result[0]!.text).toBe("new message");
    });

    test("respects limit parameter", async () => {
      const service = makeService();
      for (let i = 0; i < 5; i++) {
        service.recordAppendedMessages({
          conversationKey: `conv-${i}`,
          messages: [new HumanMessage(`message ${i}`)],
          startingIndex: 0,
          occurredAt: `2025-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
        });
      }

      const result = await service.listRecentMessages({ limit: 2 });
      expect(result).toHaveLength(2);
    });

    test("skips messages with empty text", async () => {
      const service = makeService();
      service.recordAppendedMessages({
        conversationKey: "conv-1",
        messages: [new HumanMessage("   ")],
        startingIndex: 0,
        occurredAt: "2025-01-01T00:00:00Z",
      });
      service.recordAppendedMessages({
        conversationKey: "conv-2",
        messages: [new HumanMessage("visible")],
        startingIndex: 0,
        occurredAt: "2025-01-02T00:00:00Z",
      });

      const result = await service.listRecentMessages();
      expect(result).toHaveLength(1);
      expect(result[0]!.text).toBe("visible");
    });
  });

  describe("profile isolation", () => {
    test("messages from different profiles are not mixed", async () => {
      const serviceA = makeService("profile-a");
      const serviceB = makeService("profile-b");

      serviceA.recordAppendedMessages({
        conversationKey: "conv-1",
        messages: [new HumanMessage("from profile A")],
        startingIndex: 0,
        occurredAt: "2025-01-01T00:00:00Z",
      });
      serviceB.recordAppendedMessages({
        conversationKey: "conv-2",
        messages: [new HumanMessage("from profile B")],
        startingIndex: 0,
        occurredAt: "2025-01-01T00:00:00Z",
      });

      const resultA = await serviceA.listRecentMessages();
      expect(resultA).toHaveLength(1);
      expect(resultA[0]!.text).toBe("from profile A");

      const resultB = await serviceB.listRecentMessages();
      expect(resultB).toHaveLength(1);
      expect(resultB[0]!.text).toBe("from profile B");
    });
  });
});
