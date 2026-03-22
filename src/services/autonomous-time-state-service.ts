import fs from "node:fs";
import path from "node:path";
import type { ProfileRecord } from "../domain/profiles";
import { assertTestRuntimeRootIsIsolated, resolveRuntimePath } from "./runtime-root";

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

export class AutonomousTimeStateService {
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

  save(state: AutonomousTimeStateShape) {
    assertTestRuntimeRootIsIsolated("Autonomous-time state");
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
