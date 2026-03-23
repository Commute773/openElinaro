import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DeploymentVersionService } from "./deployment-version-service";

let tempRoot = "";
let previousCwd = "";
let previousServiceRoot: string | undefined;

describe("deployment version service", () => {
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-deployment-version-"));
    previousCwd = process.cwd();
    previousServiceRoot = process.env.OPENELINARO_SERVICE_ROOT_DIR;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (previousServiceRoot === undefined) {
      delete process.env.OPENELINARO_SERVICE_ROOT_DIR;
    } else {
      process.env.OPENELINARO_SERVICE_ROOT_DIR = previousServiceRoot;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = "";
  });

  test("reads VERSION.json from the active service root", () => {
    const resolvedRoot = path.resolve(tempRoot);
    fs.writeFileSync(
      path.join(tempRoot, "VERSION.json"),
      `${JSON.stringify({
        version: "2026.03.15.2",
        releasedAt: "2026-03-15T10:30:00Z",
        previousVersion: "2026.03.15",
        releaseId: "20260315T103000Z-deadbee",
        changelogPath: "DEPLOYMENTS.md",
      }, null, 2)}\n`,
      "utf8",
    );

    process.env.OPENELINARO_SERVICE_ROOT_DIR = tempRoot;

    expect(new DeploymentVersionService().load()).toEqual({
      version: "2026.03.15.2",
      releasedAt: "2026-03-15T10:30:00Z",
      previousVersion: "2026.03.15",
      releaseId: "20260315T103000Z-deadbee",
      changelogPath: path.join(resolvedRoot, "DEPLOYMENTS.md"),
      sourceRoot: null,
      serviceRoot: resolvedRoot,
      managedService: true,
    });
  });

  test("prefers release.json when running from a managed-service release root", () => {
    fs.writeFileSync(
      path.join(tempRoot, "VERSION.json"),
      `${JSON.stringify({
        version: "2026.03.15",
        releasedAt: "2026-03-15T09:00:00Z",
        releaseId: "stale-release",
      }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(tempRoot, "release.json"),
      `${JSON.stringify({
        id: "20260315T120000Z-cafef00",
        createdAt: "2026-03-15T12:00:00Z",
        sourceRoot: "/opt/openelinaro/app",
        version: "2026.03.15.3",
        releasedAt: "2026-03-15T12:00:00Z",
        previousVersion: "2026.03.15.2",
        changelogPath: "DEPLOYMENTS.md",
      }, null, 2)}\n`,
      "utf8",
    );

    process.env.OPENELINARO_SERVICE_ROOT_DIR = tempRoot;

    expect(new DeploymentVersionService().load()).toEqual({
      version: "2026.03.15.3",
      releasedAt: "2026-03-15T12:00:00Z",
      previousVersion: "2026.03.15.2",
      releaseId: "20260315T120000Z-cafef00",
      changelogPath: path.join(tempRoot, "DEPLOYMENTS.md"),
      sourceRoot: "/opt/openelinaro/app",
      serviceRoot: tempRoot,
      managedService: true,
    });
  });

  test("returns an explicit unversioned fallback when metadata is missing", () => {
    const resolvedRoot = path.resolve(tempRoot);
    process.env.OPENELINARO_SERVICE_ROOT_DIR = tempRoot;

    expect(new DeploymentVersionService().load()).toEqual({
      version: "unversioned",
      releasedAt: null,
      previousVersion: null,
      releaseId: null,
      changelogPath: null,
      sourceRoot: null,
      serviceRoot: resolvedRoot,
      managedService: true,
    });
  });

  test("formats deployment changelog entries newer than a requested version", () => {
    process.env.OPENELINARO_SERVICE_ROOT_DIR = tempRoot;
    fs.writeFileSync(
      path.join(tempRoot, "VERSION.json"),
      `${JSON.stringify({
        version: "2026.03.16.2",
        releasedAt: "2026-03-16T15:48:00Z",
        previousVersion: "2026.03.16",
        releaseId: "20260316T154800Z-1098649",
        changelogPath: "DEPLOYMENTS.md",
      }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(tempRoot, "DEPLOYMENTS.md"),
      [
        "# Deployments",
        "",
        "## 2026.03.16.2",
        "- Released at: 2026-03-16T15:48:00Z",
        "- Previous version: 2026.03.16",
        "",
        "## 2026.03.16",
        "- Released at: 2026-03-16T15:46:56Z",
        "- Previous version: 2026.03.15",
        "",
        "## 2026.03.15",
        "- Released at: 2026-03-15T23:04:50Z",
        "- Previous version: none",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = new DeploymentVersionService().formatChangelogSinceVersion("2026.03.15");

    expect(result).toContain("Deployments since 2026.03.15: 2 entries. Current version: 2026.03.16.2.");
    expect(result).toContain("Version format: YYYY.MM.DD[.N] where .N resets each UTC day.");
    expect(result).toContain(
      "Release-id SHAs record the source revision before the deploy commit is written, so they do not match the later deploy commit hash.",
    );
    expect(result).toContain("## 2026.03.16.2");
    expect(result).toContain("## 2026.03.16");
    expect(result).not.toContain("## 2026.03.15");
  });

  test("accepts a requested version that is not present in the changelog and compares numerically", () => {
    process.env.OPENELINARO_SERVICE_ROOT_DIR = tempRoot;
    fs.writeFileSync(
      path.join(tempRoot, "VERSION.json"),
      `${JSON.stringify({
        version: "2026.03.18.3",
        changelogPath: "DEPLOYMENTS.md",
      }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(tempRoot, "DEPLOYMENTS.md"),
      [
        "# Deployments",
        "",
        "## 2026.03.18.3",
        "- Released at: 2026-03-18T12:00:00Z",
        "",
        "## 2026.03.18",
        "- Released at: 2026-03-18T11:00:00Z",
        "",
        "## 2026.03.17.9",
        "- Released at: 2026-03-17T21:00:00Z",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = new DeploymentVersionService().formatChangelogSinceVersion("0.0.0.0");

    expect(result).toContain("Deployments since 0.0.0.0: 3 entries. Current version: 2026.03.18.3.");
    expect(result).toContain("## 2026.03.18.3");
    expect(result).toContain("## 2026.03.18");
    expect(result).toContain("## 2026.03.17.9");
  });

  test("treats missing version segments as zero during comparison", () => {
    process.env.OPENELINARO_SERVICE_ROOT_DIR = tempRoot;
    fs.writeFileSync(
      path.join(tempRoot, "VERSION.json"),
      `${JSON.stringify({
        version: "2026.03.18.3",
        changelogPath: "DEPLOYMENTS.md",
      }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(tempRoot, "DEPLOYMENTS.md"),
      [
        "# Deployments",
        "",
        "## 2026.03.18.3",
        "- Released at: 2026-03-18T12:00:00Z",
        "",
        "## 2026.03.18",
        "- Released at: 2026-03-18T11:00:00Z",
        "",
        "## 2026.03.17.9",
        "- Released at: 2026-03-17T21:00:00Z",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = new DeploymentVersionService().formatChangelogSinceVersion("2026.3.18.0");
    const resultLines = result.split("\n");

    expect(result).toContain("Deployments since 2026.3.18.0: 1 entry. Current version: 2026.03.18.3.");
    expect(result).toContain("## 2026.03.18.3");
    expect(resultLines).not.toContain("## 2026.03.18");
    expect(resultLines).not.toContain("## 2026.03.17.9");
  });

  test("returns an explicit message when no deployments were recorded after the requested version", () => {
    process.env.OPENELINARO_SERVICE_ROOT_DIR = tempRoot;
    fs.writeFileSync(
      path.join(tempRoot, "VERSION.json"),
      `${JSON.stringify({
        version: "2026.03.16.2",
        changelogPath: "DEPLOYMENTS.md",
      }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(tempRoot, "DEPLOYMENTS.md"),
      [
        "# Deployments",
        "",
        "## 2026.03.16.2",
        "- Released at: 2026-03-16T15:48:00Z",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = new DeploymentVersionService().formatChangelogSinceVersion("2026.03.16.2");

    expect(result).toBe("No deployments were recorded after 2026.03.16.2. Current version: 2026.03.16.2.");
  });

  test("formats a prepared update newer than the running service version", () => {
    const sourceRoot = path.join(tempRoot, "source");
    fs.mkdirSync(sourceRoot, { recursive: true });
    process.env.OPENELINARO_SERVICE_ROOT_DIR = tempRoot;
    fs.writeFileSync(
      path.join(tempRoot, "release.json"),
      `${JSON.stringify({
        id: "20260316T100000Z-live",
        createdAt: "2026-03-16T10:00:00Z",
        sourceRoot,
        version: "2026.03.16",
        releasedAt: "2026-03-16T10:00:00Z",
        previousVersion: "2026.03.15.9",
        changelogPath: "DEPLOYMENTS.md",
      }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(sourceRoot, "VERSION.json"),
      `${JSON.stringify({
        version: "2026.03.16.2",
        releasedAt: "2026-03-16T12:00:00Z",
        previousVersion: "2026.03.16.1",
        changelogPath: "DEPLOYMENTS.md",
      }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(sourceRoot, "DEPLOYMENTS.md"),
      [
        "# Deployments",
        "",
        "## 2026.03.16.2",
        "- Released at: 2026-03-16T12:00:00Z",
        "- Previous version: 2026.03.16.1",
        "- Add deploy preview changelog details",
        "- Require handwritten changes during prepare update",
        "",
        "## 2026.03.16.1",
        "- Released at: 2026-03-16T11:00:00Z",
        "- Previous version: 2026.03.16",
        "- Tighten deploy metadata handling",
        "",
        "## 2026.03.16",
        "- Released at: 2026-03-16T10:00:00Z",
        "- Previous version: 2026.03.15.9",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = new DeploymentVersionService().formatPreparedUpdate();

    expect(result).toContain("Deployed version: 2026.03.16.");
    expect(result).toContain("Pulled source version: 2026.03.16.2.");
    expect(result).toContain("Deployment available: 2026.03.16 -> 2026.03.16.2.");
    expect(result).toContain(`Source root: ${sourceRoot}`);
    expect(result).toContain("Pending deployment entries since 2026.03.16: 2.");
    expect(result).toContain("## 2026.03.16.2");
    expect(result).toContain("## 2026.03.16.1");
    expect(result).toContain("- Add deploy preview changelog details");
    expect(result).toContain("- Tighten deploy metadata handling");
  });

  test("reports when no prepared update is newer than the running service", () => {
    const sourceRoot = path.join(tempRoot, "source");
    fs.mkdirSync(sourceRoot, { recursive: true });
    process.env.OPENELINARO_SERVICE_ROOT_DIR = tempRoot;
    fs.writeFileSync(
      path.join(tempRoot, "release.json"),
      `${JSON.stringify({
        id: "20260316T100000Z-live",
        createdAt: "2026-03-16T10:00:00Z",
        sourceRoot,
        version: "2026.03.16.2",
        releasedAt: "2026-03-16T10:00:00Z",
        previousVersion: "2026.03.16.1",
        changelogPath: "DEPLOYMENTS.md",
      }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(sourceRoot, "VERSION.json"),
      `${JSON.stringify({
        version: "2026.03.16.2",
        releasedAt: "2026-03-16T12:00:00Z",
        previousVersion: "2026.03.16.1",
        changelogPath: "DEPLOYMENTS.md",
      }, null, 2)}\n`,
      "utf8",
    );

    const result = new DeploymentVersionService().formatPreparedUpdate();

    expect(result).toContain("Deployed version: 2026.03.16.2.");
    expect(result).toContain("Pulled source version: 2026.03.16.2.");
    expect(result).toContain("Update skipped: the deployed service is already at version 2026.03.16.2, which matches the pulled source version.");
    expect(result).toContain("Nothing to deploy.");
  });

  test("formats update preview with separate remote, source, and deployed versions", () => {
    const sourceRoot = path.join(tempRoot, "source");
    fs.mkdirSync(sourceRoot, { recursive: true });
    process.env.OPENELINARO_SERVICE_ROOT_DIR = tempRoot;
    fs.writeFileSync(
      path.join(tempRoot, "release.json"),
      `${JSON.stringify({
        id: "20260316T100000Z-live",
        createdAt: "2026-03-16T10:00:00Z",
        sourceRoot,
        version: "2026.03.16",
        releasedAt: "2026-03-16T10:00:00Z",
        previousVersion: "2026.03.15.9",
        changelogPath: "DEPLOYMENTS.md",
      }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(sourceRoot, "VERSION.json"),
      `${JSON.stringify({
        version: "2026.03.16.2",
        releasedAt: "2026-03-16T12:00:00Z",
        previousVersion: "2026.03.16.1",
        changelogPath: "DEPLOYMENTS.md",
      }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(sourceRoot, "DEPLOYMENTS.md"),
      [
        "# Deployments",
        "",
        "## 2026.03.16.2",
        "- Released at: 2026-03-16T12:00:00Z",
        "- Previous version: 2026.03.16.1",
        "- Add deploy preview changelog details",
        "",
        "## 2026.03.16.1",
        "- Released at: 2026-03-16T11:00:00Z",
        "- Previous version: 2026.03.16",
        "- Tighten deploy metadata handling",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = new DeploymentVersionService().formatAvailableUpdate("2026.03.16.2");

    expect(result).toContain("Deployed version: 2026.03.16.");
    expect(result).toContain("Pulled source version: 2026.03.16.2.");
    expect(result).toContain("Latest remote tag version: 2026.03.16.2.");
    expect(result).toContain("Source checkout is up to date with the latest remote tag.");
    expect(result).toContain("Deployment available: 2026.03.16 -> 2026.03.16.2.");
    expect(result).toContain("Run `/update confirm:true` to deploy the already pulled version.");
    expect(result).toContain("## 2026.03.16.2");
    expect(result).toContain("## 2026.03.16.1");
  });

  test("reports when the deployed service already matches the pulled source version", () => {
    const sourceRoot = path.join(tempRoot, "source");
    fs.mkdirSync(sourceRoot, { recursive: true });
    process.env.OPENELINARO_SERVICE_ROOT_DIR = tempRoot;
    fs.writeFileSync(
      path.join(tempRoot, "release.json"),
      `${JSON.stringify({
        id: "20260316T100000Z-live",
        createdAt: "2026-03-16T10:00:00Z",
        sourceRoot,
        version: "2026.03.16.2",
        releasedAt: "2026-03-16T10:00:00Z",
        previousVersion: "2026.03.16.1",
        changelogPath: "DEPLOYMENTS.md",
      }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(sourceRoot, "VERSION.json"),
      `${JSON.stringify({
        version: "2026.03.16.2",
        releasedAt: "2026-03-16T12:00:00Z",
        previousVersion: "2026.03.16.1",
        changelogPath: "DEPLOYMENTS.md",
      }, null, 2)}\n`,
      "utf8",
    );

    const result = new DeploymentVersionService().formatAvailableUpdate("2026.03.16.2");

    expect(result).toContain("Deployed version: 2026.03.16.2.");
    expect(result).toContain("Pulled source version: 2026.03.16.2.");
    expect(result).toContain("Latest remote tag version: 2026.03.16.2.");
    expect(result).toContain("Source checkout is up to date with the latest remote tag.");
    expect(result).toContain("Update skipped: the deployed service is already at version 2026.03.16.2, which matches the pulled source version. No deploy needed.");
    expect(new DeploymentVersionService().hasPreparedUpdate()).toBe(false);
  });

  test("treats an unversioned deployed service as behind a valid pulled source version", () => {
    const sourceRoot = path.join(tempRoot, "source");
    fs.mkdirSync(sourceRoot, { recursive: true });
    process.env.OPENELINARO_SERVICE_ROOT_DIR = tempRoot;
    fs.writeFileSync(
      path.join(tempRoot, "release.json"),
      `${JSON.stringify({
        id: "20260316T100000Z-live",
        createdAt: "2026-03-16T10:00:00Z",
        sourceRoot,
        version: "unversioned",
        releasedAt: "2026-03-16T10:00:00Z",
        changelogPath: "DEPLOYMENTS.md",
      }, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(sourceRoot, "VERSION.json"),
      `${JSON.stringify({
        version: "2026.03.16.2",
        releasedAt: "2026-03-16T12:00:00Z",
        previousVersion: "2026.03.16.1",
        changelogPath: "DEPLOYMENTS.md",
      }, null, 2)}\n`,
      "utf8",
    );

    const result = new DeploymentVersionService().formatAvailableUpdate("2026.03.16.2");

    expect(result).toContain("Deployed version: unversioned.");
    expect(result).toContain("Pulled source version: 2026.03.16.2.");
    expect(result).toContain("Deployment available: unversioned -> 2026.03.16.2.");
    expect(new DeploymentVersionService().hasPreparedUpdate()).toBe(true);
  });
});
