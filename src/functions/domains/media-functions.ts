/**
 * Media playback function definitions.
 * Migrated from src/tools/groups/media-tools.ts.
 * These produce agent tools, API routes, and Discord commands from a single source.
 */
import { z } from "zod";
import { defineFunction, type FunctionDomainBuilder } from "../define-function";
import type { MediaKind } from "../../services/media-service";

// ---------------------------------------------------------------------------
// Shared schemas (same as media-tools.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Media auth defaults
// ---------------------------------------------------------------------------

const MEDIA_AUTH = { access: "root" as const, behavior: "uniform" as const };
const MEDIA_SCOPES: ("chat" | "direct")[] = ["chat", "direct"];
const MEDIA_DOMAINS = ["media"];

// ---------------------------------------------------------------------------
// Domain builder
// ---------------------------------------------------------------------------

export const buildMediaFunctions: FunctionDomainBuilder = (ctx) => [
  // -----------------------------------------------------------------------
  // media_list
  // -----------------------------------------------------------------------
  defineFunction({
    name: "media_list",
    description:
      "List tagged local media from the runtime media/ library. Use this to inspect songs, ambience, ids, and tags before playback.",
    input: mediaListSchema,
    handler: async (input, fnCtx) => {
      const media = fnCtx.services.media;
      if (!media) throw new Error("Media service is not available.");
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
    auth: { ...MEDIA_AUTH, note: "Reads the local tagged media library under the runtime media/ directory." },
    domains: MEDIA_DOMAINS,
    agentScopes: MEDIA_SCOPES,
    examples: ["list songs and ambience", "find thunder audio"],
    featureGate: "media",
    readsWorkspace: true,
    untrustedOutput: {
      sourceType: "filesystem",
      sourceName: "local media library listing",
      notes: "Media filenames and tags come from local files and optional user-managed catalog metadata.",
    },
  }),

  // -----------------------------------------------------------------------
  // media_list_speakers
  // -----------------------------------------------------------------------
  defineFunction({
    name: "media_list_speakers",
    description:
      "List known output speakers and whether they are currently available. Includes configured aliases such as bedroom/B06HD.",
    input: z.object({}),
    handler: async (_input, fnCtx) => {
      const media = fnCtx.services.media;
      if (!media) throw new Error("Media service is not available.");
      const speakers = await media.listSpeakers();
      if (speakers.length === 0) {
        return "No speakers detected.";
      }
      return speakers.map((speaker) =>
        `- ${speaker.id}: ${speaker.name} | device=${speaker.deviceName} | transport=${speaker.transport} | available=${speaker.available ? "yes" : "no"}${speaker.isCurrentOutput ? " | current output" : ""}`
      ).join("\n");
    },
    auth: { ...MEDIA_AUTH, note: "Inspects local output devices and configured speaker aliases." },
    domains: MEDIA_DOMAINS,
    agentScopes: MEDIA_SCOPES,
    examples: ["list speakers", "check if B06HD is available"],
    featureGate: "media",
    readsWorkspace: true,
  }),

  // -----------------------------------------------------------------------
  // media_play
  // -----------------------------------------------------------------------
  defineFunction({
    name: "media_play",
    description:
      "Play a tagged local media item on a specific speaker. Resolves media by id, title, tag, or direct file path.",
    input: mediaPlaySchema,
    handler: async (input, fnCtx) => {
      const media = fnCtx.services.media;
      if (!media) throw new Error("Media service is not available.");
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
    auth: { ...MEDIA_AUTH, note: "Controls local audio playback and speaker routing on this machine." },
    domains: MEDIA_DOMAINS,
    agentScopes: MEDIA_SCOPES,
    examples: ["play thunder on bedroom speaker", "start a song on B06HD"],
    featureGate: "media",
    mutatesState: true,
  }),

  // -----------------------------------------------------------------------
  // media_pause
  // -----------------------------------------------------------------------
  defineFunction({
    name: "media_pause",
    description: "Pause the currently playing audio on a speaker.",
    input: mediaSpeakerSchema,
    handler: async (input, fnCtx) => {
      const media = fnCtx.services.media;
      if (!media) throw new Error("Media service is not available.");
      const status = await media.pause(input.speaker);
      return `Paused ${status.media?.title ?? "current audio"} on ${status.speaker.name}.`;
    },
    auth: { ...MEDIA_AUTH, note: "Controls local audio playback and speaker routing on this machine." },
    domains: MEDIA_DOMAINS,
    agentScopes: MEDIA_SCOPES,
    examples: ["pause the speaker", "pause current audio"],
    featureGate: "media",
    mutatesState: true,
  }),

  // -----------------------------------------------------------------------
  // media_stop
  // -----------------------------------------------------------------------
  defineFunction({
    name: "media_stop",
    description: "Stop the currently playing audio on a speaker.",
    input: mediaSpeakerSchema,
    handler: async (input, fnCtx) => {
      const media = fnCtx.services.media;
      if (!media) throw new Error("Media service is not available.");
      const status = await media.stop(input.speaker);
      return `Stopped playback on ${status.speaker.name}.`;
    },
    auth: { ...MEDIA_AUTH, note: "Controls local audio playback and speaker routing on this machine." },
    domains: MEDIA_DOMAINS,
    agentScopes: MEDIA_SCOPES,
    examples: ["stop the speaker", "stop current audio"],
    featureGate: "media",
    mutatesState: true,
  }),

  // -----------------------------------------------------------------------
  // media_set_volume
  // -----------------------------------------------------------------------
  defineFunction({
    name: "media_set_volume",
    description: "Set the mpv playback volume for the active media player on a speaker.",
    input: mediaVolumeSchema,
    handler: async (input, fnCtx) => {
      const media = fnCtx.services.media;
      if (!media) throw new Error("Media service is not available.");
      const status = await media.setVolume(input.volume, input.speaker);
      return `Volume set to ${status.volume ?? input.volume} on ${status.speaker.name}.`;
    },
    auth: { ...MEDIA_AUTH, note: "Controls local audio playback volume on this machine." },
    domains: MEDIA_DOMAINS,
    agentScopes: MEDIA_SCOPES,
    examples: ["set volume to 60", "turn down current audio"],
    featureGate: "media",
    mutatesState: true,
  }),

  // -----------------------------------------------------------------------
  // media_status
  // -----------------------------------------------------------------------
  defineFunction({
    name: "media_status",
    description: "Show what is currently playing on a speaker, including pause state and volume.",
    input: mediaSpeakerSchema,
    handler: async (input, fnCtx) => {
      const media = fnCtx.services.media;
      if (!media) throw new Error("Media service is not available.");
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
    auth: { ...MEDIA_AUTH, note: "Reads local audio playback state from the managed mpv player." },
    domains: MEDIA_DOMAINS,
    agentScopes: MEDIA_SCOPES,
    examples: ["what is playing now", "show current speaker playback"],
    featureGate: "media",
    readsWorkspace: true,
    untrustedOutput: {
      sourceType: "filesystem",
      sourceName: "local media playback state",
      notes: "Playback state may include local file paths and user-managed media metadata.",
    },
  }),
];
