import type { AgentStreamEvent } from "../domain/assistant";

// ---------------------------------------------------------------------------
// Block model — mirrors the G2 UI's chatBlocks structure
// ---------------------------------------------------------------------------

interface ThinkingBlock { type: "thinking"; text: string }
interface ToolBlock { type: "tool"; name: string; state: "running" | "done" | "failed"; elapsed: string | null; summary: string | null }
interface TaskBlock { type: "task"; taskId: string; description: string; state: "running" | "done" | "failed"; elapsed: string | null; children: ToolBlock[] }
interface TextBlock { type: "text"; text: string }
interface StatusBlock { type: "status"; text: string }
interface ResultBlock { type: "result"; turns: number; duration: string; cost: string }

type Block = ThinkingBlock | ToolBlock | TaskBlock | TextBlock | StatusBlock | ResultBlock;

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const IC_RUN = "\u25D0"; // ◐
const IC_OK = "\u2713";  // ✓
const IC_ERR = "\u2717"; // ✗

function stateIcon(state: "running" | "done" | "failed"): string {
  return state === "running" ? IC_RUN : state === "failed" ? IC_ERR : IC_OK;
}

// ---------------------------------------------------------------------------
// TurnRenderer — accumulates stream events, produces a text snapshot
// ---------------------------------------------------------------------------

export class TurnRenderer {
  private blocks: Block[] = [];

  /** Push a stream event into the block model. */
  push(event: AgentStreamEvent): void {
    switch (event.type) {
      case "thinking": {
        const last = this.blocks[this.blocks.length - 1];
        if (last?.type === "thinking") { last.text = event.text; }
        else this.blocks.push({ type: "thinking", text: event.text });
        break;
      }
      case "tool_start": {
        const toolBlock: ToolBlock = { type: "tool", name: event.name, state: "running", elapsed: null, summary: null };
        if (event.taskId) {
          const task = this.findTaskBlock(event.taskId);
          if (task) { task.children.push(toolBlock); break; }
        }
        this.blocks.push(toolBlock);
        break;
      }
      case "tool_progress": {
        const tool = this.findRunningTool(event.name, event.taskId);
        if (tool) {
          if (event.elapsed != null) tool.elapsed = event.elapsed.toFixed(1) + "s";
          if (event.message) tool.summary = event.message;
        }
        break;
      }
      case "tool_end": {
        const tool = this.findRunningTool(event.name, undefined);
        if (tool) {
          tool.state = event.isError ? "failed" : "done";
          if (event.summary) tool.summary = event.summary;
          if (event.error) tool.summary = event.error;
        }
        break;
      }
      case "tool_summary": {
        const tool = this.findRecentTool();
        if (tool) tool.summary = event.summary;
        break;
      }
      case "task_started":
        this.blocks.push({ type: "task", taskId: event.taskId, description: event.description ?? event.taskId, state: "running", elapsed: null, children: [] });
        break;
      case "task_progress": {
        const task = this.findTaskBlock(event.taskId);
        if (task && event.durationMs) {
          task.elapsed = (event.durationMs / 1000).toFixed(1) + "s";
        }
        break;
      }
      case "task_completed": {
        const task = this.findTaskBlock(event.taskId);
        if (task) {
          task.state = (event.status === "error" || event.status === "failed") ? "failed" : "done";
          if (event.summary && !task.elapsed) task.elapsed = event.summary;
        }
        break;
      }
      case "text":
        this.blocks.push({ type: "text", text: event.text });
        break;
      case "agent_init":
        // Suppress verbose init
        break;
      case "compaction":
        this.blocks.push({ type: "status", text: "Compacting..." });
        break;
      case "result":
        this.blocks.push({ type: "result", turns: event.turns, duration: (event.durationMs / 1000).toFixed(1) + "s", cost: "$" + event.costUsd.toFixed(4) });
        break;
      case "error":
        this.blocks.push({ type: "status", text: IC_ERR + " " + event.message });
        break;
      case "status":
      case "progress":
        this.blocks.push({ type: "status", text: event.message });
        break;
    }
  }

