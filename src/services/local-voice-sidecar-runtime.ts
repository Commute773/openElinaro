import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { getRuntimeConfig } from "../config/runtime-config";
import { assertSharedPythonRuntimeReady, getLocalVoicePythonModules } from "./python-runtime";
import { resolveRuntimePath, resolveServicePath } from "./runtime-root";
import { telemetry } from "./infrastructure/telemetry";

const DEFAULT_LOCAL_LLM_BASE_URL = "http://127.0.0.1:8800/v1";
const DEFAULT_KOKORO_BASE_URL = "http://127.0.0.1:8801/v1";
const DEFAULT_LOCAL_LLM_MODEL = "qwen3.5-35b-a3b";
const DEFAULT_KOKORO_VOICE = "am_fenrir";
const RESTART_DELAY_MS = 3_000;

type SidecarSpec = {
  name: "local-llm" | "kokoro";
  healthUrl: string;
  startupTimeoutMs: number;
  scriptPath: string;
  args?: string[];
  env?: Record<string, string>;
  pythonBin: string;
  warmup: () => Promise<void>;
};

type SpawnedSidecar = {
  child: ChildProcessByStdio<null, Readable, Readable>;
  stdoutPath: string;
  stderrPath: string;
};

function parseBooleanEnv(value: string | undefined, fallback: boolean) {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function isLocalHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return ["127.0.0.1", "localhost", "0.0.0.0"].includes(url.hostname);
  } catch {
    return false;
  }
}

function logDir() {
  return resolveRuntimePath("logs");
}

async function waitForHealth(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return true;
      }
    } catch {}
    await Bun.sleep(1_000);
  }
  return false;
}

function resolveVoicePythonBin() {
  return assertSharedPythonRuntimeReady(getLocalVoicePythonModules());
}

function resolveLocalLlmBaseUrl() {
  return getRuntimeConfig().localVoice.localLlm.baseUrl?.trim()
    || DEFAULT_LOCAL_LLM_BASE_URL;
}

function resolveKokoroBaseUrl() {
  return getRuntimeConfig().localVoice.kokoro.baseUrl?.trim()
    || DEFAULT_KOKORO_BASE_URL;
}

