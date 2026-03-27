import type { ProfileRecord } from "../domain/profiles";
import { resolveRuntimePath } from "./runtime-root";
import { JsonStateService } from "./json-state-service";

type AutonomousTimeProfileState = {
  lastTriggeredLocalDate?: string;
};

type AutonomousTimeStateShape = {
  version: number;
  profiles: Record<string, AutonomousTimeProfileState>;
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
    lastTriggeredLocalDate:
      typeof candidate.lastTriggeredLocalDate === "string" && candidate.lastTriggeredLocalDate.trim().length > 0
        ? candidate.lastTriggeredLocalDate
        : undefined,
  };
}

function normalizeState(raw: unknown): AutonomousTimeStateShape {
  if (!raw || typeof raw !== "object") {
    return { version: 1, profiles: {} };
  }
  const candidate = raw as Record<string, unknown>;
  const profilesRaw = candidate.profiles;
  return {
    version: 1,
    profiles: profilesRaw && typeof profilesRaw === "object"
      ? Object.fromEntries(
          Object.entries(profilesRaw).map(([profileId, state]) => [profileId, normalizeProfileState(state)]),
        )
      : {},
  };
}

export class AutonomousTimeStateService extends JsonStateService<AutonomousTimeStateShape> {
  constructor(filePath = getStatePath()) {
    super(filePath);
  }

  protected normalize(raw: unknown): AutonomousTimeStateShape {
    return normalizeState(raw);
  }

  getProfileState(profile: Pick<ProfileRecord, "id"> | string) {
    const profileId = typeof profile === "string" ? profile : profile.id;
    return this.load().profiles[profileId] ?? {};
  }

  updateProfileState(
    profile: Pick<ProfileRecord, "id"> | string,
    updater: (state: AutonomousTimeProfileState) => AutonomousTimeProfileState,
  ) {
    const profileId = typeof profile === "string" ? profile : profile.id;
    const current = this.load();
    const nextProfileState = normalizeProfileState(updater(current.profiles[profileId] ?? {}));
    return this.save({
      ...current,
      profiles: {
        ...current.profiles,
        [profileId]: nextProfileState,
      },
    }).profiles[profileId] ?? {};
  }
}

export type { AutonomousTimeProfileState };
