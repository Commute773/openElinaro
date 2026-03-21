import fs from "node:fs";
import path from "node:path";
import { assertTestRuntimeRootIsIsolated, resolveRuntimePath } from "./runtime-root";

export interface CalendarSyncState {
  lastAttemptAt?: string;
  lastCompletedAt?: string;
  lastFailureAt?: string;
  nextAttemptAt?: string;
  consecutiveFailures?: number;
  etag?: string;
  lastModified?: string;
}

function getCalendarSyncStateFilePath() {
  return resolveRuntimePath("calendar-sync-state.json");
}

function normalizeCalendarSyncState(raw: unknown): CalendarSyncState {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const candidate = raw as Record<string, unknown>;
  const readString = (key: string) =>
    typeof candidate[key] === "string" && candidate[key]!.trim().length > 0
      ? candidate[key] as string
      : undefined;

  return {
    lastAttemptAt: readString("lastAttemptAt"),
    lastCompletedAt: readString("lastCompletedAt"),
    lastFailureAt: readString("lastFailureAt"),
    nextAttemptAt: readString("nextAttemptAt"),
    consecutiveFailures:
      typeof candidate.consecutiveFailures === "number" && Number.isFinite(candidate.consecutiveFailures)
        ? Math.max(0, Math.floor(candidate.consecutiveFailures))
        : undefined,
    etag: readString("etag"),
    lastModified: readString("lastModified"),
  };
}

export class CalendarSyncStateService {
  constructor(private readonly filePath = getCalendarSyncStateFilePath()) {}

  load(): CalendarSyncState {
    if (!fs.existsSync(this.filePath)) {
      return {};
    }

    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      return normalizeCalendarSyncState(raw);
    } catch {
      return {};
    }
  }

  save(state: CalendarSyncState): CalendarSyncState {
    assertTestRuntimeRootIsIsolated("Calendar sync state");
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const normalized = normalizeCalendarSyncState(state);
    fs.writeFileSync(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    return normalized;
  }
}

export { getCalendarSyncStateFilePath as CALENDAR_SYNC_STATE_FILE_PATH };
