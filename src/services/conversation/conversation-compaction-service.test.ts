import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProfileRecord } from "../../domain/profiles";
import { ScriptedProviderConnector } from "../../test/scripted-provider-connector";
import { ConversationCompactionService } from "./conversation-compaction-service";
import { MemoryService } from "../memory-service";
import { ProfileService } from "../profiles";

const ROOT_PROFILE: ProfileRecord = {
  id: "root",
  name: "Root",
  roles: ["root"],
  memoryNamespace: "root",
};

let previousCwd = "";
let previousRootDir = "";
let tempRoot = "";

beforeEach(() => {
  previousCwd = process.cwd();
  previousRootDir = process.env.OPENELINARO_ROOT_DIR ?? "";
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-compaction-"));
  process.env.OPENELINARO_ROOT_DIR = tempRoot;
  process.chdir(tempRoot);
  fs.mkdirSync(path.join(tempRoot, ".openelinarotest", "memory", "documents", "root"), { recursive: true });
});

afterEach(() => {
  process.chdir(previousCwd);
  if (previousRootDir) {
    process.env.OPENELINARO_ROOT_DIR = previousRootDir;
  } else {
    delete process.env.OPENELINARO_ROOT_DIR;
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("ConversationCompactionService", () => {
  test("parses durable memory from sectioned non-JSON output", async () => {
    const service = new ConversationCompactionService(
      new ScriptedProviderConnector(() =>
        new AIMessage([
          "Summary:",
          "- User wants short answers.",
          "",
          "Durable Memory:",
          "- Prefers concise replies.",
          "- Working in the openElinaro repo.",
        ].join("\n")),
      ),
      new MemoryService(ROOT_PROFILE, new ProfileService("root")),
      {
        async generateMemoryText(params) {
          const merged = params.userPrompt.includes("Prefers concise replies.")
            ? [
                "# Core Memory",
                "",
                "## Preferences",
                "",
                "- Prefers concise replies.",
                "- Working in the openElinaro repo.",
              ].join("\n")
            : "# Core Memory";
          return merged;
        },
      },
    );

    const result = await service.compact({
      conversationKey: "sectioned-compaction",
      systemPrompt: "You are a test system prompt.",
      messages: [new HumanMessage("Keep replies short and direct.")],
    });

    expect(result.summary).toContain("User wants short answers");
    expect(result.memoryFilePath).toBeString();
    expect(result.memoryFilePath).toContain(path.join("core", "MEMORY.md"));
    const saved = fs.readFileSync(result.memoryFilePath!, "utf8");
    expect(saved).toContain("Prefers concise replies.");
  });

  test("recovers durable memory from the summary when memory_markdown is empty", async () => {
    const requests: string[] = [];
    const service = new ConversationCompactionService(
      new ScriptedProviderConnector((request) => {
        requests.push(request.usagePurpose ?? "unknown");
        if (request.usagePurpose === "conversation_compaction_memory") {
          return new AIMessage("- User prefers one-line summaries.\n- Root profile owns deployment steps.");
        }
        return new AIMessage(JSON.stringify({
          summary: "User prefers one-line summaries and root handles deploys.",
          memory_markdown: "",
        }));
      }),
      new MemoryService(ROOT_PROFILE, new ProfileService("root")),
      {
        async generateMemoryText(params) {
          if (params.usagePurpose === "conversation_compaction_core_memory") {
            return [
              "# Core Memory",
              "",
              "## Preferences",
              "",
              "- User prefers one-line summaries.",
              "",
              "## Operations",
              "",
              "- Root profile owns deployment steps.",
            ].join("\n");
          }
          return "";
        },
      },
    );

    const result = await service.compact({
      conversationKey: "recovered-memory",
      systemPrompt: "You are a test system prompt.",
      messages: [new HumanMessage("Please remember that I prefer one-line summaries.")],
    });

    expect(requests).toEqual([
      "conversation_compaction",
      "conversation_compaction_memory",
    ]);
    expect(result.memoryFilePath).toBeString();
    expect(result.memoryFilePath).toContain(path.join("core", "MEMORY.md"));
    const saved = fs.readFileSync(result.memoryFilePath!, "utf8");
    expect(saved).toContain("User prefers one-line summaries.");
    expect(saved).toContain("Root profile owns deployment steps.");
  });
});
