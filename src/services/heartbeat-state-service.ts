import fs from "node:fs";
import path from "node:path";
import { assertTestRuntimeRootIsIsolated, resolveRuntimePath } from "./runtime-root";

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
    lastCompletedAt:
      typeof candidate.lastCompletedAt === "string" && candidate.lastCompletedAt.trim().length > 0
        ? candidate.lastCompletedAt
        : undefined,
    lastFailedAt:
      typeof candidate.lastFailedAt === "string" && candidate.lastFailedAt.trim().length > 0
        ? candidate.lastFailedAt
        : undefined,
    consecutiveFailures:
      typeof candidate.consecutiveFailures === "number" && Number.isFinite(candidate.consecutiveFailures)
        ? Math.max(0, Math.floor(candidate.consecutiveFailures))
        : undefined,
    nextAttemptAt:
      typeof candidate.nextAttemptAt === "string" && candidate.nextAttemptAt.trim().length > 0
        ? candidate.nextAttemptAt
        : undefined,
  };
}

export class HeartbeatStateService {
  constructor(private readonly filePath = getHeartbeatStateFilePath()) {}

  load(): HeartbeatState {
    if (!fs.existsSync(this.filePath)) {
      return {};
    }

    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      return normalizeHeartbeatState(raw);
    } catch {
      return {};
    }
  }

  save(state: HeartbeatState): HeartbeatState {
    assertTestRuntimeRootIsIsolated("Heartbeat state");
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const normalized = normalizeHeartbeatState(state);
    fs.writeFileSync(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    return normalized;
  }
}

export { getHeartbeatStateFilePath as HEARTBEAT_STATE_FILE_PATH };
