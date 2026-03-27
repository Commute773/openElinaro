import { type StructuredToolInterface } from "@langchain/core/tools";
import { defineTool } from "../define-tool";
import { z } from "zod";
import type { MediaKind } from "../../services/media-service";
import { createTraceSpan } from "../../utils/telemetry-helpers";
import { telemetry } from "../../services/telemetry";
import type { ToolBuildContext } from "./tool-group-types";

const toolTelemetry = telemetry.child({ component: "tool" });
const traceSpan = createTraceSpan(toolTelemetry);

const mediaKindSchema = z.enum(["song", "ambience"]);

const mediaListSchema = z.object({
  query: z.string().min(1).optional(),
  kind: mediaKindSchema.or(z.literal("all")).optional(),
  tags: z.array(z.string().min(1)).max(12).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const mediaSpeakerSchema = z.object({
  speaker: z.string().min(1).optional(),
});

const mediaPlaySchema = z.object({
  query: z.string().min(1),
  speaker: z.string().min(1).optional(),
  kind: mediaKindSchema.optional(),
  volume: z.number().int().min(0).max(130).optional(),
  loop: z.boolean().optional(),
});

const mediaVolumeSchema = z.object({
  volume: z.number().int().min(0).max(130),
  speaker: z.string().min(1).optional(),
});

export function buildMediaTools(ctx: ToolBuildContext): StructuredToolInterface[] {
  const tools: StructuredToolInterface[] = [];

  if (ctx.media && ctx.featureConfig.isActive("media")) {
    const media = ctx.media;
    tools.push(
      defineTool(
        async (input) =>
          traceSpan(
            "tool.media_list",
            async () => {
              const result = media.listMedia({
                query: input.query,
                kind: input.kind as MediaKind | "all" | undefined,
                tags: input.tags,
                limit: input.limit,
              });
              if (result.items.length === 0) {
                return "No media matched.";
              }
              return [
                `Media matches: ${result.total} total (${result.counts.songs} songs, ${result.counts.ambience} ambience).`,
                ...result.items.map((item) =>
                  `- [${item.id}] ${item.title} | ${item.kind} | tags: ${item.tags.join(", ")} | source: ${item.source}`
                ),
              ].join("\n");
            },
            { attributes: input },
          ),
        {
          name: "media_list",
          description:
            "List tagged local media from the runtime media/ library. Use this to inspect songs, ambience, ids, and tags before playback.",
          schema: mediaListSchema,
        },
      ),
      defineTool(
        async () =>
          traceSpan(
            "tool.media_list_speakers",
            async () => {
              const speakers = await media.listSpeakers();
              if (speakers.length === 0) {
                return "No speakers detected.";
              }
              return speakers.map((speaker) =>
                `- ${speaker.id}: ${speaker.name} | device=${speaker.deviceName} | transport=${speaker.transport} | available=${speaker.available ? "yes" : "no"}${speaker.isCurrentOutput ? " | current output" : ""}`
              ).join("\n");
            },
          ),
        {
          name: "media_list_speakers",
          description:
            "List known output speakers and whether they are currently available. Includes configured aliases such as bedroom/B06HD.",
          schema: z.object({}),
        },
      ),
      defineTool(
        async (input) =>
          traceSpan(
            "tool.media_play",
            async () => {
              const result = await media.play({
                query: input.query,
                speaker: input.speaker,
                kind: input.kind as MediaKind | undefined,
                volume: input.volume,
                loop: input.loop,
              });
              return [
                `Playing ${result.item.title}.`,
                `Speaker: ${result.speaker.name} (${result.speaker.id})`,
                `Kind: ${result.item.kind}`,
                `Volume: ${result.volume}`,
                `Loop: ${result.loop ? "on" : "off"}`,
                `Tags: ${result.item.tags.join(", ")}`,
              ].join("\n");
            },
            { attributes: input },
          ),
        {
          name: "media_play",
          description:
            "Play a tagged local media item on a specific speaker. Resolves media by id, title, tag, or direct file path.",
          schema: mediaPlaySchema,
        },
      ),
      defineTool(
        async (input) =>
          traceSpan(
            "tool.media_pause",
            async () => {
              const status = await media.pause(input.speaker);
              return `Paused ${status.media?.title ?? "current audio"} on ${status.speaker.name}.`;
            },
            { attributes: input },
          ),
        {
          name: "media_pause",
          description: "Pause the currently playing audio on a speaker.",
          schema: mediaSpeakerSchema,
        },
      ),
      defineTool(
        async (input) =>
          traceSpan(
            "tool.media_stop",
            async () => {
              const status = await media.stop(input.speaker);
              return `Stopped playback on ${status.speaker.name}.`;
            },
            { attributes: input },
          ),
        {
          name: "media_stop",
          description: "Stop the currently playing audio on a speaker.",
          schema: mediaSpeakerSchema,
        },
      ),
      defineTool(
        async (input) =>
          traceSpan(
            "tool.media_set_volume",
            async () => {
              const status = await media.setVolume(input.volume, input.speaker);
              return `Volume set to ${status.volume ?? input.volume} on ${status.speaker.name}.`;
            },
            { attributes: input },
          ),
        {
          name: "media_set_volume",
          description: "Set the mpv playback volume for the active media player on a speaker.",
          schema: mediaVolumeSchema,
        },
      ),
      defineTool(
        async (input) =>
          traceSpan(
            "tool.media_status",
            async () => {
              const status = await media.getStatus(input.speaker);
              if (status.state === "stopped") {
                return `${status.speaker.name} is stopped.`;
              }
              return [
                `${status.speaker.name} is ${status.state}.`,
                `Track: ${status.media?.title ?? status.path ?? "unknown"}`,
                `Kind: ${status.media?.kind ?? "unknown"}`,
                `Volume: ${status.volume ?? "unknown"}`,
                status.media ? `Tags: ${status.media.tags.join(", ")}` : undefined,
              ].filter(Boolean).join("\n");
            },
            { attributes: input },
          ),
        {
          name: "media_status",
          description: "Show what is currently playing on a speaker, including pause state and volume.",
          schema: mediaSpeakerSchema,
        },
      ),
    );
  }

  return tools;
}
