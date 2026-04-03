#!/bin/bash
/opt/homebrew/bin/codex exec --dangerously-bypass-approvals-and-sandbox --model gpt-5.4 - < "/Users/elinaro/Documents/openElinaro/subagent-hooks/run-1774306459619-4ub0ju/goal.txt"
export CODEX_EXIT_CODE=$?
/Users/elinaro/Documents/openElinaro/subagent-hooks/run-1774306459619-4ub0ju/notify.sh