import mqtt from "mqtt";
import type { MqttClient, IClientOptions } from "mqtt";
import { getRuntimeConfig } from "../config/runtime-config";
import { SecretStoreService } from "./secret-store-service";
import { telemetry } from "./telemetry";

const log = telemetry.child({ component: "zigbee2mqtt" });

// ---------- Domain types ----------

export type Zigbee2MqttDeviceExpose = {
  type: string;
  features?: Array<{
    name: string;
    type: string;
    property: string;
    access: number;
    description?: string;
    values?: string[];
    value_min?: number;
    value_max?: number;
    value_step?: number;
    unit?: string;
  }>;
  /** Flat expose (e.g. linkquality) */
  name?: string;
  property?: string;
  type_?: string;
  access?: number;
  unit?: string;
};

export type Zigbee2MqttDevice = {
  ieee_address: string;
  friendly_name: string;
  type: "Coordinator" | "Router" | "EndDevice";
  model_id?: string;
  manufacturer?: string;
  description?: string;
  definition?: {
    model: string;
    vendor: string;
    description: string;
    exposes?: Zigbee2MqttDeviceExpose[];
  };
  supported: boolean;
  disabled: boolean;
  power_source?: string;
  interview_completed?: boolean;
};

export type DeviceState = Record<string, unknown>;

// ---------- Service ----------

export class Zigbee2MqttService {
  private client: MqttClient | null = null;
  private devices = new Map<string, Zigbee2MqttDevice>();
  private deviceStates = new Map<string, DeviceState>();
  private bridgeState: "online" | "offline" = "offline";
  private bridgeInfo: Record<string, unknown> = {};
  private connectPromise: Promise<void> | null = null;
  private baseTopic = "zigbee2mqtt";

  /** Connect to the MQTT broker using runtime config. Idempotent. */
  async connect(): Promise<void> {
    if (this.client?.connected) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this._doConnect();
    return this.connectPromise;
  }

  private async _doConnect(): Promise<void> {
    const config = getRuntimeConfig().zigbee2mqtt;
    this.baseTopic = config.baseTopic;

    const opts: IClientOptions = {
      reconnectPeriod: 5_000,
      connectTimeout: 10_000,
    };

    if (config.username) {
      opts.username = config.username;
    }
    if (config.passwordSecretRef) {
      try {
        const secrets = new SecretStoreService();
        const pw = secrets.resolveSecretRef(config.passwordSecretRef, "root").trim();
        if (pw) opts.password = pw;
      } catch {
        // No password configured — connect without auth.
      }
    }

    return new Promise<void>((resolve, reject) => {
      const client = mqtt.connect(config.brokerUrl, opts);
      this.client = client;

      const timeout = setTimeout(() => {
        reject(new Error(`MQTT connect timeout after 10 s to ${config.brokerUrl}`));
      }, 10_000);

      client.on("connect", () => {
        clearTimeout(timeout);
        log.event("zigbee2mqtt.connected", { url: config.brokerUrl });
        this.subscribe();
        resolve();
      });

      client.on("error", (err) => {
        log.recordError(err, { operation: "mqtt.connect" });
        clearTimeout(timeout);
        reject(err);
      });

      client.on("message", (topic: string, payload: Buffer) => {
        this.handleMessage(topic, payload);
      });

      client.on("close", () => {
        log.event("zigbee2mqtt.disconnected", {});
      });

      client.on("reconnect", () => {
        log.event("zigbee2mqtt.reconnecting", {});
      });
    });
  }

  private subscribe() {
    if (!this.client) return;
    const base = this.baseTopic;
    this.client.subscribe([
      `${base}/bridge/state`,
      `${base}/bridge/devices`,
      `${base}/bridge/info`,
      `${base}/bridge/response/#`,
      `${base}/+`,
    ], (err) => {
      if (err) {
        log.recordError(err, { operation: "mqtt.subscribe" });
      }
    });
  }

  private handleMessage(topic: string, payload: Buffer) {
    const base = this.baseTopic;
    try {
      const data = JSON.parse(payload.toString());

      if (topic === `${base}/bridge/state`) {
        this.bridgeState = typeof data === "string" ? data : data?.state ?? "offline";
        return;
      }

      if (topic === `${base}/bridge/info`) {
        this.bridgeInfo = data;
        return;
      }

      if (topic === `${base}/bridge/devices`) {
        this.devices.clear();
        for (const device of data as Zigbee2MqttDevice[]) {
          this.devices.set(device.friendly_name, device);
        }
        return;
      }

      // Device state updates: zigbee2mqtt/<friendly_name>
      if (topic.startsWith(`${base}/`) && !topic.startsWith(`${base}/bridge/`)) {
        const friendlyName = topic.slice(base.length + 1);
        const existing = this.deviceStates.get(friendlyName) ?? {};
        this.deviceStates.set(friendlyName, { ...existing, ...data });
        return;
      }
    } catch {
      // Non-JSON payload — ignore.
    }
  }

