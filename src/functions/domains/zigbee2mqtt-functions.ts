/**
 * Zigbee2MQTT / smart lighting function definitions.
 * Migrated from src/tools/groups/zigbee2mqtt-tools.ts.
 * These produce agent tools, API routes, and Discord commands from a single source.
 */
import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert warm/cool white channel values (0-255) to mirek + brightness. */
function wcToMirek(w: number, c: number): { color_temp: number; brightness: number } {
  const total = w + c;
  if (total === 0) return { color_temp: 370, brightness: 1 };
  const color_temp = Math.round(153 + (w / total) * (500 - 153));
  const brightness = Math.max(1, Math.round((Math.max(w, c) / 255) * 254));
  return { color_temp, brightness };
}

// ---------------------------------------------------------------------------
// Schemas (same as zigbee2mqtt-tools.ts)
// ---------------------------------------------------------------------------

const ch = z.number().int().min(0).max(255);

const lightSetSchema = z.object({
  device: z.string().describe("Friendly name of the light"),
  mode: z.enum(["rgb", "wc"]).describe("Channel mode: 'rgb' for color LEDs, 'wc' for warm/cool white LEDs"),
  ch1: ch.describe("Red (rgb) or Warm white (wc) — 0-255"),
  ch2: ch.describe("Green (rgb) or Cool white (wc) — 0-255"),
  ch3: ch.optional().describe("Blue (rgb mode only) — 0-255"),
});

const deviceNameSchema = z.object({
  device: z.string().describe("Friendly name of the light"),
});

const permitJoinSchema = z.object({
  seconds: z.number().int().min(10).max(600).optional().describe("Join window in seconds (default 120)"),
});

const renameSchema = z.object({
  old_name: z.string().describe("Current friendly name"),
  new_name: z.string().describe("New friendly name"),
});

// ---------------------------------------------------------------------------
// Auth / metadata defaults
// ---------------------------------------------------------------------------

const ZIGBEE_AUTH = { access: "root" as const, behavior: "uniform" as const };
const ZIGBEE_SCOPES: ("chat" | "direct")[] = ["chat", "direct"];
const ZIGBEE_DOMAINS = ["zigbee2mqtt", "iot"];

// ---------------------------------------------------------------------------
// Domain builder
// ---------------------------------------------------------------------------

