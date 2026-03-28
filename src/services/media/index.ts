/**
 * Media subsystem barrel export.
 * Re-exports all public types and the sub-modules for use by the MediaService facade.
 */
export type {
  CommandResult,
  MediaCatalogFile,
  MediaCatalogTrack,
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
  SpeakerConfigRecord,
  SpeakerTransport,
} from "./types";

export * as constants from "./constants";
export * as utils from "./utils";
export * as catalog from "./catalog";
export * as speakerConfig from "./speaker-config";
export * as audioDevice from "./audio-device";
export * as player from "./player";
