/**
 * Speaker configuration loading, discovery, and resolution.
 */
import { attemptOrAsync } from "../../utils/result";
import type { MediaSpeaker, MediaStatus, RunCommand, SpeakerConfigRecord } from "./types";
import { normalizeTransport, readJsonFile, slugify, uniqueStrings } from "./utils";

export function getConfiguredSpeakers(speakerConfigPath: string): SpeakerConfigRecord[] {
  const json = readJsonFile<{ speakers?: SpeakerConfigRecord[] }>(speakerConfigPath);
  return json?.speakers ?? [];
}

export async function listSpeakers(
  speakerConfigPath: string,
  runCommand: RunCommand,
  switchAudioSourceBin: string,
): Promise<MediaSpeaker[]> {
  const availableOutputs = await getAvailableOutputDeviceNames(runCommand, switchAudioSourceBin);
  const currentOutput = await getCurrentOutputDeviceName(runCommand, switchAudioSourceBin);
  const configured = getConfiguredSpeakers(speakerConfigPath);
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
      transport: normalizeTransport(record.transport),
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

export async function getAvailableOutputDeviceNames(
  runCommand: RunCommand,
  switchAudioSourceBin: string,
): Promise<Set<string>> {
  return attemptOrAsync(async () => {
    const result = await runCommand({
      file: switchAudioSourceBin,
      args: ["-a", "-t", "output"],
    });
    return new Set(
      result.stdout
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter(Boolean),
    );
  }, new Set<string>());
}

export async function getCurrentOutputDeviceName(
  runCommand: RunCommand,
  switchAudioSourceBin: string,
): Promise<string | null> {
  return attemptOrAsync(async () => {
    const result = await runCommand({
      file: switchAudioSourceBin,
      args: ["-c", "-t", "output"],
    });
    return result.stdout.trim() || null;
  }, null);
}

export async function resolveSpeaker(
  query: string | undefined,
  requireAvailable: boolean,
  speakerConfigPath: string,
  runCommand: RunCommand,
  switchAudioSourceBin: string,
): Promise<MediaSpeaker> {
  const speakers = await listSpeakers(speakerConfigPath, runCommand, switchAudioSourceBin);
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

export async function resolveTargetSpeakerForControl(
  speakerQuery: string | undefined,
  getActiveStatuses: () => Promise<MediaStatus[]>,
  speakerConfigPath: string,
  runCommand: RunCommand,
  switchAudioSourceBin: string,
): Promise<MediaSpeaker> {
  if (speakerQuery?.trim()) {
    return resolveSpeaker(speakerQuery, false, speakerConfigPath, runCommand, switchAudioSourceBin);
  }
  const active = await getActiveStatuses();
  if (active.length === 1) {
    return active[0]!.speaker;
  }
  if (active.length > 1) {
    throw new Error("Multiple speakers are active. Specify which speaker to control.");
  }
  throw new Error("No active media player found.");
}

export async function resolveStatusSpeaker(
  speakerQuery: string | undefined,
  getActiveStatuses: () => Promise<MediaStatus[]>,
  speakerConfigPath: string,
  runCommand: RunCommand,
  switchAudioSourceBin: string,
): Promise<MediaSpeaker> {
  if (speakerQuery?.trim()) {
    return resolveSpeaker(speakerQuery, false, speakerConfigPath, runCommand, switchAudioSourceBin);
  }
  const active = await getActiveStatuses();
  if (active.length === 1) {
    return active[0]!.speaker;
  }
  return resolveSpeaker(undefined, false, speakerConfigPath, runCommand, switchAudioSourceBin);
}
