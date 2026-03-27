import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createIsolatedRuntimeRoot } from "../test/isolated-runtime-root";
import { ProjectWorkspaceService } from "./project-workspace-service";

const testRoot = createIsolatedRuntimeRoot("openelinaro-project-workspace-");

function initGitRepo(repoRoot: string) {
  fs.mkdirSync(repoRoot, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "OpenElinaro Test"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "tests@example.com"], { cwd: repoRoot, stdio: "ignore" });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# fixture\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });
}

describe("ProjectWorkspaceService", () => {
  beforeEach(() => testRoot.setup());
  afterEach(() => testRoot.teardown());

  test("creates an isolated linked worktree and records it in the runtime store", () => {
    const repoRoot = path.join(testRoot.path, "repo");
    const sourceWorkspace = path.join(repoRoot, "src");
    initGitRepo(repoRoot);
    fs.mkdirSync(sourceWorkspace, { recursive: true });
    fs.writeFileSync(path.join(sourceWorkspace, "note.txt"), "source\n", "utf8");
    execFileSync("git", ["add", "src/note.txt"], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add source note"], { cwd: repoRoot, stdio: "ignore" });

    const service = new ProjectWorkspaceService();
    const workspace = service.ensureIsolatedWorkspace({
      cwd: sourceWorkspace,
      runId: "run-test-123",
      goal: "Investigate workspace safety",
      profileId: "root",
    });

    expect(workspace).toBeTruthy();
    expect(workspace?.worktreeRoot).toContain(`${path.sep}.openelinaro-worktrees${path.sep}`);
    expect(workspace?.workspaceCwd).toBe(path.join(workspace!.worktreeRoot, "src"));
    expect(fs.existsSync(path.join(workspace!.workspaceCwd, "note.txt"))).toBe(true);
    expect(
      execFileSync("git", ["-C", workspace!.worktreeRoot, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(),
    ).toBe(workspace!.branch);

    const store = JSON.parse(fs.readFileSync(path.join(testRoot.path, ".openelinarotest", "project-workspaces.json"), "utf8")) as {
      workspaces: Array<{ worktreeRoot: string; workspaceCwd: string }>;
    };
    expect(store.workspaces).toHaveLength(1);
    expect(store.workspaces[0]?.worktreeRoot).toBe(workspace?.worktreeRoot);
    expect(store.workspaces[0]?.workspaceCwd).toBe(workspace?.workspaceCwd);
  });

  test("refuses to fork a dirty local git workspace", () => {
    const repoRoot = path.join(testRoot.path, "repo");
    initGitRepo(repoRoot);
    fs.writeFileSync(path.join(repoRoot, "README.md"), "# dirty\n", "utf8");

    const service = new ProjectWorkspaceService();

    expect(() => service.ensureIsolatedWorkspace({
      cwd: repoRoot,
      runId: "run-dirty-123",
      goal: "Dirty workspace",
      profileId: "root",
    })).toThrow("refuses to fork a local git workspace with uncommitted changes");
  });
});
