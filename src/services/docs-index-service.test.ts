import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { updateTestRuntimeConfig } from "../test/runtime-config-test-helpers";
import { DocsIndexService } from "./docs-index-service";

let runtimeRoot = "";
let previousCwd = "";
let previousRootDirEnv: string | undefined;

function writeFile(relativePath: string, content: string) {
  const absolutePath = path.join(runtimeRoot, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, "utf8");
}

beforeEach(() => {
  previousCwd = process.cwd();
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-docs-index-"));
  process.env.OPENELINARO_ROOT_DIR = runtimeRoot;
  process.chdir(runtimeRoot);
});

afterEach(() => {
  process.chdir(previousCwd);
  if (previousRootDirEnv === undefined) {
    delete process.env.OPENELINARO_ROOT_DIR;
  } else {
    process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
  }
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  runtimeRoot = "";
});

describe("DocsIndexService", () => {
  test("syncs managed doc indexes and writes a report", () => {
    writeFile("AGENTS.md", [
      "# AGENTS",
      "",
      "## Generated Docs Entry Points",
      "<!-- docs-index:start:doc-entrypoints -->",
      "- stale",
      "<!-- docs-index:end:doc-entrypoints -->",
      "",
    ].join("\n"));
    writeFile("README.md", "# Root\n");
    writeFile("docs/README.md", [
      "# Docs",
      "",
      "## Generated Inventory",
      "<!-- docs-index:start:inventory -->",
      "- stale",
      "<!-- docs-index:end:inventory -->",
      "",
    ].join("\n"));
    writeFile("docs/assistant/README.md", [
      "# Assistant Docs",
      "",
      "## Generated Inventory",
      "<!-- docs-index:start:inventory -->",
      "- stale",
      "<!-- docs-index:end:inventory -->",
      "",
    ].join("\n"));
    writeFile("docs/research/README.md", [
      "# Research Notes",
      "",
      "## Generated Inventory",
      "<!-- docs-index:start:inventory -->",
      "- stale",
      "<!-- docs-index:end:inventory -->",
      "",
    ].join("\n"));
    writeFile("system_prompt/40-docs-and-reload.md", [
      "# Docs And Reload",
      "",
      "Useful docs:",
      "<!-- docs-index:start:assistant-docs -->",
      "- stale",
      "<!-- docs-index:end:assistant-docs -->",
      "",
    ].join("\n"));
    writeFile("docs/assistant/repo-layout.md", "# Repo Layout And Boundaries\n");
    writeFile("docs/assistant/architecture-decisions.md", "# Architecture Decisions\n");
    writeFile("docs/assistant/runtime-domain-model.md", "# Runtime Domain Model\n");
    writeFile("docs/assistant/projects.md", "# Project Context Model\n");
    writeFile("docs/assistant/memory.md", "# Memory Runtime\n");
    writeFile("docs/assistant/observability.md", "# Observability\n");
    writeFile("docs/assistant/reflection.md", "# Reflection Runtime\n");
    writeFile("docs/assistant/tickets.md", "# Tickets Tooling\n");
    writeFile("docs/assistant/media.md", "# Media Runtime\n");
    writeFile("docs/assistant/decision-support.md", "# Decision Support\n");
    writeFile("docs/assistant/openclaw-migration.md", "# OpenClaw Migration\n");
    writeFile("docs/assistant/tool-use-playbook.md", "# Tool Use Playbook\n");
    writeFile("docs/assistant/harness-smoke-tests.md", "# Harness Smoke Tests\n");
    writeFile("docs/research/openclaw-auth-and-frameworks.md", "# OpenClaw Auth And Frameworks\n");
    writeFile("docs/research/worktree-first-agent-workflows.md", "# Worktree First Agent Workflows\n");
    writeFile("docs/openelinaro-todos.md", "# OpenElinaro Todos\n");

    const service = new DocsIndexService(runtimeRoot, path.join(runtimeRoot, ".openelinarotest", "docs-index.json"));
    const report = service.sync();

    const docsReadme = fs.readFileSync(path.join(runtimeRoot, "docs/README.md"), "utf8");
    const assistantReadme = fs.readFileSync(path.join(runtimeRoot, "docs/assistant/README.md"), "utf8");
    const researchReadme = fs.readFileSync(path.join(runtimeRoot, "docs/research/README.md"), "utf8");
    const agents = fs.readFileSync(path.join(runtimeRoot, "AGENTS.md"), "utf8");
    const systemPrompt = fs.readFileSync(path.join(runtimeRoot, "system_prompt/40-docs-and-reload.md"), "utf8");
    const persistedReport = JSON.parse(fs.readFileSync(path.join(runtimeRoot, ".openelinarotest", "docs-index.json"), "utf8")) as {
      orphanDocs: string[];
      changedFiles: string[];
    };

    expect(docsReadme).toContain("[Assistant Docs](assistant/README.md)");
    expect(docsReadme).toContain("[Research Notes](research/README.md)");
    expect(assistantReadme).toContain("[Repo Layout And Boundaries](repo-layout.md)");
    expect(assistantReadme).toContain("[Decision Support](decision-support.md)");
    expect(researchReadme).toContain("[OpenClaw Auth And Frameworks](openclaw-auth-and-frameworks.md)");
    expect(agents).toContain("[docs/assistant/README.md](docs/assistant/README.md)");
    expect(systemPrompt).toContain("`docs/assistant/decision-support.md`");
    expect(report.orphanDocs).toEqual([]);
    expect(persistedReport.orphanDocs).toEqual([]);
    expect(persistedReport.changedFiles).toEqual(expect.arrayContaining([
      "AGENTS.md",
      "docs/README.md",
      "docs/assistant/README.md",
      "docs/research/README.md",
      "system_prompt/40-docs-and-reload.md",
    ]));
  });

  test("reads the local setting and defaults to disabled", () => {
    writeFile("docs/README.md", "# Docs\n");
    const service = new DocsIndexService(runtimeRoot, path.join(runtimeRoot, ".openelinarotest", "docs-index.json"));

    expect(service.isEnabled()).toBe(false);

    fs.rmSync(path.join(runtimeRoot, ".openelinarotest"), { recursive: true, force: true });
    updateTestRuntimeConfig((config) => {
      config.core.app.docsIndexerEnabled = true;
    });
    expect(new DocsIndexService(runtimeRoot, path.join(runtimeRoot, ".openelinarotest", "docs-index.json")).isEnabled()).toBe(true);
  });
});
