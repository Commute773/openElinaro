/**
 * Zigbee2MQTT / smart lighting function definitions.
 * Migrated from src/tools/groups/zigbee2mqtt-tools.ts.
 * These produce agent tools, API routes, and Discord commands from a single source.
 */
import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";
import { formatResult } from "../formatters";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Kelvin to mireds (clamped to Zigbee range 153-500). */
function kelvinToMireds(k: number): number {
  return Math.max(153, Math.min(500, Math.round(1_000_000 / k)));
}

/** Named color/temperature presets → Zigbee state. */
const COLOR_PRESETS: Record<string, Record<string, unknown>> = {
  // Temperature presets
  "warm":       { color_temp: kelvinToMireds(2700) },
  "warm white": { color_temp: kelvinToMireds(2700) },
  "soft":       { color_temp: kelvinToMireds(3000) },
  "soft white": { color_temp: kelvinToMireds(3000) },
  "neutral":    { color_temp: kelvinToMireds(4000) },
  "cool":       { color_temp: kelvinToMireds(5500) },
  "cool white": { color_temp: kelvinToMireds(5500) },
  "daylight":   { color_temp: kelvinToMireds(6500) },
  // RGB presets
  "red":        { color: { r: 255, g: 0, b: 0 } },
  "green":      { color: { r: 0, g: 255, b: 0 } },
  "blue":       { color: { r: 0, g: 0, b: 255 } },
  "cyan":       { color: { r: 0, g: 255, b: 255 } },
  "magenta":    { color: { r: 255, g: 0, b: 255 } },
  "yellow":     { color: { r: 255, g: 255, b: 0 } },
  "orange":     { color: { r: 255, g: 165, b: 0 } },
  "purple":     { color: { r: 128, g: 0, b: 255 } },
  "pink":       { color: { r: 255, g: 105, b: 180 } },
  "white":      { color_temp: kelvinToMireds(4000) },
};

/** Parse a hex color string (#RGB or #RRGGBB) to {r,g,b}. */
function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1]!;
  if (h.length === 3) {
    return { r: parseInt(h[0]! + h[0]!, 16), g: parseInt(h[1]! + h[1]!, 16), b: parseInt(h[2]! + h[2]!, 16) };
  }
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

/** Build the Zigbee state payload from the high-level lights_set input. */
function buildLightState(input: {
  color?: string;
  kelvin?: number;
  brightness?: number;
}): Record<string, unknown> {
  const state: Record<string, unknown> = {};

  // Color / temperature
  if (input.kelvin) {
    state.color_temp = kelvinToMireds(input.kelvin);
  } else if (input.color) {
    const key = input.color.toLowerCase().trim();
    const preset = COLOR_PRESETS[key];
    if (preset) {
      Object.assign(state, preset);
    } else {
      const rgb = parseHex(key);
      if (rgb) {
        state.color = rgb;
      } else {
        throw new Error(`Unknown color "${input.color}". Use a name (warm, cool, red, blue, daylight…), hex (#FF0000), or kelvin param.`);
      }
    }
  }

  // Brightness (0-100% → 1-254 Zigbee scale)
  if (input.brightness != null) {
    if (input.brightness === 0) return { state: "OFF" };
    state.brightness = Math.max(1, Math.round((input.brightness / 100) * 254));
  }

  // Default: if nothing was set, just turn on
  if (Object.keys(state).length === 0) {
    state.state = "ON";
  }

  return state;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const lightSetSchema = z.object({
  device: z.string().describe("Friendly name of the light"),
  color: z.string().optional().describe("Color name (warm, cool, daylight, red, blue, purple, pink…), hex (#FF0000), or temperature name (warm white, cool white, soft, neutral)"),
  kelvin: z.number().int().min(2000).max(6500).optional().describe("Color temperature in Kelvin (2000=warm, 4000=neutral, 6500=cool daylight)"),
  brightness: z.number().int().min(0).max(100).optional().describe("Brightness percentage (0=off, 100=max)"),
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
    format: formatResult,
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
    format: formatResult,
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
      "Set a light's color and brightness. Use color names (warm, cool, daylight, red, blue…), hex codes (#FF0000), kelvin values (2700=warm, 6500=cool), and brightness as a percentage (0-100). Examples: color='cool' brightness=80, color='red', kelvin=3000 brightness=50.",
    input: lightSetSchema,
    handler: async (input, fnCtx) => {
      const state = buildLightState(input);
      const desc = JSON.stringify(state);
      const result = await fnCtx.services.zigbee2mqtt.setDeviceState(input.device, state);
      return `Set → ${desc}\n\n${result}`;
    },
    format: formatResult,
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
    format: formatResult,
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
    format: formatResult,
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
    format: formatResult,
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
    format: formatResult,
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
    format: formatResult,
    auth: { ...ZIGBEE_AUTH, note: "Renames a paired light's friendly name." },
    domains: ZIGBEE_DOMAINS,
    agentScopes: ZIGBEE_SCOPES,
    featureGate: "zigbee2mqtt",
    mutatesState: true,
  }),
];
