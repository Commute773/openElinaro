/**
 * Shared type definitions for the media subsystem.
 */

export type MediaKind = "song" | "ambience";

export type PlaybackEndEvent = {
  speakerId: string;
  title: string;
  reason: "eof" | "stopped";
};

export type PlaybackEndCallback = (event: PlaybackEndEvent) => void;

export type SpeakerTransport = "aux" | "bluetooth" | "built-in" | "system" | "unknown";

export type SpeakerConfigRecord = {
  id?: string;
  name?: string;
  aliases?: string[];
  device_name?: string;
  bt_address?: string;
  transport?: string;
};

export type MediaCatalogTrack = {
  id?: string;
  title?: string;
  file?: string;
  tags?: string[];
  artist?: string;
  category?: string;
};

export type MediaCatalogFile = {
  tracks?: MediaCatalogTrack[];
};

export type MediaPlayerMetadata = {
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

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type RunCommand = (params: {
  file: string;
  args?: string[];
  input?: string;
  timeoutMs?: number;
  allowFailure?: boolean;
}) => Promise<CommandResult>;

export type SpawnDetached = (params: {
  file: string;
  args?: string[];
  stdoutPath: string;
  stderrPath: string;
}) => Promise<{ pid: number }>;

export type ProcessIsAlive = (pid: number) => boolean;
export type SignalProcess = (pid: number, signal: NodeJS.Signals) => void;
