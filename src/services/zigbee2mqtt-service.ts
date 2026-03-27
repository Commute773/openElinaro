import fs from "node:fs";
import path from "node:path";
import { Controller, type Events } from "zigbee-herdsman";
import type { Device } from "zigbee-herdsman/dist/controller/model";
import { findByDevice, type Definition, type Tz } from "zigbee-herdsman-converters";
import { getRuntimeConfig } from "../config/runtime-config";
import { resolveRuntimePath } from "./runtime-root";
import { telemetry } from "./telemetry";

const log = telemetry.child({ component: "zigbee" });

// ---------- Paths ----------

function zigbeeDir() {
  return resolveRuntimePath("zigbee");
}

function databasePath() {
  return path.join(zigbeeDir(), "database.db");
}

function friendlyNamesPath() {
  return path.join(zigbeeDir(), "friendly_names.json");
}

// ---------- USB radio auto-detection ----------

export function detectZigbeeRadio(): string | null {
  const patterns = [
    // macOS
    "/dev/cu.usbserial-",
    "/dev/cu.usbmodem",
    // Linux
    "/dev/ttyUSB",
    "/dev/ttyACM",
  ];

  for (const pattern of patterns) {
    const dir = path.dirname(pattern);
    const prefix = path.basename(pattern);
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith(prefix)) {
          return path.join(dir, entry);
        }
      }
    } catch {
      // Directory doesn't exist on this platform.
    }
  }
  return null;
}

// ---------- Adapter type detection ----------

function detectAdapterType(serialPort: string): string {
  // Try to identify adapter from USB device metadata via a synchronous probe.
  try {
    const { execSync } = require("node:child_process");
    // macOS: system_profiler can identify USB devices.
    if (process.platform === "darwin") {
      const output = execSync("system_profiler SPUSBDataType -detailLevel mini 2>/dev/null", { encoding: "utf8", timeout: 5000 });
      // Sonoff dongles (Itead / SONOFF) typically use ember firmware.
      if (output.includes("Itead") || output.includes("SONOFF") || output.includes("Sonoff")) {
        return "ember";
      }
      // Nabu Casa SkyConnect / HA Connect ZBT-1
      if (output.includes("Nabu Casa") || output.includes("SkyConnect")) {
        return "ember";
      }
      // TI CC2652/CC2538 based (ConBee, etc.)
      if (output.includes("ConBee") || output.includes("dresden")) {
        return "deconz";
      }
    }
  } catch {
    // Detection failed, fall through.
  }
  // Default to zstack as the most common/compatible adapter type.
  return "zstack";
}

// ---------- Friendly name persistence ----------

type FriendlyNameMap = Record<string, string>; // IEEE address → friendly name

