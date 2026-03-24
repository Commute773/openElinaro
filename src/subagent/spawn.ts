import fs from "node:fs";
import path from "node:path";
import type { SubagentProvider } from "../domain/subagent-run";
import { resolveRuntimePath } from "../services/runtime-root";

export interface SpawnAgentParams {
  runId: string;
  provider: SubagentProvider;
  binaryPath: string;
  goal: string;
  cwd: string;
  profileId: string;
  sidecarSocketPath: string;
  timeoutMs: number;
  model?: string;
}

function getHooksDir(runId: string): string {
  return resolveRuntimePath("subagent-hooks", runId);
}

/**
 * Build the shell command to spawn a Claude Code agent in interactive mode.
 *
 * Hooks are passed via --settings flag so they're picked up regardless of
 * project directory configuration. The goal is passed via -p flag.
 */
export function buildClaudeSpawnCommand(params: SpawnAgentParams & { hooksSettingsPath?: string }): string {
  const parts = [params.binaryPath];

  if (params.model) {
    parts.push("--model", params.model);
  }

  // Pass hooks config via --settings
  if (params.hooksSettingsPath) {
    parts.push("--settings", params.hooksSettingsPath);
  }

  // Pass the goal as the initial prompt via -p flag
  // Use interactive mode (no --print) so steering works
  parts.push("-p", JSON.stringify(params.goal));

  // Allow the agent to work autonomously
  parts.push("--dangerously-skip-permissions");

  return parts.join(" ");
}

/**
 * Build the shell command to spawn a Codex agent.
 *
 * Uses `codex exec` (non-interactive). When a notifyScriptPath is provided,
 * we write a wrapper script that runs codex and then calls the notify script
 * with the exit code. This avoids quoting issues with inline bash -c.
 */
export function buildCodexSpawnCommand(params: SpawnAgentParams & { notifyScriptPath?: string }): string {
  if (params.notifyScriptPath) {
    // Write a wrapper script that runs codex and then calls notify
    const hooksDir = path.dirname(params.notifyScriptPath);
    const wrapperPath = path.join(hooksDir, "run-codex.sh");
    const codexParts = [params.binaryPath, "exec"];
    codexParts.push("--dangerously-bypass-approvals-and-sandbox");
    if (params.model) {
      codexParts.push("--model", params.model);
    }
    // Write goal to a temp file to avoid quoting issues
    const goalPath = path.join(hooksDir, "goal.txt");
    fs.writeFileSync(goalPath, params.goal, { mode: 0o600 });
    codexParts.push("-"); // Read from stdin

    const outputPath = path.join(hooksDir, "codex-output.txt");
    const wrapperContent = [
      "#!/bin/bash",
      `CODEX_OUTPUT_FILE=${JSON.stringify(outputPath)}`,
      `${codexParts.join(" ")} < ${JSON.stringify(goalPath)} 2>&1 | tee "$CODEX_OUTPUT_FILE"`,
      `export CODEX_EXIT_CODE=\${PIPESTATUS[0]}`,
      `export CODEX_CAPTURED_OUTPUT=$(tail -c 4000 "$CODEX_OUTPUT_FILE" 2>/dev/null)`,
      params.notifyScriptPath,
    ].join("\n");
    fs.writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });
    return wrapperPath;
  }

  const parts = [params.binaryPath, "exec"];
  parts.push("--dangerously-bypass-approvals-and-sandbox");
  if (params.model) {
    parts.push("--model", params.model);
  }
  parts.push(JSON.stringify(params.goal));
  return parts.join(" ");
}

/**
 * Generate the hook script content for Claude Code.
 * This script is called by Claude's hook system and POSTs events
 * to the sidecar Unix socket.
 */
function buildClaudeHookScript(params: {
  runId: string;
  sidecarSocketPath: string;
}): string {
  return `#!/bin/bash
# Auto-generated hook script for subagent run ${params.runId}
# Posts events to the subagent sidecar via Unix socket

HOOK_TYPE="\${1:-Stop}"
RUN_ID="${params.runId}"
SOCKET="${params.sidecarSocketPath}"

# Read stdin (Claude passes hook input as JSON on stdin)
INPUT=""
if [ ! -t 0 ]; then
  INPUT=$(cat)
fi

# Extract exit code from environment (Claude sets this for Stop hooks)
EXIT_CODE="\${CLAUDE_EXIT_CODE:-0}"

# Build error message when exit code is non-zero
ERROR_MSG=""
if [ "$EXIT_CODE" != "0" ]; then
  ERROR_MSG="Process exited with code $EXIT_CODE."
fi

curl --silent --unix-socket "$SOCKET" \\
  -X POST "http://localhost/events/claude" \\
  -H "Content-Type: application/json" \\
  -d "$(cat <<EOF
{
  "runId": "$RUN_ID",
  "hookType": "$HOOK_TYPE",
  "exitCode": $EXIT_CODE,
  "result": $(echo "$INPUT" | head -c 10000 | jq -Rs .),
  "error": $(echo "$ERROR_MSG" | jq -Rs .)
}
EOF
)" 2>/dev/null || true
`;
}

