import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ensureRuntimeConfigFile,
  formatRuntimeConfigValidationError,
  hasRuntimeConfigPath,
  validateRuntimeConfigFile,
  validateRuntimeConfigText,
} from "./runtime-config";

let runtimeRoot = "";
let previousRootDir: string | undefined;

beforeEach(() => {
  previousRootDir = process.env.OPENELINARO_ROOT_DIR;
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-runtime-config-"));
  process.env.OPENELINARO_ROOT_DIR = runtimeRoot;
  ensureRuntimeConfigFile();
});

afterEach(() => {
  if (previousRootDir === undefined) {
    delete process.env.OPENELINARO_ROOT_DIR;
  } else {
    process.env.OPENELINARO_ROOT_DIR = previousRootDir;
  }
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

describe("runtime-config", () => {
  test("validates the current config file and known schema paths", () => {
    const config = validateRuntimeConfigFile();

    expect(config.core.assistant.displayName).toBe("OpenElinaro");
    expect(hasRuntimeConfigPath("email.enabled")).toBe(true);
    expect(hasRuntimeConfigPath("communications.vonage.applicationId")).toBe(true);
    expect(hasRuntimeConfigPath("email.notARealField")).toBe(false);
    expect(hasRuntimeConfigPath("")).toBe(false);
  });

  test("formats schema validation failures with config paths", () => {
    let message = "";

    try {
      validateRuntimeConfigText("email:\n  imapPort: 0\n");
    } catch (error) {
      message = formatRuntimeConfigValidationError(error);
    }

    expect(message).toContain("email.imapPort");
    expect(message).toContain("Too small");
  });
});
