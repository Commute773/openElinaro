// TODO: Migrate from node:fs to Bun.file() per CLAUDE.md conventions.
// Kept as node:fs for now because RoutinesStore.load()/save() are called synchronously
// from 40+ methods in RoutinesService and cascading callers across 20+ files.
// Converting to async Bun.file() requires making every caller async first.
import fs from "node:fs";
import path from "node:path";
import type { RoutineItem, RoutineStoreData } from "../../domain/routines";
import { getLocalTimezone } from "../local-time-service";
import { ProfileService } from "../profiles";
import { resolveRuntimePath } from "../runtime-root";
import { DEFAULT_PROFILE_ID as DEFAULT_ROUTINE_PROFILE_ID } from "../../config/service-constants";
import { writeJsonFileSecurely } from "../../utils/file-utils";

type LegacyRoutineItem = RoutineItem & {
  notes?: string;
  state?: RoutineItem["state"] & { streak?: number };
};

function getStorePath() {
  return resolveRuntimePath("routines.json");
}

function ensureStoreDir() {
  fs.mkdirSync(path.dirname(getStorePath()), { recursive: true });
}

function createEmptyStore(): RoutineStoreData {
  const timezone = getLocalTimezone();
  return {
    settings: {
      timezone,
      workBlock: {
        days: ["mon", "tue", "wed", "thu", "fri"],
        start: "09:00",
        end: "17:00",
      },
      sleepBlock: {
        days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        start: "00:00",
        end: "08:30",
      },
      quietHours: {
        enabled: true,
        timezone,
        start: "00:01",
        end: "09:00",
      },
    },
    calendarEvents: [],
    items: {},
  };
}

function normalizeItem(item: LegacyRoutineItem): RoutineItem {
  const status = item.status ?? "active";
  const profileId = normalizeProfileId(item);
  return {
    ...item,
    description: item.description ?? item.notes,
    profileId,
    enabled: item.enabled ?? (status !== "paused" && status !== "archived" && status !== "completed"),
    status,
    state: {
      completionHistory: item.state?.completionHistory ?? [],
      skippedOccurrenceKeys: item.state?.skippedOccurrenceKeys ?? [],
      reminderCountForOccurrence: item.state?.reminderCountForOccurrence ?? 0,
      lastCompletedAt: item.state?.lastCompletedAt,
      lastSkippedAt: item.state?.lastSkippedAt,
      snoozedUntil: item.state?.snoozedUntil,
      lastRemindedAt: item.state?.lastRemindedAt,
      activeOccurrenceKey: item.state?.activeOccurrenceKey,
    },
  };
}

function listKnownProfileIds() {
  try {
    return new Set(new ProfileService().loadRegistry().profiles.map((profile) => profile.id));
  } catch {
    return new Set([DEFAULT_ROUTINE_PROFILE_ID]);
  }
}

function normalizeProfileId(item: Pick<RoutineItem, "profileId" | "jobId">) {
  const knownProfileIds = listKnownProfileIds();
  const explicitProfileId = item.profileId?.trim();
  if (explicitProfileId && knownProfileIds.has(explicitProfileId)) {
    return explicitProfileId;
  }

  const jobScopedProfileId = item.jobId?.trim();
  if (jobScopedProfileId && knownProfileIds.has(jobScopedProfileId)) {
    return jobScopedProfileId;
  }

  return DEFAULT_ROUTINE_PROFILE_ID;
}

export class RoutinesStore {
  load(): RoutineStoreData {
    ensureStoreDir();
    const storePath = getStorePath();
    if (!fs.existsSync(storePath)) {
      return createEmptyStore();
    }

    const raw = JSON.parse(fs.readFileSync(storePath, "utf8")) as RoutineStoreData;
    return {
      settings: {
        timezone: raw.settings?.timezone || getLocalTimezone(),
        notificationTargetUserId: raw.settings?.notificationTargetUserId,
        dayResetHour: raw.settings?.dayResetHour,
        workBlock:
          raw.settings?.workBlock ?? createEmptyStore().settings.workBlock,
        sleepBlock:
          raw.settings?.sleepBlock ?? createEmptyStore().settings.sleepBlock,
        quietHours:
          raw.settings?.quietHours ?? createEmptyStore().settings.quietHours,
      },
      calendarEvents: raw.calendarEvents ?? [],
      items: Object.fromEntries(
        Object.entries(raw.items ?? {}).map(([id, item]) => [id, normalizeItem(item)]),
      ),
    };
  }

  save(data: RoutineStoreData): RoutineStoreData {
    writeJsonFileSecurely(getStorePath(), data);
    return data;
  }
}
