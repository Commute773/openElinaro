import crypto from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { getRuntimeConfig } from "../config/runtime-config";
import { getRuntimeRootDir, getServiceRootDir, resolveRuntimePath } from "./runtime-root";
import { telemetry } from "./telemetry";

const SUPPORTED_MEDIA_EXTENSIONS = new Set([
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".ogg",
  ".wav",
  ".webm",
]);

const AMBIENCE_HINTS = new Set([
  "ambient",
  "ambience",
  "background",
  "noise",
  "rain",
  "sleep",
  "storm",
  "thunder",
  "white",
]);

function getDefaultMediaRoots() {
  return [resolveRuntimePath("media")];
}

function getDefaultCatalogPath() {
  return resolveRuntimePath("media", "catalog.json");
}

const DEFAULT_SPEAKER_CONFIG_PATH = resolveRuntimePath("media", "speakers.json");
const LEGACY_SPEAKER_CONFIG_PATH = path.join(
  os.homedir(),
  ".openclaw",
  "workspace",
  "skills",
  "play-sound",
  "references",
  "speakers.json",
);
const DEFAULT_STATE_ROOT = resolveRuntimePath("media");
const DEFAULT_SOCKET_ROOT = path.join(
  os.tmpdir(),
  "oe-media",
  crypto.createHash("sha1")
    .update(process.env.OPENELINARO_SERVICE_ROOT_DIR?.trim() ? getServiceRootDir() : getRuntimeRootDir())
    .digest("hex")
    .slice(0, 8),
);
const DEFAULT_SWITCH_AUDIO_SOURCE_BIN = "/opt/homebrew/bin/SwitchAudioSource";
const DEFAULT_BLUEUTIL_BIN = "/opt/homebrew/bin/blueutil";
const DEFAULT_MPV_BIN = "/opt/homebrew/bin/mpv";
const DEFAULT_NC_BIN = "/usr/bin/nc";
const DEFAULT_OSASCRIPT_BIN = "/usr/bin/osascript";
const DEFAULT_PLAYER_READY_TIMEOUT_MS = 5_000;
const DEFAULT_PLAYER_STOP_TIMEOUT_MS = 3_000;
const PLAYER_WAIT_POLL_MS = 50;
const EOF_POLL_INTERVAL_MS = 3_000;

export type MediaKind = "song" | "ambience";

export type PlaybackEndEvent = {
  speakerId: string;
  title: string;
  reason: "eof" | "stopped";
};

type PlaybackEndCallback = (event: PlaybackEndEvent) => void;

type SpeakerTransport = "aux" | "bluetooth" | "built-in" | "system" | "unknown";

type SpeakerConfigRecord = {
  id?: string;
  name?: string;
  aliases?: string[];
  device_name?: string;
  bt_address?: string;
  transport?: string;
};

type MediaCatalogTrack = {
  id?: string;
  title?: string;
  file?: string;
  tags?: string[];
  artist?: string;
  category?: string;
};

type MediaCatalogFile = {
  tracks?: MediaCatalogTrack[];
};

type MediaPlayerMetadata = {
  speakerId: string;
  speakerName: string;
  deviceName: string;
  mediaId: string;
  mediaTitle: string;
  mediaPath: string;
  mediaKind: MediaKind;
  mediaTags: string[];
  startedAt: string;
  loop: boolean;
  volume: number;
  pid: number;
};

export interface MediaItem {
  id: string;
  title: string;
  path: string;
  relativePath: string;
  kind: MediaKind;
  tags: string[];
  source: "local";
  artist?: string;
}

export interface MediaSpeaker {
  id: string;
  name: string;
  aliases: string[];
  deviceName: string;
  transport: SpeakerTransport;
  btAddress?: string;
  configured: boolean;
  available: boolean;
  isCurrentOutput: boolean;
}

export interface MediaStatus {
  speaker: MediaSpeaker;
  state: "playing" | "paused" | "stopped";
  volume: number | null;
  media: MediaItem | null;
  path: string | null;
  startedAt?: string;
}

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