/**
 * Generate the notify script for Codex.
 * Codex calls this with the run context when it completes.
 */
function buildCodexNotifyScript(params: {
  runId: string;
  sidecarSocketPath: string;
}): string {
  return `#!/bin/bash
# Auto-generated notify script for subagent run ${params.runId}
# Posts events to the subagent sidecar via Unix socket

RUN_ID="${params.runId}"
SOCKET="${params.sidecarSocketPath}"
EXIT_CODE="\${CODEX_EXIT_CODE:-0}"

# Read stdin if available
OUTPUT=""
if [ ! -t 0 ]; then
  OUTPUT=$(cat | head -c 10000)
fi

# Use captured output from wrapper if available
if [ -n "\${CODEX_CAPTURED_OUTPUT:-}" ]; then
  OUTPUT="\${CODEX_CAPTURED_OUTPUT}"
fi

# Build error message when exit code is non-zero
ERROR_MSG=""
if [ "$EXIT_CODE" != "0" ]; then
  ERROR_MSG="Process exited with code $EXIT_CODE."
  if [ -n "$OUTPUT" ]; then
    # Include last 2000 chars of output in the error for diagnostics
    ERROR_MSG="$ERROR_MSG Output: $(echo "$OUTPUT" | tail -c 2000)"
  fi
fi

curl --silent --unix-socket "$SOCKET" \\
  -X POST "http://localhost/events/codex" \\
  -H "Content-Type: application/json" \\
  -d "$(cat <<EOF
{
  "runId": "$RUN_ID",
  "exitCode": $EXIT_CODE,
  "output": $(echo "$OUTPUT" | jq -Rs .),
  "error": $(echo "$ERROR_MSG" | jq -Rs .)
}
EOF
)" 2>/dev/null || true
`;
}

/**
 * Write Claude Code hooks configuration.
 * Creates a hook script and a settings JSON file that can be passed via --settings.
 * Returns both paths so the caller can use the settings file with --settings flag.
 */
export function writeClaudeHooksConfig(params: {
  runId: string;
  worktreeCwd: string;
  sidecarSocketPath: string;
}): { hookScriptPath: string; settingsPath: string } {
  const hooksDir = getHooksDir(params.runId);
  fs.mkdirSync(hooksDir, { recursive: true });

  // Write the hook script
  const hookScriptPath = path.join(hooksDir, "hook.sh");
  fs.writeFileSync(hookScriptPath, buildClaudeHookScript({
    runId: params.runId,
    sidecarSocketPath: params.sidecarSocketPath,
  }), { mode: 0o755 });

  const settings = {
    hooks: {
      SessionEnd: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: `${hookScriptPath} Stop` },
          ],
        },
      ],
      Notification: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: `${hookScriptPath} Notification` },
          ],
        },
      ],
    },
  };

  // Write settings file into the hooks dir (passed via --settings flag)
  const settingsPath = path.join(hooksDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });

  return { hookScriptPath, settingsPath };
}

/**
 * Write Codex notify configuration for a run.
 * Returns the path to the notify script.
 */
export function writeCodexNotifyConfig(params: {
  runId: string;
  sidecarSocketPath: string;
}): string {
  const hooksDir = getHooksDir(params.runId);
  fs.mkdirSync(hooksDir, { recursive: true });

  const notifyScriptPath = path.join(hooksDir, "notify.sh");
  fs.writeFileSync(notifyScriptPath, buildCodexNotifyScript({
    runId: params.runId,
    sidecarSocketPath: params.sidecarSocketPath,
  }), { mode: 0o755 });

  return notifyScriptPath;
}

/**
 * Clean up hook scripts for a completed run.
 */
export function cleanupHooksDir(runId: string): void {
  const hooksDir = getHooksDir(runId);
  if (fs.existsSync(hooksDir)) {
    fs.rmSync(hooksDir, { recursive: true, force: true });
  }
}
