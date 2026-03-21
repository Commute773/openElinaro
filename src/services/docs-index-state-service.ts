import fs from "node:fs";
import path from "node:path";
import { assertTestRuntimeRootIsIsolated, resolveRuntimePath } from "./runtime-root";

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

export class DocsIndexStateService {
  constructor(private readonly filePath = getDocsIndexStateFilePath()) {}

  load(): DocsIndexState {
    if (!fs.existsSync(this.filePath)) {
      return {};
    }

    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      return normalizeDocsIndexState(raw);
    } catch {
      return {};
    }
  }

  save(state: DocsIndexState): DocsIndexState {
    assertTestRuntimeRootIsIsolated("Docs index state");
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const normalized = normalizeDocsIndexState(state);
    fs.writeFileSync(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    return normalized;
  }
}

export { getDocsIndexStateFilePath as DOCS_INDEX_STATE_FILE_PATH };