type RunCommand = (params: {
  file: string;
  args?: string[];
  input?: string;
  timeoutMs?: number;
  allowFailure?: boolean;
}) => Promise<CommandResult>;

type SpawnDetached = (params: {
  file: string;
  args?: string[];
  stdoutPath: string;
  stderrPath: string;
}) => Promise<{ pid: number }>;

type ProcessIsAlive = (pid: number) => boolean;
type SignalProcess = (pid: number, signal: NodeJS.Signals) => void;

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value && value.trim()))));
}

function normalizeToken(value: string) {
  return value.toLowerCase().trim();
}

function slugify(value: string) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "media";
}

function titleCaseFromSlug(value: string) {
  return value
    .replace(/\.[^.]+$/, "")
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function sleep(delayMs: number) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function defaultProcessIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function defaultSignalProcess(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal);
  } catch {
    // Best effort only.
  }
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch (error) {
    telemetry.event("media.invalid_json", {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    }, {
      level: "warn",
      outcome: "error",
    });
    return null;
  }
}

function resolveSpeakerConfigPath(): string {
  if (existsSync(DEFAULT_SPEAKER_CONFIG_PATH)) {
    return DEFAULT_SPEAKER_CONFIG_PATH;
  }
  if (existsSync(LEGACY_SPEAKER_CONFIG_PATH)) {
    telemetry.event("media.legacy_speaker_config", {
      legacyPath: LEGACY_SPEAKER_CONFIG_PATH,
      expectedPath: DEFAULT_SPEAKER_CONFIG_PATH,
    }, {
      level: "warn",
      outcome: "ok",
    });
    return LEGACY_SPEAKER_CONFIG_PATH;
  }
  return DEFAULT_SPEAKER_CONFIG_PATH;
}

