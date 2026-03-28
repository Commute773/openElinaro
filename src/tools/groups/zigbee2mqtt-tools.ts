import { type StructuredToolInterface } from "@langchain/core/tools";
import { defineTool } from "../define-tool";
import { z } from "zod";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { telemetry } from "../../services/infrastructure/telemetry";
import type { ToolBuildContext } from "./tool-group-types";

const toolTelemetry = telemetry.child({ component: "tool" });
const traceSpan = createTraceSpan(toolTelemetry);

// ---------- Helpers: friendly color/temp → Zigbee commands ----------

type LightCommand = { color?: { h: number; s: number }; brightness?: number; color_temp?: number; state?: string };

function parseColorDescription(input: string): LightCommand {
  const cmd: LightCommand = {};
  const lower = input.toLowerCase().trim();

  // Named colors → HSV
  const namedColors: Record<string, [number, number]> = {
    red: [0, 100], crimson: [348, 90], scarlet: [11, 100],
    orange: [30, 100], coral: [16, 80], peach: [28, 60],
    yellow: [60, 100], gold: [45, 100], amber: [38, 100],
    lime: [75, 100], chartreuse: [90, 100],
    green: [120, 100], emerald: [140, 90], mint: [150, 60],
    teal: [170, 80], cyan: [180, 100], aqua: [175, 80],
    blue: [240, 100], navy: [240, 100], sky: [200, 70], azure: [210, 80], cobalt: [215, 90],
    indigo: [260, 90], violet: [270, 90], purple: [280, 90],
    magenta: [300, 100], pink: [330, 70], rose: [340, 75],
    fuchsia: [310, 100], lavender: [270, 50],
    white: [0, 0],
  };

  // Check named colors
  for (const [name, [h, s]] of Object.entries(namedColors)) {
    if (lower.includes(name)) {
      cmd.color = { h, s };
      break;
    }
  }

  // Temperature keywords → mirek
  const tempKeywords: Record<string, number> = {
    candlelight: 500, candle: 500,
    'ultra warm': 500, 'very warm': 475,
    'warm white': 454, warm: 454,
    'soft white': 400,
    neutral: 370, natural: 370,
    'cool white': 250, cool: 250,
    daylight: 200, 'bright white': 200,
    'cold white': 167, cold: 167,
  };

  for (const [keyword, mirek] of Object.entries(tempKeywords)) {
    if (lower.includes(keyword)) {
      cmd.color_temp = mirek;
      cmd.color = undefined; // temperature mode, not color mode
      break;
    }
  }

  // Explicit kelvin: "3000k", "3000 kelvin"
  const kelvinMatch = lower.match(/(\d{3,5})\s*k(?:elvin)?/);
  if (kelvinMatch?.[1]) {
    const kelvin = parseInt(kelvinMatch[1], 10);
    cmd.color_temp = Math.round(1_000_000 / Math.max(1500, Math.min(10000, kelvin)));
    cmd.color = undefined;
  }

  // Explicit mirek: "400 mirek"
  const mirekMatch = lower.match(/(\d{2,3})\s*mi(?:rek|red)/);
  if (mirekMatch?.[1]) {
    cmd.color_temp = Math.max(50, Math.min(600, parseInt(mirekMatch[1], 10)));
    cmd.color = undefined;
  }

  // Brightness keywords
  if (lower.includes('dim') || lower.includes('low')) cmd.brightness = 50;
  else if (lower.includes('medium') || lower.includes('half')) cmd.brightness = 127;
  else if (lower.includes('bright') || lower.includes('full') || lower.includes('max')) cmd.brightness = 254;

  // Explicit percentage: "80%", "at 50%"
  const pctMatch = lower.match(/(\d{1,3})\s*%/);
  if (pctMatch?.[1]) {
    cmd.brightness = Math.max(1, Math.round(parseInt(pctMatch[1], 10) / 100 * 254));
  }

  return cmd;
}

