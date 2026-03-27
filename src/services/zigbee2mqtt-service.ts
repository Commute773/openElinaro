import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { getRuntimeConfig } from "../config/runtime-config";
import { resolveRuntimePath, resolveServicePath } from "./runtime-root";
import { telemetry } from "./telemetry";

const log = telemetry.child({ component: "zigbee" });
const BRIDGE_PORT = 8085;
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;
const RESTART_DELAY_MS = 3_000;
const STARTUP_TIMEOUT_MS = 30_000;

// ---------- Paths ----------

function zigbeeDir() {
  return resolveRuntimePath("zigbee");
}

function logDir() {
  return resolveRuntimePath("logs");
}

// ---------- USB radio auto-detection ----------

export function detectZigbeeRadio(): string | null {
  const patterns = ["/dev/cu.usbserial-", "/dev/cu.usbmodem", "/dev/ttyUSB", "/dev/ttyACM"];
  for (const pattern of patterns) {
    const dir = path.dirname(pattern);
    const prefix = path.basename(pattern);
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith(prefix)) return path.join(dir, entry);
      }
    } catch {}
  }
  return null;
}

// ---------- HTTP helpers ----------

async function bridgeGet(path: string): Promise<any> {
  const res = await fetch(`${BRIDGE_URL}${path}`);
  return res.json();
}

