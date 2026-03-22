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

// Do NOT set OPENELINARO_USER_DATA_DIR here.  The runtime-root module
// already derives it from OPENELINARO_ROOT_DIR when NODE_ENV=test.
// Setting it in the preload would freeze the value, so tests that later
// override OPENELINARO_ROOT_DIR would still read from the preload's
// user-data directory instead of their own isolated root.

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "test";
}
