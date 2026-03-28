import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TmuxManager } from "./tmux";
import { SubagentSidecar } from "./sidecar";
import { SubagentRegistry } from "./registry";
import { SubagentTimeoutManager } from "./timeout";
import {
  buildClaudeSpawnCommand,
  buildCodexSpawnCommand,
  writeClaudeHooksConfig,
  writeCodexNotifyConfig,
  cleanupHooksDir,
} from "./spawn";
import type { SubagentEvent } from "./events";
import type { SubagentRun } from "../domain/subagent-run";
import { buildOpenElinaroCommandEnvironment } from "../services/shell-environment";
import { summarizeAgentRun } from "../services/subagent-summary-service";

/**
 * Real E2E tests that launch actual Claude Code and Codex subagents.
 *
 * These tests require:
 * - claude binary at /Users/elinaro/.local/bin/claude (or discoverable)
 * - codex binary at /opt/homebrew/bin/codex (or discoverable)
 * - Valid API keys configured for both tools
 * - tmux installed
 *
 * Skip with: SKIP_SUBAGENT_E2E=1 bun test
 */

const SKIP = process.env.SKIP_SUBAGENT_E2E === "1";
const CLAUDE_BIN = "/Users/elinaro/.local/bin/claude";
const CODEX_BIN = "/opt/homebrew/bin/codex";
const TEST_SESSION = "openelinaro-e2e-test";
const TEST_CWD = "/tmp";
const SOCKET_PATH = `/tmp/openelinaro-e2e-sidecar-${process.pid}.sock`;
const COMPLETION_TIMEOUT_MS = 120_000; // 2 minutes for real API calls
const STRIPPED_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

let tmux: TmuxManager;
let sidecar: SubagentSidecar;
let registry: SubagentRegistry;
let timeouts: SubagentTimeoutManager;
const events: SubagentEvent[] = [];
const completedRuns = new Map<string, SubagentEvent>();

