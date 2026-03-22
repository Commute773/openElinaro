import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { updateTestRuntimeConfig } from "../test/runtime-config-test-helpers";
import { SystemPromptService } from "./system-prompt-service";

let previousCwd = "";
let previousRootDirEnv: string | undefined;
let tempRoot = "";

beforeEach(() => {
  previousCwd = process.cwd();
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-system-prompt-"));
  process.env.OPENELINARO_ROOT_DIR = tempRoot;
  process.chdir(tempRoot);
});

afterEach(() => {
  process.chdir(previousCwd);
  if (previousRootDirEnv === undefined) {
    delete process.env.OPENELINARO_ROOT_DIR;
  } else {
    process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("SystemPromptService", () => {
  test("prepends a runtime overview before prompt files", () => {
    updateTestRuntimeConfig((config) => {
      config.core.app.automaticConversationMemoryEnabled = false;
      config.core.app.docsIndexerEnabled = true;
      config.finance.enabled = true;
      config.webSearch.enabled = true;
    });
    fs.mkdirSync(path.join(tempRoot, "system_prompt"), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "system_prompt/00-test.md"), "You are OpenElinaro.", "utf8");

    const snapshot = new SystemPromptService().load();

    expect(snapshot.text.startsWith("## Runtime\nRuntime: OpenElinaro local-first agent runtime.")).toBe(true);
    expect(snapshot.text).toContain("Core toggles: automatic conversation memory off; docs indexer on.");
    expect(snapshot.text).toContain("Optional features enabled in config: webSearch, finance.");
    expect(snapshot.text).toContain("Optional features disabled in config:");
    expect(snapshot.text).toContain("feature_manage");
    expect(snapshot.text.indexOf("## Runtime")).toBeLessThan(snapshot.text.indexOf("<!-- system_prompt/00-test.md -->"));
  });

  test("injects the configured assistant display name into loaded prompt context", () => {
    updateTestRuntimeConfig((config) => {
      config.core.assistant.displayName = "Llvind";
    });
    fs.mkdirSync(path.join(tempRoot, "system_prompt"), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "system_prompt/00-test.md"), "You are OpenElinaro.", "utf8");

    const snapshot = new SystemPromptService().load();

    expect(snapshot.text).toContain("Configured assistant display name: Llvind.");
    expect(snapshot.text).toContain("Use this display name in user-facing status text");
  });
});