function createWarmupSpec(): SidecarSpec[] {
  const llmBaseUrl = resolveLocalLlmBaseUrl().replace(/\/+$/, "");
  const kokoroBaseUrl = resolveKokoroBaseUrl().replace(/\/+$/, "");
  const llmHealthUrl = llmBaseUrl.endsWith("/v1") ? `${llmBaseUrl.slice(0, -3)}/health` : `${llmBaseUrl}/health`;
  const kokoroHealthUrl = kokoroBaseUrl.endsWith("/v1") ? `${kokoroBaseUrl.slice(0, -3)}/health` : `${kokoroBaseUrl}/health`;
  const llmPort = new URL(llmBaseUrl).port || "8800";
  const kokoroPort = new URL(kokoroBaseUrl).port || "8801";

  const specs: SidecarSpec[] = [
    {
      name: "local-llm",
      healthUrl: llmHealthUrl,
      startupTimeoutMs: 600_000,
      scriptPath: resolveServicePath("scripts/mlx_cache_server.py"),
      args: ["--host", "127.0.0.1", "--port", llmPort, "--no-logs"],
      pythonBin: resolveVoicePythonBin(),
      warmup: async () => {
        const response = await fetch(`${llmBaseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            model: getRuntimeConfig().localVoice.localLlm.model?.trim() || DEFAULT_LOCAL_LLM_MODEL,
            messages: [{ role: "user", content: "Reply with OK." }],
            max_tokens: 8,
            temperature: 0,
            stream: false,
            enable_thinking: false,
          }),
        });
        if (!response.ok) {
          throw new Error(`local-llm warmup failed: ${response.status} ${response.statusText}`);
        }
        await response.arrayBuffer();
      },
    },
    {
      name: "kokoro",
      healthUrl: kokoroHealthUrl,
      startupTimeoutMs: 90_000,
      scriptPath: resolveServicePath("scripts/kokoro_server.py"),
      env: {
        OPENELINARO_KOKORO_HOST: "127.0.0.1",
        OPENELINARO_KOKORO_PORT: kokoroPort,
      },
      pythonBin: resolveVoicePythonBin(),
      warmup: async () => {
        const response = await fetch(`${kokoroBaseUrl}/audio/speech`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "audio/wav",
          },
          body: JSON.stringify({
            model: getRuntimeConfig().localVoice.kokoro.model?.trim() || "kokoro",
            voice: getRuntimeConfig().localVoice.kokoro.voiceName?.trim() || DEFAULT_KOKORO_VOICE,
            input: "Warmup.",
            response_format: "wav",
          }),
        });
        if (!response.ok) {
          throw new Error(`kokoro warmup failed: ${response.status} ${response.statusText}`);
        }
        await response.arrayBuffer();
      },
    },
  ];
  return specs.filter((spec) => isLocalHttpUrl(spec.healthUrl));
}

class ManagedSidecar {
  private child: SpawnedSidecar | null = null;
  private stopping = false;
  private restartTimer: Timer | null = null;

  constructor(private readonly spec: SidecarSpec) {}

  async start() {
    const healthy = await waitForHealth(this.spec.healthUrl, 1_500);
    if (healthy) {
      telemetry.event("local_voice_sidecar.adopt_existing", { sidecar: this.spec.name });
      await this.runWarmup("adopted");
      return;
    }

    await this.spawnAndWait();
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      this.child.child.kill("SIGTERM");
      this.child = null;
    }
  }

  private async spawnAndWait() {
    fs.mkdirSync(logDir(), { recursive: true });
    const stdoutPath = path.join(logDir(), `${this.spec.name}.stdout.log`);
    const stderrPath = path.join(logDir(), `${this.spec.name}.stderr.log`);
    const stdoutFd = fs.openSync(stdoutPath, "a");
    const stderrFd = fs.openSync(stderrPath, "a");
    const child = spawn(this.spec.pythonBin, [this.spec.scriptPath, ...(this.spec.args ?? [])], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(this.spec.env ?? {}),
      },
    });
    child.stdout.pipe(fs.createWriteStream("", { fd: stdoutFd, autoClose: true }));
    child.stderr.pipe(fs.createWriteStream("", { fd: stderrFd, autoClose: true }));
    this.child = { child, stdoutPath, stderrPath };

    child.once("exit", (code, signal) => {
      this.child = null;
      telemetry.event("local_voice_sidecar.exit", {
        sidecar: this.spec.name,
        code: code ?? null,
        signal: signal ?? null,
      });
      if (!this.stopping) {
        this.restartTimer = setTimeout(() => {
          void this.start().catch((error) => {
            telemetry.recordError(error, {
              eventName: "local_voice_sidecar.restart_failed",
              sidecar: this.spec.name,
            });
          });
        }, RESTART_DELAY_MS);
      }
    });

    const healthy = await waitForHealth(this.spec.healthUrl, this.spec.startupTimeoutMs);
    if (!healthy) {
      child.kill("SIGTERM");
      throw new Error(`Timed out waiting for ${this.spec.name} health at ${this.spec.healthUrl}`);
    }
    telemetry.event("local_voice_sidecar.started", {
      sidecar: this.spec.name,
      healthUrl: this.spec.healthUrl,
      stdoutPath,
      stderrPath,
    });
    await this.runWarmup("spawned");
  }

  private async runWarmup(source: "spawned" | "adopted") {
    try {
      await this.spec.warmup();
      telemetry.event("local_voice_sidecar.warm", {
        sidecar: this.spec.name,
        source,
      });
    } catch (error) {
      telemetry.recordError(error, {
        eventName: "local_voice_sidecar.warmup_failed",
        sidecar: this.spec.name,
        source,
      });
    }
  }
}

export type LocalVoiceSidecarRuntime = {
  stop: () => Promise<void>;
};

export async function startLocalVoiceSidecarRuntime(): Promise<LocalVoiceSidecarRuntime> {
  const enabled = getRuntimeConfig().localVoice.enabled;
  if (!enabled) {
    return {
      stop: async () => {},
    };
  }

  const managed = createWarmupSpec().map((spec) => new ManagedSidecar(spec));
  for (const sidecar of managed) {
    try {
      await sidecar.start();
    } catch (error) {
      telemetry.recordError(error, {
        eventName: "local_voice_sidecar.start_failed",
      });
    }
  }

  return {
    stop: async () => {
      await Promise.all(managed.map((sidecar) => sidecar.stop()));
    },
  };
}
