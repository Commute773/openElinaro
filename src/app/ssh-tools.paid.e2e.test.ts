import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

const repoRoot = process.cwd();

function canSshToLocalhost(): boolean {
  const sshKeyPath = path.join(os.homedir(), ".ssh", "id_ed25519");
  if (!fs.existsSync(sshKeyPath)) {
    return false;
  }
  const username = os.userInfo().username;
  try {
    execSync(
      `ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -i ${sshKeyPath} ${username}@127.0.0.1 echo ok`,
      { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    return true;
  } catch {
    return false;
  }
}

const RUN_SSH_E2E =
  process.env.OPENELINARO_ENABLE_SSH_E2E !== "0" && canSshToLocalhost();

describe("SSH tools e2e", () => {
  // Skip when SSH to localhost is not available (requires ssh key and local sshd).
  // Disable explicitly with OPENELINARO_ENABLE_SSH_E2E=0.
  const liveTest = RUN_SSH_E2E ? test : test.skip;

  liveTest("exercises all SSH tools and subagent launching via real SSH to localhost", () => {
    const runnerPath = path.join(repoRoot, "src/app/ssh-tools.e2e.runner.ts");
    const stdout = execFileSync("bun", ["run", runnerPath], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      timeout: 300_000,
    });

    expect(stdout).toContain("SSH_TOOLS_E2E_OK");
  }, 320_000);
});
