/**
 * E2E test: function layer surface equivalence.
 * Verifies that the function layer generates valid API routes and agent tools
 * from the same function definitions.
 *
 * This test does NOT call an LLM and is gated only on the test fixtures
 * being present (no auth credentials needed since it only tests tool metadata
 * and route generation, not actual API calls).
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, test } from "bun:test";

const repoRoot = process.cwd();

describe("function layer surface equivalence e2e", () => {
  test("generates valid API routes and agent tools from function definitions", () => {
    const runnerPath = path.join(repoRoot, "src/app/agent-function-layer.e2e.runner.ts");
    const stdout = execFileSync("bun", ["run", runnerPath], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      timeout: 60_000,
    });

    expect(stdout).toContain("FNLAYER_REGISTRY_BUILD_OK");
    expect(stdout).toContain("FNLAYER_AGENT_TOOLS_OK");
    expect(stdout).toContain("FNLAYER_API_ROUTES_OK");
    expect(stdout).toContain("FNLAYER_OPENAPI_OK");
    expect(stdout).toContain("FNLAYER_AUTH_DECLS_OK");
    expect(stdout).toContain("FNLAYER_CATALOG_OK");
  }, 80_000);
});
