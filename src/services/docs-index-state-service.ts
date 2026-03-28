import { normalizeString } from "../utils/text-utils";
import { FileStateService } from "./file-state-service";
import { resolveRuntimePath } from "./runtime-root";

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
    lastCompletedAt: normalizeString(candidate.lastCompletedAt) ?? undefined,
    lastFailedAt: normalizeString(candidate.lastFailedAt) ?? undefined,
    consecutiveFailures:
      typeof candidate.consecutiveFailures === "number" && Number.isFinite(candidate.consecutiveFailures)
        ? Math.max(0, Math.floor(candidate.consecutiveFailures))
        : undefined,
    nextAttemptAt: normalizeString(candidate.nextAttemptAt) ?? undefined,
  };
}

export class DocsIndexStateService extends FileStateService<DocsIndexState> {
  constructor(filePath = getDocsIndexStateFilePath()) {
    super(filePath, "Docs index state", normalizeDocsIndexState, () => ({}));
  }
}

export { getDocsIndexStateFilePath as DOCS_INDEX_STATE_FILE_PATH };
