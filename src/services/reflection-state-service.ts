import fs from "node:fs";
import path from "node:path";
import type { ProfileRecord } from "../domain/profiles";
import { assertTestRuntimeRootIsIsolated, resolveRuntimePath } from "./runtime-root";

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

export class ReflectionStateService {
  constructor(private readonly filePath = getStatePath()) {}

  load() {
    if (!fs.existsSync(this.filePath)) {
      return normalizeState(undefined);
    }

    try {
      return normalizeState(JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown);
    } catch {
      return normalizeState(undefined);
    }
  }

  save(state: ReflectionStateShape) {
    assertTestRuntimeRootIsIsolated("Reflection state");
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const normalized = normalizeState(state);
    fs.writeFileSync(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    return normalized;
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
