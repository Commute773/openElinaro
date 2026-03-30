import { realpathSync } from "node:fs";
import path from "node:path";
import type { ProfileRecord } from "../../domain/profiles";
import { ProjectsService } from "../projects-service";
import { ProfileService } from "./profile-service";
import { ProjectWorkspaceService } from "../project-workspace-service";
import { getRuntimeRootDir, resolveRuntimePath, resolveUserDataPath } from "../runtime-root";

function getRepoRoot() {
  return getRuntimeRootDir();
}

function getDataRoot() {
  return resolveUserDataPath();
}

function normalize(targetPath: string, remote = false) {
  if (remote) {
    return path.posix.resolve(targetPath);
  }
  const resolved = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(getRuntimeRootDir(), targetPath);
  try {
    return realpathSync.native(resolved);
  } catch {
    // File may not exist yet (e.g. write target). Resolve the parent directory
    // to canonicalize symlinks (macOS /tmp → /private/tmp), then re-append the basename.
    try {
      return path.join(realpathSync.native(path.dirname(resolved)), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

function isWithin(targetPath: string, basePath: string, remote = false) {
  const pathApi = remote ? path.posix : path;
  const relative = pathApi.relative(basePath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));
}

/**
 * Access control for a single-profile install.
 * Each install is one identity with full access to its own resources.
 * Path access is still enforced for SSH backends and configured pathRoots.
 */
export class AccessControlService {
  constructor(
    private readonly profile: ProfileRecord,
    private readonly profiles: ProfileService,
    private readonly projects: ProjectsService,
    private readonly workspaces = new ProjectWorkspaceService(),
  ) {}

  getProfile() {
    return this.profile;
  }

  canUseTool(_name: string) {
    return true;
  }

  assertToolAllowed(_name: string) {
    // Single-profile install: all tools are available.
  }

  assertPathAccess(targetPath: string) {
    const remote = this.profiles.isSshExecutionProfile(this.profile);
    const resolved = normalize(targetPath, remote);

    // Local profiles: allow access to repo root, data root, project workspaces, path roots, managed workspaces
    if (!remote) {
      if (isWithin(resolved, normalize(getRepoRoot()))) return resolved;
      if (isWithin(resolved, normalize(getDataRoot()))) return resolved;
    }

    // Check project workspaces
    for (const project of this.projects.listAllProjects()) {
      const projectWorkspace = normalize(this.projects.resolveWorkspacePath(project), remote);
      if (isWithin(resolved, projectWorkspace, remote)) return resolved;
      if (!remote) {
        const projectDocRoot = path.dirname(this.projects.resolveDocPath(project));
        if (isWithin(resolved, projectDocRoot)) return resolved;
      }
    }

    // Check configured path roots
    for (const root of this.profiles.getPathRoots(this.profile)) {
      if (isWithin(resolved, normalize(root, remote), remote)) return resolved;
    }

    // Check managed workspaces
    if (!remote) {
      const managedWorkspace = this.workspaces.findManagedWorkspaceForPath(resolved);
      if (managedWorkspace) {
        this.assertPathAccess(managedWorkspace.sourceWorkspaceCwd);
        return resolved;
      }
    }

    throw new Error(`Path is outside the allowed workspace roots for profile ${this.profile.id}: ${resolved}`);
  }
}
