import { resolveRuntimePath } from "./runtime-root";
import { JsonStateService } from "./json-state-service";

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

export class CalendarSyncStateService extends JsonStateService<CalendarSyncState> {
  constructor(filePath = getCalendarSyncStateFilePath()) {
    super(filePath);
  }

  protected normalize(raw: unknown): CalendarSyncState {
    return normalizeCalendarSyncState(raw);
  }
}

export { getCalendarSyncStateFilePath as CALENDAR_SYNC_STATE_FILE_PATH };
