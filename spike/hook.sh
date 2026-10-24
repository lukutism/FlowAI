#!/bin/bash
# records every hook event; refuses git push (stands in for the engine's PreToolUse check)
in=$(cat)
echo "$in" >> "$(dirname "$0")/recordings/hooks.jsonl"
if echo "$in" | grep -q '"hook_event_name":"PreToolUse"' && echo "$in" | grep -q 'git push'; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"flow: pushing is done by flow ship, not the agent"}}'
fi
exit 0
