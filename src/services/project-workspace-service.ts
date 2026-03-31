import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveRuntimePath } from "./runtime-root";
import { telemetry as rootTelemetry, type TelemetryService } from "./infrastructure/telemetry";
import { timestamp } from "../utils/timestamp";
import { attemptOr } from "../utils/result";

const WORKSPACE_STORE_VERSION = 1;
const WORKTREE_ROOT_DIRNAME = ".openelinaro-worktrees";
const WORKTREE_BRANCH_PREFIX = "codex/workflow";

export interface ManagedProjectWorkspaceRecord {
  id: string;
  profileId?: string;
  originRunId: string;
  purpose: string;
  repoRoot: string;
  sourceWorkspaceCwd: string;
  worktreeRoot: string;
  workspaceCwd: string;
  branch: string;
  createdAt: string;
  lastUsedAt: string;
}

type WorkspaceStore = {
  version: number;
  workspaces: ManagedProjectWorkspaceRecord[];
};

function getWorkspaceStorePath() {
  return resolveRuntimePath("project-workspaces.json");
}

function ensureStoreDir() {
  mkdirSync(path.dirname(getWorkspaceStorePath()), { recursive: true });
}

function sanitizeSegment(value: string, fallback: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function isWithin(targetPath: string, basePath: string) {
  const relative = path.relative(basePath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readTrimmedGitOutput(cwd: string, args: string[]) {
  return execFileSync(
    "git",
    ["-C", cwd, ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

function resolveExistingPath(targetPath: string) {
  return realpathSync.native(path.resolve(targetPath));
}

export class ProjectWorkspaceService {
  private readonly telemetry: TelemetryService;

  constructor(
    telemetry: TelemetryService = rootTelemetry.child({ component: "project_workspace" }),
  ) {
    this.telemetry = telemetry;
  }

  resolveGitRepoRoot(cwd: string) {
    return attemptOr(
      () => resolveExistingPath(readTrimmedGitOutput(resolveExistingPath(cwd), ["rev-parse", "--show-toplevel"])),
      undefined,
    );
  }

  ensureIsolatedWorkspace(params: {
    cwd: string;
    runId: string;
    goal: string;
    profileId?: string;
  }) {
    const sourceWorkspaceCwd = resolveExistingPath(params.cwd);
    const repoRoot = this.resolveGitRepoRoot(sourceWorkspaceCwd);
    if (!repoRoot) {
      return undefined;
    }

    const dirtyEntries = this.readDirtyEntries(sourceWorkspaceCwd);
    if (dirtyEntries.length > 0) {
      throw new Error(
        [
          "launch_agent refuses to fork a local git workspace with uncommitted changes.",
          "Linked worktrees only include committed content, so continuing would risk missing or later losing work.",
          "Commit or stash the current changes first, then launch the coding agent again.",
          "Dirty paths:",
          ...dirtyEntries.slice(0, 10).map((entry) => `- ${entry}`),
        ].join("\n"),
      );
    }

    const worktreeRoot = this.buildWorktreeRoot(repoRoot, params.goal, params.runId);
    const branch = this.buildBranchName(params.goal, params.runId);
    mkdirSync(path.dirname(worktreeRoot), { recursive: true });
    readTrimmedGitOutput(repoRoot, ["worktree", "add", "-b", branch, worktreeRoot, "HEAD"]);

    const relativeWorkspacePath = path.relative(repoRoot, sourceWorkspaceCwd);
    const workspaceCwd = relativeWorkspacePath && relativeWorkspacePath !== "."
      ? path.join(worktreeRoot, relativeWorkspacePath)
      : worktreeRoot;

    const record: ManagedProjectWorkspaceRecord = {
      id: sanitizeSegment(`${params.runId}-${Date.now()}`, "workspace"),
      profileId: params.profileId,
      originRunId: params.runId,
      purpose: params.goal,
      repoRoot,
      sourceWorkspaceCwd,
      worktreeRoot,
      workspaceCwd,
      branch,
      createdAt: timestamp(),
      lastUsedAt: timestamp(),
    };

    const store = this.loadStore();
    const nextWorkspaces = store.workspaces
      .filter((entry) => entry.worktreeRoot !== record.worktreeRoot)
      .concat(record);
    this.saveStore(nextWorkspaces);

    this.telemetry.event("project_workspace.created", {
      entityType: "project_workspace",
      entityId: record.id,
      workflowRunId: params.runId,
      profileId: params.profileId,
      repoRoot,
      sourceWorkspaceCwd,
      worktreeRoot,
      branch,
    });

    return record;
  }

  findManagedWorkspaceForPath(targetPath: string) {
    const resolvedTarget = path.resolve(targetPath);
    const store = this.loadStore();
    const retained = store.workspaces.filter((record) => existsSync(record.worktreeRoot));
    const prunedMissingEntries = retained.length !== store.workspaces.length;
    const matchIndex = retained.findIndex((record) => isWithin(resolvedTarget, record.worktreeRoot));

    if (matchIndex < 0) {
      if (prunedMissingEntries) {
        this.saveStore(retained);
      }
      return undefined;
    }

    const matchedRecord = retained[matchIndex]!;
    const updatedRecord: ManagedProjectWorkspaceRecord = {
      ...matchedRecord,
      lastUsedAt: timestamp(),
    };
    retained[matchIndex] = updatedRecord;
    if (prunedMissingEntries || updatedRecord.lastUsedAt !== matchedRecord.lastUsedAt) {
      this.saveStore(retained);
    }
    return updatedRecord;
  }

  private readDirtyEntries(cwd: string) {
    const output = readTrimmedGitOutput(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
    if (!output) {
      return [];
    }
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private buildWorktreeRoot(repoRoot: string, goal: string, runId: string) {
    const repoName = sanitizeSegment(path.basename(repoRoot), "repo");
    const goalSlug = sanitizeSegment(goal, "task").slice(0, 32);
    const runSlug = sanitizeSegment(runId, "run").slice(0, 24);
    return path.join(path.dirname(repoRoot), WORKTREE_ROOT_DIRNAME, repoName, `${goalSlug}-${runSlug}`);
  }

  private buildBranchName(goal: string, runId: string) {
    const goalSlug = sanitizeSegment(goal, "task").slice(0, 24);
    const runSlug = sanitizeSegment(runId, "run").slice(0, 24);
    return `${WORKTREE_BRANCH_PREFIX}/${goalSlug}-${runSlug}`;
  }

  private loadStore(): WorkspaceStore {
    ensureStoreDir();
    const storePath = getWorkspaceStorePath();
    if (!existsSync(storePath)) {
      return {
        version: WORKSPACE_STORE_VERSION,
        workspaces: [],
      };
    }

    const raw = JSON.parse(readFileSync(storePath, "utf8")) as Partial<WorkspaceStore>;
    return {
      version: raw.version ?? WORKSPACE_STORE_VERSION,
      workspaces: Array.isArray(raw.workspaces) ? raw.workspaces.map((entry) => ({
        ...entry,
        repoRoot: path.resolve(entry.repoRoot),
        sourceWorkspaceCwd: path.resolve(entry.sourceWorkspaceCwd),
        worktreeRoot: path.resolve(entry.worktreeRoot),
        workspaceCwd: path.resolve(entry.workspaceCwd),
      })) : [],
    };
  }

  private saveStore(workspaces: ManagedProjectWorkspaceRecord[]) {
    ensureStoreDir();
    writeFileSync(
      getWorkspaceStorePath(),
      `${JSON.stringify({
        version: WORKSPACE_STORE_VERSION,
        workspaces,
      }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
}
