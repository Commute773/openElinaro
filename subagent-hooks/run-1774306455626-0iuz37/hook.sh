#!/bin/bash
# Auto-generated hook script for subagent run run-1774306455626-0iuz37
# Posts events to the subagent sidecar via Unix socket

HOOK_TYPE="${1:-Stop}"
RUN_ID="run-1774306455626-0iuz37"
SOCKET="/Users/elinaro/Documents/openElinaro/subagent-sidecar.sock"

# Read stdin (Claude passes hook input as JSON on stdin)
INPUT=""
if [ ! -t 0 ]; then
  INPUT=$(cat)
fi

# Extract exit code from environment (Claude sets this for Stop hooks)
EXIT_CODE="${CLAUDE_EXIT_CODE:-0}"

curl --silent --unix-socket "$SOCKET" \
  -X POST "http://localhost/events/claude" \
  -H "Content-Type: application/json" \
  -d "$(cat <<EOF
{
  "runId": "$RUN_ID",
  "hookType": "$HOOK_TYPE",
  "exitCode": $EXIT_CODE,
  "result": $(echo "$INPUT" | head -c 10000 | jq -Rs .),
  "error": ""
}
EOF
)" 2>/dev/null || true
