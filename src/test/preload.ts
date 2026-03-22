/**
 * Bun test preload script.
 *
 * Sets OPENELINARO_ROOT_DIR and OPENELINARO_USER_DATA_DIR to per-run temp
 * directories so that no test ever accidentally reads or writes to
 * ~/.openelinarotest.  Individual tests that need an isolated root still
 * create their own temp dirs and override these values -- this preload
 * simply acts as a safety net.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.OPENELINARO_ROOT_DIR) {
  const fallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openelinaro-test-preload-"));
  process.env.OPENELINARO_ROOT_DIR = fallbackRoot;

  // Clean up on exit so we don't leak temp dirs.
  process.on("exit", () => {
    try {
      fs.rmSync(fallbackRoot, { recursive: true, force: true });
    } catch {
      // Best effort; ignore errors during cleanup.
    }
  });
}

if (!process.env.OPENELINARO_USER_DATA_DIR) {
  const userDataDir = path.join(process.env.OPENELINARO_ROOT_DIR, ".openelinarotest");
  fs.mkdirSync(userDataDir, { recursive: true });
  process.env.OPENELINARO_USER_DATA_DIR = userDataDir;
}

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "test";
}
