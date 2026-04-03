#!/bin/bash
# Auto-generated hook script for subagent run run-1774555476369-p92wng
# Posts events to the subagent sidecar via Unix socket

HOOK_TYPE="${1:-Stop}"
RUN_ID="run-1774555476369-p92wng"
SOCKET="/Users/elinaro/Documents/openElinaro/subagent-sidecar.sock"

# Read stdin (Claude passes hook input as JSON on stdin)
INPUT=""
if [ ! -t 0 ]; then
  INPUT=$(cat)
fi

# Extract exit code from environment (Claude sets this for Stop hooks)
EXIT_CODE="${CLAUDE_EXIT_CODE:-0}"

# Build error message when exit code is non-zero
ERROR_MSG=""
if [ "$EXIT_CODE" != "0" ]; then
  ERROR_MSG="Process exited with code $EXIT_CODE."
fi

curl --silent --unix-socket "$SOCKET" \
  -X POST "http://localhost/events/claude" \
  -H "Content-Type: application/json" \
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
