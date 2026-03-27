import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createIsolatedRuntimeRoot } from "../test/isolated-runtime-root";

const repoRoot = process.cwd();
const testRoot = createIsolatedRuntimeRoot("openelinaro-recent-context-");

let previousCwd = "";
let profileServiceModule: typeof import("./profile-service");
let projectsServiceModule: typeof import("./projects-service");
let recentContextModule: typeof import("./recent-thread-context-service");

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?test=${Date.now()}-${Math.random()}`) as Promise<T>;
}

function writeFile(relativePath: string, content: string, modifiedAt: Date) {
  const absolutePath = path.join(testRoot.path, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, "utf8");
  fs.utimesSync(absolutePath, modifiedAt, modifiedAt);
}

beforeAll(async () => {
  previousCwd = process.cwd();
  testRoot.setup();
  process.chdir(testRoot.path);

  fs.mkdirSync(".openelinarotest/profiles", { recursive: true });
  fs.writeFileSync(
    ".openelinarotest/profiles/registry.json",
    `${JSON.stringify({
      version: 1,
      profiles: [
        {
          id: "root",
          name: "Root",
          roles: ["root"],
          memoryNamespace: "root",
        },
        {
          id: "restricted",
          name: "Restricted",
          roles: ["restricted"],
          memoryNamespace: "restricted",
        },
      ],
    }, null, 2)}\n`,
  );

  fs.mkdirSync(".openelinarotest/projects/sample", { recursive: true });
  fs.mkdirSync(".openelinarotest/projects/root-only", { recursive: true });
  fs.writeFileSync(
    ".openelinarotest/projects/registry.json",
    `${JSON.stringify({
      version: 1,
      projects: [
        {
          id: "sample",
          name: "Sample",
          status: "active",
          allowedRoles: ["restricted"],
          workspacePath: path.join(testRoot.path, ".openelinarotest", "projects/sample/workspace"),
          summary: "Sample project.",
          currentState: "Recent changes landed.",
          state: "The sample project moved its long-form state into the registry.",
          future: "The sample project should keep using embedded registry context.",
          nextFocus: ["Finish the next pass."],
          structure: ["README.md", "projects/registry.json: embedded state/future"],
          tags: ["sample"],
          docs: {
            readme: "projects/sample/README.md",
          },
        },
        {
          id: "root-only",
          name: "Root Only",
          status: "active",
          allowedRoles: [],
          workspacePath: path.join(testRoot.path, ".openelinarotest", "projects/root-only/workspace"),
          summary: "Root-only project.",
          currentState: "Hidden from restricted.",
          state: "Root-only registry state.",
          future: "Remain hidden from restricted.",
          nextFocus: ["Stay hidden."],
          structure: ["README.md", "projects/registry.json: embedded state/future"],
          tags: ["root"],
          docs: {
            readme: "projects/root-only/README.md",
          },
        },
      ],
    }, null, 2)}\n`,
  );

  const now = new Date("2026-03-12T17:30:00.000Z");
  writeFile(
    ".openelinarotest/memory/documents/root/compactions/2026-03-12T17-06-03.752Z.md",
    "# Root compaction\n\nShipped the recent memory bootstrap change.\n",
    new Date(now.getTime() - 1_000),
  );
  writeFile(
    ".openelinarotest/memory/documents/restricted/private.md",
    "# Restricted note\n\nOnly restricted should see this note.\n",
    new Date(now.getTime() - 2_000),
  );
  writeFile(
    ".openelinarotest/memory/documents/root/identity/JOURNAL.md",
    "## 2026-03-12T17:20:00.000Z [daily]\n\n- mood: productive\n- bring_up_next_time: finish the finance onboarding flow\n\nPrivate reflection.\n",
    new Date(now.getTime() - 250),
  );
  writeFile(
    ".openelinarotest/projects/sample/README.md",
    "# Sample README\n\nProject overview.\n",
    new Date(now.getTime() - 3_000),
  );
  writeFile(
    ".openelinarotest/projects/root-only/README.md",
    "# Root Only README\n\nRestricted doc.\n",
    new Date(now.getTime() - 500),
  );
  writeFile(
    "docs/assistant/runtime-notes.md",
    "# Runtime Notes\n\nRecent runtime behavior changed.\n",
    new Date(now.getTime() - 10_000),
  );
  writeFile(
    "docs/research/skip-me.md",
    "# Research\n\nThis should not be in the startup digest.\n",
    now,
  );

  profileServiceModule = await importFresh("src/services/profile-service.ts");
  projectsServiceModule = await importFresh("src/services/projects-service.ts");
  recentContextModule = await importFresh("src/services/recent-thread-context-service.ts");
});

afterAll(() => {
  process.chdir(previousCwd);
  testRoot.teardown();
});

describe("RecentThreadContextService", () => {
  test("builds a bounded startup digest from recent memory and docs", () => {
    const profiles = new profileServiceModule.ProfileService("root");
    const profile = profiles.getActiveProfile();
    const projects = new projectsServiceModule.ProjectsService(profile, profiles);
    const service = new recentContextModule.RecentThreadContextService(profile, projects, profiles);

    const text = service.buildThreadStartContext();

    expect(text).toContain("## Thread-Start Recent Context");
    expect(text).toContain(".openelinarotest/memory/documents/root/compactions/2026-03-12T17-06-03.752Z.md");
    expect(text).toContain(".openelinarotest/projects/sample/README.md");
    expect(text).toContain(".openelinarotest/projects/root-only/README.md");
    expect(text).toContain("docs/assistant/runtime-notes.md");
    expect(text).not.toContain("docs/research/skip-me.md");
    expect(text).not.toContain(".openelinarotest/memory/documents/root/identity/JOURNAL.md");
    expect(text.length).toBeLessThanOrEqual(recentContextModule.THREAD_START_CONTEXT_CHAR_BUDGET);
  });

  test("respects profile-scoped memory and project access", () => {
    const profiles = new profileServiceModule.ProfileService("restricted");
    const profile = profiles.getActiveProfile();
    const projects = new projectsServiceModule.ProjectsService(profile, profiles);
    const service = new recentContextModule.RecentThreadContextService(profile, projects, profiles);

    const text = service.buildThreadStartContext();

    expect(text).toContain(".openelinarotest/memory/documents/restricted/private.md");
    expect(text).toContain(".openelinarotest/projects/sample/README.md");
    expect(text).not.toContain(".openelinarotest/memory/documents/root/compactions/2026-03-12T17-06-03.752Z.md");
    expect(text).not.toContain(".openelinarotest/projects/root-only/README.md");
  });

  test("only includes startup context before the first human message", () => {
    expect(recentContextModule.shouldIncludeRecentThreadContext([])).toBe(true);
    expect(
      recentContextModule.shouldIncludeRecentThreadContext([new AIMessage("Fresh conversation.")]),
    ).toBe(true);
    expect(
      recentContextModule.shouldIncludeRecentThreadContext([
        new AIMessage("Fresh conversation."),
        new HumanMessage("hello"),
      ]),
    ).toBe(false);
  });
});
