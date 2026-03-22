/**
 * Helpers for resolving test fixture paths.
 *
 * Tests should use `getTestFixturesDir()` to read bundled fixture data instead
 * of referencing ~/.openelinarotest directly.  This keeps the test suite
 * portable across machines.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to `src/test/fixtures/` in the repository. */
export function getTestFixturesDir(): string {
  return path.join(__dirname, "fixtures");
}