  /** Produce a plain-text snapshot of the current turn state. */
  snapshot(maxChars?: number): string {
    const lines = this.flattenBlocks();
    let text = lines.join("\n");
    if (maxChars && text.length > maxChars) {
      text = this.flattenBlocksTruncated(maxChars);
    }
    return text;
  }

  /** Whether there are any blocks accumulated. */
  get empty(): boolean {
    return this.blocks.length === 0;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private findTaskBlock(taskId: string): TaskBlock | undefined {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]!;
      if (b.type === "task" && b.taskId === taskId) return b;
    }
    return undefined;
  }

  private findRunningTool(name: string, taskId: string | undefined): ToolBlock | undefined {
    if (taskId) {
      const task = this.findTaskBlock(taskId);
      if (task) {
        for (let i = task.children.length - 1; i >= 0; i--) {
          const child = task.children[i]!;
          if (child.name === name && child.state === "running") return child;
        }
      }
    }
    // Fall through: search top-level and all tasks
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]!;
      if (b.type === "tool" && b.name === name && b.state === "running") return b;
      if (b.type === "task") {
        for (let j = b.children.length - 1; j >= 0; j--) {
          const child = b.children[j]!;
          if (child.name === name && child.state === "running") return child;
        }
      }
    }
    return undefined;
  }

  private findRecentTool(): ToolBlock | undefined {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]!;
      if (b.type === "tool") return b;
      if (b.type === "task" && b.children.length > 0) return b.children[b.children.length - 1]!;
    }
    return undefined;
  }

  private flattenBlocks(): string[] {
    const lines: string[] = [];
    for (const block of this.blocks) {
      switch (block.type) {
        case "thinking": {
          const preview = block.text.length > 60 ? block.text.slice(0, 60) + "..." : block.text;
          lines.push("*" + preview + "*");
          break;
        }
        case "tool":
          lines.push(this.toolLine(block));
          if (block.summary) lines.push("  " + block.summary);
          break;
        case "task": {
          const icon = stateIcon(block.state);
          const time = block.elapsed ? " (" + block.elapsed + ")" : "";
          lines.push(icon + " " + block.description + time);
          const childLines: string[] = [];
          for (const child of block.children) {
            const cIcon = stateIcon(child.state);
            const cTime = child.elapsed ? " (" + child.elapsed + ")" : "";
            childLines.push("  | " + cIcon + " " + child.name + cTime);
            if (child.summary) childLines.push("  |   " + child.summary);
          }
          const MAX_AGENT_LINES = 6;
          if (childLines.length > MAX_AGENT_LINES) {
            const hidden = childLines.length - MAX_AGENT_LINES;
            lines.push("  | ... (+" + hidden + " hidden)");
            for (const l of childLines.slice(-MAX_AGENT_LINES)) lines.push(l);
          } else {
            for (const l of childLines) lines.push(l);
          }
          break;
        }
        case "text":
          lines.push(block.text);
          break;
        case "result":
          lines.push(block.turns + " turns  " + block.duration + "  " + block.cost);
          break;
        case "status":
          lines.push(block.text);
          break;
      }
    }
    return lines;
  }

  /**
   * Produce a truncated snapshot that fits within maxChars.
   * Strategy: keep the most recent blocks, collapse older ones.
   */
  private flattenBlocksTruncated(maxChars: number): string {
    const allLines = this.flattenBlocks();
    // Work backwards — keep as many recent lines as fit
    const kept: string[] = [];
    let budget = maxChars - 20; // reserve space for ellipsis line
    for (let i = allLines.length - 1; i >= 0; i--) {
      const line = allLines[i]!;
      const cost = line.length + 1; // +1 for newline
      if (budget - cost < 0) break;
      budget -= cost;
      kept.unshift(line);
    }
    if (kept.length < allLines.length) {
      const hidden = allLines.length - kept.length;
      kept.unshift("... (" + hidden + " lines hidden)");
    }
    return kept.join("\n");
  }

  private toolLine(tool: ToolBlock): string {
    const icon = stateIcon(tool.state);
    const time = tool.elapsed ? " (" + tool.elapsed + ")" : "";
    return icon + " " + tool.name + time;
  }
}