function waitForEvent(runId: string, kind: string, timeoutMs = COMPLETION_TIMEOUT_MS): Promise<SubagentEvent> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${kind} event on run ${runId} after ${timeoutMs}ms`));
    }, timeoutMs);

    const check = () => {
      const match = events.find((e) => e.runId === runId && e.kind === kind);
      if (match) {
        clearTimeout(deadline);
        resolve(match);
        return;
      }
      setTimeout(check, 250);
    };
    check();
  });
}

if (!SKIP) {
  beforeAll(() => {
    tmux = new TmuxManager(TEST_SESSION);
    sidecar = new SubagentSidecar(SOCKET_PATH);
    registry = new SubagentRegistry();
    timeouts = new SubagentTimeoutManager(tmux, 5_000);

    sidecar.onEvent(async (event) => {
      events.push(event);
      if (event.kind === "worker.completed" || event.kind === "worker.failed") {
        completedRuns.set(event.runId, event);
      }
    });

    sidecar.start();
  });

  afterAll(async () => {
    timeouts.clearAll();
    // Kill any leftover test windows
    const windows = await tmux.listWindows();
    for (const w of windows) {
      if (w.startsWith("e2e-")) {
        await tmux.killWindow(w);
      }
    }
    // Kill test session
    try {
      const tmuxBin = (tmux as unknown as { tmux: string }).tmux;
      const { $ } = await import("bun");
      await $`${tmuxBin} kill-session -t ${TEST_SESSION}`.nothrow().quiet();
    } catch { /* ignore */ }
    sidecar.stop();
  });
}

const describeE2E = SKIP ? describe.skip : describe;

describeE2E("subagent E2E — claude code", () => {
  const hasClaude = fs.existsSync(CLAUDE_BIN);
  const runTest = hasClaude ? test : test.skip;

  runTest("launches claude, completes a trivial file-creation task", async () => {
    const runId = `e2e-claude-${Date.now()}`;
    const targetFile = `/tmp/e2e-claude-test-${Date.now()}.txt`;
    const goal = `Create a file at ${targetFile} containing exactly 'claude-e2e-ok'. Do not explain, just do it.`;

    // Write hooks config
    const { settingsPath } = writeClaudeHooksConfig({
      runId,
      worktreeCwd: TEST_CWD,
      sidecarSocketPath: sidecar.socketPath,
    });

    // Build spawn command (no model — let claude use its default)
    const command = buildClaudeSpawnCommand({
      runId,
      provider: "claude",
      binaryPath: CLAUDE_BIN,
      goal,
      cwd: TEST_CWD,
      profileId: "root",
      sidecarSocketPath: sidecar.socketPath,
      timeoutMs: COMPLETION_TIMEOUT_MS,
      hooksSettingsPath: settingsPath,
    });

    // Launch in tmux
    await tmux.runInWindow(runId, command, TEST_CWD);

    // Verify window exists and process is alive
    expect(await tmux.hasWindow(runId)).toBe(true);
    expect(await tmux.isWindowProcessAlive(runId)).toBe(true);

    // Wait for completion event from hooks
    const event = await waitForEvent(runId, "worker.completed");
    expect(event.provider).toBe("claude");

    // Verify the file was actually created
    expect(fs.existsSync(targetFile)).toBe(true);
    const content = fs.readFileSync(targetFile, "utf8").trim();
    expect(content).toBe("claude-e2e-ok");

    // Cleanup
    await tmux.killWindow(runId);
    cleanupHooksDir(runId);
    fs.rmSync(targetFile, { force: true });
  }, COMPLETION_TIMEOUT_MS + 10_000);

  runTest("can read agent status while running", async () => {
    const runId = `e2e-claude-status-${Date.now()}`;
    const goal = "Wait for 10 seconds by running 'sleep 10' in the terminal, then exit.";

    const { settingsPath } = writeClaudeHooksConfig({
      runId,
      worktreeCwd: TEST_CWD,
      sidecarSocketPath: sidecar.socketPath,
    });

    const command = buildClaudeSpawnCommand({
      runId,
      provider: "claude",
      binaryPath: CLAUDE_BIN,
      goal,
      cwd: TEST_CWD,
      profileId: "root",
      sidecarSocketPath: sidecar.socketPath,
      timeoutMs: COMPLETION_TIMEOUT_MS,
      hooksSettingsPath: settingsPath,
    });

    await tmux.runInWindow(runId, command, TEST_CWD);

    // Give it a moment to start and produce output
    await Bun.sleep(5_000);

    // Status: window should exist and be alive
    expect(await tmux.hasWindow(runId)).toBe(true);
    expect(await tmux.isWindowProcessAlive(runId)).toBe(true);

    // Capture pane output — may or may not have content yet depending on timing
    const pane = await tmux.capturePane(runId, 20);
    // Just verify capturePane doesn't throw; content depends on timing
    expect(typeof pane).toBe("string");

    // Wait for completion then clean up
    await waitForEvent(runId, "worker.completed");
    await tmux.killWindow(runId);
    cleanupHooksDir(runId);
  }, COMPLETION_TIMEOUT_MS + 10_000);

  runTest("can send keys to a running agent via tmux", async () => {
    const runId = `e2e-claude-steer-${Date.now()}`;
    const targetFile = `/tmp/e2e-steer-test-${Date.now()}.txt`;
    const goal = `Create a file at ${targetFile} containing 'steer-phase-1'. Then wait for further instructions by asking the user what to do next.`;

    const { settingsPath } = writeClaudeHooksConfig({
      runId,
      worktreeCwd: TEST_CWD,
      sidecarSocketPath: sidecar.socketPath,
    });

    const command = buildClaudeSpawnCommand({
      runId,
      provider: "claude",
      binaryPath: CLAUDE_BIN,
      goal,
      cwd: TEST_CWD,
      profileId: "root",
      sidecarSocketPath: sidecar.socketPath,
      timeoutMs: COMPLETION_TIMEOUT_MS,
      hooksSettingsPath: settingsPath,
    });

    await tmux.runInWindow(runId, command, TEST_CWD);

    // Wait for the initial task to complete (file creation)
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !fs.existsSync(targetFile)) {
      await Bun.sleep(500);
    }

    // Verify phase 1 completed
    if (fs.existsSync(targetFile)) {
      expect(fs.readFileSync(targetFile, "utf8").trim()).toBe("steer-phase-1");
    }

    // Steer: sendKeys should not throw on a running window
    if (await tmux.isWindowProcessAlive(runId)) {
      await tmux.sendKeys(runId, "Now exit. /exit");
    }

    // Wait for completion (either from the steer or the original task finishing)
    await waitForEvent(runId, "worker.completed", 60_000);

    await tmux.killWindow(runId);
    cleanupHooksDir(runId);
    fs.rmSync(targetFile, { force: true });
  }, COMPLETION_TIMEOUT_MS + 30_000);

  runTest("can cancel a running agent", async () => {
    const runId = `e2e-claude-cancel-${Date.now()}`;
    const goal = "Run 'sleep 300' in the terminal. Do nothing else.";

    const { settingsPath } = writeClaudeHooksConfig({
      runId,
      worktreeCwd: TEST_CWD,
      sidecarSocketPath: sidecar.socketPath,
    });

    const command = buildClaudeSpawnCommand({
      runId,
      provider: "claude",
      binaryPath: CLAUDE_BIN,
      goal,
      cwd: TEST_CWD,
      profileId: "root",
      sidecarSocketPath: sidecar.socketPath,
      timeoutMs: COMPLETION_TIMEOUT_MS,
      hooksSettingsPath: settingsPath,
    });

    await tmux.runInWindow(runId, command, TEST_CWD);
    await Bun.sleep(3_000);

    expect(await tmux.isWindowProcessAlive(runId)).toBe(true);

    // Cancel by killing the window
    await tmux.killWindow(runId);
    await Bun.sleep(1_000);

    // Window should be gone
    expect(await tmux.hasWindow(runId)).toBe(false);

    cleanupHooksDir(runId);
  }, 30_000);
});

describeE2E("subagent E2E — codex", () => {
  const hasCodex = fs.existsSync(CODEX_BIN);
  const runTest = hasCodex ? test : test.skip;

  runTest("launches codex, completes a trivial file-creation task", async () => {
    const runId = `e2e-codex-${Date.now()}`;
    const targetFile = `/tmp/e2e-codex-test-${Date.now()}.txt`;
    const goal = `Create a file at ${targetFile} containing exactly 'codex-e2e-ok'.`;

    // Write notify config
    const notifyScriptPath = writeCodexNotifyConfig({
      runId,
      sidecarSocketPath: sidecar.socketPath,
    });

    // Build spawn command (no model)
    const command = buildCodexSpawnCommand({
      runId,
      provider: "codex",
      binaryPath: CODEX_BIN,
      goal,
      cwd: TEST_CWD,
      profileId: "root",
      sidecarSocketPath: sidecar.socketPath,
      timeoutMs: COMPLETION_TIMEOUT_MS,
      notifyScriptPath,
    });

    // Launch in tmux
    await tmux.runInWindow(runId, command, TEST_CWD);
    expect(await tmux.hasWindow(runId)).toBe(true);

    // Wait for completion event from notify script
    const event = await waitForEvent(runId, "worker.completed");
    expect(event.provider).toBe("codex");

    // Verify the file was actually created
    expect(fs.existsSync(targetFile)).toBe(true);
    const content = fs.readFileSync(targetFile, "utf8").trim();
    expect(content).toBe("codex-e2e-ok");

    // Cleanup
    await tmux.killWindow(runId);
    cleanupHooksDir(runId);
    fs.rmSync(targetFile, { force: true });
  }, COMPLETION_TIMEOUT_MS + 10_000);

  runTest("fails under a stripped PATH when node is unavailable to Codex dispatch", async () => {
    const runId = `e2e-codex-path-fail-${Date.now()}`;

    const notifyScriptPath = writeCodexNotifyConfig({
      runId,
      sidecarSocketPath: sidecar.socketPath,
    });

    const command = buildCodexSpawnCommand({
      runId,
      provider: "codex",
      binaryPath: CODEX_BIN,
      goal: "Print exactly 'path-failure-check' and exit.",
      cwd: TEST_CWD,
      profileId: "root",
      sidecarSocketPath: sidecar.socketPath,
      timeoutMs: COMPLETION_TIMEOUT_MS,
      notifyScriptPath,
    });

    await tmux.runInWindow(runId, command, TEST_CWD, { PATH: STRIPPED_PATH });

    const event = await waitForEvent(runId, "worker.failed", 30_000);
    const pane = await tmux.readTerminal(runId);

    expect(event.provider).toBe("codex");
    expect(`${JSON.stringify(event.payload)}\n${pane}`.toLowerCase()).toMatch(/node|no such file|not found/);

    await tmux.killWindow(runId);
    cleanupHooksDir(runId);
  }, 40_000);

  runTest("launches Codex successfully under the same stripped PATH when the hardened env is applied", async () => {
    const runId = `e2e-codex-path-pass-${Date.now()}`;
    const targetFile = `/tmp/e2e-codex-path-pass-${Date.now()}.txt`;

    const notifyScriptPath = writeCodexNotifyConfig({
      runId,
      sidecarSocketPath: sidecar.socketPath,
    });

    const command = buildCodexSpawnCommand({
      runId,
      provider: "codex",
      binaryPath: CODEX_BIN,
      goal: `Create a file at ${targetFile} containing exactly 'codex-path-ok'.`,
      cwd: TEST_CWD,
      profileId: "root",
      sidecarSocketPath: sidecar.socketPath,
      timeoutMs: COMPLETION_TIMEOUT_MS,
      notifyScriptPath,
    });

    const env = buildOpenElinaroCommandEnvironment({ PATH: STRIPPED_PATH });
    await tmux.runInWindow(runId, command, TEST_CWD, env);

    const event = await waitForEvent(runId, "worker.completed");
    expect(event.provider).toBe("codex");
    expect(fs.existsSync(targetFile)).toBe(true);
    expect(fs.readFileSync(targetFile, "utf8").trim()).toBe("codex-path-ok");

    await tmux.killWindow(runId);
    cleanupHooksDir(runId);
    fs.rmSync(targetFile, { force: true });
  }, COMPLETION_TIMEOUT_MS + 10_000);
});

describeE2E("subagent E2E — interactive terminal summary", () => {
  const hasClaude = fs.existsSync(CLAUDE_BIN);
  const runTest = hasClaude ? test : test.skip;

  runTest("summarizes a live Claude run from the full terminal buffer", async () => {
    const runId = `e2e-claude-summary-${Date.now()}`;

    const { settingsPath } = writeClaudeHooksConfig({
      runId,
      worktreeCwd: TEST_CWD,
      sidecarSocketPath: sidecar.socketPath,
    });

    const command = buildClaudeSpawnCommand({
      runId,
      provider: "claude",
      binaryPath: CLAUDE_BIN,
      goal: "Think about the phrase full-screen-summary-check, then wait for further instructions instead of exiting immediately.",
      cwd: TEST_CWD,
      profileId: "root",
      sidecarSocketPath: sidecar.socketPath,
      timeoutMs: COMPLETION_TIMEOUT_MS,
      hooksSettingsPath: settingsPath,
    });

    await tmux.runInWindow(runId, command, TEST_CWD);

    const run: SubagentRun = {
      id: runId,
      profileId: "root",
      provider: "claude",
      goal: "Think about the phrase full-screen-summary-check, then wait for further instructions instead of exiting immediately.",
      status: "running",
      tmuxSession: TEST_SESSION,
      tmuxWindow: runId,
      workspaceCwd: TEST_CWD,
      createdAt: new Date().toISOString(),
      launchDepth: 1,
      timeoutMs: COMPLETION_TIMEOUT_MS,
      eventLog: [],
    };

    let terminal = "";
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      terminal = await tmux.readTerminal(runId);
      if (terminal.trim().length >= 120) {
        break;
      }
      await Bun.sleep(1_000);
    }

    expect(terminal.trim().length).toBeGreaterThanOrEqual(120);

    const summary = await summarizeAgentRun({
      runId,
      subagents: {
        getAgentRun: (requestedRunId: string) => requestedRunId === runId ? run : undefined,
        readAgentTerminal: async () => terminal,
      },
      models: {
        summarizeToolResult: async ({ output }: { output: string }) =>
          output.trim().length >= 120
            ? "Captured alternate-screen terminal content from the running Claude session."
            : "insufficient evidence",
      } as never,
    });

    expect(summary).toBe("Captured alternate-screen terminal content from the running Claude session.");

    if (await tmux.isWindowProcessAlive(runId)) {
      await tmux.sendKeys(runId, "/exit");
    }
    await tmux.killWindow(runId);
    cleanupHooksDir(runId);
  }, 45_000);
});

describeE2E("subagent E2E — registry state tracking", () => {
  test("registry tracks run lifecycle: starting → running → completed", async () => {
    const runId = `e2e-registry-${Date.now()}`;

    // Create
    const run = registry.create({
      id: runId,
      profileId: "root",
      provider: "claude",
      goal: "test registry lifecycle",
      tmuxSession: TEST_SESSION,
      tmuxWindow: runId,
      workspaceCwd: TEST_CWD,
      launchDepth: 1,
      timeoutMs: 60_000,
    });
    expect(run.status).toBe("starting");
    expect(registry.get(runId)?.status).toBe("starting");

    // Mark started
    const started = registry.markStarted(runId);
    expect(started?.status).toBe("running");
    expect(started?.startedAt).toBeTruthy();

    // Mark completed
    const completed = registry.markCompleted(runId, "task done");
    expect(completed?.status).toBe("completed");
    expect(completed?.completedAt).toBeTruthy();
    expect(completed?.resultSummary).toBe("task done");

    // List includes this run
    const all = registry.list();
    const found = all.find((r) => r.id === runId);
    expect(found?.status).toBe("completed");
  });

  test("registry tracks failed runs with error", () => {
    const runId = `e2e-registry-fail-${Date.now()}`;

    registry.create({
      id: runId,
      profileId: "root",
      provider: "codex",
      goal: "test failure tracking",
      tmuxSession: TEST_SESSION,
      tmuxWindow: runId,
      workspaceCwd: TEST_CWD,
      launchDepth: 1,
      timeoutMs: 60_000,
    });
    registry.markStarted(runId);

    const failed = registry.markFailed(runId, "process crashed");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("process crashed");
    expect(failed?.completedAt).toBeTruthy();
  });

  test("registry tracks cancelled runs", () => {
    const runId = `e2e-registry-cancel-${Date.now()}`;

    registry.create({
      id: runId,
      profileId: "root",
      provider: "claude",
      goal: "test cancel tracking",
      tmuxSession: TEST_SESSION,
      tmuxWindow: runId,
      workspaceCwd: TEST_CWD,
      launchDepth: 1,
      timeoutMs: 60_000,
    });
    registry.markStarted(runId);

    const cancelled = registry.markCancelled(runId);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.completedAt).toBeTruthy();
  });

  test("registry appends events to run log", () => {
    const runId = `e2e-registry-events-${Date.now()}`;

    registry.create({
      id: runId,
      profileId: "root",
      provider: "claude",
      goal: "test event logging",
      tmuxSession: TEST_SESSION,
      tmuxWindow: runId,
      workspaceCwd: TEST_CWD,
      launchDepth: 1,
      timeoutMs: 60_000,
    });

    registry.appendEvent(runId, {
      kind: "worker.progress",
      timestamp: new Date().toISOString(),
      summary: "working on it",
    });

    registry.appendEvent(runId, {
      kind: "worker.completed",
      timestamp: new Date().toISOString(),
      summary: "done",
    });

    const run = registry.get(runId)!;
    expect(run.eventLog).toHaveLength(2);
    expect(run.eventLog[0]!.kind).toBe("worker.progress");
    expect(run.eventLog[1]!.kind).toBe("worker.completed");
  });
});

describeE2E("subagent E2E — sidecar event routing", () => {
  test("sidecar receives and routes claude hook events", async () => {
    const testRunId = `e2e-sidecar-claude-${Date.now()}`;
    const before = events.length;

    // POST a synthetic claude hook event to the sidecar
    const response = await fetch(`http://localhost/events/claude`, {
      method: "POST",
      unix: sidecar.socketPath,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: testRunId,
        hookType: "Stop",
        exitCode: 0,
        result: "test complete",
        error: "",
      }),
    } as RequestInit);

    expect(response.ok).toBe(true);
    await Bun.sleep(100);

    const newEvents = events.slice(before);
    expect(newEvents.length).toBeGreaterThanOrEqual(1);
    const event = newEvents.find((e) => e.runId === testRunId);
    expect(event).toBeTruthy();
    expect(event!.kind).toBe("worker.completed");
    expect(event!.provider).toBe("claude");
  });

  test("sidecar receives and routes codex notify events", async () => {
    const testRunId = `e2e-sidecar-codex-${Date.now()}`;
    const before = events.length;

    const response = await fetch(`http://localhost/events/codex`, {
      method: "POST",
      unix: sidecar.socketPath,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: testRunId,
        exitCode: 0,
        output: "all done",
        error: "",
      }),
    } as RequestInit);

    expect(response.ok).toBe(true);
    await Bun.sleep(100);

    const newEvents = events.slice(before);
    const event = newEvents.find((e) => e.runId === testRunId);
    expect(event).toBeTruthy();
    expect(event!.kind).toBe("worker.completed");
    expect(event!.provider).toBe("codex");
  });

  test("sidecar routes failed events correctly", async () => {
    const testRunId = `e2e-sidecar-fail-${Date.now()}`;
    const before = events.length;

    await fetch(`http://localhost/events/claude`, {
      method: "POST",
      unix: sidecar.socketPath,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: testRunId,
        hookType: "Stop",
        exitCode: 1,
        result: "",
        error: "something went wrong",
      }),
    } as RequestInit);

    await Bun.sleep(100);

    const event = events.slice(before).find((e) => e.runId === testRunId);
    expect(event).toBeTruthy();
    expect(event!.kind).toBe("worker.failed");
  });
});
