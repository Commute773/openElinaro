import { normalizeString } from "../utils/text-utils";
import { FileStateService } from "./file-state-service";
import { resolveRuntimePath } from "./runtime-root";

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
  return {
    lastAttemptAt: normalizeString(candidate.lastAttemptAt) ?? undefined,
    lastCompletedAt: normalizeString(candidate.lastCompletedAt) ?? undefined,
    lastFailureAt: normalizeString(candidate.lastFailureAt) ?? undefined,
    nextAttemptAt: normalizeString(candidate.nextAttemptAt) ?? undefined,
    consecutiveFailures:
      typeof candidate.consecutiveFailures === "number" && Number.isFinite(candidate.consecutiveFailures)
        ? Math.max(0, Math.floor(candidate.consecutiveFailures))
        : undefined,
    etag: normalizeString(candidate.etag) ?? undefined,
    lastModified: normalizeString(candidate.lastModified) ?? undefined,
  };
}

export class CalendarSyncStateService extends FileStateService<CalendarSyncState> {
  constructor(filePath = getCalendarSyncStateFilePath()) {
    super(filePath, "Calendar sync state", normalizeCalendarSyncState, () => ({}));
  }
}

export { getCalendarSyncStateFilePath as CALENDAR_SYNC_STATE_FILE_PATH };
