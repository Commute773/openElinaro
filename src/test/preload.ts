/**
 * Bun test preload script.
 *
 * Sets OPENELINARO_ROOT_DIR to a per-run temp directory so that no test ever
 * accidentally reads or writes to ~/.openelinarotest.  Individual tests that
 * need an isolated root still create their own temp dirs and override this
 * value — this preload simply acts as a safety net.
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