async function defaultRunCommand(params: {
  file: string;
  args?: string[];
  input?: string;
  timeoutMs?: number;
  allowFailure?: boolean;
}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(params.file, params.args ?? [], {
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = params.timeoutMs ?? 15_000;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${params.file}`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const result = {
        stdout,
        stderr,
        exitCode: exitCode ?? 0,
      };
      if (result.exitCode !== 0 && !params.allowFailure) {
        reject(new Error(`Command failed (${result.exitCode}): ${params.file} ${(params.args ?? []).join(" ")}\n${stderr.trim()}`));
        return;
      }
      resolve(result);
    });

    if (params.input) {
      child.stdin.write(params.input);
    }
    child.stdin.end();
  });
}

async function defaultSpawnDetached(params: {
  file: string;
  args?: string[];
  stdoutPath: string;
  stderrPath: string;
}): Promise<{ pid: number }> {
  mkdirSync(path.dirname(params.stdoutPath), { recursive: true });
  mkdirSync(path.dirname(params.stderrPath), { recursive: true });
  const stdoutFd = openSync(params.stdoutPath, "a");
  const stderrFd = openSync(params.stderrPath, "a");
  const child = spawn(params.file, params.args ?? [], {
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
  });
  child.unref();
  closeSync(stdoutFd);
  closeSync(stderrFd);
  return { pid: child.pid ?? 0 };
}

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
    this.speakerConfigPath = path.resolve(options?.speakerConfigPath ?? resolveSpeakerConfigPath());
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

  async listSpeakers() {
    const availableOutputs = await this.getAvailableOutputDeviceNames();
    const currentOutput = await this.getCurrentOutputDeviceName();
    const configured = this.getConfiguredSpeakers();
    const speakersById = new Map<string, MediaSpeaker>();
    const matchedOutputs = new Set<string>();

    for (const record of configured) {
      const deviceName = record.device_name?.trim() || record.name?.trim() || record.id?.trim() || "unknown";
      const available = availableOutputs.has(deviceName);
      if (available) {
        matchedOutputs.add(deviceName);
      }
      const speaker: MediaSpeaker = {
        id: slugify(record.id?.trim() || record.name?.trim() || deviceName),
        name: record.name?.trim() || deviceName,
        aliases: uniqueStrings([
          record.id?.trim()?.toLowerCase(),
          record.name?.trim()?.toLowerCase(),
          ...(record.aliases ?? []).map((entry) => entry.toLowerCase()),
          deviceName.toLowerCase(),
        ]),
        deviceName,
        transport: this.normalizeTransport(record.transport),
        btAddress: record.bt_address?.trim() || undefined,
        configured: true,
        available,
        isCurrentOutput: currentOutput === deviceName,
      };
      speakersById.set(speaker.id, speaker);
    }

    for (const output of availableOutputs) {
      if (matchedOutputs.has(output)) {
        continue;
      }
      const speaker: MediaSpeaker = {
        id: slugify(output),
        name: output,
        aliases: [output.toLowerCase()],
        deviceName: output,
        transport: "system",
        configured: false,
        available: true,
        isCurrentOutput: currentOutput === output,
      };
      speakersById.set(speaker.id, speaker);
    }

    return [...speakersById.values()].sort((left, right) => {
      if (left.isCurrentOutput !== right.isCurrentOutput) {
        return left.isCurrentOutput ? -1 : 1;
      }
      if (left.available !== right.available) {
        return left.available ? -1 : 1;
      }
      if (left.configured !== right.configured) {
        return left.configured ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
  }

  listMedia(options?: {
    query?: string;
    kind?: MediaKind | "all";
    tags?: string[];
    limit?: number;
  }) {
    const library = this.getLibrary();
    const filtered = this.filterLibrary(library, options);
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
    const item = this.resolveMediaItem(params.query, params.kind);
    const speaker = await this.resolveSpeaker(params.speaker, true);
    const volume = params.volume ?? 80;
    const loop = params.loop ?? item.kind === "ambience";

    await this.stopAllPlayers({ exceptSpeakerId: speaker.id });
    await this.ensureSystemVolumeMax();
    await this.ensureSpeakerReady(speaker);
    await this.stopSpeaker(speaker.id);

    const socketPath = this.getSocketPath(speaker.id);
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
    const ready = await this.waitForPlayerSocket(socketPath, spawnResult.pid, this.playerReadyTimeoutMs);
    if (!ready) {
      await this.forceStopProcess(spawnResult.pid);
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
    this.writePlayerMetadata(metadata);
    this.startEofWatcher(speaker.id, item.title, loop);

    return {
      speaker,
      item,
      volume,
      loop,
      pid: spawnResult.pid,
    };
  }

  async pause(speakerQuery?: string) {
    const speaker = await this.resolveTargetSpeakerForControl(speakerQuery);
    await this.sendPlayerCommand(speaker.id, {
      command: ["set_property", "pause", true],
    });
    return this.getStatus(speaker.id);
  }

  async stop(speakerQuery?: string) {
    const speaker = await this.resolveTargetSpeakerForControl(speakerQuery);
    await this.stopSpeaker(speaker.id);
    return this.getStatus(speaker.id);
  }

  async setVolume(volume: number, speakerQuery?: string) {
    const speaker = await this.resolveTargetSpeakerForControl(speakerQuery);
    await this.sendPlayerCommand(speaker.id, {
      command: ["set_property", "volume", volume],
    });
    const metadata = this.readPlayerMetadata(speaker.id);
    if (metadata) {
      metadata.volume = volume;
      this.writePlayerMetadata(metadata);
    }
    return this.getStatus(speaker.id);
  }

  async getStatus(speakerQuery?: string): Promise<MediaStatus> {
    const speaker = await this.resolveStatusSpeaker(speakerQuery);
    const metadata = this.readPlayerMetadata(speaker.id);
    const socketPath = this.getSocketPath(speaker.id);
    if (!existsSync(socketPath)) {
      await this.cleanupBrokenPlayer(metadata);
      this.deletePlayerMetadata(speaker.id);
      return {
        speaker,
        state: "stopped",
        volume: null,
        media: null,
        path: null,
      };
    }

    const pid = await this.queryPlayerProperty(socketPath, "pid");
    if (typeof pid !== "number") {
      await this.cleanupBrokenPlayer(metadata);
      this.deletePlayerMetadata(speaker.id);
      return {
        speaker,
        state: "stopped",
        volume: null,
        media: null,
        path: null,
      };
    }

    const pause = await this.queryPlayerProperty(socketPath, "pause");
    const volume = await this.queryPlayerProperty(socketPath, "volume");
    const mediaPath = await this.queryPlayerProperty(socketPath, "path");
    const media = this.resolveMediaForPath(
      typeof mediaPath === "string" && mediaPath.trim() ? mediaPath.trim() : metadata?.mediaPath,
    );

    return {
      speaker,
      state: pause ? "paused" : "playing",
      volume: typeof volume === "number" ? Math.round(volume) : metadata?.volume ?? null,
      media,
      path: typeof mediaPath === "string" && mediaPath.trim() ? mediaPath.trim() : metadata?.mediaPath ?? null,
      startedAt: metadata?.startedAt,
    };
  }

  buildAssistantContext() {
    const speakers = this.getConfiguredSpeakers().map((record) => ({
      id: slugify(record.id?.trim() || record.name?.trim() || record.device_name?.trim() || "speaker"),
      name: record.name?.trim() || record.device_name?.trim() || record.id?.trim() || "Unknown speaker",
    }));
    const library = this.getLibrary();
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

  private startEofWatcher(speakerId: string, title: string, loop: boolean) {
    this.stopEofWatcher(speakerId);
    if (loop) {
      return;
    }
    const interval = setInterval(() => {
      void this.checkEof(speakerId, title);
    }, this.eofPollIntervalMs);
    this.eofWatchers.set(speakerId, interval);
  }

  private stopEofWatcher(speakerId: string) {
    const existing = this.eofWatchers.get(speakerId);
    if (existing) {
      clearInterval(existing);
      this.eofWatchers.delete(speakerId);
    }
  }

  private async checkEof(speakerId: string, title: string) {
    const socketPath = this.getSocketPath(speakerId);
    if (!existsSync(socketPath)) {
      this.stopEofWatcher(speakerId);
      this.emitPlaybackEnd({ speakerId, title, reason: "eof" });
      return;
    }
    const eofReached = await this.queryPlayerProperty(socketPath, "eof-reached");
    if (eofReached === true) {
      this.stopEofWatcher(speakerId);
      this.emitPlaybackEnd({ speakerId, title, reason: "eof" });
    }
  }

  private emitPlaybackEnd(event: PlaybackEndEvent) {
    for (const callback of this.playbackEndCallbacks) {
      try {
        callback(event);
      } catch {
        // Best effort only.
      }
    }
  }

  private getLibrary() {
    const catalogEntries = this.getCatalogEntries();
    const library = new Map<string, MediaItem>();
    const seenPaths = new Set<string>();

    for (const entry of catalogEntries) {
      library.set(entry.id, entry);
      seenPaths.add(entry.path);
    }

    for (const root of this.mediaRoots) {
      if (!existsSync(root)) {
        continue;
      }
      for (const filePath of this.walkMediaFiles(root)) {
        const resolved = path.resolve(filePath);
        if (seenPaths.has(resolved)) {
          continue;
        }
        const item = this.buildSyntheticMediaItem(resolved, root);
        seenPaths.add(item.path);
        library.set(item.id, item);
      }
    }

    return [...library.values()].sort((left, right) => left.title.localeCompare(right.title));
  }

  private getCatalogEntries() {
    const catalog = readJsonFile<MediaCatalogFile>(this.catalogPath);
    if (!catalog?.tracks?.length) {
      return [];
    }
    const catalogRoot = this.mediaRoots[0]
      ?? getDefaultMediaRoots()[0]
      ?? resolveRuntimePath("media");
    const items: MediaItem[] = [];

    for (const track of catalog.tracks) {
      if (!track.file?.trim()) {
        continue;
      }
      const trackFile = track.file.trim();
      const absolutePath = path.resolve(catalogRoot, trackFile);
      if (!existsSync(absolutePath)) {
        continue;
      }
      const ext = path.extname(absolutePath).toLowerCase();
      if (!SUPPORTED_MEDIA_EXTENSIONS.has(ext)) {
        continue;
      }
      const tags = this.buildTags(track.tags ?? [], absolutePath, this.inferKind(track.category, track.tags, absolutePath));
      const kind = this.inferKind(track.category, tags, absolutePath);
      items.push({
        id: slugify(track.id?.trim() || track.title?.trim() || track.file),
        title: track.title?.trim() || titleCaseFromSlug(path.basename(trackFile)),
        path: absolutePath,
        relativePath: trackFile,
        kind,
        tags,
        source: "local",
        artist: track.artist?.trim() || undefined,
      });
    }

    return items;
  }

  private walkMediaFiles(root: string): string[] {
    const pending = [root];
    const files: string[] = [];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current || !existsSync(current)) {
        continue;
      }
      const entries = readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const target = path.join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(target);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        if (!SUPPORTED_MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          continue;
        }
        files.push(target);
      }
    }
    return files;
  }

  private buildSyntheticMediaItem(filePath: string, root: string): MediaItem {
    const relativePath = path.relative(root, filePath);
    const normalizedRelativePath = relativePath.split(path.sep).join("/");
    const title = titleCaseFromSlug(path.basename(filePath));
    const kind = this.inferKind(undefined, [], filePath);
    const tags = this.buildTags([], filePath, kind);
    const isPrimaryThunderTrack = kind === "ambience" && normalizedRelativePath === "ambience/thunder.mp3";
    const baseId = isPrimaryThunderTrack
      ? "thunder-noises"
      : slugify(relativePath);
    return {
      id: baseId,
      title: isPrimaryThunderTrack ? "Thunder Noises" : title,
      path: filePath,
      relativePath,
      kind,
      tags,
      source: "local",
    };
  }

  private buildTags(inputTags: string[], filePath: string, kind: MediaKind) {
    const relativeTokens = path.relative(path.dirname(filePath), filePath)
      .split(/[\/_.\-\s]+/g)
      .map(normalizeToken)
      .filter(Boolean);
    const baseTags = [...inputTags.map(normalizeToken), ...relativeTokens];
    if (kind === "ambience") {
      baseTags.push("ambient", "ambience", "background");
    } else {
      baseTags.push("song", "songs", "music");
    }
    if (filePath.toLowerCase().includes("thunder")) {
      baseTags.push("storm", "rain", "sleep", "thunder");
    }
    return uniqueStrings(baseTags);
  }

  private inferKind(category: string | undefined, tags: string[] | undefined, filePath: string): MediaKind {
    const categoryToken = normalizeToken(category ?? "");
    if (["ambient", "ambience", "ambient-noise", "ambient_noise", "ambient-sound", "ambient_sound"].includes(categoryToken)) {
      return "ambience";
    }
    if (["song", "songs", "music", "track", "tracks"].includes(categoryToken)) {
      return "song";
    }
    const tokens = [
      ...((tags ?? []).map(normalizeToken)),
      ...filePath.split(/[\/_.\-\s]+/g).map(normalizeToken),
    ];
    return tokens.some((token) => AMBIENCE_HINTS.has(token)) ? "ambience" : "song";
  }

  private filterLibrary(
    library: MediaItem[],
    options?: {
      query?: string;
      kind?: MediaKind | "all";
      tags?: string[];
      limit?: number;
    },
  ) {
    const requestedTags = (options?.tags ?? []).map(normalizeToken);
    const query = options?.query?.trim().toLowerCase();
    return library
      .filter((item) => !options?.kind || options.kind === "all" || item.kind === options.kind)
      .filter((item) => requestedTags.every((tag) => item.tags.includes(tag)))
      .map((item) => ({
        item,
        score: query ? this.scoreMediaItem(item, query) : 0,
      }))
      .filter((entry) => !query || entry.score > 0)
      .sort((left, right) =>
        right.score - left.score
        || left.item.title.localeCompare(right.item.title)
      )
      .map((entry) => entry.item);
  }

  private scoreMediaItem(item: MediaItem, query: string) {
    const normalizedQuery = normalizeToken(query);
    const queryTokens = normalizedQuery.split(/\s+/g).filter(Boolean);
    let score = 0;

    if (item.id === normalizedQuery) {
      score += 400;
    }
    if (item.title.toLowerCase() === normalizedQuery) {
      score += 320;
    }
    if (item.path.toLowerCase() === normalizedQuery) {
      score += 300;
    }
    if (item.tags.includes(normalizedQuery)) {
      score += 280;
    }
    if (item.title.toLowerCase().includes(normalizedQuery)) {
      score += 160;
    }
    if (item.relativePath.toLowerCase().includes(normalizedQuery)) {
      score += 140;
    }
    for (const token of queryTokens) {
      if (item.tags.includes(token)) {
        score += 60;
      }
      if (item.title.toLowerCase().includes(token)) {
        score += 35;
      }
      if (item.relativePath.toLowerCase().includes(token)) {
        score += 25;
      }
    }
    if (item.kind === "ambience" && queryTokens.some((token) => token === "ambient" || token === "ambience")) {
      score += 40;
    }
    if (item.kind === "song" && queryTokens.some((token) => token === "song" || token === "music")) {
      score += 40;
    }
    return score;
  }

  private resolveMediaItem(query: string, kind?: MediaKind) {
    const directPath = query.startsWith("/") ? path.resolve(query) : "";
    if (directPath && existsSync(directPath) && SUPPORTED_MEDIA_EXTENSIONS.has(path.extname(directPath).toLowerCase())) {
      return this.buildSyntheticMediaItem(directPath, path.dirname(directPath));
    }

    const matches = this.filterLibrary(this.getLibrary(), {
      query,
      kind: kind ?? "all",
      limit: 10,
    });
    if (matches.length === 0) {
      throw new Error(`No media matched "${query}".`);
    }
    const item = matches[0];
    if (!item) {
      throw new Error(`No media matched "${query}".`);
    }
    return item;
  }

  private resolveMediaForPath(mediaPath?: string) {
    const normalizedPath = mediaPath?.trim();
    if (!normalizedPath) {
      return null;
    }
    return this.getLibrary().find((item) => item.path === path.resolve(normalizedPath))
      ?? this.buildSyntheticMediaItem(path.resolve(normalizedPath), path.dirname(path.resolve(normalizedPath)));
  }

  private normalizeTransport(value?: string): SpeakerTransport {
    switch (normalizeToken(value ?? "")) {
      case "aux":
        return "aux";
      case "bluetooth":
        return "bluetooth";
      case "built-in":
      case "builtin":
      case "internal":
        return "built-in";
      default:
        return value ? "unknown" : "system";
    }
  }

  private getConfiguredSpeakers() {
    const json = readJsonFile<{ speakers?: SpeakerConfigRecord[] }>(this.speakerConfigPath);
    return json?.speakers ?? [];
  }

  private async getAvailableOutputDeviceNames() {
    try {
      const result = await this.runCommandImpl({
        file: this.switchAudioSourceBin,
        args: ["-a", "-t", "output"],
      });
      return new Set(
        result.stdout
          .split(/\r?\n/g)
          .map((line) => line.trim())
          .filter(Boolean),
      );
    } catch {
      return new Set<string>();
    }
  }

  private async getCurrentOutputDeviceName() {
    try {
      const result = await this.runCommandImpl({
        file: this.switchAudioSourceBin,
        args: ["-c", "-t", "output"],
      });
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async resolveSpeaker(query: string | undefined, requireAvailable = false) {
    const speakers = await this.listSpeakers();
    if (!query?.trim()) {
      const current = speakers.find((speaker) => speaker.isCurrentOutput);
      if (current && (!requireAvailable || current.available)) {
        return current;
      }
      const fallback = speakers.find((speaker) => !requireAvailable || speaker.available);
      if (fallback) {
        return fallback;
      }
      throw new Error("No speaker is available.");
    }

    const normalizedQuery = query.trim().toLowerCase();
    const exact = speakers.find((speaker) =>
      speaker.id === normalizedQuery
      || speaker.name.toLowerCase() === normalizedQuery
      || speaker.deviceName.toLowerCase() === normalizedQuery
      || speaker.aliases.includes(normalizedQuery)
    );
    const partial = exact ?? speakers.find((speaker) =>
      speaker.name.toLowerCase().includes(normalizedQuery)
      || speaker.deviceName.toLowerCase().includes(normalizedQuery)
      || speaker.aliases.some((alias) => alias.includes(normalizedQuery))
    );
    if (!partial) {
      throw new Error(`Speaker not found: ${query}`);
    }
    if (requireAvailable && !partial.available) {
      throw new Error(`Speaker is configured but not currently available: ${partial.name}`);
    }
    return partial;
  }

  private async resolveTargetSpeakerForControl(speakerQuery?: string) {
    if (speakerQuery?.trim()) {
      return this.resolveSpeaker(speakerQuery, false);
    }
    const active = await this.getActiveStatuses();
    if (active.length === 1) {
      return active[0]!.speaker;
    }
    if (active.length > 1) {
      throw new Error("Multiple speakers are active. Specify which speaker to control.");
    }
    throw new Error("No active media player found.");
  }

  private async resolveStatusSpeaker(speakerQuery?: string) {
    if (speakerQuery?.trim()) {
      return this.resolveSpeaker(speakerQuery, false);
    }
    const active = await this.getActiveStatuses();
    if (active.length === 1) {
      return active[0]!.speaker;
    }
    return this.resolveSpeaker(undefined, false);
  }

  private async getActiveStatuses() {
    const statuses: MediaStatus[] = [];
    for (const entry of readdirSync(this.metadataRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const speakerId = entry.name.replace(/\.json$/, "");
      const status = await this.getStatus(speakerId);
      if (status.state !== "stopped") {
        statuses.push(status);
      }
    }
    return statuses;
  }

  private async ensureSystemVolumeMax() {
    try {
      await this.runCommandImpl({
        file: this.osascriptBin,
        args: ["-e", "set volume output volume 100"],
        allowFailure: true,
      });
    } catch {
      // Best effort only.
    }
  }

  private async ensureSpeakerReady(speaker: MediaSpeaker) {
    if (speaker.transport === "bluetooth" && speaker.btAddress) {
      await this.runCommandImpl({
        file: this.blueutilBin,
        args: ["--connect", speaker.btAddress],
        allowFailure: true,
      });
    }
    if (speaker.deviceName) {
      await this.runCommandImpl({
        file: this.switchAudioSourceBin,
        args: ["-s", speaker.deviceName, "-t", "output"],
        allowFailure: true,
      });
    }
  }

  private async stopAllPlayers(options?: { exceptSpeakerId?: string }) {
    for (const entry of readdirSync(this.metadataRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const speakerId = entry.name.replace(/\.json$/, "");
      if (speakerId === options?.exceptSpeakerId) {
        continue;
      }
      await this.stopSpeaker(speakerId);
    }
  }

  private async stopSpeaker(speakerId: string) {
    this.stopEofWatcher(speakerId);
    const metadata = this.readPlayerMetadata(speakerId);
    const socketPath = this.getSocketPath(speakerId);
    if (existsSync(socketPath)) {
      await this.sendPlayerCommand(speakerId, {
        command: ["quit"],
      });
      if (metadata?.pid) {
        await this.waitForProcessExit(metadata.pid, this.playerStopTimeoutMs);
      }
    }
    await this.forceStopProcess(metadata?.pid);
    rmSync(socketPath, { force: true });
    this.deletePlayerMetadata(speakerId);
  }

  private getSocketPath(speakerId: string) {
    return path.join(this.socketsRoot, `mpv-${speakerId}.sock`);
  }

  private getMetadataPath(speakerId: string) {
    return path.join(this.metadataRoot, `${speakerId}.json`);
  }

  private readPlayerMetadata(speakerId: string) {
    return readJsonFile<MediaPlayerMetadata>(this.getMetadataPath(speakerId));
  }

  private writePlayerMetadata(metadata: MediaPlayerMetadata) {
    writeFileSync(this.getMetadataPath(metadata.speakerId), `${JSON.stringify(metadata, null, 2)}\n`);
  }

  private deletePlayerMetadata(speakerId: string) {
    rmSync(this.getMetadataPath(speakerId), { force: true });
  }

  private async sendPlayerCommand(speakerId: string, payload: Record<string, unknown>) {
    const socketPath = this.getSocketPath(speakerId);
    if (!existsSync(socketPath)) {
      throw new Error(`No active player socket for ${speakerId}.`);
    }
    await this.runCommandImpl({
      file: this.ncBin,
      args: ["-w", "1", "-U", socketPath],
      input: `${JSON.stringify(payload)}\n`,
      allowFailure: true,
      timeoutMs: 2_000,
    });
  }

  private async queryPlayerProperty(socketPath: string, property: string) {
    const result = await this.runCommandImpl({
      file: this.ncBin,
      args: ["-w", "1", "-U", socketPath],
      input: `${JSON.stringify({ command: ["get_property", property] })}\n`,
      allowFailure: true,
      timeoutMs: 2_000,
    });
    if (!result.stdout.trim()) {
      return null;
    }
    try {
      const parsed = JSON.parse(result.stdout);
      return parsed.data ?? null;
    } catch {
      return null;
    }
  }

  private async waitForPlayerSocket(socketPath: string, pid: number, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (existsSync(socketPath) && await this.isPlayerSocketResponsive(socketPath, pid)) {
        return true;
      }
      if (!this.processIsAliveImpl(pid)) {
        return false;
      }
      await sleep(PLAYER_WAIT_POLL_MS);
    }
    return existsSync(socketPath) && await this.isPlayerSocketResponsive(socketPath, pid);
  }

  private async isPlayerSocketResponsive(socketPath: string, expectedPid: number) {
    const pid = await this.queryPlayerProperty(socketPath, "pid");
    if (typeof pid !== "number") {
      return false;
    }
    return expectedPid <= 0 || pid === expectedPid;
  }

  private async waitForProcessExit(pid: number, timeoutMs: number) {
    if (!pid || timeoutMs <= 0) {
      return !pid || !this.processIsAliveImpl(pid);
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (!this.processIsAliveImpl(pid)) {
        return true;
      }
      await sleep(PLAYER_WAIT_POLL_MS);
    }
    return !this.processIsAliveImpl(pid);
  }

  private async forceStopProcess(pid?: number) {
    if (!pid || !this.processIsAliveImpl(pid)) {
      return;
    }
    this.signalProcessImpl(pid, "SIGTERM");
    const exitedAfterTerm = await this.waitForProcessExit(pid, this.playerStopTimeoutMs);
    if (exitedAfterTerm || !this.processIsAliveImpl(pid)) {
      return;
    }
    this.signalProcessImpl(pid, "SIGKILL");
    await this.waitForProcessExit(pid, this.playerStopTimeoutMs);
  }

  private async cleanupBrokenPlayer(metadata: MediaPlayerMetadata | null) {
    if (!metadata?.pid || !this.processIsAliveImpl(metadata.pid)) {
      return;
    }
    await this.forceStopProcess(metadata.pid);
  }
}