function formatCommand(cmd: LightCommand): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  if (cmd.state) state.state = cmd.state;
  if (cmd.color) state.color = cmd.color;
  if (cmd.color_temp !== undefined) state.color_temp = cmd.color_temp;
  if (cmd.brightness !== undefined) state.brightness = cmd.brightness;
  return state;
}

// ---------- Schemas ----------

const lightSetSchema = z.object({
  device: z.string().describe("Friendly name of the light"),
  description: z.string().describe(
    'Natural language color/temperature/brightness description. Examples: "warm white at 80%", "red", "2200k dim", "cool daylight", "blue 50%", "candle", "orange bright". Supports named colors, kelvin values (e.g. 3000k), temperatures (warm/cool/daylight), and brightness (dim/medium/bright/full or percentage).',
  ),
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

// ---------- Tool builder ----------

export function buildZigbee2MqttTools(ctx: ToolBuildContext): StructuredToolInterface[] {
  if (!ctx.featureConfig.isActive("zigbee2mqtt")) {
    return [];
  }

  return [
    defineTool(
      async () =>
        traceSpan("tool.lights_status", async () => ctx.zigbee2mqtt.renderStatus()),
      {
        name: "lights_status",
        description:
          "Show all smart lights: names, models, power state, brightness, color, and connection quality.",
        schema: z.object({}),
      },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.lights_inspect",
          async () => ctx.zigbee2mqtt.renderDeviceDetail(input.device),
          { attributes: input },
        ),
      {
        name: "lights_inspect",
        description:
          "Inspect a specific light: model, capabilities, supported features, and current state.",
        schema: deviceNameSchema,
      },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.lights_set",
          async () => {
            const cmd = parseColorDescription(input.description);
            if (!cmd.color && cmd.color_temp === undefined && cmd.brightness === undefined) {
              return `Could not parse "${input.description}" into a light command. Try: a color name (red, blue, warm white), a temperature (3000k, candle, daylight), and/or a brightness (dim, 80%, full).`;
            }
            const state = formatCommand(cmd);
            const parsed = JSON.stringify(state);
            const result = await ctx.zigbee2mqtt.setDeviceState(input.device, state);
            return `Parsed "${input.description}" → ${parsed}\n\n${result}`;
          },
          { attributes: input },
        ),
      {
        name: "lights_set",
        description:
          "Set a light's color, temperature, and/or brightness using a natural description. Supports: color names (red, blue, coral, lavender...), color temperatures (warm, cool, daylight, candle, or exact like 2700k), brightness (dim, 80%, full). Examples: \"warm white at 50%\", \"soft red dim\", \"4000k bright\", \"candle\".",
        schema: lightSetSchema,
      },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.lights_read",
          async () => ctx.zigbee2mqtt.getDeviceStateFresh(input.device),
          { attributes: input },
        ),
      {
        name: "lights_read",
        description:
          "Read the current state of a light directly from the device (fresh values, not cached).",
        schema: deviceNameSchema,
      },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.lights_on",
          async () => ctx.zigbee2mqtt.setDeviceState(input.device, { state: "ON" }),
          { attributes: input },
        ),
      {
        name: "lights_on",
        description: "Turn a light on.",
        schema: deviceNameSchema,
      },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.lights_off",
          async () => ctx.zigbee2mqtt.setDeviceState(input.device, { state: "OFF" }),
          { attributes: input },
        ),
      {
        name: "lights_off",
        description: "Turn a light off.",
        schema: deviceNameSchema,
      },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.lights_pair",
          async () => ctx.zigbee2mqtt.permitJoin(input.seconds),
          { attributes: input },
        ),
      {
        name: "lights_pair",
        description:
          "Open the Zigbee network for pairing so a new light can join. The user should put their device in pairing mode after this.",
        schema: permitJoinSchema,
      },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.lights_rename",
          async () => ctx.zigbee2mqtt.renameDevice(input.old_name, input.new_name),
          { attributes: input },
        ),
      {
        name: "lights_rename",
        description: "Rename a light's friendly name.",
        schema: renameSchema,
      },
    ),
  ];
}
