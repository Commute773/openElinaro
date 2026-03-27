import { type StructuredToolInterface } from "@langchain/core/tools";
import { defineTool } from "../define-tool";
import { z } from "zod";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { telemetry } from "../../services/telemetry";
import type { ToolBuildContext } from "./tool-group-types";

const toolTelemetry = telemetry.child({ component: "tool" });
const traceSpan = createTraceSpan(toolTelemetry);

const deviceSetSchema = z.object({
  device: z.string().describe("Friendly name of the Zigbee device"),
  state: z.string().describe(
    'JSON object of state properties to set, e.g. {"state":"ON","brightness":200,"color_temp":350}',
  ),
});

const deviceGetSchema = z.object({
  device: z.string().describe("Friendly name of the Zigbee device"),
});

const permitJoinSchema = z.object({
  seconds: z.number().int().min(10).max(600).optional().describe("Join window in seconds (default 120)"),
});

const deviceRenameSchema = z.object({
  old_name: z.string().describe("Current friendly name"),
  new_name: z.string().describe("New friendly name"),
});

export function buildZigbee2MqttTools(ctx: ToolBuildContext): StructuredToolInterface[] {
  if (!ctx.featureConfig.isActive("zigbee2mqtt")) {
    return [];
  }

  return [
    defineTool(
      async () =>
        traceSpan(
          "tool.zigbee_status",
          async () => {
            await ctx.zigbee2mqtt.connect();
            return ctx.zigbee2mqtt.renderStatus();
          },
        ),
      {
        name: "zigbee_status",
        description:
          "Show Zigbee2MQTT bridge status and all paired devices with their current state.",
        schema: z.object({}),
      },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.zigbee_device_detail",
          async () => {
            await ctx.zigbee2mqtt.connect();
            return ctx.zigbee2mqtt.renderDeviceDetail(input.device);
          },
          { attributes: input },
        ),
      {
        name: "zigbee_device_detail",
        description:
          "Show detailed info about a specific Zigbee device: model, capabilities, and current state.",
        schema: deviceGetSchema,
      },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.zigbee_device_set",
          async () => {
            await ctx.zigbee2mqtt.connect();
            const parsed = JSON.parse(input.state) as Record<string, unknown>;
            return ctx.zigbee2mqtt.setDeviceState(input.device, parsed);
          },
          { attributes: input },
        ),
      {
        name: "zigbee_device_set",
        description:
          "Set the state of a Zigbee device. Supports state (ON/OFF), brightness (0-254), color_temp, color ({x,y} or {hue,saturation}), and any other exposed property.",
        schema: deviceSetSchema,
      },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.zigbee_device_get",
          async () => {
            await ctx.zigbee2mqtt.connect();
            return ctx.zigbee2mqtt.getDeviceStateFresh(input.device);
          },
          { attributes: input },
        ),
      {
        name: "zigbee_device_get",
        description:
          "Request a fresh state update from a Zigbee device and return the result.",
        schema: deviceGetSchema,
      },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.zigbee_permit_join",
          async () => {
            await ctx.zigbee2mqtt.connect();
            return ctx.zigbee2mqtt.permitJoin(input.seconds);
          },
          { attributes: input },
        ),
      {
        name: "zigbee_permit_join",
        description:
          "Enable Zigbee network joining so new devices can pair. Opens for the specified number of seconds (default 120).",
        schema: permitJoinSchema,
      },
    ),

    defineTool(
      async () =>
        traceSpan(
          "tool.zigbee_disable_join",
          async () => {
            await ctx.zigbee2mqtt.connect();
            return ctx.zigbee2mqtt.disableJoin();
          },
        ),
      {
        name: "zigbee_disable_join",
        description:
          "Close the Zigbee network to prevent new devices from joining.",
        schema: z.object({}),
      },
    ),

    defineTool(
      async (input) =>
        traceSpan(
          "tool.zigbee_device_rename",
          async () => {
            await ctx.zigbee2mqtt.connect();
            return ctx.zigbee2mqtt.renameDevice(input.old_name, input.new_name);
          },
          { attributes: input },
        ),
      {
        name: "zigbee_device_rename",
        description:
          "Rename a paired Zigbee device's friendly name.",
        schema: deviceRenameSchema,
      },
    ),
  ];
}
