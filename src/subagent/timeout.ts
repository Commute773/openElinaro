import type { TmuxManager } from "./tmux";

/**
 * Manages per-run timeouts for subagent processes.
 *
 * When a timeout fires:
 * 1. Sends a polite stop signal via tmux send-keys
 * 2. Waits a grace period for the agent to wrap up
 * 3. Kills the tmux window if still alive
 */
export class SubagentTimeoutManager {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly tmux: TmuxManager,
    private readonly graceMs: number,
  ) {}

  register(runId: string, timeoutMs: number, onTimeout: (runId: string) => void): void {
    this.clear(runId);
    const timer = setTimeout(async () => {
      this.timers.delete(runId);

      // Try a polite stop first
      const hasWindow = await this.tmux.hasWindow(runId);
      if (!hasWindow) {
        onTimeout(runId);
        return;
      }

      await this.tmux.sendKeys(runId, "/stop");

      // Grace period: wait, then force-kill if still alive
      setTimeout(async () => {
        const stillAlive = await this.tmux.hasWindow(runId);
        if (stillAlive) {
          await this.tmux.killWindow(runId);
        }
        onTimeout(runId);
      }, this.graceMs);
    }, timeoutMs);

    this.timers.set(runId, timer);
  }

  clear(runId: string): void {
    const timer = this.timers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(runId);
    }
  }

  clearAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  /** Get the remaining timeout for a run (for re-registration on restart). */
  has(runId: string): boolean {
    return this.timers.has(runId);
  }
}
