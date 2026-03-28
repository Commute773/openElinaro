import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MemoryService } from "./memory-service";
import { ProfileService } from "./profiles";
import { RoutinesService } from "./scheduling/routines-service";
import { SoulService } from "./soul-service";
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

beforeEach(() => {
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-soul-"));
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

describe("SoulService", () => {
  test("rewrites SOUL.md from the authored soul prompt and tracks cadence state", async () => {
    fs.mkdirSync(path.dirname(resolveAssistantContextPath("soul.md")), { recursive: true });
    fs.writeFileSync(
      resolveAssistantContextPath("soul.md"),
      "# Soul Rewrite\n\nRewrite the self-model honestly.\n",
      "utf8",
    );

    const profiles = new ProfileService("root");
    const profile = profiles.getActiveProfile();
    const routines = new RoutinesService();
    const memory = new MemoryService(profile, profiles);
    await memory.upsertProfileDocument({
      relativePath: "identity/JOURNAL.md",
      content: [
        "## 2026-03-10T20:00:00.000Z [daily]",
        "",
        "- mood: focused",
        "- bring_up_next_time: tighten onboarding",
        "",
        "I care more about the finance system than I expected.",
        "",
      ].join("\n"),
    });

    const captured: { systemPrompt?: string; userPrompt?: string } = {};
    const soul = new SoulService(
      profile,
      routines,
      memory,
      {
        async generateMemoryText(params: { systemPrompt: string; userPrompt: string }) {
          captured.systemPrompt = params.systemPrompt;
          captured.userPrompt = params.userPrompt;
          return "# SOUL\n\nI am becoming more opinionated about product quality.\n";
        },
      },
    );

    const result = await soul.runExplicitRewrite({
      reference: new Date("2026-03-18T02:00:00.000Z"),
    });

    expect(result?.filePath).toContain("/identity/SOUL.md");
    expect(await memory.readProfileDocument("identity/SOUL.md")).toContain("product quality");
    expect(captured.systemPrompt).toContain("Rewrite the self-model honestly.");
    expect(captured.userPrompt).toContain("Recent journal entries:");
    expect(soul.isScheduledRewriteEligible(new Date("2026-03-19T02:00:00.000Z"))).toBe(false);
    expect(soul.isScheduledRewriteEligible(new Date("2026-03-26T02:00:00.000Z"))).toBe(true);
  });
});
