import fs from "node:fs";
import type { ProfileRecord } from "../domain/profiles";
import { writeJsonFileSecurely } from "../utils/file-utils";
import { attemptOr } from "../utils/result";
import { assertTestRuntimeRootIsIsolated } from "./runtime-root";

/**
 * Generic base class for JSON file-backed state services.
 *
 * Subclasses provide a file path, a label for test isolation checks, a
 * normalizer that coerces raw JSON into the canonical shape, and a default
 * value returned when the file is missing or corrupt.
 */
export class FileStateService<T> {
  constructor(
    protected readonly filePath: string,
    private readonly label: string,
    private readonly normalize: (raw: unknown) => T,
    private readonly defaultValue: () => T,
  ) {}

  load(): T {
    if (!fs.existsSync(this.filePath)) {
      return this.defaultValue();
    }

    return attemptOr(
      () => this.normalize(JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown),
      this.defaultValue(),
    );
  }

  save(state: T): T {
    assertTestRuntimeRootIsIsolated(this.label);
    const normalized = this.normalize(state);
    writeJsonFileSecurely(this.filePath, normalized);
    return normalized;
  }
}

/**
 * Shape used by profile-scoped state files (reflection, autonomous-time).
 */
export type ProfileStateShape<P> = {
  version: number;
  profiles: Record<string, P>;
};

/**
 * Base class for profile-scoped JSON file state services.
 *
 * Adds `getProfileState()` and `updateProfileState()` on top of the
 * standard load/save provided by `FileStateService`.
 */
export class ProfileFileStateService<P> extends FileStateService<ProfileStateShape<P>> {
  constructor(
    filePath: string,
    label: string,
    private readonly normalizeProfile: (raw: unknown) => P,
  ) {
    const normalizeShape = (raw: unknown): ProfileStateShape<P> => {
      if (!raw || typeof raw !== "object") {
        return { version: 1, profiles: {} };
      }
      const candidate = raw as Record<string, unknown>;
      const profilesRaw = candidate.profiles;
      return {
        version: 1,
        profiles:
          profilesRaw && typeof profilesRaw === "object"
            ? Object.fromEntries(
                Object.entries(profilesRaw).map(([profileId, state]) => [
                  profileId,
                  normalizeProfile(state),
                ]),
              )
            : {},
      };
    };

    super(filePath, label, normalizeShape, () => ({ version: 1, profiles: {} }));
  }

  getProfileState(profile: Pick<ProfileRecord, "id"> | string): P {
    const profileId = typeof profile === "string" ? profile : profile.id;
    return this.load().profiles[profileId] ?? this.normalizeProfile(undefined);
  }

  updateProfileState(
    profile: Pick<ProfileRecord, "id"> | string,
    updater: (state: P) => P,
  ): P {
    const profileId = typeof profile === "string" ? profile : profile.id;
    const current = this.load();
    const nextProfileState = this.normalizeProfile(updater(current.profiles[profileId] ?? this.normalizeProfile(undefined)));
    return (
      this.save({
        ...current,
        profiles: {
          ...current.profiles,
          [profileId]: nextProfileState,
        },
      }).profiles[profileId] ?? this.normalizeProfile(undefined)
    );
  }
}
