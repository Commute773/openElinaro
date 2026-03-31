/**
 * mpv player management: IPC via socket, playback control, EOF monitoring, process lifecycle.
 */
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  MediaPlayerMetadata,
  MediaStatus,
  PlaybackEndCallback,
  PlaybackEndEvent,
  ProcessIsAlive,
  RunCommand,
  SignalProcess,
  SpawnDetached,
} from "./types";
import { attemptOr } from "../../utils/result";
import { readJsonFile, sleep } from "./utils";
import { PLAYER_WAIT_POLL_MS } from "./constants";

export function getSocketPath(socketsRoot: string, speakerId: string) {
  return path.join(socketsRoot, `mpv-${speakerId}.sock`);
}

export function getMetadataPath(metadataRoot: string, speakerId: string) {
  return path.join(metadataRoot, `${speakerId}.json`);
}

export function readPlayerMetadata(metadataRoot: string, speakerId: string) {
  return readJsonFile<MediaPlayerMetadata>(getMetadataPath(metadataRoot, speakerId));
}

export function writePlayerMetadata(metadataRoot: string, metadata: MediaPlayerMetadata) {
  writeFileSync(getMetadataPath(metadataRoot, metadata.speakerId), `${JSON.stringify(metadata, null, 2)}\n`);
}

export function deletePlayerMetadata(metadataRoot: string, speakerId: string) {
  rmSync(getMetadataPath(metadataRoot, speakerId), { force: true });
}

export async function sendPlayerCommand(
  speakerId: string,
  payload: Record<string, unknown>,
  socketsRoot: string,
  runCommand: RunCommand,
  ncBin: string,
) {
  const socketPath = getSocketPath(socketsRoot, speakerId);
  if (!existsSync(socketPath)) {
    throw new Error(`No active player socket for ${speakerId}.`);
  }
  await runCommand({
    file: ncBin,
    args: ["-w", "1", "-U", socketPath],
    input: `${JSON.stringify(payload)}\n`,
    allowFailure: true,
    timeoutMs: 2_000,
  });
}

export async function queryPlayerProperty(
  socketPath: string,
  property: string,
  runCommand: RunCommand,
  ncBin: string,
) {
  const result = await runCommand({
    file: ncBin,
    args: ["-w", "1", "-U", socketPath],
    input: `${JSON.stringify({ command: ["get_property", property] })}\n`,
    allowFailure: true,
    timeoutMs: 2_000,
  });
  if (!result.stdout.trim()) {
    return null;
  }
  return attemptOr(() => {
    const parsed = JSON.parse(result.stdout);
    return parsed.data ?? null;
  }, null);
}

export async function waitForPlayerSocket(
  socketPath: string,
  pid: number,
  timeoutMs: number,
  processIsAlive: ProcessIsAlive,
  runCommand: RunCommand,
  ncBin: string,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (existsSync(socketPath) && await isPlayerSocketResponsive(socketPath, pid, runCommand, ncBin)) {
      return true;
    }
    if (!processIsAlive(pid)) {
      return false;
    }
    await sleep(PLAYER_WAIT_POLL_MS);
  }
  return existsSync(socketPath) && await isPlayerSocketResponsive(socketPath, pid, runCommand, ncBin);
}

async function isPlayerSocketResponsive(
  socketPath: string,
  expectedPid: number,
  runCommand: RunCommand,
  ncBin: string,
) {
  const pid = await queryPlayerProperty(socketPath, "pid", runCommand, ncBin);
  if (typeof pid !== "number") {
    return false;
  }
  return expectedPid <= 0 || pid === expectedPid;
}

export async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  processIsAlive: ProcessIsAlive,
) {
  if (!pid || timeoutMs <= 0) {
    return !pid || !processIsAlive(pid);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!processIsAlive(pid)) {
      return true;
    }
    await sleep(PLAYER_WAIT_POLL_MS);
  }
  return !processIsAlive(pid);
}

export async function forceStopProcess(
  pid: number | undefined,
  processIsAlive: ProcessIsAlive,
  signalProcess: SignalProcess,
  playerStopTimeoutMs: number,
) {
  if (!pid || !processIsAlive(pid)) {
    return;
  }
  signalProcess(pid, "SIGTERM");
  const exitedAfterTerm = await waitForProcessExit(pid, playerStopTimeoutMs, processIsAlive);
  if (exitedAfterTerm || !processIsAlive(pid)) {
    return;
  }
  signalProcess(pid, "SIGKILL");
  await waitForProcessExit(pid, playerStopTimeoutMs, processIsAlive);
}

