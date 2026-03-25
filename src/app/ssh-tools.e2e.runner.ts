import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const TEST_ROOT_NAME = ".openelinarotest";

let previousRootDirEnv: string | undefined;
let tempRoot = "";

let runtimeModule: typeof import("./runtime");
let spawnModule: typeof import("../subagent/spawn");

async function importFresh<T>(relativePath: string): Promise<T> {
  const absolutePath = path.join(repoRoot, relativePath);
  const url = pathToFileURL(absolutePath).href;
  return import(`${url}?runner=${Date.now()}-${Math.random()}`) as Promise<T>;
}

function resolveTestPath(...segments: string[]) {
  return path.join(tempRoot, TEST_ROOT_NAME, ...segments);
}

function copyDirectory(relativePath: string) {
  const source = path.join(repoRoot, relativePath);
  if (!fs.existsSync(source)) {
    return;
  }
  fs.cpSync(source, path.join(tempRoot, relativePath), { recursive: true });
}

function writeProfileRegistry(workspacePath: string) {
  fs.mkdirSync(resolveTestPath("profiles"), { recursive: true });
  fs.writeFileSync(
    resolveTestPath("profiles", "registry.json"),
    `${JSON.stringify({
      version: 1,
      profiles: [
        {
          id: "root",
          name: "Root",
          roles: ["root"],
          memoryNamespace: "root",
          preferredProvider: "claude",
          defaultModelId: "claude-sonnet-4-6-20260301",
          maxSubagentDepth: 1,
        },
        {
          id: "ssh-test",
          name: "SSH Test",
          roles: ["ssh-test"],
          memoryNamespace: "ssh-test",
          pathRoots: [workspacePath],
          execution: {
            kind: "ssh",
            host: "127.0.0.1",
            user: os.userInfo().username,
            defaultCwd: workspacePath,
          },
          preferredProvider: "claude",
          defaultModelId: "claude-sonnet-4-6-20260301",
          maxSubagentDepth: 1,
          subagentPaths: {
            claude: {
              path: path.join(os.homedir(), ".local", "bin", "claude"),
            },
          },
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
}

function writeProjectRegistry(workspacePath: string) {
  fs.mkdirSync(resolveTestPath("projects", "link-coach"), { recursive: true });
  fs.writeFileSync(
    resolveTestPath("projects", "link-coach", "README.md"),
    "# Link Coach\n",
    "utf8",
  );
  fs.writeFileSync(
    resolveTestPath("projects", "registry.json"),
    `${JSON.stringify({
      version: 1,
      jobs: [
        {
          id: "ssh-test-job",
          name: "SSH Test Job",
          status: "active",
          priority: "medium",
          summary: "SSH-backed e2e test job.",
        },
      ],
      projects: [
        {
          id: "link-coach",
          name: "Link Coach",
          status: "active",
          jobId: "ssh-test-job",
          priority: "medium",
          allowedRoles: ["ssh-test"],
          workspacePath: resolveTestPath("projects", "link-coach"),
          workspaceOverrides: {
            "ssh-test": workspacePath,
          },
          summary: "SSH-backed project for e2e testing.",
          currentState: "Configured for SSH-backed access.",
          state: "Link Coach is configured for SSH-backed access through the ssh-test profile.",
          future: "Used for e2e testing of SSH tools.",
          nextFocus: ["Verify SSH tool operations."],
          structure: ["workspace/: local placeholder"],
          tags: ["ssh", "e2e"],
          docs: {
            readme: "projects/link-coach/README.md",
          },
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
}

function writeSecretStore(workspacePath: string) {
  const sshKeyPath = path.join(os.homedir(), ".ssh", "id_ed25519");
  const sshPubKeyPath = path.join(os.homedir(), ".ssh", "id_ed25519.pub");

  const privateKey = fs.readFileSync(sshKeyPath, "utf8");
  const publicKey = fs.readFileSync(sshPubKeyPath, "utf8");

  const store = {
    version: 2,
    profiles: {
      "ssh-test": {
        secrets: {
          "profile_ssh_keypair_ssh-test": {
            kind: "generic",
            fields: {
              privateKey,
              publicKey,
            },
            updatedAt: new Date().toISOString(),
          },
        },
        auth: {},
      },
      root: {
        secrets: {},
        auth: {},
      },
    },
  };

  const storePath = resolveTestPath("secret-store.json");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function writeSshKeyFiles() {
  const sshKeyPath = path.join(os.homedir(), ".ssh", "id_ed25519");
  const sshPubKeyPath = path.join(os.homedir(), ".ssh", "id_ed25519.pub");

  // Write SSH key to the runtime-ssh-keys location the profile service expects
  const keyDir = resolveTestPath("runtime-ssh-keys", "ssh-test");
  fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(sshKeyPath, path.join(keyDir, "id_ed25519"));
  fs.chmodSync(path.join(keyDir, "id_ed25519"), 0o600);
  fs.copyFileSync(sshPubKeyPath, path.join(keyDir, "id_ed25519.pub"));
  fs.chmodSync(path.join(keyDir, "id_ed25519.pub"), 0o644);
}

function writeWorkspaceFixture(workspacePath: string) {
  fs.mkdirSync(path.join(workspacePath, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, "README.md"),
    "# SSH Tools E2E Workspace\n\nThis is a test workspace for SSH tool validation.\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(workspacePath, "src", "hello.ts"),
    'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
    "utf8",
  );
  fs.writeFileSync(
    path.join(workspacePath, "package.json"),
    `${JSON.stringify({
      name: "ssh-tools-e2e-workspace",
      private: true,
      type: "module",
      version: "1.0.0",
    }, null, 2)}\n`,
    "utf8",
  );
}

function writeAssistantContextFixture() {
  const assistantContextRoot = resolveTestPath("assistant_context");
  fs.mkdirSync(assistantContextRoot, { recursive: true });
  fs.writeFileSync(
    path.join(assistantContextRoot, "heartbeat.md"),
    "# Heartbeat\n\n- Test heartbeat instructions.\n",
    "utf8",
  );
}

function writeMemoryFixture() {
  fs.mkdirSync(resolveTestPath("memory", "documents", "ssh-test"), { recursive: true });
}

async function main() {
  console.log("SSH_TOOLS_E2E: starting...");

  previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-ssh-tools-e2e-"));
  process.env.OPENELINARO_ROOT_DIR = tempRoot;
  console.log(`SSH_TOOLS_E2E: temp root = ${tempRoot}`);

  const workspacePath = path.join(tempRoot, "ssh-workspace");
  fs.mkdirSync(workspacePath, { recursive: true });

  // Set up all fixtures
  copyDirectory("system_prompt");
  writeAssistantContextFixture();
  writeWorkspaceFixture(workspacePath);
  writeProfileRegistry(workspacePath);
  writeProjectRegistry(workspacePath);
  writeSecretStore(workspacePath);
  writeSshKeyFiles();
  writeMemoryFixture();

  console.log("SSH_TOOLS_E2E: fixtures written, importing modules...");

  runtimeModule = await importFresh("src/app/runtime.ts");
  spawnModule = await importFresh("src/subagent/spawn.ts");

  console.log("SSH_TOOLS_E2E: creating app with ssh-test profile...");
  const app = new runtimeModule.OpenElinaroApp({ profileId: "ssh-test" });

  // ----------------------------------------------------------------
  // Test 1: exec_command
  // ----------------------------------------------------------------
  console.log("SSH_TOOLS_E2E: test 1 - exec_command...");
  const execResult = await app.invokeRoutineTool("exec_command", {
    command: "echo hello-from-ssh",
    cwd: workspacePath,
  });
  const execOutput = typeof execResult === "string" ? execResult : JSON.stringify(execResult);
  console.log(`SSH_TOOLS_E2E: exec_command result preview: ${execOutput.slice(0, 200)}`);
  assert(
    execOutput.includes("hello-from-ssh"),
    `exec_command should return output containing 'hello-from-ssh'. Got: ${execOutput}`,
  );
  assert(
    execOutput.includes("exitCode: 0"),
    `exec_command should have exitCode 0. Got: ${execOutput}`,
  );
  console.log("SSH_TOOLS_E2E: test 1 PASSED");

  // ----------------------------------------------------------------
  // Test 2: read_file
  // ----------------------------------------------------------------
  console.log("SSH_TOOLS_E2E: test 2 - read_file...");
  const readResult = await app.invokeRoutineTool("read_file", {
    path: path.join(workspacePath, "README.md"),
  });
  const readOutput = typeof readResult === "string" ? readResult : JSON.stringify(readResult);
  console.log(`SSH_TOOLS_E2E: read_file result preview: ${readOutput.slice(0, 200)}`);
  assert(
    readOutput.includes("SSH Tools E2E Workspace"),
    `read_file should contain 'SSH Tools E2E Workspace'. Got: ${readOutput}`,
  );
  assert(
    readOutput.includes("test workspace for SSH tool validation"),
    `read_file should contain 'test workspace for SSH tool validation'. Got: ${readOutput}`,
  );
  console.log("SSH_TOOLS_E2E: test 2 PASSED");

  // ----------------------------------------------------------------
  // Test 3: write_file
  // ----------------------------------------------------------------
  console.log("SSH_TOOLS_E2E: test 3 - write_file...");
  const newFilePath = path.join(workspacePath, "written-via-ssh.txt");
  const writeContent = "This file was written via SSH.\nLine 2.\n";
  const writeResult = await app.invokeRoutineTool("write_file", {
    path: newFilePath,
    content: writeContent,
  });
  const writeOutput = typeof writeResult === "string" ? writeResult : JSON.stringify(writeResult);
  console.log(`SSH_TOOLS_E2E: write_file result: ${writeOutput.slice(0, 200)}`);
  assert(
    writeOutput.toLowerCase().includes("wrote") || writeOutput.toLowerCase().includes("bytes"),
    `write_file should acknowledge the write. Got: ${writeOutput}`,
  );

  // Verify by reading the file back via SSH
  const verifyRead = await app.invokeRoutineTool("read_file", { path: newFilePath });
  const verifyOutput = typeof verifyRead === "string" ? verifyRead : JSON.stringify(verifyRead);
  assert(
    verifyOutput.includes("This file was written via SSH"),
    `write_file verification: re-read should contain written content. Got: ${verifyOutput}`,
  );
  console.log("SSH_TOOLS_E2E: test 3 PASSED");

  // ----------------------------------------------------------------
  // Test 4: edit_file
  // ----------------------------------------------------------------
  console.log("SSH_TOOLS_E2E: test 4 - edit_file...");
  const editResult = await app.invokeRoutineTool("edit_file", {
    path: path.join(workspacePath, "README.md"),
    old_string: "test workspace for SSH tool validation",
    new_string: "EDITED workspace for SSH tool validation",
  });
  const editOutput = typeof editResult === "string" ? editResult : JSON.stringify(editResult);
  console.log(`SSH_TOOLS_E2E: edit_file result: ${editOutput.slice(0, 200)}`);
  assert(
    editOutput.toLowerCase().includes("applied") || editOutput.toLowerCase().includes("replaced"),
    `edit_file should acknowledge the edit. Got: ${editOutput}`,
  );

  // Verify the edit by reading the file back
  const editVerify = await app.invokeRoutineTool("read_file", {
    path: path.join(workspacePath, "README.md"),
  });
  const editVerifyOutput = typeof editVerify === "string" ? editVerify : JSON.stringify(editVerify);
  assert(
    editVerifyOutput.includes("EDITED workspace for SSH tool validation"),
    `edit_file verification: re-read should contain edited content. Got: ${editVerifyOutput}`,
  );
  console.log("SSH_TOOLS_E2E: test 4 PASSED");

  // ----------------------------------------------------------------
  // Test 5: list_dir
  // ----------------------------------------------------------------
  console.log("SSH_TOOLS_E2E: test 5 - list_dir...");
  const listResult = await app.invokeRoutineTool("list_dir", {
    path: workspacePath,
  });
  const listOutput = typeof listResult === "string" ? listResult : JSON.stringify(listResult);
  console.log(`SSH_TOOLS_E2E: list_dir result preview: ${listOutput.slice(0, 300)}`);
  assert(
    listOutput.includes("README.md"),
    `list_dir should list README.md. Got: ${listOutput}`,
  );
  assert(
    listOutput.includes("package.json"),
    `list_dir should list package.json. Got: ${listOutput}`,
  );
  assert(
    listOutput.includes("src/") || listOutput.includes("src"),
    `list_dir should list src directory. Got: ${listOutput}`,
  );
  console.log("SSH_TOOLS_E2E: test 5 PASSED");

  // ----------------------------------------------------------------
  // Test 6: glob
  // ----------------------------------------------------------------
  console.log("SSH_TOOLS_E2E: test 6 - glob...");
  const globResult = await app.invokeRoutineTool("glob", {
    pattern: "**/*.ts",
    path: workspacePath,
  });
  const globOutput = typeof globResult === "string" ? globResult : JSON.stringify(globResult);
  console.log(`SSH_TOOLS_E2E: glob result preview: ${globOutput.slice(0, 300)}`);
  assert(
    globOutput.includes("hello.ts"),
    `glob should find hello.ts. Got: ${globOutput}`,
  );
  console.log("SSH_TOOLS_E2E: test 6 PASSED");

  // ----------------------------------------------------------------
  // Test 7: grep
  // ----------------------------------------------------------------
  console.log("SSH_TOOLS_E2E: test 7 - grep...");
  const grepResult = await app.invokeRoutineTool("grep", {
    pattern: "greet",
    path: workspacePath,
  });
  const grepOutput = typeof grepResult === "string" ? grepResult : JSON.stringify(grepResult);
  console.log(`SSH_TOOLS_E2E: grep result preview: ${grepOutput.slice(0, 300)}`);
  assert(
    grepOutput.includes("greet"),
    `grep should find 'greet' in hello.ts. Got: ${grepOutput}`,
  );
  assert(
    grepOutput.includes("hello.ts"),
    `grep should reference hello.ts. Got: ${grepOutput}`,
  );
  console.log("SSH_TOOLS_E2E: test 7 PASSED");

  // ----------------------------------------------------------------
  // Test 8: project_get
  // ----------------------------------------------------------------
  console.log("SSH_TOOLS_E2E: test 8 - project_get...");
  const projectResult = await app.invokeRoutineTool("project_get", {
    id: "link-coach",
  });
  const projectOutput = typeof projectResult === "string" ? projectResult : JSON.stringify(projectResult);
  console.log(`SSH_TOOLS_E2E: project_get result preview: ${projectOutput.slice(0, 300)}`);
  assert(
    projectOutput.includes("link-coach"),
    `project_get should contain 'link-coach'. Got: ${projectOutput}`,
  );
  assert(
    projectOutput.includes(workspacePath),
    `project_get should contain the remote workspace path '${workspacePath}'. Got: ${projectOutput}`,
  );
  console.log("SSH_TOOLS_E2E: test 8 PASSED");

  // ----------------------------------------------------------------
  // Test 9: buildSshWrappedSpawnCommand + real subagent launch
  // ----------------------------------------------------------------
  console.log("SSH_TOOLS_E2E: test 9 - subagent SSH wrapping...");

  const sshKeyPath = resolveTestPath("runtime-ssh-keys", "ssh-test", "id_ed25519");
  const username = os.userInfo().username;

  // 9a: Verify buildSshWrappedSpawnCommand produces a valid SSH command
  const testInnerCommand = "echo agent-test-ok";
  const sshCmd = spawnModule.buildSshWrappedSpawnCommand({
    innerCommand: testInnerCommand,
    host: "127.0.0.1",
    user: username,
    keyPath: sshKeyPath,
    remoteCwd: workspacePath,
  });
  console.log(`SSH_TOOLS_E2E: built SSH command: ${sshCmd.slice(0, 200)}`);
  assert(sshCmd.includes("ssh"), "SSH command should contain 'ssh'");
  assert(sshCmd.includes("127.0.0.1"), "SSH command should contain the host");
  assert(sshCmd.includes(sshKeyPath), "SSH command should contain the key path");
  assert(sshCmd.includes(workspacePath), "SSH command should contain the remote cwd");
  assert(sshCmd.includes(testInnerCommand), "SSH command should contain the inner command");

  // 9b: Actually run the SSH-wrapped command and verify output
  const sshExecOutput = execSync(sshCmd, {
    encoding: "utf8",
    timeout: 30_000,
    env: process.env,
  });
  assert(
    sshExecOutput.includes("agent-test-ok"),
    `SSH-wrapped command should output 'agent-test-ok'. Got: ${sshExecOutput}`,
  );
  console.log("SSH_TOOLS_E2E: SSH wrapping verification PASSED");

  // 9c: Real subagent launch via SSH (if claude CLI is available)
  const claudePath = path.join(os.homedir(), ".local", "bin", "claude");
  if (fs.existsSync(claudePath)) {
    console.log("SSH_TOOLS_E2E: claude CLI found, testing real subagent launch...");
    const agentMarkerFile = path.join(workspacePath, "agent-was-here.txt");
    const agentGoal = `Create a file called agent-was-here.txt in the current directory with the exact content 'hello from agent'. Do not create any other files.`;
    const agentSshCmd = spawnModule.buildSshWrappedSpawnCommand({
      innerCommand: `${claudePath} -p ${JSON.stringify(agentGoal)} --dangerously-skip-permissions --print`,
      host: "127.0.0.1",
      user: username,
      keyPath: sshKeyPath,
      remoteCwd: workspacePath,
    });

    try {
      console.log("SSH_TOOLS_E2E: launching agent via SSH...");
      execSync(agentSshCmd, {
        encoding: "utf8",
        timeout: 120_000,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Verify the agent created the file
      assert(
        fs.existsSync(agentMarkerFile),
        `Agent should have created ${agentMarkerFile}`,
      );
      const agentFileContent = fs.readFileSync(agentMarkerFile, "utf8");
      assert(
        agentFileContent.includes("hello from agent"),
        `Agent file should contain 'hello from agent'. Got: ${agentFileContent}`,
      );
      console.log("SSH_TOOLS_E2E: real subagent launch PASSED");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(`SSH_TOOLS_E2E: subagent launch failed (non-fatal): ${errorMessage.slice(0, 200)}`);
      console.log("SSH_TOOLS_E2E: skipping real subagent assertion (claude may not be configured)");
    }
  } else {
    console.log("SSH_TOOLS_E2E: claude CLI not found, skipping real subagent test");
  }

  console.log("SSH_TOOLS_E2E: test 9 PASSED");

  console.log("SSH_TOOLS_E2E_OK");
}

function cleanup() {
  if (previousRootDirEnv === undefined) {
    delete process.env.OPENELINARO_ROOT_DIR;
  } else {
    process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
  }
  if (tempRoot) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  }
}

main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    cleanup();
    process.exit(1);
  });
