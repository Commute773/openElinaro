import fs from "node:fs";
import path from "node:path";
import { getServiceRootDir } from "./runtime-root";

type VersionFilePayload = {
  version: string;
  releasedAt?: string;
  previousVersion?: string | null;
  releaseId?: string;
  changelogPath?: string;
  sequence?: number;
};

type ReleaseFilePayload = {
  id: string;
  createdAt: string;
  sourceRoot: string;
  version?: string;
  releasedAt?: string;
  previousVersion?: string | null;
  changelogPath?: string;
};

export type DeploymentVersionInfo = {
  version: string;
  releasedAt: string | null;
  previousVersion: string | null;
  releaseId: string | null;
  changelogPath: string | null;
  sourceRoot: string | null;
  serviceRoot: string;
  managedService: boolean;
};

export type DeploymentChangelogEntry = {
  version: string;
  lines: string[];
};

const DEFAULT_DEPLOYMENT_VERSION = "unversioned";
const RELEASE_FILE_NAME = "release.json";
const VERSION_FILE_NAME = "VERSION.json";
const CHANGELOG_FILE_NAME = "DEPLOYMENTS.md";

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function resolveOptionalPath(serviceRoot: string, filePath?: string) {
  if (!filePath?.trim()) {
    return null;
  }
  return path.resolve(serviceRoot, filePath);
}

function parseDeploymentChangelog(markdown: string): DeploymentChangelogEntry[] {
  const lines = markdown.split(/\r?\n/g);
  const entries: DeploymentChangelogEntry[] = [];
  let current: DeploymentChangelogEntry | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      if (current) {
        entries.push(current);
      }
      current = {
        version: headingMatch[1]!.trim(),
        lines: [],
      };
      continue;
    }

    if (current) {
      current.lines.push(line);
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries;
}

function parseVersionSegments(version: string): number[] {
  const segments = version.match(/\d+/g)?.map((value) => Number.parseInt(value, 10)) ?? [];
  if (segments.length === 0) {
    throw new Error(`Version ${version} does not contain any numeric segments.`);
  }
  return segments;
}

function tryParseVersionSegments(version: string | null | undefined) {
  if (!version?.trim()) {
    return null;
  }

  try {
    return parseVersionSegments(version);
  } catch {
    return null;
  }
}

function compareVersionSegments(left: number[], right: number[]) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue > rightValue ? 1 : -1;
    }
  }
  return 0;
}

function resolveSourceRoot(info: DeploymentVersionInfo) {
  if (info.sourceRoot?.trim()) {
    return path.resolve(info.sourceRoot);
  }
  const runtimeRoot = process.env.OPENELINARO_ROOT_DIR?.trim();
  if (runtimeRoot) {
    return path.resolve(runtimeRoot);
  }
  return path.resolve(info.serviceRoot);
}

export class DeploymentVersionService {
  load(): DeploymentVersionInfo {
    const serviceRoot = getServiceRootDir();
    const release = readJsonFile<ReleaseFilePayload>(path.join(serviceRoot, RELEASE_FILE_NAME));
    const version = readJsonFile<VersionFilePayload>(path.join(serviceRoot, VERSION_FILE_NAME));

    return {
      version: release?.version ?? version?.version ?? DEFAULT_DEPLOYMENT_VERSION,
      releasedAt: release?.releasedAt ?? version?.releasedAt ?? release?.createdAt ?? null,
      previousVersion: release?.previousVersion ?? version?.previousVersion ?? null,
      releaseId: release?.id ?? version?.releaseId ?? null,
      changelogPath: resolveOptionalPath(serviceRoot, release?.changelogPath ?? version?.changelogPath),
      sourceRoot: release?.sourceRoot ?? null,
      serviceRoot,
      managedService: Boolean(process.env.OPENELINARO_SERVICE_ROOT_DIR?.trim()),
    };
  }

