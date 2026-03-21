import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, "scripts/service-prepare-update.sh");
const serviceCommonPath = path.join(repoRoot, "scripts/service-common.sh");

const tempRoots: string[] = [];

function initGitRepo(repoPath: string) {
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "OpenElinaro Test"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "tests@example.com"], { cwd: repoPath, stdio: "ignore" });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath, stdio: "ignore" });
}

function addTrackedOrigin(repoPath: string, remotePath: string) {
  execFileSync("git", ["init", "--bare", remotePath], { stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remotePath], { cwd: repoPath, stdio: "ignore" });
  const branch = execFileSync("git", ["branch", "--show-current"], { cwd: repoPath, encoding: "utf8" }).trim();
  execFileSync("git", ["push", "-u", "origin", branch], { cwd: repoPath, stdio: "ignore" });
  return branch;
}

function writeFakeBun(repoPath: string) {
  const fakeBunPath = path.join(repoPath, "fake-bun.sh");
  fs.writeFileSync(
    fakeBunPath,
    [
      "#!/usr/bin/env bash",
      "if [[ \"$1\" == \"run\" && \"$2\" == \"check\" ]]; then",
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  return fakeBunPath;
}

describe("service-prepare-update.sh", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("refuses detached HEAD so prepared-update commits cannot be orphaned", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-prepare-update-"));
    tempRoots.push(tempRoot);
    initGitRepo(tempRoot);
    fs.mkdirSync(path.join(tempRoot, "scripts"), { recursive: true });
    fs.copyFileSync(serviceCommonPath, path.join(tempRoot, "scripts/service-common.sh"));
    const fakeBunPath = writeFakeBun(tempRoot);
    const initialHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempRoot, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", initialHead], { cwd: tempRoot, stdio: "ignore" });

    expect(() => execFileSync(
      scriptPath,
      ["--changes", "- test detached head guard"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          OPENELINARO_ROOT_DIR: tempRoot,
          BUN_BIN: fakeBunPath,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    )).toThrow("refuses to commit from a detached HEAD");
    expect(fs.existsSync(path.join(tempRoot, "VERSION.json"))).toBe(false);
  });

  test("commits and pushes the prepared update to the tracked upstream branch", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-prepare-update-push-"));
    tempRoots.push(tempRoot);
    initGitRepo(tempRoot);
    const remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-prepare-update-remote-"));
    tempRoots.push(remoteRoot);
    const branch = addTrackedOrigin(tempRoot, remoteRoot);
    fs.mkdirSync(path.join(tempRoot, "scripts"), { recursive: true });
    fs.copyFileSync(serviceCommonPath, path.join(tempRoot, "scripts/service-common.sh"));
    const fakeBunPath = writeFakeBun(tempRoot);

    const output = execFileSync(
      scriptPath,
      ["--changes", "- verify prepare-update pushes upstream"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          OPENELINARO_ROOT_DIR: tempRoot,
          BUN_BIN: fakeBunPath,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    expect(output).toContain("Version:");
    expect(output).toContain(`Pushed branch: ${branch}`);

    const localHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tempRoot, encoding: "utf8" }).trim();
    const remoteHead = execFileSync("git", ["rev-parse", branch], { cwd: remoteRoot, encoding: "utf8" }).trim();
    expect(remoteHead).toBe(localHead);
  });

  test("migrates legacy deployment symlinks into release pointer files", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-service-state-"));
    tempRoots.push(tempRoot);
    fs.mkdirSync(path.join(tempRoot, "scripts"), { recursive: true });
    fs.copyFileSync(serviceCommonPath, path.join(tempRoot, "scripts/service-common.sh"));
    const deploymentsDir = path.join(tempRoot, ".openelinaro", "deployments");
    const releasesDir = path.join(deploymentsDir, "releases");
    const currentReleaseDir = path.join(releasesDir, "20260321T010203Z-current");
    const previousReleaseDir = path.join(releasesDir, "20260320T235959Z-previous");
    fs.mkdirSync(currentReleaseDir, { recursive: true });
    fs.mkdirSync(previousReleaseDir, { recursive: true });
    const normalizedCurrentReleaseDir = fs.realpathSync(currentReleaseDir);
    const normalizedPreviousReleaseDir = fs.realpathSync(previousReleaseDir);
    fs.symlinkSync(currentReleaseDir, path.join(deploymentsDir, "current"));
    fs.symlinkSync(previousReleaseDir, path.join(deploymentsDir, "previous"));

    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          `export OPENELINARO_REPO_ROOT='${tempRoot}'`,
          `export OPENELINARO_USER_DATA_DIR='${path.join(tempRoot, ".openelinaro")}'`,
          `source '${path.join(tempRoot, "scripts/service-common.sh")}'`,
          "openelinaro_ensure_deployment_dirs",
          "printf 'current=%s\\n' \"$(openelinaro_current_release_dir)\"",
          "printf 'previous=%s\\n' \"$(openelinaro_previous_release_dir)\"",
        ].join("; "),
      ],
      { encoding: "utf8" },
    );

    expect(output).toContain(`current=${normalizedCurrentReleaseDir}`);
    expect(output).toContain(`previous=${normalizedPreviousReleaseDir}`);
    expect(fs.readFileSync(path.join(deploymentsDir, "current-release.txt"), "utf8").trim()).toBe(normalizedCurrentReleaseDir);
    expect(fs.readFileSync(path.join(deploymentsDir, "previous-release.txt"), "utf8").trim()).toBe(normalizedPreviousReleaseDir);
    expect(fs.existsSync(path.join(deploymentsDir, "current"))).toBe(false);
    expect(fs.existsSync(path.join(deploymentsDir, "previous"))).toBe(false);
  });

  test("release snapshots include the python requirements bundle needed for shared-runtime features", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-release-snapshot-"));
    tempRoots.push(tempRoot);
    fs.mkdirSync(path.join(tempRoot, "scripts"), { recursive: true });
    fs.copyFileSync(serviceCommonPath, path.join(tempRoot, "scripts/service-common.sh"));
    for (const entry of ["src", "system_prompt", "profiles", "docs", "media"]) {
      fs.mkdirSync(path.join(tempRoot, entry), { recursive: true });
    }
    fs.mkdirSync(path.join(tempRoot, "python"), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, "python/requirements.txt"), "crawl4ai\nplaywright\n", "utf8");

    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          `export OPENELINARO_REPO_ROOT='${tempRoot}'`,
          `export OPENELINARO_USER_DATA_DIR='${path.join(tempRoot, ".openelinaro")}'`,
          `source '${path.join(tempRoot, "scripts/service-common.sh")}'`,
          "openelinaro_ensure_deployment_dirs",
          "release_dir=\"${OPENELINARO_RELEASES_DIR}/fixture-release\"",
          "openelinaro_create_release_snapshot \"${release_dir}\" fixture-release 2026.03.21.99 2026-03-21T22:00:00Z 2026.03.21.98",
          "test -f \"${release_dir}/python/requirements.txt\"",
          "printf 'requirements=%s\\n' \"$(cat \"${release_dir}/python/requirements.txt\")\"",
        ].join("; "),
      ],
      { encoding: "utf8" },
    );

    expect(output).toContain("requirements=crawl4ai");
    expect(
      fs.readFileSync(
        path.join(tempRoot, ".openelinaro", "deployments", "releases", "fixture-release", "python", "requirements.txt"),
        "utf8",
      ),
    ).toContain("playwright");
  });
});
