import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

describe("install-linux.sh", () => {
  test("supports dry-run mode on non-Linux hosts for package-manager coverage", () => {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-linux-install-"));
    tempRoots.push(targetRoot);

    const output = execFileSync(
      "bash",
      [path.join(process.cwd(), "scripts/install-linux.sh"), "--dry-run", "--non-interactive"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENELINARO_INSTALL_HOST_OS: "Linux",
          OPENELINARO_PACKAGE_MANAGER: "apt",
          OPENELINARO_LINUX_INSTALL_ROOT: targetRoot,
        },
        encoding: "utf8",
      },
    );

    expect(output).toContain("Detected package manager: apt");
    expect(output).toContain(`+ mkdir -p ${targetRoot}`);
    expect(output).toContain(`+ OPENELINARO_ROOT_DIR=${targetRoot} ${targetRoot}/scripts/service-install.sh`);
  });
});