  formatSummary() {
    const info = this.load();
    return [
      `Version: ${info.version}`,
      `Released at: ${info.releasedAt ?? "unknown"}`,
      `Release id: ${info.releaseId ?? "unknown"}`,
      `Previous version: ${info.previousVersion ?? "none"}`,
      `Managed service: ${info.managedService ? "yes" : "no"}`,
      `Service root: ${info.serviceRoot}`,
      info.changelogPath ? `Changelog: ${info.changelogPath}` : "",
      info.sourceRoot ? `Source root: ${info.sourceRoot}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  getChangelogSinceVersion(sinceVersion: string, options?: { limit?: number }) {
    const normalizedSinceVersion = sinceVersion.trim();
    if (!normalizedSinceVersion) {
      throw new Error("sinceVersion is required.");
    }

    const info = this.load();
    if (!info.changelogPath) {
      throw new Error("No deployment changelog is available for this runtime.");
    }
    if (!fs.existsSync(info.changelogPath)) {
      throw new Error(`Deployment changelog was not found: ${info.changelogPath}`);
    }

    const entries = parseDeploymentChangelog(fs.readFileSync(info.changelogPath, "utf8"));
    const sinceSegments = parseVersionSegments(normalizedSinceVersion);
    const newerEntries = entries.filter(
      (entry) => compareVersionSegments(parseVersionSegments(entry.version), sinceSegments) > 0,
    );
    const limit = options?.limit ? Math.max(1, options.limit) : undefined;
    return limit ? newerEntries.slice(0, limit) : newerEntries;
  }

  formatChangelogSinceVersion(sinceVersion: string, options?: { limit?: number }) {
    const entries = this.getChangelogSinceVersion(sinceVersion, options);
    const info = this.load();
    if (entries.length === 0) {
      return `No deployments were recorded after ${sinceVersion}. Current version: ${info.version}.`;
    }

    return [
      `Deployments since ${sinceVersion}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}. Current version: ${info.version}.`,
      "Version format: YYYY.MM.DD[.N] where .N resets each UTC day.",
      "Release-id SHAs record the source revision before the deploy commit is written, so they do not match the later deploy commit hash.",
      ...entries.flatMap((entry) => [
        `## ${entry.version}`,
        ...entry.lines.filter((line, index, all) => {
          const previousLine = index > 0 ? all[index - 1] : undefined;
          return line.trim().length > 0 || (previousLine?.trim().length ?? 0) > 0;
        }),
      ]),
    ].join("\n");
  }

  formatPreparedUpdate() {
    const runtime = this.load();
    const sourceRoot = resolveSourceRoot(runtime);
    const sourceVersion = readJsonFile<VersionFilePayload>(path.join(sourceRoot, VERSION_FILE_NAME));
    const preparedVersion = sourceVersion?.version?.trim();
    if (!preparedVersion) {
      return [
        `Current version: ${runtime.version}.`,
        `No prepared update metadata was found in ${sourceRoot}.`,
        "Run bun run service:prepare-update first.",
      ].join("\n");
    }

    const preparedSegments = tryParseVersionSegments(preparedVersion);
    const runtimeSegments = tryParseVersionSegments(runtime.version);
    if (!preparedSegments) {
      return [
        `Current version: ${runtime.version}.`,
        `Prepared source version ${preparedVersion} has an unsupported format.`,
        `Source root: ${sourceRoot}`,
      ].join("\n");
    }

    if (runtimeSegments && compareVersionSegments(preparedSegments, runtimeSegments) <= 0) {
      return [
        `Current version: ${runtime.version}.`,
        `Prepared source version: ${preparedVersion}.`,
        "No prepared update is newer than the running service.",
      ].join("\n");
    }

    const changelogPath = resolveOptionalPath(
      sourceRoot,
      sourceVersion?.changelogPath ?? CHANGELOG_FILE_NAME,
    );
    const changelogEntries = changelogPath && fs.existsSync(changelogPath)
      ? parseDeploymentChangelog(fs.readFileSync(changelogPath, "utf8")).filter((entry) => {
        const entrySegments = tryParseVersionSegments(entry.version);
        if (!entrySegments) {
          return false;
        }
        return runtimeSegments
          ? compareVersionSegments(entrySegments, runtimeSegments) > 0
          : compareVersionSegments(entrySegments, preparedSegments) <= 0;
      })
      : [];

    return [
      `Prepared update available: ${runtime.version} -> ${preparedVersion}.`,
      `Prepared at: ${sourceVersion?.releasedAt ?? "unknown"}`,
      `Source root: ${sourceRoot}`,
      ...(
        changelogEntries.length > 0
          ? [
              `Pending deployment entries since ${runtime.version}: ${changelogEntries.length}.`,
              ...changelogEntries.flatMap((entry) => [
                `## ${entry.version}`,
                ...entry.lines.filter((line, index, all) => {
                  const previousLine = index > 0 ? all[index - 1] : undefined;
                  return line.trim().length > 0 || (previousLine?.trim().length ?? 0) > 0;
                }),
              ]),
            ]
          : [`No deployment changelog entries newer than ${runtime.version} were found in ${path.basename(changelogPath ?? CHANGELOG_FILE_NAME)}.`]
      ),
    ].join("\n");
  }

  formatAvailableUpdate(latestTagVersion: string) {
    const runtime = this.load();
    const currentVersion = runtime.version;

    if (!latestTagVersion) {
      return [
        `Current version: ${currentVersion}.`,
        "No tagged versions were found on the remote.",
      ].join("\n");
    }

    const latestSegments = tryParseVersionSegments(latestTagVersion);
    const currentSegments = tryParseVersionSegments(currentVersion);

    if (!latestSegments) {
      return [
        `Current version: ${currentVersion}.`,
        `Latest remote tag version ${latestTagVersion} has an unsupported format.`,
      ].join("\n");
    }

    if (currentSegments && compareVersionSegments(latestSegments, currentSegments) <= 0) {
      return [
        `Current version: ${currentVersion}.`,
        `Latest remote tag version: ${latestTagVersion}.`,
        "Already up to date. No newer tagged version is available.",
      ].join("\n");
    }

    const lines = [
      `Update available: ${currentVersion} -> ${latestTagVersion}.`,
      "Run `/update confirm:true` to pull and deploy this version.",
    ];

    // Show changelog entries between current and latest if available
    if (runtime.changelogPath && fs.existsSync(runtime.changelogPath) && currentSegments) {
      const entries = parseDeploymentChangelog(fs.readFileSync(runtime.changelogPath, "utf8"))
        .filter((entry) => {
          const entrySegments = tryParseVersionSegments(entry.version);
          return entrySegments && compareVersionSegments(entrySegments, currentSegments) > 0;
        });

      if (entries.length > 0) {
        lines.push(
          `Pending changelog entries: ${entries.length}.`,
          ...entries.flatMap((entry) => [
            `## ${entry.version}`,
            ...entry.lines.filter((line, index, all) => {
              const previousLine = index > 0 ? all[index - 1] : undefined;
              return line.trim().length > 0 || (previousLine?.trim().length ?? 0) > 0;
            }),
          ]),
        );
      }
    }

    return lines.join("\n");
  }
}
