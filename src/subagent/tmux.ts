import fs from "node:fs";
import { $ } from "bun";

const TMUX_SEARCH_PATHS = [
  "/opt/homebrew/bin/tmux",
  "/usr/local/bin/tmux",
  "/usr/bin/tmux",
  "/bin/tmux",
];

function resolveTmuxBinary(): string {
  for (const candidate of TMUX_SEARCH_PATHS) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `tmux binary not found. Searched: ${TMUX_SEARCH_PATHS.join(", ")}. Install tmux (e.g. brew install tmux).`,
  );
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function wrapCommandWithEnv(command: string, env?: Record<string, string>) {
  if (!env || Object.keys(env).length === 0) {
    return command;
  }

  const exports = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  return `/usr/bin/env ${exports} ${command}`;
}

/**
 * Manages tmux sessions and windows for subagent worker processes.
 *
 * tmux is used for:
 * - Process persistence across runtime restarts
 * - Manual attach for debugging (tmux attach -t session:window)
 * - NOT as a source of truth for agent completion (use sidecar events)
 *
 * Uses the resolved absolute path to the tmux binary because Bun's $
 * shell resolves commands via process.env.PATH, which may not include
 * /opt/homebrew/bin when running under launchd.
 */
export class TmuxManager {
  private readonly tmux: string;

  constructor(private readonly sessionName: string) {
    this.tmux = resolveTmuxBinary();
  }

  /** Ensure the tmux session exists. Idempotent. */
  async ensureSession(): Promise<void> {
    const result = await $`${this.tmux} has-session -t ${this.sessionName} 2>/dev/null`.nothrow().quiet();
    if (result.exitCode !== 0) {
      const create = await $`${this.tmux} new-session -d -s ${this.sessionName} -x 200 -y 50`.nothrow().quiet();
      if (create.exitCode !== 0) {
        const stderr = create.stderr.toString().trim();
        throw new Error(
          `Failed to create tmux session "${this.sessionName}" (exit ${create.exitCode}).${stderr ? ` stderr: ${stderr}` : ""} Is tmux installed and working?`,
        );
      }
    }
  }

  /**
   * Create a new tmux window and run a command inside it.
   * Sets remain-on-exit so the window stays alive after process death,
   * allowing pane capture for diagnostics.
   */
  async runInWindow(
    windowName: string,
    command: string,
    cwd: string,
    env?: Record<string, string>,
  ): Promise<void> {
    await this.ensureSession();
    const resolvedCommand = wrapCommandWithEnv(command, env);
    const result = await $`${this.tmux} new-window -t ${this.sessionName} -n ${windowName} -c ${cwd} ${resolvedCommand}`.nothrow().quiet();
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim();
      throw new Error(
        `Failed to create tmux window "${windowName}" (exit ${result.exitCode}).${stderr ? ` stderr: ${stderr}` : ""} Command: ${resolvedCommand.slice(0, 200)}`,
      );
    }
    // Keep window alive after process exits so we can capture output for diagnostics
    await $`${this.tmux} set-window-option -t ${this.sessionName}:${windowName} remain-on-exit on`.nothrow().quiet();
  }

  /**
   * Check if the process inside a tmux window is still running.
   * Returns false if the window doesn't exist or the pane is dead.
   */
  async isWindowProcessAlive(windowName: string): Promise<boolean> {
    const result = await $`${this.tmux} list-panes -t ${this.sessionName}:${windowName} -F "#{pane_dead}"`.nothrow().quiet();
    if (result.exitCode !== 0) return false;
    return result.text().trim() !== "1";
  }

  /**
   * Send keystrokes to a tmux window (for steering an interactive agent).
   * The text is sent as literal keystrokes followed by Enter.
   */
  async sendKeys(windowName: string, text: string): Promise<void> {
    await $`${this.tmux} send-keys -t ${this.sessionName}:${windowName} ${text} Enter`.quiet();
  }

  /** Kill a tmux window and its process. */
  async killWindow(windowName: string): Promise<void> {
    await $`${this.tmux} kill-window -t ${this.sessionName}:${windowName}`.nothrow().quiet();
  }

  /** Check if a tmux window still exists. */
  async hasWindow(windowName: string): Promise<boolean> {
    const result = await $`${this.tmux} list-windows -t ${this.sessionName} -F "#{window_name}"`.nothrow().quiet();
    if (result.exitCode !== 0) return false;
    const windows = result.text().trim().split("\n");
    return windows.includes(windowName);
  }

  /**
   * Capture the last N lines from a tmux pane. Debug-only.
   * Not a source of truth for completion status.
   */
  async capturePane(windowName: string, lines = 50): Promise<string> {
    const result = await $`${this.tmux} capture-pane -t ${this.sessionName}:${windowName} -p -S -${lines}`.nothrow().quiet();
    if (result.exitCode !== 0) return "";
    return result.text().trim();
  }

  /**
   * Capture the full visible terminal buffer for a tmux pane.
   * Unlike capturePane (which captures the last N scrollback lines),
   * this captures the entire visible area including any alternate screen
   * content — useful for debugging interactive programs like claude/codex.
   */
  async readTerminal(windowName: string): Promise<string> {
    // -e: include escape sequences (stripped by default) — we DON'T want them
    // -p: print to stdout
    // -S 0: start from the very beginning of the visible area
    // First try the full scrollback + visible
    const result = await $`${this.tmux} capture-pane -t ${this.sessionName}:${windowName} -p -S - -E -`.nothrow().quiet();
    if (result.exitCode === 0) {
      const text = result.text();
      if (text.trim()) {
        return text;
      }
    }
    return this.capturePane(windowName, 200);
  }

  /** List all window names in this session. */
  async listWindows(): Promise<string[]> {
    const result = await $`${this.tmux} list-windows -t ${this.sessionName} -F "#{window_name}"`.nothrow().quiet();
    if (result.exitCode !== 0) return [];
    return result.text().trim().split("\n").filter(Boolean);
  }
}
