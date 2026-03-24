import { $ } from "bun";
import { buildOpenElinaroCommandEnvironment } from "../services/shell-environment";

/**
 * Manages tmux sessions and windows for subagent worker processes.
 *
 * tmux is used for:
 * - Process persistence across runtime restarts
 * - Manual attach for debugging (tmux attach -t session:window)
 * - NOT as a source of truth for agent completion (use sidecar events)
 */
export class TmuxManager {
  private readonly env: Record<string, string>;

  constructor(private readonly sessionName: string) {
    this.env = buildOpenElinaroCommandEnvironment();
  }

  /** Ensure the tmux session exists. Idempotent. */
  async ensureSession(): Promise<void> {
    const result = await $`tmux has-session -t ${this.sessionName} 2>/dev/null`.env(this.env).nothrow().quiet();
    if (result.exitCode !== 0) {
      const create = await $`tmux new-session -d -s ${this.sessionName} -x 200 -y 50`.env(this.env).nothrow().quiet();
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
  async runInWindow(windowName: string, command: string, cwd: string): Promise<void> {
    await this.ensureSession();
    const result = await $`tmux new-window -t ${this.sessionName} -n ${windowName} -c ${cwd} ${command}`.env(this.env).nothrow().quiet();
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim();
      throw new Error(
        `Failed to create tmux window "${windowName}" (exit ${result.exitCode}).${stderr ? ` stderr: ${stderr}` : ""} Command: ${command.slice(0, 200)}`,
      );
    }
    // Keep window alive after process exits so we can capture output for diagnostics
    await $`tmux set-window-option -t ${this.sessionName}:${windowName} remain-on-exit on`.env(this.env).nothrow().quiet();
  }

  /**
   * Check if the process inside a tmux window is still running.
   * Returns false if the window doesn't exist or the pane is dead.
   */
  async isWindowProcessAlive(windowName: string): Promise<boolean> {
    const result = await $`tmux list-panes -t ${this.sessionName}:${windowName} -F "#{pane_dead}"`.env(this.env).nothrow().quiet();
    if (result.exitCode !== 0) return false;
    return result.text().trim() !== "1";
  }

  /**
   * Send keystrokes to a tmux window (for steering an interactive agent).
   * The text is sent as literal keystrokes followed by Enter.
   */
  async sendKeys(windowName: string, text: string): Promise<void> {
    await $`tmux send-keys -t ${this.sessionName}:${windowName} ${text} Enter`.env(this.env).quiet();
  }

  /** Kill a tmux window and its process. */
  async killWindow(windowName: string): Promise<void> {
    await $`tmux kill-window -t ${this.sessionName}:${windowName}`.env(this.env).nothrow().quiet();
  }

  /** Check if a tmux window still exists. */
  async hasWindow(windowName: string): Promise<boolean> {
    const result = await $`tmux list-windows -t ${this.sessionName} -F "#{window_name}"`.env(this.env).nothrow().quiet();
    if (result.exitCode !== 0) return false;
    const windows = result.text().trim().split("\n");
    return windows.includes(windowName);
  }

  /**
   * Capture the last N lines from a tmux pane. Debug-only.
   * Not a source of truth for completion status.
   */
  async capturePane(windowName: string, lines = 50): Promise<string> {
    const result = await $`tmux capture-pane -t ${this.sessionName}:${windowName} -p -S -${lines}`.env(this.env).nothrow().quiet();
    if (result.exitCode !== 0) return "";
    return result.text().trim();
  }

  /** List all window names in this session. */
  async listWindows(): Promise<string[]> {
    const result = await $`tmux list-windows -t ${this.sessionName} -F "#{window_name}"`.env(this.env).nothrow().quiet();
    if (result.exitCode !== 0) return [];
    return result.text().trim().split("\n").filter(Boolean);
  }
}
