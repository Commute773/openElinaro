import fs from "node:fs";
import { parse, stringify } from "yaml";
import { telemetry } from "../services/telemetry";

export const CURRENT_CONFIG_VERSION = 2;

type RawConfig = Record<string, unknown>;
type Migration = (config: RawConfig) => RawConfig;

function getConfigVersion(config: RawConfig): number {
  const version = config.configVersion;
  return typeof version === "number" && Number.isFinite(version) ? version : 0;
}

/**
 * Migration 1 (v0 → v1): Replace core.app.workflow with core.app.subagent.
 *
 * Old fields dropped: stuckAfterMs, maxConsecutiveTaskErrors, resumeRetryDelayMs.
 * Old field renamed: hardTimeoutGraceMs → timeoutGraceMs.
 * New fields added with defaults: tmuxSession, defaultTimeoutMs, sidecarSocketPath.
 */
function migrationV1(config: RawConfig): RawConfig {
  const core = config.core as RawConfig | undefined;
  if (!core) return { ...config, configVersion: 1 };

  const app = core.app as RawConfig | undefined;
  if (!app) return { ...config, configVersion: 1 };

  const workflow = app.workflow as RawConfig | undefined;
  const subagent: RawConfig = {
    tmuxSession: "openelinaro",
    defaultTimeoutMs: 3_600_000,
    timeoutGraceMs: 30_000,
    sidecarSocketPath: "",
  };

  if (workflow) {
    if (typeof workflow.hardTimeoutGraceMs === "number") {
      subagent.timeoutGraceMs = workflow.hardTimeoutGraceMs;
    }
  }

  const { workflow: _dropped, ...restApp } = app;
  return {
    ...config,
    configVersion: 1,
    core: {
      ...core,
      app: {
        ...restApp,
        subagent,
      },
    },
  };
}

/**
 * Migration 2 (v1 → v2): Bump version for new models.extendedContext config section.
 *
 * The new `models` section is populated by Zod defaults during validation,
 * so this migration only needs to bump the version number.
 */
function migrationV2(config: RawConfig): RawConfig {
  return { ...config, configVersion: 2 };
}

const MIGRATIONS: Migration[] = [
  migrationV1,
  migrationV2,
];

/**
 * Run all pending config migrations on a raw (pre-validation) config object.
 * Returns the migrated config and whether any migrations were applied.
 */
export function runConfigMigrations(config: RawConfig): { config: RawConfig; migrated: boolean } {
  let current = config;
  let version = getConfigVersion(current);
  const startVersion = version;

  while (version < CURRENT_CONFIG_VERSION) {
    const migration = MIGRATIONS[version];
    if (!migration) {
      throw new Error(`Missing config migration for version ${version} → ${version + 1}`);
    }
    current = migration(current);
    version = getConfigVersion(current);
  }

  const migrated = version > startVersion;
  if (migrated) {
    telemetry.event("config.migrated", {
      fromVersion: startVersion,
      toVersion: version,
    });
  }

  return { config: current, migrated };
}

/**
 * Run migrations on a config file in place. Reads the file, migrates, and
 * writes back if any migrations were applied.
 */
export function migrateConfigFile(configPath: string): boolean {
  if (!fs.existsSync(configPath)) {
    return false;
  }

  const text = fs.readFileSync(configPath, "utf8");
  const raw = text.trim() ? (parse(text) as RawConfig) : {};
  const { config: migrated, migrated: didMigrate } = runConfigMigrations(raw);

  if (didMigrate) {
    fs.writeFileSync(configPath, stringify(migrated), { mode: 0o600 });
  }

  return didMigrate;
}