async function bridgePost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BRIDGE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ---------- Health check ----------

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BRIDGE_URL}/health`);
      if (res.ok) {
        const data = await res.json() as { started?: boolean };
        if (data.started) return true;
      }
    } catch {}
    await Bun.sleep(500);
  }
  return false;
}

// ---------- Types ----------

export type DeviceState = Record<string, unknown>;

export type DeviceInfo = {
  ieeeAddr: string;
  friendlyName: string;
  type: string;
  modelID?: string;
  manufacturer?: string;
  powerSource?: string;
  lastSeen?: number;
  definition?: { vendor: string; model: string; description: string } | null;
};

// ---------- Service ----------

export class Zigbee2MqttService {
  private child: ChildProcess | null = null;
  private stopping = false;
  private restartTimer: Timer | null = null;
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;

    // Check if bridge is already running (e.g. from a previous instance).
    const alreadyHealthy = await waitForHealth(1_500);
    if (alreadyHealthy) {
      this.started = true;
      log.event("zigbee.bridge_adopted", {});
      return;
    }

    await this.spawnBridge();
  }

  private async spawnBridge(): Promise<void> {
    const config = getRuntimeConfig().zigbee2mqtt;
    const serialPort = config.serialPort.trim() || detectZigbeeRadio();
    if (!serialPort) {
      throw new Error("No Zigbee USB radio detected. Set zigbee2mqtt.serialPort in config or plug in a coordinator.");
    }

    const bridgeScript = resolveServicePath("scripts/zigbee-bridge.mjs");
    const nodeBin = findNodeBin();
    if (!nodeBin) {
      throw new Error("Node.js is required for the zigbee bridge (Bun doesn't support serialport native module yet). Install Node.js.");
    }

    fs.mkdirSync(logDir(), { recursive: true });
    fs.mkdirSync(zigbeeDir(), { recursive: true });
    const stdoutPath = path.join(logDir(), "zigbee-bridge.stdout.log");
    const stderrPath = path.join(logDir(), "zigbee-bridge.stderr.log");
    const stdoutFd = fs.openSync(stdoutPath, "a");
    const stderrFd = fs.openSync(stderrPath, "a");

    const child = spawn(nodeBin, [
      bridgeScript,
      "--port", String(BRIDGE_PORT),
      "--serial", serialPort,
      "--adapter", config.adapterType || "ember",
      "--channel", String(config.channel),
      "--db-path", zigbeeDir(),
    ], {
      cwd: resolveServicePath("."),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    child.stdout?.pipe(fs.createWriteStream("", { fd: stdoutFd, autoClose: true }));
    child.stderr?.pipe(fs.createWriteStream("", { fd: stderrFd, autoClose: true }));
    this.child = child;

    child.once("exit", (code, signal) => {
      this.child = null;
      this.started = false;
      log.event("zigbee.bridge_exit", { code: code ?? null, signal: signal ?? null });
      if (!this.stopping) {
        this.restartTimer = setTimeout(() => {
          void this.start().catch((err) => {
            log.recordError(err, { eventName: "zigbee.bridge_restart_failed" });
          });
        }, RESTART_DELAY_MS);
      }
    });

    const healthy = await waitForHealth(STARTUP_TIMEOUT_MS);
    if (!healthy) {
      child.kill("SIGTERM");
      throw new Error(`Zigbee bridge did not become healthy within ${STARTUP_TIMEOUT_MS / 1000}s. Check ${stderrPath}`);
    }

    this.started = true;
    log.event("zigbee.bridge_started", { serialPort, stdoutPath, stderrPath });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
    this.started = false;
  }

  isStarted(): boolean {
    return this.started;
  }

  // ---------- Device queries (proxied to bridge) ----------

  listDevices(): DeviceInfo[] {
    // Sync-safe: return empty if not started. Tools will call ensureStarted.
    return [];
  }

  async listDevicesAsync(): Promise<{ devices: DeviceInfo[]; states: Record<string, DeviceState> }> {
    await this.ensureStarted();
    return bridgeGet("/devices");
  }

  async getDeviceState(friendlyName: string): Promise<DeviceState | undefined> {
    const data = await this.listDevicesAsync();
    return data.states[friendlyName];
  }

  // ---------- Device control ----------

  async setDeviceState(friendlyName: string, state: Record<string, unknown>): Promise<string> {
    await this.ensureStarted();
    const data = await bridgePost("/device/set", { device: friendlyName, state });
    if (data.error) return data.error;
    return (data.results || [])
      .map((r: any) => `${r.key}=${JSON.stringify(r.value)} ${r.ok ? "✓" : "✗ " + r.error}${r.raw ? " (raw)" : ""}`)
      .join("\n");
  }

  async getDeviceStateFresh(friendlyName: string): Promise<string> {
    await this.ensureStarted();
    const data = await bridgeGet(`/device?name=${encodeURIComponent(friendlyName)}`);
    if (data.error) return data.error;
    return JSON.stringify(data.state, null, 2);
  }

  async renameDevice(oldName: string, newName: string): Promise<string> {
    await this.ensureStarted();
    const data = await bridgePost("/rename", { old_name: oldName, new_name: newName });
    if (data.error) return data.error;
    return `Renamed: ${oldName} → ${newName}`;
  }

  async permitJoin(seconds = 120): Promise<string> {
    await this.ensureStarted();
    const data = await bridgePost("/permit-join", { seconds });
    if (data.error) return data.error;
    return `Permit join enabled for ${seconds}s. Put your device in pairing mode now.`;
  }

  async disableJoin(): Promise<string> {
    await this.ensureStarted();
    const data = await bridgePost("/disable-join", {});
    if (data.error) return data.error;
    return "Permit join disabled.";
  }

  // ---------- Render ----------

  async renderStatus(): Promise<string> {
    await this.ensureStarted();
    const lines: string[] = [];
    lines.push(`Zigbee bridge: ${this.started ? "running" : "stopped"}`);

    if (!this.started) {
      lines.push("Devices: unknown (bridge not running)");
      return lines.join("\n");
    }

    try {
      const data = await bridgeGet("/devices");
      const devices: DeviceInfo[] = data.devices || [];
      const states: Record<string, DeviceState> = data.states || {};
      lines.push(`Devices: ${devices.length} paired`);
      lines.push("");

      if (devices.length === 0) {
        lines.push("No devices paired yet. Use zigbee_permit_join to pair a new device.");
      } else {
        for (const dev of devices) {
          const state = states[dev.friendlyName];
          const stateStr = state ? ` | ${summarizeState(state)}` : "";
          const model = dev.definition
            ? `${dev.definition.vendor} ${dev.definition.model}`
            : (dev.modelID ?? "unknown");
          lines.push(`- ${dev.friendlyName} (${model}, ${dev.type})${stateStr}`);
        }
      }
    } catch (err) {
      lines.push(`Error fetching devices: ${err instanceof Error ? err.message : String(err)}`);
    }
    return lines.join("\n");
  }

  async renderDeviceDetail(friendlyName: string): Promise<string> {
    await this.ensureStarted();
    const data = await bridgeGet(`/device?name=${encodeURIComponent(friendlyName)}`);
    if (data.error) return data.error;

    const dev: DeviceInfo = data.device;
    const state: DeviceState = data.state || {};
    const lines: string[] = [];
    lines.push(`Name: ${dev.friendlyName}`);
    lines.push(`IEEE: ${dev.ieeeAddr}`);
    lines.push(`Type: ${dev.type}`);
    lines.push(`Model: ${dev.modelID ?? "unknown"}`);
    lines.push(`Manufacturer: ${dev.manufacturer ?? "unknown"}`);
    lines.push(`Power: ${dev.powerSource ?? "unknown"}`);
    lines.push(`Last seen: ${dev.lastSeen ? new Date(dev.lastSeen).toISOString() : "never"}`);

    if (dev.definition) {
      lines.push(`Definition: ${dev.definition.vendor} ${dev.definition.model} — ${dev.definition.description}`);
    }

    if (Object.keys(state).length > 0) {
      lines.push(`\nCurrent state: ${JSON.stringify(state, null, 2)}`);
    }

    return lines.join("\n");
  }

  private async ensureStarted() {
    if (!this.started) await this.start();
  }
}

function summarizeState(state: DeviceState): string {
  const parts: string[] = [];
  if ("state" in state) parts.push(`state=${state.state}`);
  if ("onOff" in state) parts.push(`on=${state.onOff}`);
  if ("brightness" in state) parts.push(`brightness=${state.brightness}`);
  if ("currentLevel" in state) parts.push(`level=${state.currentLevel}`);
  if ("color_temp" in state) parts.push(`color_temp=${state.color_temp}`);
  if ("temperature" in state) parts.push(`temp=${state.temperature}`);
  if ("humidity" in state) parts.push(`humidity=${state.humidity}`);
  if ("occupancy" in state) parts.push(`occupancy=${state.occupancy}`);
  if ("battery" in state) parts.push(`battery=${state.battery}%`);
  if ("linkquality" in state) parts.push(`lqi=${state.linkquality}`);
  return parts.join(", ") || "no state";
}

function findNodeBin(): string | null {
  const candidates = [
    "/opt/homebrew/opt/node@22/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------- Runtime startup ----------

export type ZigbeeRuntime = {
  service: Zigbee2MqttService;
  stop: () => Promise<void>;
};

export async function startZigbeeRuntime(): Promise<ZigbeeRuntime> {
  const config = getRuntimeConfig().zigbee2mqtt;
  const service = new Zigbee2MqttService();

  if (!config.enabled) {
    return { service, stop: async () => {} };
  }

  try {
    await service.start();
  } catch (error) {
    log.recordError(error, { eventName: "zigbee.start_failed" });
  }

  return {
    service,
    stop: async () => {
      try {
        await service.stop();
      } catch (error) {
        log.recordError(error, { eventName: "zigbee.stop_failed" });
      }
    },
  };
}
