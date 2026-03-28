import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const repoRoot = process.cwd();

let previousCwd = "";
let previousRootDirEnv: string | undefined;
let tempRoot = "";

let appRuntimeModule: typeof import("./runtime");
let memoryServiceModule: typeof import("../services/memory-service");
let shellServiceModule: typeof import("../services/infrastructure/shell-service");

let originalEnsureReady: typeof memoryServiceModule.MemoryService.prototype.ensureReady;
let originalShellExec: typeof shellServiceModule.ShellService.prototype.exec;

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?test=${Date.now()}-${Math.random()}`) as Promise<T>;
}

function copyDirectory(relativePath: string) {
  const source = path.join(repoRoot, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }
  fs.cpSync(source, path.join(tempRoot, relativePath), { recursive: true });
}

function writeAssistantContextFixture() {
  const assistantContextRoot = path.join(tempRoot, ".openelinarotest", "assistant_context");
  fs.mkdirSync(assistantContextRoot, { recursive: true });
  fs.writeFileSync(
    path.join(assistantContextRoot, "heartbeat.md"),
    "# Heartbeat\n\n- Test heartbeat instructions.\n",
    "utf8",
  );
}

function writeTestProfileRegistry() {
  fs.mkdirSync(path.join(tempRoot, ".openelinarotest", "profiles"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, ".openelinarotest", "profiles/registry.json"),
    `${JSON.stringify({
      version: 1,
      profiles: [
        {
          id: "root",
          name: "Root",
          roles: ["root"],
          memoryNamespace: "root",
          preferredProvider: "openai-codex",
          defaultModelId: "gpt-5.4",
          maxSubagentDepth: 1,
        },
        {
          id: "remote",
          name: "Remote",
          roles: ["remote"],
          memoryNamespace: "remote",
          execution: {
            kind: "ssh",
            host: "192.168.2.42",
            user: "remote",
            defaultCwd: "/Users/remote/link-coach",
          },
          preferredProvider: "claude",
          defaultModelId: "claude-opus-4-6-20260301",
          maxSubagentDepth: 1,
        },
      ],
    }, null, 2)}\n`,
  );
}

function writeTestProjectRegistry() {
  fs.mkdirSync(path.join(tempRoot, ".openelinarotest", "projects/link-coach"), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, ".openelinarotest", "projects/link-coach/workspace"), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, ".openelinarotest", "projects/link-coach/README.md"), "# Link Coach\n", "utf8");
  fs.writeFileSync(
    path.join(tempRoot, ".openelinarotest", "projects/registry.json"),
    `${JSON.stringify({
      version: 1,
      jobs: [
        {
          id: "remote",
          name: "Remote",
          status: "active",
          priority: "medium",
          summary: "SSH-backed client work.",
        },
      ],
      projects: [
        {
          id: "link-coach",
          name: "Link Coach",
          status: "active",
          jobId: "remote",
          priority: "medium",
          allowedRoles: ["remote"],
          workspacePath: path.join(tempRoot, ".openelinarotest", "projects/link-coach/workspace"),
          workspaceOverrides: {
            remote: "/Users/remote/link-coach",
          },
          summary: "SSH-backed project for remote.",
          currentState: "Configured for SSH-backed access.",
          state: "Link Coach is configured for SSH-backed access through the remote profile.",
          future: "The remote workspace should become the normal operating root for remote.",
          nextFocus: ["Use the remote workspace path."],
          structure: ["workspace/: local placeholder", "workspaceOverrides.remote: remote path"],
          tags: ["remote", "ssh"],
          docs: {
            readme: "projects/link-coach/README.md",
          },
        },
      ],
    }, null, 2)}\n`,
  );
}

function writeWorkspaceFixture() {
  fs.mkdirSync(path.join(tempRoot, ".openelinarotest", "memory/documents/root"), { recursive: true });
  fs.mkdirSync(path.join(tempRoot, ".openelinarotest", "memory/documents/remote"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, "package.json"),
    JSON.stringify({ name: "ssh-profile-e2e-fixture", type: "module" }, null, 2),
    "utf8",
  );
}

function decodeFilesystemRequest(command: string) {
  const match = command.match(/OPENELINARO_SSH_FS_REQUEST='([^']+)'/);
  if (!match?.[1]) {
    return null;
  }
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as Record<string, unknown>;
}

beforeAll(async () => {
  previousCwd = process.cwd();
  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-ssh-profile-e2e-"));
  process.env.OPENELINARO_ROOT_DIR = tempRoot;
  process.chdir(tempRoot);

  copyDirectory("src");
  copyDirectory("system_prompt");
  writeAssistantContextFixture();

  writeTestProfileRegistry();
  writeTestProjectRegistry();
  writeWorkspaceFixture();

  appRuntimeModule = await importFresh("src/app/runtime.ts");
  memoryServiceModule = await importFresh("src/services/memory-service.ts");
  shellServiceModule = await importFresh("src/services/infrastructure/shell-service.ts");

  originalEnsureReady = memoryServiceModule.MemoryService.prototype.ensureReady;
  originalShellExec = shellServiceModule.ShellService.prototype.exec;

  memoryServiceModule.MemoryService.prototype.ensureReady = async function ensureReadyStub() {
    return {
      version: 1,
      builtAt: new Date().toISOString(),
      modelId: "stub",
      sourceRoot: path.join(tempRoot, ".openelinarotest", "memory/documents"),
      documentRoot: path.join(tempRoot, ".openelinarotest", "memory/documents"),
      documents: [],
      chunks: [],
      documentFrequencies: {},
      averageChunkLength: 0,
    };
  };

  shellServiceModule.ShellService.prototype.exec = async function execStub(params) {
    const request = decodeFilesystemRequest(params.command);
    if (!request) {
      throw new Error(`Unexpected SSH command in test: ${params.command}`);
    }
    if (request.op === "stat" && request.path === "/Users/remote/link-coach/README.md") {
      return {
        command: params.command,
        cwd: "/Users/remote/link-coach",
        timeoutMs: params.timeoutMs ?? 120_000,
        sudo: params.sudo === true,
        effectiveUser: "remote@192.168.2.42",
        exitCode: 0,
        stdout: JSON.stringify({
          type: "file",
          sizeBytes: 52,
          modifiedAt: 1700000000,
          createdAt: 1700000000,
        }),
        stderr: "",
      };
    }
    if (request.op === "read" && request.path === "/Users/remote/link-coach/README.md") {
      return {
        command: params.command,
        cwd: "/Users/remote/link-coach",
        timeoutMs: params.timeoutMs ?? 120_000,
        sudo: params.sudo === true,
        effectiveUser: "remote@192.168.2.42",
        exitCode: 0,
        stdout: JSON.stringify({
          type: "file",
          content: "# Link Coach Remote\n\nremote ssh workspace fixture\n",
        }),
        stderr: "",
      };
    }
    throw new Error(`Unexpected remote filesystem request in test: ${JSON.stringify(request)}`);
  };
});

afterAll(() => {
  memoryServiceModule.MemoryService.prototype.ensureReady = originalEnsureReady;
  shellServiceModule.ShellService.prototype.exec = originalShellExec;
  process.chdir(previousCwd);
  if (previousRootDirEnv === undefined) {
    delete process.env.OPENELINARO_ROOT_DIR;
  } else {
    process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("OpenElinaro SSH profile e2e", () => {
  test("resolves project metadata and file reads through the remote SSH profile", async () => {
    const app = new appRuntimeModule.OpenElinaroApp({ profileId: "remote" });

    const project = await app.invokeRoutineTool("project_get", { id: "link-coach" });
    const remoteReadme = await app.invokeRoutineTool("read_file", { path: "README.md" });
    const projectContext = app.buildAssistantProjectContext();

    expect(project).toContain("Project: link-coach");
    expect(project).toContain("Workspace: /Users/remote/link-coach");
    expect(remoteReadme).toContain("Path: /Users/remote/link-coach/README.md");
    expect(remoteReadme).toContain("remote ssh workspace fixture");
    expect(projectContext).toContain("Workspace: /Users/remote/link-coach");
  });
});
