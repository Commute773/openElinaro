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
  mockMemoryDocumentRoot = path.join(mockUserDataPath, "memory");
  fs.mkdirSync(mockMemoryDocumentRoot, { recursive: true });
  process.env.OPENELINARO_ROOT_DIR = mockRuntimeRootDir;
  process.env.OPENELINARO_USER_DATA_DIR = mockUserDataPath;
});

afterEach(() => {
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

function makeProfileService(overrides: Record<string, Function> = {}) {
  return {
    isSshExecutionProfile: mock((p: ProfileRecord) => !!p.execution),
    getPathRoots: mock((p: ProfileRecord) => p.pathRoots ?? []),
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

function testProfile(extra: Partial<ProfileRecord> = {}): ProfileRecord {
  return {
    id: "test",
    name: "Test",
    memoryNamespace: "test",
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
  });

  function createService(profile: ProfileRecord = testProfile()) {
    return new AccessControlService(profile, profilesSvc, projectsSvc, workspaceSvc);
  }

  // -----------------------------------------------------------------------
  // getProfile
  // -----------------------------------------------------------------------
  describe("getProfile", () => {
    test("returns the profile the service was constructed with", () => {
      const profile = testProfile();
      const svc = createService(profile);
      expect(svc.getProfile()).toBe(profile);
    });
  });

  // -----------------------------------------------------------------------
  // canUseTool — always returns true in single-profile mode
  // -----------------------------------------------------------------------
  describe("canUseTool", () => {
    test("returns true for any tool name", () => {
      const svc = createService();
      expect(svc.canUseTool("exec_command")).toBe(true);
      expect(svc.canUseTool("exec_status")).toBe(true);
      expect(svc.canUseTool("exec_output")).toBe(true);
      expect(svc.canUseTool("routine_list")).toBe(true);
      expect(svc.canUseTool("email")).toBe(true);
      expect(svc.canUseTool("project_list")).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // assertToolAllowed — no-op in single-profile mode
  // -----------------------------------------------------------------------
  describe("assertToolAllowed", () => {
    test("does not throw for any tool", () => {
      const svc = createService();
      expect(() => svc.assertToolAllowed("exec_command")).not.toThrow();
      expect(() => svc.assertToolAllowed("email")).not.toThrow();
      expect(() => svc.assertToolAllowed("routine_list")).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // assertPathAccess
  // -----------------------------------------------------------------------
  describe("assertPathAccess", () => {
    test("can access paths inside repo root", () => {
      const svc = createService();
      const resolved = svc.assertPathAccess(mockRuntimeRootDir + "/some-file.ts");
      expect(typeof resolved).toBe("string");
    });

    test("can access paths in the data root", () => {
      const svc = createService();
      const resolved = svc.assertPathAccess(mockUserDataPath + "/some-data");
      expect(resolved).toContain("some-data");
    });

    test("can access paths in an allowed project workspace", () => {
      const project = { id: "proj1", workspacePath: "/workspace/proj1" };
      projectsSvc.listAllProjects.mockReturnValue([project]);
      projectsSvc.resolveWorkspacePath.mockReturnValue("/workspace/proj1");
      projectsSvc.resolveDocPath.mockReturnValue(path.join(mockUserDataPath, "projects/proj1/README.md"));
      projectsSvc.canAccessProject.mockReturnValue(true);

      const svc = createService();
      const resolved = svc.assertPathAccess("/workspace/proj1/file.ts");
      expect(resolved).toContain("/workspace/proj1/file.ts");
    });

    test("can access configured pathRoots", () => {
      profilesSvc.getPathRoots.mockReturnValue(["/allowed/custom"]);
      const svc = createService(testProfile({ pathRoots: ["/allowed/custom"] }));
      const resolved = svc.assertPathAccess("/allowed/custom/file.txt");
      expect(resolved).toContain("/allowed/custom/file.txt");
    });

    test("is denied path outside all allowed roots", () => {
      const svc = createService();
      expect(() => svc.assertPathAccess("/totally/random/path")).toThrow(
        /outside the allowed workspace roots/,
      );
    });

    test("managed workspace path falls back to sourceWorkspaceCwd check", () => {
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
      const svc = createService();
      const resolved = svc.assertPathAccess("/tmp/worktree-123/file.ts");
      expect(resolved).toContain("/tmp/worktree-123/file.ts");
    });
  });
});
