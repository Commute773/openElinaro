/**
 * MediaService facade — coordinates speaker config, audio devices, catalog, and player.
 *
 * Implementation details live in src/services/media/:
 *   types.ts         — shared type definitions
 *   constants.ts     — defaults and config paths
 *   utils.ts         — pure helpers (slugify, readJson, command runners, …)
 *   catalog.ts       — media file discovery, classification, scoring
 *   speaker-config.ts — speaker loading, discovery, resolution
 *   audio-device.ts  — SwitchAudioSource / blueutil / osascript
 *   player.ts        — mpv IPC, playback lifecycle, EOF monitoring
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { getRuntimeConfig } from "../config/runtime-config";
import { normalizeString } from "../utils/text-utils";

import {
  DEFAULT_BLUEUTIL_BIN,
  DEFAULT_MPV_BIN,
  DEFAULT_NC_BIN,
  DEFAULT_OSASCRIPT_BIN,
  DEFAULT_PLAYER_READY_TIMEOUT_MS,
  DEFAULT_PLAYER_STOP_TIMEOUT_MS,
  DEFAULT_SPEAKER_CONFIG_PATH,
  DEFAULT_STATE_ROOT,
  DEFAULT_SOCKET_ROOT,
  DEFAULT_SWITCH_AUDIO_SOURCE_BIN,
  EOF_POLL_INTERVAL_MS,
  getDefaultCatalogPath,
  getDefaultMediaRoots,
} from "./media/constants";

import {
  defaultProcessIsAlive,
  defaultRunCommand,
  defaultSignalProcess,
  defaultSpawnDetached,
  slugify,
  uniqueStrings,
} from "./media/utils";

import {
  buildSyntheticMediaItem,
  filterLibrary,
  getLibrary,
  resolveMediaForPath,
  resolveMediaItem,
} from "./media/catalog";

import {
  getConfiguredSpeakers,
  listSpeakers,
  resolveSpeaker,
  resolveStatusSpeaker,
  resolveTargetSpeakerForControl,
} from "./media/speaker-config";

import {
  ensureSpeakerReady,
  ensureSystemVolumeMax,
} from "./media/audio-device";

import {
  deletePlayerMetadata,
  emitPlaybackEnd,
  forceStopProcess,
  getActiveStatuses,
  getSocketPath,
  queryPlayerProperty,
  readPlayerMetadata,
  sendPlayerCommand,
  startEofWatcher,
  stopAllPlayers,
  stopEofWatcher,
  stopSpeaker,
  waitForPlayerSocket,
  writePlayerMetadata,
  cleanupBrokenPlayer,
} from "./media/player";

import type {
  MediaItem,
  MediaKind,
  MediaPlayerMetadata,
  MediaSpeaker,
  MediaStatus,
  PlaybackEndCallback,
  PlaybackEndEvent,
  ProcessIsAlive,
  RunCommand,
  SignalProcess,
  SpawnDetached,
} from "./media/types";

// Re-export public types so existing imports from "media-service" keep working.
export type { MediaItem, MediaKind, MediaSpeaker, MediaStatus, PlaybackEndEvent };

export class MediaService {
  private readonly mediaRoots: string[];
  private readonly catalogPath: string;
  private readonly speakerConfigPath: string;
  private readonly stateRoot: string;
  private readonly socketsRoot: string;
  private readonly metadataRoot: string;
  private readonly logsRoot: string;
  private readonly runCommandImpl: RunCommand;
  private readonly spawnDetachedImpl: SpawnDetached;
  private readonly switchAudioSourceBin: string;
  private readonly blueutilBin: string;
  private readonly mpvBin: string;
  private readonly ncBin: string;
  private readonly osascriptBin: string;
  private readonly processIsAliveImpl: ProcessIsAlive;
  private readonly signalProcessImpl: SignalProcess;
  private readonly playerReadyTimeoutMs: number;
  private readonly playerStopTimeoutMs: number;
  private readonly eofPollIntervalMs: number;
  private readonly eofWatchers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly playbackEndCallbacks: PlaybackEndCallback[] = [];

  constructor(options?: {
    mediaRoots?: string[];
    catalogPath?: string;
    speakerConfigPath?: string;
    stateRoot?: string;
    socketRoot?: string;
    runCommand?: RunCommand;
    spawnDetached?: SpawnDetached;
    switchAudioSourceBin?: string;
    blueutilBin?: string;
    mpvBin?: string;
    ncBin?: string;
    osascriptBin?: string;
    processIsAlive?: ProcessIsAlive;
    signalProcess?: SignalProcess;
    playerReadyTimeoutMs?: number;
    playerStopTimeoutMs?: number;
    eofPollIntervalMs?: number;
  }) {
    const configuredRoots = options?.mediaRoots?.length
      ? options.mediaRoots
      : getRuntimeConfig().media.roots;
    const defaultMediaRoots = getDefaultMediaRoots();
    this.mediaRoots = uniqueStrings((configuredRoots.length > 0 ? configuredRoots : defaultMediaRoots).map((entry) =>
      path.resolve(entry)
    ));
    this.catalogPath = path.resolve(options?.catalogPath ?? getDefaultCatalogPath());
    this.speakerConfigPath = path.resolve(
      options?.speakerConfigPath ?? DEFAULT_SPEAKER_CONFIG_PATH,
    );
    this.stateRoot = path.resolve(options?.stateRoot ?? DEFAULT_STATE_ROOT);
    this.socketsRoot = path.resolve(options?.socketRoot ?? DEFAULT_SOCKET_ROOT);
    this.metadataRoot = path.join(this.stateRoot, "players");
    this.logsRoot = path.join(this.stateRoot, "logs");
    this.runCommandImpl = options?.runCommand ?? defaultRunCommand;
    this.spawnDetachedImpl = options?.spawnDetached ?? defaultSpawnDetached;
    this.switchAudioSourceBin = options?.switchAudioSourceBin ?? DEFAULT_SWITCH_AUDIO_SOURCE_BIN;
    this.blueutilBin = options?.blueutilBin ?? DEFAULT_BLUEUTIL_BIN;
    this.mpvBin = options?.mpvBin ?? DEFAULT_MPV_BIN;
    this.ncBin = options?.ncBin ?? DEFAULT_NC_BIN;
    this.osascriptBin = options?.osascriptBin ?? DEFAULT_OSASCRIPT_BIN;
    this.processIsAliveImpl = options?.processIsAlive ?? defaultProcessIsAlive;
    this.signalProcessImpl = options?.signalProcess ?? defaultSignalProcess;
    this.playerReadyTimeoutMs = Math.max(0, options?.playerReadyTimeoutMs ?? DEFAULT_PLAYER_READY_TIMEOUT_MS);
    this.playerStopTimeoutMs = Math.max(0, options?.playerStopTimeoutMs ?? DEFAULT_PLAYER_STOP_TIMEOUT_MS);
    this.eofPollIntervalMs = Math.max(500, options?.eofPollIntervalMs ?? EOF_POLL_INTERVAL_MS);
    mkdirSync(this.socketsRoot, { recursive: true });
    mkdirSync(this.metadataRoot, { recursive: true });
    mkdirSync(this.logsRoot, { recursive: true });
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async listSpeakers() {
    return listSpeakers(this.speakerConfigPath, this.runCommandImpl, this.switchAudioSourceBin);
  }

  listMedia(options?: {
    query?: string;
    kind?: MediaKind | "all";
    tags?: string[];
    limit?: number;
  }) {
    const library = getLibrary(this.mediaRoots, this.catalogPath);
    const filtered = filterLibrary(library, options);
    return {
      total: filtered.length,
      counts: {
        songs: filtered.filter((item) => item.kind === "song").length,
        ambience: filtered.filter((item) => item.kind === "ambience").length,
      },
      items: filtered.slice(0, options?.limit ?? 20),
    };
  }

  async play(params: {
    query: string;
    speaker?: string;
    kind?: MediaKind;
    volume?: number;
    loop?: boolean;
  }): Promise<{
    speaker: MediaSpeaker;
    item: MediaItem;
    volume: number;
    loop: boolean;
    pid: number;
  }> {
    const item = resolveMediaItem(params.query, params.kind, this.mediaRoots, this.catalogPath);
    const speaker = await resolveSpeaker(
      params.speaker, true,
      this.speakerConfigPath, this.runCommandImpl, this.switchAudioSourceBin,
    );
    const volume = params.volume ?? 80;
    const loop = params.loop ?? item.kind === "ambience";

    await stopAllPlayers(
      this.metadataRoot, this.socketsRoot, this.runCommandImpl, this.ncBin,
      this.processIsAliveImpl, this.signalProcessImpl, this.playerStopTimeoutMs,
      (id) => stopEofWatcher(id, this.eofWatchers),
      speaker.id,
    );
    await ensureSystemVolumeMax(this.runCommandImpl, this.osascriptBin);
    await ensureSpeakerReady(speaker, this.runCommandImpl, this.blueutilBin, this.switchAudioSourceBin);
    await stopSpeaker(
      speaker.id, this.socketsRoot, this.metadataRoot, this.runCommandImpl, this.ncBin,
      this.processIsAliveImpl, this.signalProcessImpl, this.playerStopTimeoutMs,
      (id) => stopEofWatcher(id, this.eofWatchers),
    );

    const socketPath = getSocketPath(this.socketsRoot, speaker.id);
    rmSync(socketPath, { force: true });
    const stdoutPath = path.join(this.logsRoot, `mpv-${speaker.id}.stdout.log`);
    const stderrPath = path.join(this.logsRoot, `mpv-${speaker.id}.stderr.log`);
    const spawnResult = await this.spawnDetachedImpl({
      file: this.mpvBin,
      args: [
        "--no-video",
        "--audio-display=no",
        "--force-window=no",
        "--idle=yes",
        `--input-ipc-server=${socketPath}`,
        `--volume=${volume}`,
        loop ? "--loop=inf" : "--loop=no",
        "--really-quiet",
        item.path,
      ],
      stdoutPath,
      stderrPath,
    });
    const ready = await waitForPlayerSocket(
      socketPath, spawnResult.pid, this.playerReadyTimeoutMs,
      this.processIsAliveImpl, this.runCommandImpl, this.ncBin,
    );
    if (!ready) {
      await forceStopProcess(spawnResult.pid, this.processIsAliveImpl, this.signalProcessImpl, this.playerStopTimeoutMs);
      rmSync(socketPath, { force: true });
      throw new Error(
        `mpv failed to initialize control socket for speaker ${speaker.name}.`,
      );
    }

    const metadata: MediaPlayerMetadata = {
      speakerId: speaker.id,
      speakerName: speaker.name,
      deviceName: speaker.deviceName,
      mediaId: item.id,
      mediaTitle: item.title,
      mediaPath: item.path,
      mediaKind: item.kind,
      mediaTags: item.tags,
      startedAt: new Date().toISOString(),
      loop,
      volume,
      pid: spawnResult.pid,
    };
    writePlayerMetadata(this.metadataRoot, metadata);
    startEofWatcher(
      speaker.id, item.title, loop, this.eofPollIntervalMs,
      this.eofWatchers, this.playbackEndCallbacks,
      this.socketsRoot, this.runCommandImpl, this.ncBin,
    );

    return {
      speaker,
      item,
      volume,
      loop,
      pid: spawnResult.pid,
    };
  }

  async pause(speakerQuery?: string) {
    const speaker = await resolveTargetSpeakerForControl(
      speakerQuery,
      () => this.getActiveStatusesInternal(),
      this.speakerConfigPath, this.runCommandImpl, this.switchAudioSourceBin,
    );
    await sendPlayerCommand(speaker.id, { command: ["set_property", "pause", true] }, this.socketsRoot, this.runCommandImpl, this.ncBin);
    return this.getStatus(speaker.id);
  }

  async stop(speakerQuery?: string) {
    const speaker = await resolveTargetSpeakerForControl(
      speakerQuery,
      () => this.getActiveStatusesInternal(),
      this.speakerConfigPath, this.runCommandImpl, this.switchAudioSourceBin,
    );
    await stopSpeaker(
      speaker.id, this.socketsRoot, this.metadataRoot, this.runCommandImpl, this.ncBin,
      this.processIsAliveImpl, this.signalProcessImpl, this.playerStopTimeoutMs,
      (id) => stopEofWatcher(id, this.eofWatchers),
    );
    return this.getStatus(speaker.id);
  }

  async setVolume(volume: number, speakerQuery?: string) {
    const speaker = await resolveTargetSpeakerForControl(
      speakerQuery,
      () => this.getActiveStatusesInternal(),
      this.speakerConfigPath, this.runCommandImpl, this.switchAudioSourceBin,
    );
    await sendPlayerCommand(speaker.id, { command: ["set_property", "volume", volume] }, this.socketsRoot, this.runCommandImpl, this.ncBin);
    const metadata = readPlayerMetadata(this.metadataRoot, speaker.id);
    if (metadata) {
      metadata.volume = volume;
      writePlayerMetadata(this.metadataRoot, metadata);
    }
    return this.getStatus(speaker.id);
  }

  async getStatus(speakerQuery?: string): Promise<MediaStatus> {
    const speaker = await resolveStatusSpeaker(
      speakerQuery,
      () => this.getActiveStatusesInternal(),
      this.speakerConfigPath, this.runCommandImpl, this.switchAudioSourceBin,
    );
    const metadata = readPlayerMetadata(this.metadataRoot, speaker.id);
    const socketPath = getSocketPath(this.socketsRoot, speaker.id);
    if (!existsSync(socketPath)) {
      await cleanupBrokenPlayer(metadata, this.processIsAliveImpl, this.signalProcessImpl, this.playerStopTimeoutMs);
      deletePlayerMetadata(this.metadataRoot, speaker.id);
      return {
        speaker,
        state: "stopped",
        volume: null,
        media: null,
        path: null,
      };
    }

    const pid = await queryPlayerProperty(socketPath, "pid", this.runCommandImpl, this.ncBin);
    if (typeof pid !== "number") {
      await cleanupBrokenPlayer(metadata, this.processIsAliveImpl, this.signalProcessImpl, this.playerStopTimeoutMs);
      deletePlayerMetadata(this.metadataRoot, speaker.id);
      return {
        speaker,
        state: "stopped",
        volume: null,
        media: null,
        path: null,
      };
    }

    const pause = await queryPlayerProperty(socketPath, "pause", this.runCommandImpl, this.ncBin);
    const vol = await queryPlayerProperty(socketPath, "volume", this.runCommandImpl, this.ncBin);
    const mediaPath = await queryPlayerProperty(socketPath, "path", this.runCommandImpl, this.ncBin);
    const normalizedMediaPath = normalizeString(mediaPath) ?? metadata?.mediaPath;
    const media = resolveMediaForPath(normalizedMediaPath, this.mediaRoots, this.catalogPath);

    return {
      speaker,
      state: pause ? "paused" : "playing",
      volume: typeof vol === "number" ? Math.round(vol) : metadata?.volume ?? null,
      media,
      path: normalizedMediaPath ?? null,
      startedAt: metadata?.startedAt,
    };
  }

  buildAssistantContext() {
    const speakers = getConfiguredSpeakers(this.speakerConfigPath).map((record) => ({
      id: slugify(record.id?.trim() || record.name?.trim() || record.device_name?.trim() || "speaker"),
      name: record.name?.trim() || record.device_name?.trim() || record.id?.trim() || "Unknown speaker",
    }));
    const library = getLibrary(this.mediaRoots, this.catalogPath);
    const songs = library.filter((item) => item.kind === "song").length;
    const ambience = library.filter((item) => item.kind === "ambience").length;
    const tagSample = uniqueStrings(library.flatMap((item) => item.tags)).slice(0, 12);

    return [
      "Media:",
      `- Speakers: ${speakers.map((speaker) => `${speaker.id}=${speaker.name}`).join(", ") || "none configured"}`,
      `- Library: ${library.length} track(s) total; ${songs} song(s); ${ambience} ambience track(s).`,
      `- Sources: ${this.mediaRoots.join(", ")}`,
      tagSample.length > 0 ? `- Tag vocabulary sample: ${tagSample.join(", ")}` : "- Tag vocabulary sample: none",
      "- Use media tools for speaker listing, playback, pause, stop, volume, and current status.",
    ].join("\n");
  }

  onPlaybackEnd(callback: PlaybackEndCallback): () => void {
    this.playbackEndCallbacks.push(callback);
    return () => {
      const index = this.playbackEndCallbacks.indexOf(callback);
      if (index >= 0) {
        this.playbackEndCallbacks.splice(index, 1);
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async getActiveStatusesInternal(): Promise<MediaStatus[]> {
    return getActiveStatuses(this.metadataRoot, (speakerQuery) => this.getStatus(speakerQuery));
  }
}
