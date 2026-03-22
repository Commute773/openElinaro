import { $ } from "bun";

/**
 * Manages tmux sessions and windows for subagent worker processes.
 *
 * tmux is used for:
 * - Process persistence across runtime restarts
 * - Manual attach for debugging (tmux attach -t session:window)
 * - NOT as a source of truth for agent completion (use sidecar events)
 */
export class TmuxManager {
  constructor(private readonly sessionName: string) {}

  /** Ensure the tmux session exists. Idempotent. */
  async ensureSession(): Promise<void> {
    const result = await $`tmux has-session -t ${this.sessionName} 2>/dev/null`.nothrow().quiet();
    if (result.exitCode !== 0) {
      await $`tmux new-session -d -s ${this.sessionName} -x 200 -y 50`.quiet();
    }
  }

  /**
   * Create a new tmux window and run a command inside it.
   * The command's lifetime is the window's lifetime.
   */
  async runInWindow(windowName: string, command: string, cwd: string): Promise<void> {
    await this.ensureSession();
    await $`tmux new-window -t ${this.sessionName} -n ${windowName} -c ${cwd} ${command}`.quiet();
  }

  /**
   * Send keystrokes to a tmux window (for steering an interactive agent).
   * The text is sent as literal keystrokes followed by Enter.
   */
  async sendKeys(windowName: string, text: string): Promise<void> {
    await $`tmux send-keys -t ${this.sessionName}:${windowName} ${text} Enter`.quiet();
  }

  /** Kill a tmux window and its process. */
  async killWindow(windowName: string): Promise<void> {
    await $`tmux kill-window -t ${this.sessionName}:${windowName}`.nothrow().quiet();
  }

  /** Check if a tmux window still exists. */
  async hasWindow(windowName: string): Promise<boolean> {
    const result = await $`tmux list-windows -t ${this.sessionName} -F "#{window_name}"`.nothrow().quiet();
    if (result.exitCode !== 0) return false;
    const windows = result.text().trim().split("\n");
    return windows.includes(windowName);
  }

  /**
   * Capture the last N lines from a tmux pane. Debug-only.
   * Not a source of truth for completion status.
   */
  async capturePane(windowName: string, lines = 50): Promise<string> {
    const result = await $`tmux capture-pane -t ${this.sessionName}:${windowName} -p -S -${lines}`.nothrow().quiet();
    if (result.exitCode !== 0) return "";
    return result.text().trim();
  }

  /** List all window names in this session. */
  async listWindows(): Promise<string[]> {
    const result = await $`tmux list-windows -t ${this.sessionName} -F "#{window_name}"`.nothrow().quiet();
    if (result.exitCode !== 0) return [];
    return result.text().trim().split("\n").filter(Boolean);
  }
}