function loadFriendlyNames(): FriendlyNameMap {
  try {
    const raw = fs.readFileSync(friendlyNamesPath(), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveFriendlyNames(names: FriendlyNameMap) {
  fs.mkdirSync(zigbeeDir(), { recursive: true });
  fs.writeFileSync(friendlyNamesPath(), JSON.stringify(names, null, 2), { mode: 0o600 });
}

// ---------- Types ----------

export type DeviceState = Record<string, unknown>;

export type DeviceInfo = {
  ieeeAddr: string;
  friendlyName: string;
  type: string;
  modelID?: string;
  manufacturer?: string;
  description?: string;
  powerSource?: string;
  lastSeen?: number;
  definition?: Definition;
};

// ---------- Service ----------

export class Zigbee2MqttService {
  private controller: Controller | null = null;
  private friendlyNames: FriendlyNameMap = {};
  private deviceStates = new Map<string, DeviceState>();
  private definitionCache = new Map<string, Definition | null>();
  private started = false;
  private starting = false;

  async start(): Promise<void> {
    if (this.started || this.starting) return;
    this.starting = true;

    try {
      const config = getRuntimeConfig().zigbee2mqtt;
      const serialPort = config.serialPort.trim() || detectZigbeeRadio();
      if (!serialPort) {
        throw new Error("No Zigbee USB radio detected. Set zigbee2mqtt.serialPort in config or plug in a coordinator.");
      }

      fs.mkdirSync(zigbeeDir(), { recursive: true });
      this.friendlyNames = loadFriendlyNames();

      const adapterType = config.adapterType.trim() || detectAdapterType(serialPort);

      this.controller = new Controller({
        network: {
          panID: 0x1a62,
          channelList: [config.channel],
        },
        serialPort: {
          path: serialPort,
          adapter: adapterType as any,
        },
        databasePath: databasePath(),
        databaseBackupPath: path.join(zigbeeDir(), "database.db.backup"),
        backupPath: path.join(zigbeeDir(), "coordinator_backup.json"),
        adapter: { concurrent: 16, disableLED: false },
        acceptJoiningDeviceHandler: async (ieeeAddr: string) => {
          log.event("zigbee.device_joining", { ieeeAddr });
          return true;
        },
      });

      log.event("zigbee.controller_config", { serialPort, adapterType, channel: config.channel });

      this.controller.on("message", (data) => this.onMessage(data));
      this.controller.on("deviceJoined", (data) => this.onDeviceJoined(data));
      this.controller.on("deviceInterview", (data) => this.onDeviceInterview(data));
      this.controller.on("deviceLeave", (data) => this.onDeviceLeave(data));
      this.controller.on("deviceAnnounce", (data) => this.onDeviceAnnounce(data));

      await this.controller.start();
      this.started = true;
      log.event("zigbee.started", { serialPort, channel: config.channel });

      // Cache definitions for existing devices.
      for (const device of this.controller.getDevices()) {
        if (device.type !== "Coordinator") {
          void this.resolveDefinition(device);
          this.ensureFriendlyName(device);
        }
      }
      saveFriendlyNames(this.friendlyNames);
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    if (this.controller && this.started) {
      await this.controller.stop();
      this.controller = null;
      this.started = false;
      log.event("zigbee.stopped", {});
    }
  }

  isStarted(): boolean {
    return this.started;
  }

  // ---------- Event handlers ----------

  private onMessage(data: Events.MessagePayload) {
    const name = this.getFriendlyName(data.device);
    if (data.type === "attributeReport" || data.type === "readResponse") {
      const existing = this.deviceStates.get(name) ?? {};
      const update = typeof data.data === "object" && !Buffer.isBuffer(data.data) && !Array.isArray(data.data)
        ? data.data as Record<string, unknown>
        : {};
      this.deviceStates.set(name, { ...existing, ...update, linkquality: data.linkquality });
    }
  }

  private onDeviceJoined(data: Events.DeviceJoinedPayload) {
    this.ensureFriendlyName(data.device);
    saveFriendlyNames(this.friendlyNames);
    log.event("zigbee.device_joined", {
      ieeeAddr: data.device.ieeeAddr,
      friendlyName: this.getFriendlyName(data.device),
    });
  }

  private onDeviceInterview(data: Events.DeviceInterviewPayload) {
    if (data.status === "successful") {
      void this.resolveDefinition(data.device);
      this.ensureFriendlyName(data.device);
      saveFriendlyNames(this.friendlyNames);
      log.event("zigbee.device_interview_complete", {
        ieeeAddr: data.device.ieeeAddr,
        modelID: data.device.modelID,
      });
    }
  }

  private onDeviceLeave(data: Events.DeviceLeavePayload) {
    log.event("zigbee.device_left", { ieeeAddr: data.ieeeAddr });
  }

  private onDeviceAnnounce(data: Events.DeviceAnnouncePayload) {
    this.ensureFriendlyName(data.device);
  }

  // ---------- Friendly names ----------

  private ensureFriendlyName(device: Device) {
    if (this.friendlyNames[device.ieeeAddr]) return;
    const base = device.modelID
      ? `${device.manufacturerName ?? "unknown"}_${device.modelID}`.replace(/[^a-zA-Z0-9_-]/g, "_")
      : device.ieeeAddr;
    // Deduplicate.
    let name = base;
    const existing = new Set(Object.values(this.friendlyNames));
    let i = 2;
    while (existing.has(name)) {
      name = `${base}_${i++}`;
    }
    this.friendlyNames[device.ieeeAddr] = name;
  }

  private getFriendlyName(device: Device): string {
    return this.friendlyNames[device.ieeeAddr] ?? device.ieeeAddr;
  }

  private resolveDeviceByName(friendlyName: string): Device | undefined {
    if (!this.controller) return undefined;
    // Try direct IEEE address lookup.
    const byAddr = this.controller.getDeviceByIeeeAddr(friendlyName);
    if (byAddr) return byAddr;
    // Find by friendly name.
    const ieeeAddr = Object.entries(this.friendlyNames).find(([, name]) => name === friendlyName)?.[0];
    if (ieeeAddr) return this.controller.getDeviceByIeeeAddr(ieeeAddr);
    return undefined;
  }

  // ---------- Definition cache ----------

  private async resolveDefinition(device: Device): Promise<Definition | null> {
    const cached = this.definitionCache.get(device.ieeeAddr);
    if (cached !== undefined) return cached;
    try {
      const def = await findByDevice(device, true) ?? null;
      this.definitionCache.set(device.ieeeAddr, def);
      return def;
    } catch {
      this.definitionCache.set(device.ieeeAddr, null);
      return null;
    }
  }

  // ---------- Device queries ----------

  listDevices(): DeviceInfo[] {
    if (!this.controller) return [];
    const devices: DeviceInfo[] = [];
    for (const device of this.controller.getDevices()) {
      if (device.type === "Coordinator") continue;
      devices.push(this.buildDeviceInfo(device));
    }
    return devices;
  }

  getDevice(friendlyName: string): DeviceInfo | undefined {
    const device = this.resolveDeviceByName(friendlyName);
    if (!device || device.type === "Coordinator") return undefined;
    return this.buildDeviceInfo(device);
  }

  getDeviceState(friendlyName: string): DeviceState | undefined {
    return this.deviceStates.get(friendlyName);
  }

  private buildDeviceInfo(device: Device): DeviceInfo {
    const def = this.definitionCache.get(device.ieeeAddr) ?? undefined;
    return {
      ieeeAddr: device.ieeeAddr,
      friendlyName: this.getFriendlyName(device),
      type: device.type,
      modelID: device.modelID,
      manufacturer: device.manufacturerName,
      powerSource: device.powerSource,
      lastSeen: device.lastSeen,
      definition: def ?? undefined,
    };
  }

  // ---------- Device control ----------

  async setDeviceState(friendlyName: string, state: Record<string, unknown>): Promise<string> {
    await this.ensureStarted();
    const device = this.resolveDeviceByName(friendlyName);
    if (!device) return `Device "${friendlyName}" not found.`;

    const definition = await this.resolveDefinition(device);
    const endpoint = device.getEndpoint(1) ?? device.endpoints[0];
    if (!endpoint) return `Device "${friendlyName}" has no endpoints.`;

    const results: string[] = [];
    const converters = definition?.toZigbee ?? [];

    for (const [key, value] of Object.entries(state)) {
      const converter = converters.find((c) => c.key?.includes(key));
      if (converter?.convertSet) {
        try {
          const meta: Tz.Meta = {
            message: state,
            device,
            mapped: definition!,
            options: {},
            state: this.deviceStates.get(friendlyName) ?? {},
            endpoint_name: undefined,
            publish: () => {},
          };
          const result = await converter.convertSet(endpoint, key, value, meta);
          if (result?.state) {
            const existing = this.deviceStates.get(friendlyName) ?? {};
            this.deviceStates.set(friendlyName, { ...existing, ...result.state });
          }
          results.push(`${key}=${JSON.stringify(value)} ✓`);
        } catch (err) {
          results.push(`${key}=${JSON.stringify(value)} ✗ ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        // Fallback: try raw cluster command for common properties.
        try {
          await this.setRawProperty(endpoint, key, value);
          results.push(`${key}=${JSON.stringify(value)} ✓ (raw)`);
        } catch (err) {
          results.push(`${key}=${JSON.stringify(value)} ✗ no converter (${err instanceof Error ? err.message : String(err)})`);
        }
      }
    }
    return results.join("\n");
  }

  private async setRawProperty(endpoint: Device["endpoints"][0], key: string, value: unknown) {
    switch (key) {
      case "state":
        await endpoint.command("genOnOff", value === "ON" || value === true ? "on" : "off", {});
        break;
      case "brightness":
        await endpoint.command("genLevelCtrl", "moveToLevel", { level: Number(value), transtime: 0 });
        break;
      case "color_temp":
        await endpoint.command("lightingColorCtrl", "moveToColorTemp", { colortemp: Number(value), transtime: 0 });
        break;
      default:
        throw new Error(`Unknown property: ${key}`);
    }
  }

  async getDeviceStateFresh(friendlyName: string): Promise<string> {
    await this.ensureStarted();
    const device = this.resolveDeviceByName(friendlyName);
    if (!device) return `Device "${friendlyName}" not found.`;

    const endpoint = device.getEndpoint(1) ?? device.endpoints[0];
    if (!endpoint) return `Device "${friendlyName}" has no endpoints.`;

    try {
      const clusters: Record<string, string[]> = {
        genOnOff: ["onOff"],
        genLevelCtrl: ["currentLevel"],
        lightingColorCtrl: ["colorTemperature", "currentX", "currentY"],
        msTemperatureMeasurement: ["measuredValue"],
        msRelativeHumidity: ["measuredValue"],
      };

      const state: DeviceState = {};
      for (const [cluster, attrs] of Object.entries(clusters)) {
        if (endpoint.supportsInputCluster(cluster)) {
          try {
            const result = await endpoint.read(cluster, attrs as any);
            Object.assign(state, result);
          } catch {
            // Cluster read failed, skip.
          }
        }
      }
      this.deviceStates.set(friendlyName, { ...this.deviceStates.get(friendlyName), ...state });
      return JSON.stringify(state, null, 2);
    } catch (err) {
      return `Failed to read state: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async renameDevice(oldName: string, newName: string): Promise<string> {
    const device = this.resolveDeviceByName(oldName);
    if (!device) return `Device "${oldName}" not found.`;
    this.friendlyNames[device.ieeeAddr] = newName;
    // Move cached state.
    const state = this.deviceStates.get(oldName);
    if (state) {
      this.deviceStates.delete(oldName);
      this.deviceStates.set(newName, state);
    }
    saveFriendlyNames(this.friendlyNames);
    return `Renamed: ${oldName} → ${newName}`;
  }

  async permitJoin(seconds = 120): Promise<string> {
    await this.ensureStarted();
    await this.controller!.permitJoin(seconds);
    return `Permit join enabled for ${seconds}s. Put your device in pairing mode now.`;
  }

  async disableJoin(): Promise<string> {
    await this.ensureStarted();
    await this.controller!.permitJoin(0);
    return "Permit join disabled.";
  }

  // ---------- Render for tool output ----------

  renderStatus(): string {
    const lines: string[] = [];
    lines.push(`Zigbee radio: ${this.started ? "running" : "stopped"}`);

    const devices = this.listDevices();
    lines.push(`Devices: ${devices.length} paired`);
    if (this.controller?.getPermitJoin()) {
      const end = this.controller.getPermitJoinEnd();
      const remaining = end ? Math.max(0, Math.round((end - Date.now()) / 1000)) : "?";
      lines.push(`Permit join: OPEN (${remaining}s remaining)`);
    }
    lines.push("");

    if (devices.length === 0) {
      lines.push("No devices paired yet. Use zigbee_permit_join to pair a new device.");
    } else {
      for (const dev of devices) {
        const state = this.deviceStates.get(dev.friendlyName);
        const stateStr = state ? ` | ${summarizeDeviceState(state)}` : "";
        const model = dev.definition
          ? `${dev.definition.vendor} ${dev.definition.model}`
          : (dev.modelID ?? "unknown");
        lines.push(`- ${dev.friendlyName} (${model}, ${dev.type})${stateStr}`);
      }
    }
    return lines.join("\n");
  }

  async renderDeviceDetail(friendlyName: string): Promise<string> {
    const device = this.resolveDeviceByName(friendlyName);
    if (!device) return `Device "${friendlyName}" not found.`;

    const definition = await this.resolveDefinition(device);
    const lines: string[] = [];
    lines.push(`Name: ${this.getFriendlyName(device)}`);
    lines.push(`IEEE: ${device.ieeeAddr}`);
    lines.push(`Type: ${device.type}`);
    lines.push(`Model: ${device.modelID ?? "unknown"}`);
    lines.push(`Manufacturer: ${device.manufacturerName ?? "unknown"}`);
    lines.push(`Power: ${device.powerSource ?? "unknown"}`);
    lines.push(`Last seen: ${device.lastSeen ? new Date(device.lastSeen).toISOString() : "never"}`);

    if (definition) {
      lines.push(`Definition: ${definition.vendor} ${definition.model} — ${definition.description}`);

      // Exposes.
      if (definition.exposes) {
        const exposes = typeof definition.exposes === "function"
          ? (definition.exposes as (device: Device, options: Record<string, unknown>) => any[])(device, {})
          : definition.exposes;
        if (Array.isArray(exposes) && exposes.length > 0) {
          lines.push("\nCapabilities:");
          for (const expose of exposes) {
            renderExpose(expose, lines, "  ");
          }
        }
      }
    }

    const state = this.deviceStates.get(friendlyName);
    if (state && Object.keys(state).length > 0) {
      lines.push(`\nCurrent state: ${JSON.stringify(state, null, 2)}`);
    }

    return lines.join("\n");
  }

  private async ensureStarted() {
    if (!this.started) {
      await this.start();
    }
  }
}

function renderExpose(expose: any, lines: string[], indent: string) {
  if (expose.features && Array.isArray(expose.features)) {
    lines.push(`${indent}${expose.type ?? expose.name ?? "group"}:`);
    for (const feat of expose.features) {
      renderExpose(feat, lines, indent + "  ");
    }
  } else {
    const rw = expose.access !== undefined
      ? (expose.access & 0b010 ? "settable" : "read-only")
      : "";
    const range = expose.value_min !== undefined ? ` [${expose.value_min}–${expose.value_max}]` : "";
    const values = expose.values ? ` (${expose.values.join(", ")})` : "";
    const unit = expose.unit ? ` ${expose.unit}` : "";
    const name = expose.property ?? expose.name ?? "?";
    lines.push(`${indent}${name}: ${expose.type ?? ""}${range}${values}${unit}${rw ? ` (${rw})` : ""}`);
  }
}

function summarizeDeviceState(state: DeviceState): string {
  const parts: string[] = [];
  if ("state" in state) parts.push(`state=${state.state}`);
  if ("onOff" in state) parts.push(`on=${state.onOff}`);
  if ("brightness" in state) parts.push(`brightness=${state.brightness}`);
  if ("currentLevel" in state) parts.push(`level=${state.currentLevel}`);
  if ("color_temp" in state) parts.push(`color_temp=${state.color_temp}`);
  if ("colorTemperature" in state) parts.push(`color_temp=${state.colorTemperature}`);
  if ("temperature" in state) parts.push(`temp=${state.temperature}`);
  if ("measuredValue" in state) parts.push(`measured=${state.measuredValue}`);
  if ("humidity" in state) parts.push(`humidity=${state.humidity}`);
  if ("occupancy" in state) parts.push(`occupancy=${state.occupancy}`);
  if ("contact" in state) parts.push(`contact=${state.contact}`);
  if ("battery" in state) parts.push(`battery=${state.battery}%`);
  if ("linkquality" in state) parts.push(`lqi=${state.linkquality}`);
  return parts.join(", ") || "no state";
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
