import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureRuntimeConfigFile } from "../config/runtime-config";
import {
  getPythonRuntimeSetupCommand,
  getSharedPythonBinPath,
  getSharedPythonCrawl4AiSetupPath,
  getSharedPythonRuntimeStatus,
} from "../services/python-runtime";

function usage() {
  return [
    "Usage:",
    "  bun src/cli/setup-python.ts",
    "  bun src/cli/setup-python.ts status",
    "",
    "Creates or updates the shared Python venv used by all Python-backed features.",
  ].join("\n");
}

function runOrThrow(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
    },
  });

  if (result.status === 0) {
    return;
  }

  if (result.error) {
    throw result.error;
  }

  throw new Error(`${command} ${args.join(" ")} exited with code ${result.status ?? "unknown"}.`);
}

function resolveBootstrapPython() {
  for (const candidate of [process.env.OPENELINARO_BOOTSTRAP_PYTHON_BIN?.trim(), "python3", "python"]) {
    if (!candidate) {
      continue;
    }
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (result.status === 0) {
      return candidate;
    }
  }

  throw new Error(`Python 3 was not found in PATH. Install it, then rerun \`${getPythonRuntimeSetupCommand()}\`.`);
}

function printStatus() {
  const status = getSharedPythonRuntimeStatus();
  console.log(`Shared Python venv: ${status.venvPath}`);
  console.log(`Python interpreter: ${status.pythonBin}`);
  console.log(`Requirements file: ${status.requirementsPath}`);
  console.log(`Ready: ${status.ready ? "yes" : "no"}`);
  if (status.missingModules.length > 0) {
    console.log(`Missing modules: ${status.missingModules.join(", ")}`);
  }
}

const command = process.argv[2];
if (command === "--help" || command === "-h") {
  console.log(usage());
  process.exit(0);
}

ensureRuntimeConfigFile();

if (command === "status") {
  printStatus();
  process.exit(0);
}

if (command && command !== "setup") {
  console.error(`Unknown command: ${command}`);
  console.error(usage());
  process.exit(1);
}

const status = getSharedPythonRuntimeStatus();
if (!status.requirementsPresent) {
  throw new Error(`Shared Python requirements file not found at ${status.requirementsPath}.`);
}

fs.mkdirSync(path.dirname(status.venvPath), { recursive: true });

if (!status.interpreterReady) {
  const bootstrapPython = resolveBootstrapPython();
  runOrThrow(bootstrapPython, ["-m", "venv", status.venvPath]);
}

const pythonBin = getSharedPythonBinPath();
runOrThrow(pythonBin, ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"]);
runOrThrow(pythonBin, ["-m", "pip", "install", "-r", status.requirementsPath]);
runOrThrow(pythonBin, ["-m", "playwright", "install", "chromium"]);

const crawl4AiSetup = getSharedPythonCrawl4AiSetupPath();
if (fs.existsSync(crawl4AiSetup)) {
  runOrThrow(crawl4AiSetup, []);
}

printStatus();
console.log("Shared Python runtime is ready.");
