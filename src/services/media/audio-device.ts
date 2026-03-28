/**
 * Audio device/output switching: SwitchAudioSource, blueutil, osascript volume control.
 */
import type { MediaSpeaker, RunCommand } from "./types";

export async function ensureSystemVolumeMax(
  runCommand: RunCommand,
  osascriptBin: string,
) {
  try {
    await runCommand({
      file: osascriptBin,
      args: ["-e", "set volume output volume 100"],
      allowFailure: true,
    });
  } catch {
    // Best effort only.
  }
}

export async function ensureSpeakerReady(
  speaker: MediaSpeaker,
  runCommand: RunCommand,
  blueutilBin: string,
  switchAudioSourceBin: string,
) {
  if (speaker.transport === "bluetooth" && speaker.btAddress) {
    await runCommand({
      file: blueutilBin,
      args: ["--connect", speaker.btAddress],
      allowFailure: true,
    });
  }
  if (speaker.deviceName) {
    await runCommand({
      file: switchAudioSourceBin,
      args: ["-s", speaker.deviceName, "-t", "output"],
      allowFailure: true,
    });
  }
}
