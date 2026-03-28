import { normalizeString } from "../utils/text-utils";
import { ProfileFileStateService } from "./file-state-service";
import { resolveRuntimePath } from "./runtime-root";

type AutonomousTimeProfileState = {
  lastTriggeredLocalDate?: string;
};

function getStatePath() {
  return resolveRuntimePath("autonomous-time-state.json");
}

function normalizeProfileState(raw: unknown): AutonomousTimeProfileState {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const candidate = raw as Record<string, unknown>;
  return {
    lastTriggeredLocalDate: normalizeString(candidate.lastTriggeredLocalDate) ?? undefined,
  };
}

export class AutonomousTimeStateService extends ProfileFileStateService<AutonomousTimeProfileState> {
  constructor(filePath = getStatePath()) {
    super(filePath, "Autonomous-time state", normalizeProfileState);
  }
}

export type { AutonomousTimeProfileState };
