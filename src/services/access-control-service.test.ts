import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import type { ProfileRecord } from "../domain/profiles";

// ---------------------------------------------------------------------------
// Environment-based path isolation (no mock.module for runtime-root)
// ---------------------------------------------------------------------------

let tempRoot = "";
let previousRootDir: string | undefined;
let previousUserDataDir: string | undefined;
let mockRuntimeRootDir = "";
let mockUserDataPath = "";
let mockMemoryDocumentRoot = "";

beforeEach(() => {
  previousRootDir = process.env.OPENELINARO_ROOT_DIR;
  previousUserDataDir = process.env.OPENELINARO_USER_DATA_DIR;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-acl-test-"));
  mockRuntimeRootDir = tempRoot;
  mockUserDataPath = path.join(tempRoot, ".openelinarotest");
  mockMemoryDocumentRoot = path.join(mockUserDataPath, "memory", "documents");
  fs.mkdirSync(mockMemoryDocumentRoot, { recursive: true });
  process.env.OPENELINARO_ROOT_DIR = mockRuntimeRootDir;
  process.env.OPENELINARO_USER_DATA_DIR = mockUserDataPath;
});

afterEach(() => {
  // Reset the tool-authorization mock so it delegates back to the real
  // function and does not leak stale mockReturnValue/mockImplementation
  // state into other test files.
  mockGetToolAuthorizationDeclaration.mockImplementation(
    (name: string) => _realGetDeclaration(name),
  );
  if (previousRootDir === undefined) {
    delete process.env.OPENELINARO_ROOT_DIR;
  } else {
    process.env.OPENELINARO_ROOT_DIR = previousRootDir;
  }
  if (previousUserDataDir === undefined) {
    delete process.env.OPENELINARO_USER_DATA_DIR;
  } else {
    process.env.OPENELINARO_USER_DATA_DIR = previousUserDataDir;
  }
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
// runtime-root is NOT mocked via mock.module because Bun's module mocks
// persist across test files and would cause EROFS errors in later tests.

// Mock getToolAuthorizationDeclaration: starts with real behavior, individual
// tests override via mockReturnValue/mockImplementation, afterEach resets.
const _realToolAuthModule = require("./tool-authorization-service");
const _realGetDeclaration = _realToolAuthModule.getToolAuthorizationDeclaration as (name: string) => { access: string; behavior: string; note?: string };
const mockGetToolAuthorizationDeclaration = mock(
  (name: string) => _realGetDeclaration(name),
);
mock.module("./tool-authorization-service", () => ({
  ..._realToolAuthModule,
  getToolAuthorizationDeclaration: mockGetToolAuthorizationDeclaration,
}));

// Reusable mock creators
function makeProfileService(overrides: Record<string, Function> = {}) {
  return {
    isRootProfile: mock((p: ProfileRecord) => p.roles.includes("root")),
    canUseShellTools: mock((p: ProfileRecord) => p.roles.includes("root") || !!p.shellUser),
    isSshExecutionProfile: mock((p: ProfileRecord) => !!p.execution),
    getPathRoots: mock((p: ProfileRecord) => p.pathRoots ?? []),
    canReadMemoryPath: mock((_p: ProfileRecord, _rel: string) => false),
    listLaunchableProfiles: mock((_source: ProfileRecord, _depth?: number) => []),
    getProfile: mock((id: string) => ({ id, name: id, roles: ["user"], memoryNamespace: id })),
    assertCanSpawnProfile: mock((_source: ProfileRecord, _target: ProfileRecord) => {}),
    ...overrides,
  } as any;
}

function makeProjectsService(overrides: Record<string, Function> = {}) {
  return {
    listAllProjects: mock(() => []),
    resolveDocPath: mock(() => path.join(mockUserDataPath, "projects/default/README.md")),
    resolveWorkspacePath: mock(() => "/workspace/default"),
    canAccessProject: mock(() => true),
    ...overrides,
  } as any;
}

function makeWorkspaceService(overrides: Record<string, Function> = {}) {
  return {
    findManagedWorkspaceForPath: mock((_path: string) => null),
    ...overrides,
  } as any;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rootProfile(extra: Partial<ProfileRecord> = {}): ProfileRecord {
  return {
    id: "root",
    name: "Root",
    roles: ["root"],
    memoryNamespace: "root",
    ...extra,
  };
}

function userProfile(extra: Partial<ProfileRecord> = {}): ProfileRecord {
  return {
    id: "user1",
    name: "User One",
    roles: ["user"],
    memoryNamespace: "user1",
    ...extra,
  };
}

// Import after mocks
import { AccessControlService } from "./profiles";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AccessControlService", () => {
  let profilesSvc: ReturnType<typeof makeProfileService>;
  let projectsSvc: ReturnType<typeof makeProjectsService>;
  let workspaceSvc: ReturnType<typeof makeWorkspaceService>;

  beforeEach(() => {
    profilesSvc = makeProfileService();
    projectsSvc = makeProjectsService();
    workspaceSvc = makeWorkspaceService();
    mockGetToolAuthorizationDeclaration.mockImplementation(
      () => ({ access: "anyone" as const, behavior: "uniform" as const }),
    );
  });

  function createService(profile: ProfileRecord = rootProfile()) {
    return new AccessControlService(profile, profilesSvc, projectsSvc, workspaceSvc);
  }

  // -----------------------------------------------------------------------
  // getProfile
  // -----------------------------------------------------------------------
  describe("getProfile", () => {
    test("returns the profile the service was constructed with", () => {
      const profile = rootProfile();
      const svc = createService(profile);
      expect(svc.getProfile()).toBe(profile);
    });
  });

  // -----------------------------------------------------------------------
  // isRoot
  // -----------------------------------------------------------------------
  describe("isRoot", () => {
    test("returns true for root profile", () => {
      const svc = createService(rootProfile());
      expect(svc.isRoot()).toBe(true);
    });

    test("returns false for non-root profile", () => {
      const svc = createService(userProfile());
      expect(svc.isRoot()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // canUseShellTools
  // -----------------------------------------------------------------------
  describe("canUseShellTools", () => {
    test("delegates to profileService.canUseShellTools", () => {
      const svc = createService(rootProfile());
      svc.canUseShellTools();
      expect(profilesSvc.canUseShellTools).toHaveBeenCalledTimes(1);
    });

    test("returns true for root", () => {
      const svc = createService(rootProfile());
      expect(svc.canUseShellTools()).toBe(true);
    });

    test("returns true for profile with shellUser", () => {
      const svc = createService(userProfile({ shellUser: "deploy" }));
      expect(svc.canUseShellTools()).toBe(true);
    });

    test("returns false for non-root profile without shellUser", () => {
      const svc = createService(userProfile());
      expect(svc.canUseShellTools()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // canUseTool
  // -----------------------------------------------------------------------
  describe("canUseTool", () => {
    test("shell-backed tools delegate to canUseShellTools", () => {
      const svc = createService(userProfile());
      for (const tool of ["exec_command", "exec_status", "exec_output"]) {
        svc.canUseTool(tool);
      }
      expect(profilesSvc.canUseShellTools).toHaveBeenCalledTimes(3);
    });

    test("returns false for shell tool when non-root without shellUser", () => {
      const svc = createService(userProfile());
      expect(svc.canUseTool("exec_command")).toBe(false);
    });

    test("returns true for shell tool when profile has shellUser", () => {
      const svc = createService(userProfile({ shellUser: "deploy" }));
      expect(svc.canUseTool("exec_command")).toBe(true);
    });

    test("returns true for 'anyone' access tool regardless of profile", () => {
      mockGetToolAuthorizationDeclaration.mockReturnValue({ access: "anyone", behavior: "uniform" });
      const svc = createService(userProfile());
      expect(svc.canUseTool("routine_list")).toBe(true);
    });

    test("returns false for 'root' access tool when non-root", () => {
      mockGetToolAuthorizationDeclaration.mockReturnValue({ access: "root", behavior: "uniform" });
      const svc = createService(userProfile());
      expect(svc.canUseTool("email")).toBe(false);
    });

    test("returns true for 'root' access tool when root", () => {
      mockGetToolAuthorizationDeclaration.mockReturnValue({ access: "root", behavior: "uniform" });
      const svc = createService(rootProfile());
      expect(svc.canUseTool("email")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // assertToolAllowed
  // -----------------------------------------------------------------------
  describe("assertToolAllowed", () => {
    test("does not throw for allowed tool", () => {
      mockGetToolAuthorizationDeclaration.mockReturnValue({ access: "anyone", behavior: "uniform" });
      const svc = createService(userProfile());
      expect(() => svc.assertToolAllowed("routine_list")).not.toThrow();
    });

    test("throws with shell-specific message for shell-backed tool", () => {
      const svc = createService(userProfile());
      expect(() => svc.assertToolAllowed("exec_command")).toThrow(
        /requires a root profile.*shellUser.*SSH/,
      );
    });

    test("throws with root-only message for non-shell restricted tool", () => {
      mockGetToolAuthorizationDeclaration.mockReturnValue({ access: "root", behavior: "uniform" });
      const svc = createService(userProfile());
      expect(() => svc.assertToolAllowed("email")).toThrow(
        /only available to the root profile/,
      );
    });

    test("does not throw for root profile on root-only tool", () => {
      mockGetToolAuthorizationDeclaration.mockReturnValue({ access: "root", behavior: "uniform" });
      const svc = createService(rootProfile());
      expect(() => svc.assertToolAllowed("email")).not.toThrow();
    });

    test("error includes profile id", () => {
      const profile = userProfile({ id: "tester-42" });
      const svc = createService(profile);
      expect(() => svc.assertToolAllowed("exec_command")).toThrow(/tester-42/);
    });
  });

  // -----------------------------------------------------------------------
  // assertPathAccess
  // -----------------------------------------------------------------------
  describe("assertPathAccess", () => {
    test("root profile can access any path", () => {
      const svc = createService(rootProfile());
      // Should not throw for repo root path
      const resolved = svc.assertPathAccess(mockRuntimeRootDir + "/some-file.ts");
      expect(typeof resolved).toBe("string");
    });

    test("non-root can access paths inside repo root", () => {
      const svc = createService(userProfile());
      const resolved = svc.assertPathAccess(mockRuntimeRootDir + "/src/index.ts");
      expect(resolved).toContain("src/index.ts");
    });

    test("non-root can access paths in an allowed project workspace", () => {
      const project = { id: "proj1", workspacePath: "/workspace/proj1" };
      projectsSvc.listAllProjects.mockReturnValue([project]);
      projectsSvc.resolveWorkspacePath.mockReturnValue("/workspace/proj1");
      projectsSvc.resolveDocPath.mockReturnValue(path.join(mockUserDataPath, "projects/proj1/README.md"));
      projectsSvc.canAccessProject.mockReturnValue(true);

      const svc = createService(userProfile());
      const resolved = svc.assertPathAccess("/workspace/proj1/file.ts");
      expect(resolved).toContain("/workspace/proj1/file.ts");
    });

    test("non-root is denied access to a project workspace they cannot access", () => {
      const project = { id: "proj1", workspacePath: "/workspace/proj1" };
      projectsSvc.listAllProjects.mockReturnValue([project]);
      projectsSvc.resolveWorkspacePath.mockReturnValue("/workspace/proj1");
      projectsSvc.resolveDocPath.mockReturnValue(path.join(mockUserDataPath, "projects/proj1/README.md"));
      projectsSvc.canAccessProject.mockReturnValue(false);

      const svc = createService(userProfile());
      expect(() => svc.assertPathAccess("/workspace/proj1/file.ts")).toThrow(
        /not accessible to profile/,
      );
    });

    test("non-root can access configured pathRoots", () => {
      profilesSvc.getPathRoots.mockReturnValue(["/allowed/custom"]);
      const svc = createService(userProfile({ pathRoots: ["/allowed/custom"] }));
      const resolved = svc.assertPathAccess("/allowed/custom/file.txt");
      expect(resolved).toContain("/allowed/custom/file.txt");
    });

    test("non-root is denied path outside all allowed roots", () => {
      const svc = createService(userProfile());
      expect(() => svc.assertPathAccess("/totally/random/path")).toThrow(
        /outside the allowed workspace roots/,
      );
    });

    test("non-root in data root without memory permission is denied", () => {
      const svc = createService(userProfile());
      expect(() => svc.assertPathAccess(mockUserDataPath + "/some-data")).toThrow(
        /restricted for profile/,
      );
    });

    test("non-root with memory read permission can access memory document path", () => {
      profilesSvc.canReadMemoryPath.mockReturnValue(true);
      const svc = createService(userProfile());
      const resolved = svc.assertPathAccess(mockMemoryDocumentRoot + "/notes.md");
      expect(resolved).toContain("notes.md");
    });

    test("non-root without memory permission is denied memory document path", () => {
      profilesSvc.canReadMemoryPath.mockReturnValue(false);
      const svc = createService(userProfile());
      expect(() =>
        svc.assertPathAccess(mockMemoryDocumentRoot + "/notes.md"),
      ).toThrow(/restricted for profile/);
    });

    test("managed workspace path falls back to sourceWorkspaceCwd check", () => {
      // Simulate managed workspace found, and its source is within repo root.
      // The mock must return null on the recursive call to avoid infinite recursion.
      let callCount = 0;
      workspaceSvc.findManagedWorkspaceForPath.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return {
            worktreeRoot: "/tmp/worktree-123",
            sourceWorkspaceCwd: mockRuntimeRootDir + "/projects/proj1",
          };
        }
        return null;
      });
      const svc = createService(userProfile());
      const resolved = svc.assertPathAccess("/tmp/worktree-123/file.ts");
      expect(resolved).toContain("/tmp/worktree-123/file.ts");
    });
  });

  // -----------------------------------------------------------------------
  // assertSpawnProfile
  // -----------------------------------------------------------------------
  describe("assertSpawnProfile", () => {
    test("delegates to profileService.assertCanSpawnProfile", () => {
      const svc = createService(rootProfile());
      svc.assertSpawnProfile("target-profile");
      expect(profilesSvc.getProfile).toHaveBeenCalledWith("target-profile");
      expect(profilesSvc.assertCanSpawnProfile).toHaveBeenCalledTimes(1);
    });

    test("throws if profileService.assertCanSpawnProfile throws", () => {
      profilesSvc.assertCanSpawnProfile.mockImplementation(() => {
        throw new Error("Cannot spawn");
      });
      const svc = createService(userProfile());
      expect(() => svc.assertSpawnProfile("restricted")).toThrow("Cannot spawn");
    });
  });

  // -----------------------------------------------------------------------
  // listLaunchableProfiles
  // -----------------------------------------------------------------------
  describe("listLaunchableProfiles", () => {
    test("delegates to profileService.listLaunchableProfiles", () => {
      profilesSvc.listLaunchableProfiles.mockReturnValue([
        { id: "child", name: "Child", roles: ["user"], memoryNamespace: "child" },
      ]);
      const profile = rootProfile();
      const svc = createService(profile);
      const result = svc.listLaunchableProfiles(2);
      expect(profilesSvc.listLaunchableProfiles).toHaveBeenCalledWith(profile, 2);
      expect(result).toEqual([{ id: "child", name: "Child", roles: ["user"], memoryNamespace: "child" }]);
    });

    test("defaults currentDepth to 0", () => {
      const profile = rootProfile();
      const svc = createService(profile);
      svc.listLaunchableProfiles();
      expect(profilesSvc.listLaunchableProfiles).toHaveBeenCalledWith(profile, 0);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases and bypass attempts
  // -----------------------------------------------------------------------
  describe("edge cases", () => {
    test("shell tool names are exactly matched, not substring", () => {
      // "exec_command_extended" is NOT a shell-backed tool
      mockGetToolAuthorizationDeclaration.mockReturnValue({ access: "anyone", behavior: "uniform" });
      const svc = createService(userProfile());
      expect(svc.canUseTool("exec_command_extended")).toBe(true);
    });

    test("all three shell-backed tools are restricted", () => {
      const svc = createService(userProfile());
      expect(svc.canUseTool("exec_command")).toBe(false);
      expect(svc.canUseTool("exec_status")).toBe(false);
      expect(svc.canUseTool("exec_output")).toBe(false);
    });
  });
});
