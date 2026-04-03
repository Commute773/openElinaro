#!/bin/bash
/opt/homebrew/bin/codex exec --dangerously-bypass-approvals-and-sandbox --model gpt-5.4 - < "/Users/elinaro/Documents/openElinaro/subagent-hooks/run-1774230213280-5by9tc/goal.txt"
export CODEX_EXIT_CODE=$?
/Users/elinaro/Documents/openElinaro/subagent-hooks/run-1774230213280-5by9tc/notify.sh