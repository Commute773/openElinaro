import { normalizeString } from "../utils/text-utils";
import { FileStateService } from "./file-state-service";
import { resolveRuntimePath } from "./runtime-root";

export interface HeartbeatState {
  lastCompletedAt?: string;
  lastFailedAt?: string;
  consecutiveFailures?: number;
  nextAttemptAt?: string;
}

function getHeartbeatStateFilePath() {
  return resolveRuntimePath("heartbeat-state.json");
}

function normalizeHeartbeatState(raw: unknown): HeartbeatState {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const candidate = raw as Record<string, unknown>;
  return {
    lastCompletedAt: normalizeString(candidate.lastCompletedAt) ?? undefined,
    lastFailedAt: normalizeString(candidate.lastFailedAt) ?? undefined,
    consecutiveFailures:
      typeof candidate.consecutiveFailures === "number" && Number.isFinite(candidate.consecutiveFailures)
        ? Math.max(0, Math.floor(candidate.consecutiveFailures))
        : undefined,
    nextAttemptAt: normalizeString(candidate.nextAttemptAt) ?? undefined,
  };
}

export class HeartbeatStateService extends FileStateService<HeartbeatState> {
  constructor(filePath = getHeartbeatStateFilePath()) {
    super(filePath, "Heartbeat state", normalizeHeartbeatState, () => ({}));
  }
}

export { getHeartbeatStateFilePath as HEARTBEAT_STATE_FILE_PATH };
