import type { ProfileRecord } from "../domain/profiles";
import { resolveRuntimePath } from "./runtime-root";
import { JsonStateService } from "./json-state-service";

type ReflectionProfileState = {
  lastDailyLocalDate?: string;
  lastSoulRewriteLocalDate?: string;
};

type ReflectionStateShape = {
  version: number;
  profiles: Record<string, ReflectionProfileState>;
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
    lastDailyLocalDate:
      typeof candidate.lastDailyLocalDate === "string" && candidate.lastDailyLocalDate.trim().length > 0
        ? candidate.lastDailyLocalDate
        : undefined,
    lastSoulRewriteLocalDate:
      typeof candidate.lastSoulRewriteLocalDate === "string" && candidate.lastSoulRewriteLocalDate.trim().length > 0
        ? candidate.lastSoulRewriteLocalDate
        : undefined,
  };
}

function normalizeState(raw: unknown): ReflectionStateShape {
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

export class ReflectionStateService extends JsonStateService<ReflectionStateShape> {
  constructor(filePath = getStatePath()) {
    super(filePath);
  }

  protected normalize(raw: unknown): ReflectionStateShape {
    return normalizeState(raw);
  }

  getProfileState(profile: Pick<ProfileRecord, "id"> | string) {
    const profileId = typeof profile === "string" ? profile : profile.id;
    return this.load().profiles[profileId] ?? {};
  }

  updateProfileState(
    profile: Pick<ProfileRecord, "id"> | string,
    updater: (state: ReflectionProfileState) => ReflectionProfileState,
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

export type { ReflectionProfileState };
