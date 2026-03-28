import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HumanMessage } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConversationStore } from "./conversation/conversation-store";
import { MemoryService } from "./memory-service";
import { ProfileService } from "./profiles";
import { ReflectionService } from "./reflection-service";
import { RoutinesService } from "./scheduling/routines-service";
import { resolveAssistantContextPath } from "./runtime-user-content";

let runtimeRoot = "";
let previousRootDirEnv: string | undefined;

function writeProfileRegistry(rootDir: string) {
  fs.mkdirSync(path.join(rootDir, ".openelinarotest", "profiles"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, ".openelinarotest", "profiles/registry.json"),
    `${JSON.stringify({
      version: 1,
      profiles: [
        {
          id: "root",
          name: "Root",
          roles: ["root"],
          memoryNamespace: "root",
        },
      ],
    }, null, 2)}\n`,
  );
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

beforeEach(() => {
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-reflection-"));
  process.env.OPENELINARO_ROOT_DIR = runtimeRoot;
  writeProfileRegistry(runtimeRoot);
});

afterEach(() => {
  if (previousRootDirEnv === undefined) {
    delete process.env.OPENELINARO_ROOT_DIR;
  } else {
    process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
  }
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  runtimeRoot = "";
});

describe("ReflectionService", () => {
  test("loads authored reflection prompt files from assistant_context", async () => {
    fs.mkdirSync(path.dirname(resolveAssistantContextPath("reflection.md")), { recursive: true });
    fs.writeFileSync(
      resolveAssistantContextPath("reflection.md"),
      "# Reflection\n\nWrite honestly.\n",
      "utf8",
    );
    fs.writeFileSync(
      resolveAssistantContextPath("reflection-mood-notes.md"),
      "# Mood\n\nUse one sharp word.\n",
      "utf8",
    );
    fs.writeFileSync(
      resolveAssistantContextPath("reflection-seeds.md"),
      "# Seeds\n\nLeave it empty if nothing carries forward.\n",
      "utf8",
    );

    const profiles = new ProfileService("root");
    const profile = profiles.getActiveProfile();
    const routines = new RoutinesService();
    const conversations = new ConversationStore();
    const memory = new MemoryService(profile, profiles);
    const captured: { systemPrompt?: string } = {};
    const reflection = new ReflectionService(
      profile,
      routines,
      conversations,
      memory,
      {
        async generateMemoryText(params: { systemPrompt: string }) {
          captured.systemPrompt = params.systemPrompt;
          return JSON.stringify({
            body: "A quiet day still told me something.",
            mood: "quiet",
            bring_up_next_time: "",
          });
        },
      },
    );

    await reflection.runExplicitReflection({
      reference: new Date("2026-03-18T01:00:00.000Z"),
    });

    expect(captured.systemPrompt).toContain("Write honestly.");
    expect(captured.systemPrompt).toContain("Use one sharp word.");
    expect(captured.systemPrompt).toContain("Leave it empty if nothing carries forward.");
    expect(captured.systemPrompt).toContain("Return strict JSON with keys body, mood, bring_up_next_time.");
  });

  test("writes explicit reflections into the private journal and builds bootstrap continuity", async () => {
    const profiles = new ProfileService("root");
    const profile = profiles.getActiveProfile();
    const routines = new RoutinesService();
    const conversations = new ConversationStore();
    await conversations.appendMessages("dm-1", [new HumanMessage("We should clean up the finance onboarding.")]);
    const memory = new MemoryService(profile, profiles);
    const reflection = new ReflectionService(
      profile,
      routines,
      conversations,
      memory,
      {
        async generateMemoryText() {
          return JSON.stringify({
            body: "I noticed I care about the finance workflow more than I expected. It feels like a point of pride now.",
            mood: "focused",
            bring_up_next_time: "finance onboarding flow",
          });
        },
      },
    );

    const result = await reflection.runExplicitReflection({
      focus: "finance workflow",
      reference: new Date("2026-03-17T22:15:00.000Z"),
    });

    expect(result?.filePath).toContain("/identity/JOURNAL.md");
    const journal = await memory.readProfileDocument("identity/JOURNAL.md");
    expect(journal).toContain("[explicit]");
    expect(journal).toContain("finance onboarding flow");

    const bootstrap = await reflection.buildThreadBootstrapContext();
    expect(bootstrap).toContain("Reflection Continuity");
    expect(bootstrap).toContain("Last mood continuity: focused.");
    expect(bootstrap).toContain("finance onboarding flow");
  });

  test("queues daily and compaction reflections without duplicating the same local day", async () => {
    const profiles = new ProfileService("root");
    const profile = profiles.getActiveProfile();
    const routines = new RoutinesService();
    const conversations = new ConversationStore();
    await conversations.appendMessages("dm-2", [new HumanMessage("The reminder system still feels too passive.")]);
    const memory = new MemoryService(profile, profiles);
    const reflection = new ReflectionService(
      profile,
      routines,
      conversations,
      memory,
      {
        async generateMemoryText(params: { usagePurpose: string }) {
          return JSON.stringify({
            body: `Reflection for ${params.usagePurpose}.`,
            mood: "productive",
            bring_up_next_time: params.usagePurpose.includes("compaction")
              ? "tighten reminder cadence"
              : "",
          });
        },
      },
    );

    const reference = new Date("2026-03-17T22:30:00.000Z");
    reflection.queueDailyReflectionIfEligible(reference);
    await waitFor(async () => {
      const journal = await memory.readProfileDocument("identity/JOURNAL.md");
      return (journal ?? "").includes("[daily]");
    });

    reflection.queueDailyReflectionIfEligible(reference);
    await new Promise((resolve) => setTimeout(resolve, 50));

    reflection.queueCompactionReflection({
      summary: "The session showed repeated reminder misses.",
      conversationKey: "dm-2",
      reference,
    });
    await waitFor(async () => {
      const journal = await memory.readProfileDocument("identity/JOURNAL.md");
      return (journal ?? "").includes("[compaction]");
    });

    const journal = await memory.readProfileDocument("identity/JOURNAL.md");
    expect((journal?.match(/\[daily\]/g) ?? []).length).toBe(1);
    expect(journal).toContain("[compaction]");
  });

  test("hands daily reflections off to the soul rewrite cadence when a daily entry is written", async () => {
    const profiles = new ProfileService("root");
    const profile = profiles.getActiveProfile();
    const routines = new RoutinesService();
    const conversations = new ConversationStore();
    const memory = new MemoryService(profile, profiles);
    let soulQueuedAt: Date | undefined;
    const reflection = new ReflectionService(
      profile,
      routines,
      conversations,
      memory,
      {
        async generateMemoryText() {
          return JSON.stringify({
            body: "Something shifted today.",
            mood: "sharp",
            bring_up_next_time: "",
          });
        },
      },
      {
        queueScheduledRewriteIfEligible(reference?: Date) {
          soulQueuedAt = reference;
        },
      },
    );

    const reference = new Date("2026-03-17T22:30:00.000Z");
    reflection.queueDailyReflectionIfEligible(reference);
    await waitFor(async () =>
      Boolean(await memory.readProfileDocument("identity/JOURNAL.md")) && soulQueuedAt !== undefined
    );

    expect(soulQueuedAt?.toISOString()).toBe(reference.toISOString());
  });
});
