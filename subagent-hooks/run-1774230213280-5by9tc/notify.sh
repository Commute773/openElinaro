#!/bin/bash
# Auto-generated notify script for subagent run run-1774230213280-5by9tc
# Posts events to the subagent sidecar via Unix socket

RUN_ID="run-1774230213280-5by9tc"
SOCKET="/Users/elinaro/Documents/openElinaro/subagent-sidecar.sock"
EXIT_CODE="${CODEX_EXIT_CODE:-0}"

# Read stdin if available
OUTPUT=""
if [ ! -t 0 ]; then
  OUTPUT=$(cat | head -c 10000)
fi

curl --silent --unix-socket "$SOCKET" \
  -X POST "http://localhost/events/codex" \
  -H "Content-Type: application/json" \
  -d "$(cat <<EOF
{
  "runId": "$RUN_ID",
  "exitCode": $EXIT_CODE,
  "output": $(echo "$OUTPUT" | jq -Rs .),
  "error": ""
}
EOF
)" 2>/dev/null || true
