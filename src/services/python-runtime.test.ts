import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ensureRuntimeConfigFile,
  formatRuntimeConfigValidationError,
  getRuntimeConfig,
  hasRuntimeConfigPath,
  reloadRuntimeConfig,
  saveRuntimeConfig,
  type RuntimeConfig,
  validateRuntimeConfigFile,
  validateRuntimeConfigText,
} from "../config/runtime-config";
import { assertSharedPythonRuntimeReady, getSharedPythonRuntimeStatus } from "./python-runtime";

let runtimeRoot = "";
let serviceRoot = "";
let previousRootDir: string | undefined;
let previousServiceRootDir: string | undefined;

function getPythonBinPath(venvPath: string) {
  return process.platform === "win32"
    ? path.join(venvPath, "Scripts", "python.exe")
    : path.join(venvPath, "bin", "python");
}

beforeEach(() => {
  previousRootDir = process.env.OPENELINARO_ROOT_DIR;
  previousServiceRootDir = process.env.OPENELINARO_SERVICE_ROOT_DIR;
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-python-runtime-"));
  serviceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-python-service-"));
  process.env.OPENELINARO_ROOT_DIR = runtimeRoot;
  process.env.OPENELINARO_SERVICE_ROOT_DIR = serviceRoot;
  ensureRuntimeConfigFile();

  const config = structuredClone(getRuntimeConfig()) as RuntimeConfig;
  config.core.python.venvPath = ".venvs/shared";
  config.core.python.requirementsFile = "python/custom.txt";
  saveRuntimeConfig(config);
  fs.mkdirSync(path.join(serviceRoot, "python"), { recursive: true });
  fs.writeFileSync(path.join(serviceRoot, "python", "custom.txt"), "playwright\n", "utf8");
  reloadRuntimeConfig();
});

afterEach(() => {
  if (previousRootDir === undefined) {
    delete process.env.OPENELINARO_ROOT_DIR;
  } else {
    process.env.OPENELINARO_ROOT_DIR = previousRootDir;
  }
  if (previousServiceRootDir === undefined) {
    delete process.env.OPENELINARO_SERVICE_ROOT_DIR;
  } else {
    process.env.OPENELINARO_SERVICE_ROOT_DIR = previousServiceRootDir;
  }
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  fs.rmSync(serviceRoot, { recursive: true, force: true });
});

describe("python-runtime", () => {
  test("resolves the shared venv under runtime state and the requirements file under service code", () => {
    const status = getSharedPythonRuntimeStatus();

    expect(status.venvPath).toBe(path.join(runtimeRoot, ".venvs", "shared"));
    expect(status.pythonBin).toBe(getPythonBinPath(path.join(runtimeRoot, ".venvs", "shared")));
    expect(status.requirementsPath).toBe(path.join(serviceRoot, "python", "custom.txt"));
    expect(status.ready).toBe(false);
    expect(status.interpreterReady).toBe(false);
    expect(status.requirementsPresent).toBe(true);
  });

  test("throws a setup hint when the shared runtime has not been prepared", () => {
    expect(() => assertSharedPythonRuntimeReady()).toThrow(/bun run setup:python/);
  });

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
