import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getRuntimeConfig } from "../config/runtime-config";
import { resolveRuntimePath, resolveServicePath } from "./runtime-root";
import { attemptOr } from "../utils/result";

const DEFAULT_VENV_PATH = "python/.venv";
const DEFAULT_REQUIREMENTS_FILE = "python/requirements.txt";
const VENV_BIN_DIR = process.platform === "win32" ? "Scripts" : "bin";
const PYTHON_BIN_NAME = process.platform === "win32" ? "python.exe" : "python";
const CRAWL4AI_SETUP_NAME = process.platform === "win32" ? "crawl4ai-setup.exe" : "crawl4ai-setup";
const WEB_FETCH_PYTHON_MODULES = ["crawl4ai", "playwright"] as const;
const OPENBROWSER_PYTHON_MODULES = ["openbrowser", "playwright"] as const;
const LOCAL_VOICE_PYTHON_MODULES = process.platform === "darwin"
  ? ["fastapi", "uvicorn", "numpy", "pydantic", "mlx", "mlx_lm", "mlx_audio", "mlx_embedding_models"] as const
  : ["fastapi", "uvicorn", "numpy", "pydantic"] as const;

export const SHARED_PYTHON_RUNTIME_MODULES = Array.from(new Set([
  ...WEB_FETCH_PYTHON_MODULES,
  ...OPENBROWSER_PYTHON_MODULES,
  ...LOCAL_VOICE_PYTHON_MODULES,
]));

export function getWebFetchPythonModules() {
  return [...WEB_FETCH_PYTHON_MODULES];
}

export function getOpenBrowserPythonModules() {
  return [...OPENBROWSER_PYTHON_MODULES];
}

export function getLocalVoicePythonModules() {
  return [...LOCAL_VOICE_PYTHON_MODULES];
}

function normalizeRequiredModules(requiredModules?: string[]) {
  return Array.from(new Set((requiredModules ?? SHARED_PYTHON_RUNTIME_MODULES).map((value) => value.trim()).filter(Boolean)));
}

function findMissingPythonModules(pythonBin: string, requiredModules: string[]) {
  if (requiredModules.length === 0 || !fs.existsSync(pythonBin)) {
    return [] as string[];
  }

  const result = spawnSync(
    pythonBin,
    [
      "-c",
      [
        "import importlib.util",
        "import json",
        "import sys",
        "modules = json.loads(sys.argv[1])",
        "missing = [name for name in modules if importlib.util.find_spec(name) is None]",
        "sys.stdout.write(json.dumps(missing))",
      ].join("\n"),
      JSON.stringify(requiredModules),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
      },
    },
  );

  if (result.status !== 0) {
    return [...requiredModules];
  }

  const parsed = attemptOr(() => JSON.parse(result.stdout.trim() || "[]"), undefined);
  return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [...requiredModules];
}

function resolveRuntimeRelativePath(configuredPath: string) {
  return path.isAbsolute(configuredPath) ? configuredPath : resolveRuntimePath(configuredPath);
}

function resolveServiceRelativePath(configuredPath: string) {
  return path.isAbsolute(configuredPath) ? configuredPath : resolveServicePath(configuredPath);
}

export function getSharedPythonVenvPath() {
  const configuredPath = getRuntimeConfig().core.python.venvPath?.trim() || DEFAULT_VENV_PATH;
  return resolveRuntimeRelativePath(configuredPath);
}

export function getSharedPythonBinPath() {
  return path.join(getSharedPythonVenvPath(), VENV_BIN_DIR, PYTHON_BIN_NAME);
}

export function getSharedPythonRequirementsPath() {
  const configuredPath = getRuntimeConfig().core.python.requirementsFile?.trim() || DEFAULT_REQUIREMENTS_FILE;
  return resolveServiceRelativePath(configuredPath);
}

export function getSharedPythonCrawl4AiSetupPath() {
  return path.join(getSharedPythonVenvPath(), VENV_BIN_DIR, CRAWL4AI_SETUP_NAME);
}

export function resolvePythonScriptPath(configuredPath: string | undefined, defaultRelativePath: string) {
  const trimmed = configuredPath?.trim();
  return resolveServiceRelativePath(trimmed || defaultRelativePath);
}

export function getPythonRuntimeSetupCommand() {
  return "bun run setup:python";
}

export function getSharedPythonRuntimeStatus(options?: { requiredModules?: string[] }) {
  const venvPath = getSharedPythonVenvPath();
  const pythonBin = getSharedPythonBinPath();
  const requirementsPath = getSharedPythonRequirementsPath();
  const requiredModules = normalizeRequiredModules(options?.requiredModules);
  const interpreterReady = fs.existsSync(pythonBin);
  const requirementsPresent = fs.existsSync(requirementsPath);
  const missingModules = interpreterReady ? findMissingPythonModules(pythonBin, requiredModules) : [...requiredModules];
  return {
    venvPath,
    pythonBin,
    requirementsPath,
    ready: interpreterReady && requirementsPresent && missingModules.length === 0,
    interpreterReady,
    requirementsPresent,
    requiredModules,
    missingModules,
  };
}

export function buildMissingPythonRuntimeMessage(options?: { requiredModules?: string[] }) {
  const status = getSharedPythonRuntimeStatus(options);
  const missingBits = [
    !status.interpreterReady ? `shared Python interpreter not found at ${status.pythonBin}` : "",
    !status.requirementsPresent ? `requirements file not found at ${status.requirementsPath}` : "",
    status.interpreterReady && status.missingModules.length > 0
      ? `shared Python modules missing: ${status.missingModules.join(", ")}`
      : "",
  ].filter(Boolean);
  return `${missingBits.join("; ")}. Run \`${getPythonRuntimeSetupCommand()}\`.`;
}

export function assertSharedPythonRuntimeReady(requiredModules?: string[]) {
  const status = getSharedPythonRuntimeStatus({ requiredModules });
  if (!status.ready) {
    throw new Error(buildMissingPythonRuntimeMessage({ requiredModules }));
  }
  return status.pythonBin;
}
