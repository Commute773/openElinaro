#!/bin/bash
# Auto-generated notify script for subagent run run-1774492304834-ma3epv
# Posts events to the subagent sidecar via Unix socket

RUN_ID="run-1774492304834-ma3epv"
SOCKET="/Users/elinaro/Documents/openElinaro/subagent-sidecar.sock"
EXIT_CODE="${CODEX_EXIT_CODE:-0}"

# Read stdin if available
OUTPUT=""
if [ ! -t 0 ]; then
  OUTPUT=$(cat | head -c 10000)
fi

# Use captured output from wrapper if available
if [ -n "${CODEX_CAPTURED_OUTPUT:-}" ]; then
  OUTPUT="${CODEX_CAPTURED_OUTPUT}"
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

curl --silent --unix-socket "$SOCKET" \
  -X POST "http://localhost/events/codex" \
  -H "Content-Type: application/json" \
  -d "$(cat <<EOF
{
  "runId": "$RUN_ID",
  "exitCode": $EXIT_CODE,
  "output": $(echo "$OUTPUT" | jq -Rs .),
  "error": $(echo "$ERROR_MSG" | jq -Rs .)
}
EOF
)" 2>/dev/null || true
