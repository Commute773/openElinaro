#!/bin/bash
CODEX_OUTPUT_FILE="/Users/elinaro/Documents/openElinaro/subagent-hooks/run-1774492304834-ma3epv/codex-output.txt"
/opt/homebrew/bin/codex exec --dangerously-bypass-approvals-and-sandbox - < "/Users/elinaro/Documents/openElinaro/subagent-hooks/run-1774492304834-ma3epv/goal.txt" 2>&1 | tee "$CODEX_OUTPUT_FILE"
export CODEX_EXIT_CODE=${PIPESTATUS[0]}
export CODEX_CAPTURED_OUTPUT=$(tail -c 4000 "$CODEX_OUTPUT_FILE" 2>/dev/null)
/Users/elinaro/Documents/openElinaro/subagent-hooks/run-1774492304834-ma3epv/notify.sh