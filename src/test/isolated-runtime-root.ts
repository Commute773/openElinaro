/**
 * Reusable test harness for isolating `OPENELINARO_ROOT_DIR` (and optionally
 * other environment variables) behind a per-test temp directory.
 *
 * Usage:
 * ```ts
 * import { createIsolatedRuntimeRoot } from "../test/isolated-runtime-root";
 * const testRoot = createIsolatedRuntimeRoot();
 * beforeEach(() => testRoot.setup());
 * afterEach(() => testRoot.teardown());
 * ```
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createIsolatedRuntimeRoot(prefix = "openelinaro-test-") {
  let previousRootDirEnv: string | undefined;
  let runtimeRoot = "";

  return {
    get path() {
      return runtimeRoot;
    },
    setup() {
      previousRootDirEnv = process.env.OPENELINARO_ROOT_DIR;
      runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      process.env.OPENELINARO_ROOT_DIR = runtimeRoot;
      return runtimeRoot;
    },
    teardown() {
      if (previousRootDirEnv === undefined) {
        delete process.env.OPENELINARO_ROOT_DIR;
      } else {
        process.env.OPENELINARO_ROOT_DIR = previousRootDirEnv;
      }
      if (runtimeRoot) {
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
      }
      runtimeRoot = "";
    },
  };
}