export async function cleanupBrokenPlayer(
  metadata: MediaPlayerMetadata | null,
  processIsAlive: ProcessIsAlive,
  signalProcess: SignalProcess,
  playerStopTimeoutMs: number,
) {
  if (!metadata?.pid || !processIsAlive(metadata.pid)) {
    return;
  }
  await forceStopProcess(metadata.pid, processIsAlive, signalProcess, playerStopTimeoutMs);
}

export async function stopSpeaker(
  speakerId: string,
  socketsRoot: string,
  metadataRoot: string,
  runCommand: RunCommand,
  ncBin: string,
  processIsAlive: ProcessIsAlive,
  signalProcess: SignalProcess,
  playerStopTimeoutMs: number,
  stopEofWatcher: (speakerId: string) => void,
) {
  stopEofWatcher(speakerId);
  const metadata = readPlayerMetadata(metadataRoot, speakerId);
  const socketPath = getSocketPath(socketsRoot, speakerId);
  if (existsSync(socketPath)) {
    await sendPlayerCommand(speakerId, { command: ["quit"] }, socketsRoot, runCommand, ncBin);
    if (metadata?.pid) {
      await waitForProcessExit(metadata.pid, playerStopTimeoutMs, processIsAlive);
    }
  }
  await forceStopProcess(metadata?.pid, processIsAlive, signalProcess, playerStopTimeoutMs);
  rmSync(socketPath, { force: true });
  deletePlayerMetadata(metadataRoot, speakerId);
}

export async function stopAllPlayers(
  metadataRoot: string,
  socketsRoot: string,
  runCommand: RunCommand,
  ncBin: string,
  processIsAlive: ProcessIsAlive,
  signalProcess: SignalProcess,
  playerStopTimeoutMs: number,
  stopEofWatcher: (speakerId: string) => void,
  exceptSpeakerId?: string,
) {
  for (const entry of readdirSync(metadataRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const speakerId = entry.name.replace(/\.json$/, "");
    if (speakerId === exceptSpeakerId) {
      continue;
    }
    await stopSpeaker(
      speakerId, socketsRoot, metadataRoot, runCommand, ncBin,
      processIsAlive, signalProcess, playerStopTimeoutMs, stopEofWatcher,
    );
  }
}

export async function getActiveStatuses(
  metadataRoot: string,
  getStatus: (speakerQuery: string) => Promise<MediaStatus>,
): Promise<MediaStatus[]> {
  const statuses: MediaStatus[] = [];
  for (const entry of readdirSync(metadataRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const speakerId = entry.name.replace(/\.json$/, "");
    const status = await getStatus(speakerId);
    if (status.state !== "stopped") {
      statuses.push(status);
    }
  }
  return statuses;
}

// ---------------------------------------------------------------------------
// EOF watcher management
// ---------------------------------------------------------------------------

export function startEofWatcher(
  speakerId: string,
  title: string,
  loop: boolean,
  eofPollIntervalMs: number,
  eofWatchers: Map<string, ReturnType<typeof setInterval>>,
  playbackEndCallbacks: PlaybackEndCallback[],
  socketsRoot: string,
  runCommand: RunCommand,
  ncBin: string,
) {
  stopEofWatcher(speakerId, eofWatchers);
  if (loop) {
    return;
  }
  const interval = setInterval(() => {
    void checkEof(speakerId, title, eofWatchers, playbackEndCallbacks, socketsRoot, runCommand, ncBin);
  }, eofPollIntervalMs);
  eofWatchers.set(speakerId, interval);
}

export function stopEofWatcher(
  speakerId: string,
  eofWatchers: Map<string, ReturnType<typeof setInterval>>,
) {
  const existing = eofWatchers.get(speakerId);
  if (existing) {
    clearInterval(existing);
    eofWatchers.delete(speakerId);
  }
}

async function checkEof(
  speakerId: string,
  title: string,
  eofWatchers: Map<string, ReturnType<typeof setInterval>>,
  playbackEndCallbacks: PlaybackEndCallback[],
  socketsRoot: string,
  runCommand: RunCommand,
  ncBin: string,
) {
  const socketPath = getSocketPath(socketsRoot, speakerId);
  if (!existsSync(socketPath)) {
    stopEofWatcher(speakerId, eofWatchers);
    emitPlaybackEnd({ speakerId, title, reason: "eof" }, playbackEndCallbacks);
    return;
  }
  const eofReached = await queryPlayerProperty(socketPath, "eof-reached", runCommand, ncBin);
  if (eofReached === true) {
    stopEofWatcher(speakerId, eofWatchers);
    emitPlaybackEnd({ speakerId, title, reason: "eof" }, playbackEndCallbacks);
  }
}

export function emitPlaybackEnd(event: PlaybackEndEvent, callbacks: PlaybackEndCallback[]) {
  for (const callback of callbacks) {
    attemptOr(() => callback(event), undefined);
  }
}