export const buildZigbee2MqttFunctions: FunctionDomainBuilder = (ctx) => [
  // -------------------------------------------------------------------------
  // lights_status
  // -------------------------------------------------------------------------
  defineFunction({
    name: "lights_status",
    description:
      "Show all smart lights: names, models, power state, brightness, color, and connection quality.",
    input: z.object({}),
    handler: async (_input, fnCtx) => fnCtx.services.zigbee2mqtt.renderStatus(),
    auth: { ...ZIGBEE_AUTH, note: "Reads status of all paired Zigbee smart lights." },
    domains: ZIGBEE_DOMAINS,
    agentScopes: ZIGBEE_SCOPES,
    featureGate: "zigbee2mqtt",
  }),

  // -------------------------------------------------------------------------
  // lights_inspect
  // -------------------------------------------------------------------------
  defineFunction({
    name: "lights_inspect",
    description:
      "Inspect a specific light: model, capabilities, supported features, and current state.",
    input: deviceNameSchema,
    handler: async (input, fnCtx) => fnCtx.services.zigbee2mqtt.renderDeviceDetail(input.device),
    auth: { ...ZIGBEE_AUTH, note: "Reads detailed capabilities and state of a specific light." },
    domains: ZIGBEE_DOMAINS,
    agentScopes: ZIGBEE_SCOPES,
    featureGate: "zigbee2mqtt",
  }),

  // -------------------------------------------------------------------------
  // lights_set
  // -------------------------------------------------------------------------
  defineFunction({
    name: "lights_set",
    description:
      "Set a light's channels directly. Mode 'rgb': ch1=Red, ch2=Green, ch3=Blue (0-255). Mode 'wc': ch1=Warm white, ch2=Cool white (0-255). All zeros turns the light off.",
    input: lightSetSchema,
    handler: async (input, fnCtx) => {
      let state: Record<string, unknown>;
      if (input.mode === "rgb") {
        const r = input.ch1, g = input.ch2, b = input.ch3 ?? 0;
        if (r === 0 && g === 0 && b === 0) {
          state = { state: "OFF" };
        } else {
          state = { color: { r, g, b }, brightness: Math.max(1, Math.max(r, g, b)) };
        }
      } else {
        const w = input.ch1, c = input.ch2;
        if (w === 0 && c === 0) {
          state = { state: "OFF" };
        } else {
          state = wcToMirek(w, c);
        }
      }
      const desc = JSON.stringify(state);
      const result = await fnCtx.services.zigbee2mqtt.setDeviceState(input.device, state);
      return `Set ${input.mode} → ${desc}\n\n${result}`;
    },
    auth: { ...ZIGBEE_AUTH, note: "Sets a light's color, temperature, or brightness." },
    domains: ZIGBEE_DOMAINS,
    agentScopes: ZIGBEE_SCOPES,
    featureGate: "zigbee2mqtt",
    mutatesState: true,
  }),

  // -------------------------------------------------------------------------
  // lights_read
  // -------------------------------------------------------------------------
  defineFunction({
    name: "lights_read",
    description:
      "Read the current state of a light directly from the device (fresh values, not cached).",
    input: deviceNameSchema,
    handler: async (input, fnCtx) => fnCtx.services.zigbee2mqtt.getDeviceStateFresh(input.device),
    auth: { ...ZIGBEE_AUTH, note: "Reads fresh state from a light device." },
    domains: ZIGBEE_DOMAINS,
    agentScopes: ZIGBEE_SCOPES,
    featureGate: "zigbee2mqtt",
  }),

  // -------------------------------------------------------------------------
  // lights_on
  // -------------------------------------------------------------------------
  defineFunction({
    name: "lights_on",
    description: "Turn a light on.",
    input: deviceNameSchema,
    handler: async (input, fnCtx) => fnCtx.services.zigbee2mqtt.setDeviceState(input.device, { state: "ON" }),
    auth: { ...ZIGBEE_AUTH, note: "Turns a light on." },
    domains: ZIGBEE_DOMAINS,
    agentScopes: ZIGBEE_SCOPES,
    featureGate: "zigbee2mqtt",
    mutatesState: true,
  }),

  // -------------------------------------------------------------------------
  // lights_off
  // -------------------------------------------------------------------------
  defineFunction({
    name: "lights_off",
    description: "Turn a light off.",
    input: deviceNameSchema,
    handler: async (input, fnCtx) => fnCtx.services.zigbee2mqtt.setDeviceState(input.device, { state: "OFF" }),
    auth: { ...ZIGBEE_AUTH, note: "Turns a light off." },
    domains: ZIGBEE_DOMAINS,
    agentScopes: ZIGBEE_SCOPES,
    featureGate: "zigbee2mqtt",
    mutatesState: true,
  }),

  // -------------------------------------------------------------------------
  // lights_pair
  // -------------------------------------------------------------------------
  defineFunction({
    name: "lights_pair",
    description:
      "Open the Zigbee network for pairing so a new light can join. The user should put their device in pairing mode after this.",
    input: permitJoinSchema,
    handler: async (input, fnCtx) => fnCtx.services.zigbee2mqtt.permitJoin(input.seconds),
    auth: { ...ZIGBEE_AUTH, note: "Opens the Zigbee network for new device pairing." },
    domains: ZIGBEE_DOMAINS,
    agentScopes: ZIGBEE_SCOPES,
    featureGate: "zigbee2mqtt",
    mutatesState: true,
  }),

  // -------------------------------------------------------------------------
  // lights_rename
  // -------------------------------------------------------------------------
  defineFunction({
    name: "lights_rename",
    description: "Rename a light's friendly name.",
    input: renameSchema,
    handler: async (input, fnCtx) => fnCtx.services.zigbee2mqtt.renameDevice(input.old_name, input.new_name),
    auth: { ...ZIGBEE_AUTH, note: "Renames a paired light's friendly name." },
    domains: ZIGBEE_DOMAINS,
    agentScopes: ZIGBEE_SCOPES,
    featureGate: "zigbee2mqtt",
    mutatesState: true,
  }),
];
