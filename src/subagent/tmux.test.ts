import path from "node:path";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { buildOpenElinaroCommandEnvironment } from "../services/shell-environment";

describe("TmuxManager PATH resolution", () => {
  test("buildOpenElinaroCommandEnvironment includes /opt/homebrew/bin even when process PATH is stripped", () => {
    // Simulate a minimal server PATH that doesn't include homebrew
    const env = buildOpenElinaroCommandEnvironment({
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    });
    const pathEntries = env.PATH!.split(path.delimiter);
    expect(pathEntries).toContain("/opt/homebrew/bin");
    expect(pathEntries).toContain("/usr/local/bin");
  });

  test("Bun $ with .env() uses the provided PATH for command resolution", async () => {
    // This test mirrors exactly what TmuxManager does: run a command
    // via Bun's $ with .env() to ensure PATH is respected.

    // Step 1: Stripped PATH — 'tmux' should NOT be found
    const stripped = await $`which tmux`
      .env({ PATH: "/usr/bin:/bin" })
      .nothrow()
      .quiet();
    // tmux is not at /usr/bin or /bin, so this should fail
    expect(stripped.exitCode).not.toBe(0);

    // Step 2: With buildOpenElinaroCommandEnvironment — 'tmux' SHOULD be found
    // This is the exact same pattern TmuxManager uses
    const env = buildOpenElinaroCommandEnvironment({
      PATH: "/usr/bin:/bin",
    });
    const withEnv = await $`which tmux`
      .env(env)
      .nothrow()
      .quiet();

    if (withEnv.exitCode === 0) {
      // tmux is installed — verify it resolved to a homebrew or standard path
      const tmuxPath = withEnv.text().trim();
      expect(tmuxPath).toMatch(/\btmux$/);
    } else {
      // tmux not installed on this machine — skip the resolution check
      // but the env PATH should still contain the expected directories
      expect(env.PATH!.split(path.delimiter)).toContain("/opt/homebrew/bin");
    }
  });

  test("TmuxManager constructor builds env with /opt/homebrew/bin in PATH", async () => {
    // Import TmuxManager and verify the env it constructs
    const { TmuxManager } = await import("./tmux");
    const mgr = new TmuxManager("test-session");
    // Access the private env via cast — acceptable in a test
    const env = (mgr as unknown as { env: Record<string, string> }).env;
    const pathEntries = env.PATH!.split(path.delimiter);
    expect(pathEntries).toContain("/opt/homebrew/bin");
    expect(pathEntries).toContain("/usr/local/bin");
  });
});