  /** Disconnect from the broker. */
  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.end(true);
      this.client = null;
      this.connectPromise = null;
    }
  }

  isConnected(): boolean {
    return this.client?.connected === true;
  }

  getBridgeState(): string {
    return this.bridgeState;
  }

  // ---------- Device queries ----------

  listDevices(): Zigbee2MqttDevice[] {
    return [...this.devices.values()].filter((d) => d.type !== "Coordinator");
  }

  getDevice(friendlyName: string): Zigbee2MqttDevice | undefined {
    return this.devices.get(friendlyName);
  }

  getDeviceState(friendlyName: string): DeviceState | undefined {
    return this.deviceStates.get(friendlyName);
  }

  // ---------- Device control ----------

  /** Set device state (e.g. { state: "ON", brightness: 128 }). */
  async setDeviceState(friendlyName: string, state: Record<string, unknown>): Promise<string> {
    await this.ensureConnected();
    const topic = `${this.baseTopic}/${friendlyName}/set`;
    this.client!.publish(topic, JSON.stringify(state));
    return `Published to ${topic}: ${JSON.stringify(state)}`;
  }

  /** Get device state by publishing a get request. */
  async getDeviceStateFresh(friendlyName: string, properties?: Record<string, string>): Promise<string> {
    await this.ensureConnected();
    const topic = `${this.baseTopic}/${friendlyName}/get`;
    const payload = properties ?? { state: "" };
    this.client!.publish(topic, JSON.stringify(payload));
    // Wait briefly for the state update to arrive.
    await new Promise((r) => setTimeout(r, 500));
    const state = this.deviceStates.get(friendlyName);
    return state ? JSON.stringify(state, null, 2) : "No state received yet.";
  }

  /** Rename a device. */
  async renameDevice(oldName: string, newName: string): Promise<string> {
    await this.ensureConnected();
    const topic = `${this.baseTopic}/bridge/request/device/rename`;
    const payload = { from: oldName, to: newName };
    this.client!.publish(topic, JSON.stringify(payload));
    return `Rename request sent: ${oldName} → ${newName}`;
  }

  /** Permit joining for a number of seconds (default 120). */
  async permitJoin(seconds = 120): Promise<string> {
    await this.ensureConnected();
    const topic = `${this.baseTopic}/bridge/request/permit_join`;
    this.client!.publish(topic, JSON.stringify({ value: true, time: seconds }));
    return `Permit join enabled for ${seconds}s`;
  }

  /** Disable permit join. */
  async disableJoin(): Promise<string> {
    await this.ensureConnected();
    const topic = `${this.baseTopic}/bridge/request/permit_join`;
    this.client!.publish(topic, JSON.stringify({ value: false }));
    return `Permit join disabled`;
  }

  /** Build a status summary for tool output. */
  renderStatus(): string {
    const lines: string[] = [];
    lines.push(`Bridge: ${this.bridgeState}`);
    lines.push(`MQTT: ${this.isConnected() ? "connected" : "disconnected"}`);
    lines.push(`Devices: ${this.devices.size} known (excl. coordinator)`);
    lines.push("");

    const devices = this.listDevices();
    if (devices.length === 0) {
      lines.push("No devices paired yet. Use zigbee_permit_join to pair a new device.");
    } else {
      for (const dev of devices) {
        const state = this.deviceStates.get(dev.friendly_name);
        const stateStr = state ? ` | ${summarizeDeviceState(state)}` : "";
        const model = dev.definition ? `${dev.definition.vendor} ${dev.definition.model}` : (dev.model_id ?? "unknown");
        lines.push(`- ${dev.friendly_name} (${model}, ${dev.type})${stateStr}`);
      }
    }
    return lines.join("\n");
  }

  /** Describe a single device in detail for tool output. */
  renderDeviceDetail(friendlyName: string): string {
    const dev = this.devices.get(friendlyName);
    if (!dev) return `Device "${friendlyName}" not found.`;

    const lines: string[] = [];
    lines.push(`Name: ${dev.friendly_name}`);
    lines.push(`IEEE: ${dev.ieee_address}`);
    lines.push(`Type: ${dev.type}`);
    if (dev.definition) {
      lines.push(`Model: ${dev.definition.vendor} ${dev.definition.model}`);
      lines.push(`Description: ${dev.definition.description}`);
    }
    lines.push(`Power: ${dev.power_source ?? "unknown"}`);
    lines.push(`Supported: ${dev.supported}`);

    // Exposes (capabilities)
    const exposes = dev.definition?.exposes;
    if (exposes && exposes.length > 0) {
      lines.push("\nCapabilities:");
      for (const expose of exposes) {
        if (expose.features) {
          lines.push(`  ${expose.type}:`);
          for (const feat of expose.features) {
            const rw = feat.access & 0b010 ? "settable" : "read-only";
            const range = feat.value_min !== undefined ? ` [${feat.value_min}–${feat.value_max}]` : "";
            const values = feat.values ? ` (${feat.values.join(", ")})` : "";
            const unit = feat.unit ? ` ${feat.unit}` : "";
            lines.push(`    ${feat.property}: ${feat.type}${range}${values}${unit} (${rw})`);
          }
        } else if (expose.name) {
          lines.push(`  ${expose.name}: ${expose.type ?? "unknown"}`);
        }
      }
    }

    const state = this.deviceStates.get(friendlyName);
    if (state) {
      lines.push(`\nCurrent state: ${JSON.stringify(state, null, 2)}`);
    }

    return lines.join("\n");
  }

  private async ensureConnected() {
    if (!this.client?.connected) {
      await this.connect();
    }
  }
}

function summarizeDeviceState(state: DeviceState): string {
  const parts: string[] = [];
  if ("state" in state) parts.push(`state=${state.state}`);
  if ("brightness" in state) parts.push(`brightness=${state.brightness}`);
  if ("color_temp" in state) parts.push(`color_temp=${state.color_temp}`);
  if ("temperature" in state) parts.push(`temp=${state.temperature}`);
  if ("humidity" in state) parts.push(`humidity=${state.humidity}`);
  if ("occupancy" in state) parts.push(`occupancy=${state.occupancy}`);
  if ("contact" in state) parts.push(`contact=${state.contact}`);
  if ("battery" in state) parts.push(`battery=${state.battery}%`);
  if ("linkquality" in state) parts.push(`lqi=${state.linkquality}`);
  return parts.join(", ") || "no state";
}
