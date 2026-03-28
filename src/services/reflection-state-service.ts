import { normalizeString } from "../utils/text-utils";
import { ProfileFileStateService } from "./file-state-service";
import { resolveRuntimePath } from "./runtime-root";

type ReflectionProfileState = {
  lastDailyLocalDate?: string;
  lastSoulRewriteLocalDate?: string;
};

function getStatePath() {
  return resolveRuntimePath("reflection-state.json");
}

function normalizeProfileState(raw: unknown): ReflectionProfileState {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const candidate = raw as Record<string, unknown>;
  return {
    lastDailyLocalDate: normalizeString(candidate.lastDailyLocalDate) ?? undefined,
    lastSoulRewriteLocalDate: normalizeString(candidate.lastSoulRewriteLocalDate) ?? undefined,
  };
}

export class ReflectionStateService extends ProfileFileStateService<ReflectionProfileState> {
  constructor(filePath = getStatePath()) {
    super(filePath, "Reflection state", normalizeProfileState);
  }
}

export type { ReflectionProfileState };
