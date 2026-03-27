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

type SourceVersionInfo = {
  version: string | null;
  releasedAt: string | null;
  previousVersion: string | null;
  changelogPath: string | null;
  sourceRoot: string;
};

const DEFAULT_DEPLOYMENT_VERSION = "unversioned";
const MAX_UPDATE_CHANGELOG_ENTRIES = 10;
const RELEASE_FILE_NAME = "release.json";
const VERSION_FILE_NAME = "VERSION.json";
const CHANGELOG_FILE_NAME = "DEPLOYMENTS.md";

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const file = Bun.file(filePath);
    if (!await file.exists()) {
      return null;
    }
    return JSON.parse(await file.text()) as T;
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

function renderDeploymentChangelogEntry(entry: DeploymentChangelogEntry) {
  return [
    `## ${entry.version}`,
    ...entry.lines.filter((line, index, all) => {
      const previousLine = index > 0 ? all[index - 1] : undefined;
      return line.trim().length > 0 || (previousLine?.trim().length ?? 0) > 0;
    }),
  ];
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
  private async loadSourceVersionInfo(runtime?: DeploymentVersionInfo): Promise<SourceVersionInfo> {
    const resolvedRuntime = runtime ?? await this.load();
    const sourceRoot = resolveSourceRoot(resolvedRuntime);
    const sourceVersion = await readJsonFile<VersionFilePayload>(path.join(sourceRoot, VERSION_FILE_NAME));

    return {
      version: sourceVersion?.version?.trim() || null,
      releasedAt: sourceVersion?.releasedAt ?? null,
      previousVersion: sourceVersion?.previousVersion ?? null,
      changelogPath: resolveOptionalPath(
        sourceRoot,
        sourceVersion?.changelogPath ?? CHANGELOG_FILE_NAME,
      ),
      sourceRoot,
    };
  }

  private async getChangelogEntriesBetween(
    changelogPath: string | null,
    sinceSegments: number[] | null,
    throughSegments?: number[] | null,
  ) {
    if (!changelogPath || !await Bun.file(changelogPath).exists()) {
      return [];
    }

    return parseDeploymentChangelog(await Bun.file(changelogPath).text()).filter((entry) => {
      const entrySegments = tryParseVersionSegments(entry.version);
      if (!entrySegments) {
        return false;
      }
      if (sinceSegments && compareVersionSegments(entrySegments, sinceSegments) <= 0) {
        return false;
      }
      if (throughSegments && compareVersionSegments(entrySegments, throughSegments) > 0) {
        return false;
      }
      return true;
    });
  }

  async load(): Promise<DeploymentVersionInfo> {
    const serviceRoot = getServiceRootDir();
    const release = await readJsonFile<ReleaseFilePayload>(path.join(serviceRoot, RELEASE_FILE_NAME));
    const version = await readJsonFile<VersionFilePayload>(path.join(serviceRoot, VERSION_FILE_NAME));

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

  async formatSummary() {
    const info = await this.load();
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

  async getChangelogSinceVersion(sinceVersion: string, options?: { limit?: number }) {
    const normalizedSinceVersion = sinceVersion.trim();
    if (!normalizedSinceVersion) {
      throw new Error("sinceVersion is required.");
    }

    const info = await this.load();
    if (!info.changelogPath) {
      throw new Error("No deployment changelog is available for this runtime.");
    }
    if (!await Bun.file(info.changelogPath).exists()) {
      throw new Error(`Deployment changelog was not found: ${info.changelogPath}`);
    }

    const entries = parseDeploymentChangelog(await Bun.file(info.changelogPath).text());
    const sinceSegments = parseVersionSegments(normalizedSinceVersion);
    const newerEntries = entries.filter(
      (entry) => compareVersionSegments(parseVersionSegments(entry.version), sinceSegments) > 0,
    );
    const limit = options?.limit ? Math.max(1, options.limit) : undefined;
    return limit ? newerEntries.slice(0, limit) : newerEntries;
  }

  async formatChangelogSinceVersion(sinceVersion: string, options?: { limit?: number }) {
    const entries = await this.getChangelogSinceVersion(sinceVersion, options);
    const info = await this.load();
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

  async formatPreparedUpdate(latestTagVersion = "") {
    const runtime = await this.load();
    const source = await this.loadSourceVersionInfo(runtime);
    const preparedVersion = source.version;
    if (!preparedVersion) {
      return [
        `Deployed version: ${runtime.version}.`,
        `Source root: ${source.sourceRoot}`,
        `No pulled source version metadata was found in ${source.sourceRoot}.`,
      ].join("\n");
    }

    const preparedSegments = tryParseVersionSegments(preparedVersion);
    const runtimeSegments = tryParseVersionSegments(runtime.version);
    if (!preparedSegments) {
      return [
        `Deployed version: ${runtime.version}.`,
        `Pulled source version: ${preparedVersion}.`,
        `Source root: ${source.sourceRoot}`,
        `Pulled source version ${preparedVersion} has an unsupported format.`,
      ].join("\n");
    }

    if (runtimeSegments && compareVersionSegments(preparedSegments, runtimeSegments) <= 0) {
      const isExactMatch = compareVersionSegments(preparedSegments, runtimeSegments) === 0;
      const reason = isExactMatch
        ? `Update skipped: the deployed service is already at version ${runtime.version}, which matches the pulled source version.`
        : `Update skipped: the pulled source version (${preparedVersion}) is older than the deployed service (${runtime.version}).`;
      return [
        reason,
        "",
        `Latest remote tag version: ${latestTagVersion || "unknown"}.`,
        `Pulled source version: ${preparedVersion}.`,
        `Deployed version: ${runtime.version}.`,
        `Source root: ${source.sourceRoot}`,
        "",
        ...(latestTagVersion && tryParseVersionSegments(latestTagVersion) && runtimeSegments
          && compareVersionSegments(parseVersionSegments(latestTagVersion), runtimeSegments) > 0
          ? [`A newer remote version (${latestTagVersion}) is available but has not been pulled into the local source checkout yet.`]
          : ["Nothing to deploy."]),
      ].join("\n");
    }

    const changelogEntries = await this.getChangelogEntriesBetween(
      source.changelogPath,
      runtimeSegments,
      preparedSegments,
    );

    const displayedEntries = changelogEntries.slice(0, MAX_UPDATE_CHANGELOG_ENTRIES);
    const omittedCount = changelogEntries.length - displayedEntries.length;

    return [
      `Deployed version: ${runtime.version}.`,
      `Pulled source version: ${preparedVersion}.`,
      `Deployment available: ${runtime.version} -> ${preparedVersion}.`,
      `Prepared at: ${source.releasedAt ?? "unknown"}`,
      `Source root: ${source.sourceRoot}`,
      ...(
        changelogEntries.length > 0
          ? [
            `Pending deployment entries since ${runtime.version}: ${changelogEntries.length}.`,
            ...displayedEntries.flatMap((entry) => renderDeploymentChangelogEntry(entry)),
            ...(omittedCount > 0 ? [`\n(${omittedCount} older entries omitted. Use service_changelog_since_version for full history.)`] : []),
          ]
          : [`No deployment changelog entries newer than ${runtime.version} were found in ${path.basename(source.changelogPath ?? CHANGELOG_FILE_NAME)}.`]
      ),
    ].join("\n");
  }

  async formatAvailableUpdate(latestTagVersion: string) {
    const runtime = await this.load();
    const source = await this.loadSourceVersionInfo(runtime);
    const currentVersion = runtime.version;
    const sourceVersion = source.version;
    const currentSegments = tryParseVersionSegments(currentVersion);
    const sourceSegments = tryParseVersionSegments(sourceVersion);

    const lines = [
      `Latest remote tag version: ${latestTagVersion || "unknown"}.`,
      `Pulled source version: ${sourceVersion ?? "unknown"}.`,
      `Deployed version: ${currentVersion}.`,
      `Source root: ${source.sourceRoot}`,
    ];

    if (!latestTagVersion) {
      lines.push("No tagged versions were found on the remote.");
      if (sourceSegments && (!currentSegments || compareVersionSegments(sourceSegments, currentSegments) > 0)) {
        const changelogEntries = await this.getChangelogEntriesBetween(
          source.changelogPath,
          currentSegments,
          sourceSegments,
        );
        lines.push(
          `Deployment available: ${currentVersion} -> ${sourceVersion}.`,
          "Run `/update confirm:true` to deploy the already pulled version.",
        );
        if (changelogEntries.length > 0) {
          const displayed = changelogEntries.slice(0, MAX_UPDATE_CHANGELOG_ENTRIES);
          const omitted = changelogEntries.length - displayed.length;
          lines.push(
            `Pending deployment entries since ${currentVersion}: ${changelogEntries.length}.`,
            ...displayed.flatMap((entry) => renderDeploymentChangelogEntry(entry)),
            ...(omitted > 0 ? [`\n(${omitted} older entries omitted. Use service_changelog_since_version for full history.)`] : []),
          );
        }
      }
      return lines.join("\n");
    }

    const latestSegments = tryParseVersionSegments(latestTagVersion);

    if (!latestSegments) {
      return [
        ...lines,
        `Latest remote tag version ${latestTagVersion} has an unsupported format.`,
      ].join("\n");
    }

    if (!sourceVersion) {
      lines.push(`No pulled source version metadata was found in ${source.sourceRoot}.`);
      return lines.join("\n");
    }

    if (!sourceSegments) {
      lines.push(`Pulled source version ${sourceVersion} has an unsupported format.`);
      return lines.join("\n");
    }

    if (compareVersionSegments(sourceSegments, latestSegments) >= 0) {
      lines.push("Source checkout is up to date with the latest remote tag.");
    } else {
      lines.push(`Source checkout is behind the latest remote tag: ${sourceVersion} -> ${latestTagVersion}.`);
    }

    if (!currentSegments || compareVersionSegments(sourceSegments, currentSegments) > 0) {
      const changelogEntries = await this.getChangelogEntriesBetween(
        source.changelogPath,
        currentSegments,
        sourceSegments,
      );
      lines.push(
        `Deployment available: ${currentVersion} -> ${sourceVersion}.`,
        "Run `/update confirm:true` to deploy the already pulled version.",
      );
      if (changelogEntries.length > 0) {
        const displayed = changelogEntries.slice(0, MAX_UPDATE_CHANGELOG_ENTRIES);
        const omitted = changelogEntries.length - displayed.length;
        lines.push(
          `Pending deployment entries since ${currentVersion}: ${changelogEntries.length}.`,
          ...displayed.flatMap((entry) => renderDeploymentChangelogEntry(entry)),
          ...(omitted > 0 ? [`\n(${omitted} older entries omitted. Use service_changelog_since_version for full history.)`] : []),
        );
      }
      return lines.join("\n");
    }

    if (currentSegments && compareVersionSegments(sourceSegments, currentSegments) === 0) {
      lines.push(`Update skipped: the deployed service is already at version ${currentVersion}, which matches the pulled source version. No deploy needed.`);
      return lines.join("\n");
    }

    lines.push(`Update skipped: the pulled source version (${sourceVersion}) is older than the deployed service (${currentVersion}). Deployment was skipped.`);
    return lines.join("\n");
  }

  async hasPreparedUpdate() {
    const runtime = await this.load();
    const source = await this.loadSourceVersionInfo(runtime);
    if (!source.version) {
      return false;
    }

    const sourceSegments = tryParseVersionSegments(source.version);
    const runtimeSegments = tryParseVersionSegments(runtime.version);
    if (!sourceSegments) {
      return false;
    }
    if (!runtimeSegments) {
      return true;
    }
    return compareVersionSegments(sourceSegments, runtimeSegments) > 0;
  }
}
