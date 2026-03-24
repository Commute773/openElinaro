import fs from "node:fs";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";

describe("TmuxManager binary resolution", () => {
  test("resolves tmux binary from well-known paths", async () => {
    const { TmuxManager } = await import("./tmux");
    const mgr = new TmuxManager("test-session");
    const tmuxPath = (mgr as unknown as { tmux: string }).tmux;
    // Must be an absolute path to an existing binary
    expect(tmuxPath).toMatch(/^\/.*tmux$/);
    expect(fs.existsSync(tmuxPath)).toBe(true);
  });

  test("tmux binary works when process.env.PATH lacks /opt/homebrew/bin", async () => {
    // Simulate launchd environment: minimal PATH
    const origPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    try {
      // Force reimport to test fresh construction
      const mod = await import("./tmux");
      const mgr = new mod.TmuxManager("test-path-resolution");
      const tmuxPath = (mgr as unknown as { tmux: string }).tmux;

      // The resolved absolute path should work regardless of PATH
      const r = await $`${tmuxPath} -V`.nothrow().quiet();
      expect(r.exitCode).toBe(0);
      expect(r.text().trim()).toMatch(/^tmux \d/);
    } finally {
      process.env.PATH = origPath!;
    }
  });

  test("full session lifecycle works under stripped PATH", async () => {
    const origPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    try {
      const { TmuxManager } = await import("./tmux");
      const mgr = new TmuxManager("test-lifecycle");

      // Create session
      await mgr.ensureSession();

      // Run a command in a window (sleep keeps it alive long enough to verify)
      await mgr.runInWindow("test-win", "sleep 5", "/tmp");

      // Verify window exists and process is alive
      const hasWin = await mgr.hasWindow("test-win");
      expect(hasWin).toBe(true);
      const alive = await mgr.isWindowProcessAlive("test-win");
      expect(alive).toBe(true);

      // Cleanup
      await mgr.killWindow("test-win");
      await $`${(mgr as unknown as { tmux: string }).tmux} kill-session -t test-lifecycle`.nothrow().quiet();
    } finally {
      process.env.PATH = origPath!;
    }
  });
});
