import { realpathSync } from "node:fs";
import path from "node:path";
import type { ProfileRecord } from "../../domain/profiles";
import { ProjectsService } from "../projects-service";
import { ProfileService } from "./profile-service";
import { ProjectWorkspaceService } from "../project-workspace-service";
import { getToolAuthorizationDeclaration } from "../tool-authorization-service";
import { getRuntimeRootDir, resolveRuntimePath, resolveUserDataPath } from "../runtime-root";

const PROTECTED_DATA_EXCEPTIONS = new Set<string>();

function getRepoRoot() {
  return getRuntimeRootDir();
}

function getDataRoot() {
  return resolveUserDataPath();
}

function getMemoryDocumentRoot() {
  return resolveRuntimePath("memory/documents");
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
    return resolved;
  }
}

function isWithin(targetPath: string, basePath: string, remote = false) {
  const pathApi = remote ? path.posix : path;
  const relative = pathApi.relative(basePath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));
}

const SHELL_BACKED_TOOL_NAMES = new Set([
  "exec_command",
  "exec_status",
  "exec_output",
]);

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

  listLaunchableProfiles(currentDepth = 0) {
    return this.profiles.listLaunchableProfiles(this.profile, currentDepth);
  }

  isRoot() {
    return this.profiles.isRootProfile(this.profile);
  }

  canUseShellTools() {
    return this.profiles.canUseShellTools(this.profile);
  }

  canUseTool(name: string) {
    if (SHELL_BACKED_TOOL_NAMES.has(name)) {
      return this.canUseShellTools();
    }
    const declaration = getToolAuthorizationDeclaration(name);
    if (declaration.access === "anyone") {
      return true;
    }
    return this.isRoot();
  }

  assertToolAllowed(name: string) {
    if (this.canUseTool(name)) {
      return;
    }
    if (SHELL_BACKED_TOOL_NAMES.has(name)) {
      throw new Error(
        `Tool ${name} requires a root profile, a configured shellUser, or an SSH execution backend for profile ${this.profile.id}.`,
      );
    }
    throw new Error(`Tool ${name} is only available to the root profile.`);
  }

  assertPathAccess(targetPath: string) {
    const remote = this.profiles.isSshExecutionProfile(this.profile);
    if (this.isRoot()) {
      return normalize(targetPath, remote);
    }

    const resolved = normalize(targetPath, remote);
    for (const project of this.projects.listAllProjects()) {
      const projectDocRoot = path.dirname(this.projects.resolveDocPath(project));
      const projectWorkspace = normalize(this.projects.resolveWorkspacePath(project), remote);
      const allowed = this.projects.canAccessProject(project);

      const inProjectDocRoot = !remote && isWithin(resolved, projectDocRoot);
      const inProjectWorkspace = isWithin(resolved, projectWorkspace, remote);
      if (inProjectDocRoot || inProjectWorkspace) {
        if (allowed) {
          return resolved;
        }
        throw new Error(`Project ${project.id} is not accessible to profile ${this.profile.id}.`);
      }
    }

    const dataRoot = getDataRoot();
    const memoryDocumentRoot = getMemoryDocumentRoot();
    if (!remote && isWithin(resolved, dataRoot)) {
      if (
        isWithin(resolved, memoryDocumentRoot) &&
        this.profiles.canReadMemoryPath(
          this.profile,
          path.relative(memoryDocumentRoot, resolved),
        )
      ) {
        return resolved;
      }
      if (PROTECTED_DATA_EXCEPTIONS.has(resolved)) {
        return resolved;
      }
      throw new Error(`Path is restricted for profile ${this.profile.id}: ${resolved}`);
    }

    for (const root of this.profiles.getPathRoots(this.profile)) {
      if (isWithin(resolved, normalize(root, remote), remote)) {
        return resolved;
      }
    }

    if (!remote) {
      const managedWorkspace = this.workspaces.findManagedWorkspaceForPath(resolved);
      if (managedWorkspace) {
        this.assertPathAccess(managedWorkspace.sourceWorkspaceCwd);
        return resolved;
      }
    }

    if (!remote && isWithin(resolved, getRepoRoot())) {
      return resolved;
    }

    throw new Error(`Path is outside the allowed workspace roots for profile ${this.profile.id}: ${resolved}`);
  }

  assertSpawnProfile(targetProfileId: string) {
    const target = this.profiles.getProfile(targetProfileId);
    this.profiles.assertCanSpawnProfile(this.profile, target);
  }
}
