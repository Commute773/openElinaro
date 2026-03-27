import { resolveRuntimePath } from "./runtime-root";
import { JsonStateService } from "./json-state-service";

export interface DocsIndexState {
  lastCompletedAt?: string;
  lastFailedAt?: string;
  consecutiveFailures?: number;
  nextAttemptAt?: string;
}

function getDocsIndexStateFilePath() {
  return resolveRuntimePath("docs-index-state.json");
}

function normalizeDocsIndexState(raw: unknown): DocsIndexState {
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

export class DocsIndexStateService extends JsonStateService<DocsIndexState> {
  constructor(filePath = getDocsIndexStateFilePath()) {
    super(filePath);
  }

  protected normalize(raw: unknown): DocsIndexState {
    return normalizeDocsIndexState(raw);
  }
}

export { getDocsIndexStateFilePath as DOCS_INDEX_STATE_FILE_PATH };
