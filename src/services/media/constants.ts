/**
 * Constants and defaults for the media subsystem.
 */
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { getRuntimeRootDir, getServiceRootDir, resolveRuntimePath } from "../runtime-root";

export const SUPPORTED_MEDIA_EXTENSIONS = new Set([
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".ogg",
  ".wav",
  ".webm",
]);

export const AMBIENCE_HINTS = new Set([
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

export function getDefaultMediaRoots() {
  return [resolveRuntimePath("media")];
}

export function getDefaultCatalogPath() {
  return resolveRuntimePath("media", "catalog.json");
}

export const DEFAULT_SPEAKER_CONFIG_PATH = resolveRuntimePath("media", "speakers.json");
export const DEFAULT_STATE_ROOT = resolveRuntimePath("media");
export const DEFAULT_SOCKET_ROOT = path.join(
  os.tmpdir(),
  "oe-media",
  crypto.createHash("sha1")
    .update(process.env.OPENELINARO_SERVICE_ROOT_DIR?.trim() ? getServiceRootDir() : getRuntimeRootDir())
    .digest("hex")
    .slice(0, 8),
);
export const DEFAULT_SWITCH_AUDIO_SOURCE_BIN = "/opt/homebrew/bin/SwitchAudioSource";
export const DEFAULT_BLUEUTIL_BIN = "/opt/homebrew/bin/blueutil";
export const DEFAULT_MPV_BIN = "/opt/homebrew/bin/mpv";
export const DEFAULT_NC_BIN = "/usr/bin/nc";
export const DEFAULT_OSASCRIPT_BIN = "/usr/bin/osascript";
export const DEFAULT_PLAYER_READY_TIMEOUT_MS = 5_000;
export const DEFAULT_PLAYER_STOP_TIMEOUT_MS = 3_000;
export const PLAYER_WAIT_POLL_MS = 50;
export const EOF_POLL_INTERVAL_MS = 3_000;
