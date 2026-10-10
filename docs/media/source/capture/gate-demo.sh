#!/bin/sh
# DEMO ONLY, SANDBOX ONLY. Never point this at a real SOMA_HOME or CLAUDE_CONFIG_DIR.
#
# Pipe PreToolUse payloads into soma's real lead-gate hook, inside the sandbox.
set -u
# The one rm below targets $SOMA_HOME, so the state root must be the pinned sandbox AND the
# sandbox must carry the marker setup-sandbox.sh writes.
[ "$SOMA_HOME" = "/private/tmp/soma-demo/.soma" ] && [ -f /private/tmp/soma-demo/.soma-demo-sandbox ] \
  || { echo "refusing: not the sandbox built by setup-sandbox.sh"; exit 1; }
GATE=/private/tmp/soma-demo/claude-soma-lite/bin/hooks/lead-gate.mjs
WT=/private/tmp/soma-demo/.soma/worktrees/demo-app/fix-login-bug
LEAD_ENV="SOMA_LEAD_NAME=fix-login-bug SOMA_LEAD_SESSION_UUID=lead-session-demo"

gate() { # $1 label, $2 session_id, $3 tool, $4 command
  printf '### %s\n' "$1"
  payload=$(node -e 'const [sid,tool,cmd,cwd]=process.argv.slice(1); const ti = tool==="Bash" ? {command: cmd} : {}; console.log(JSON.stringify({session_id: sid, hook_event_name: "PreToolUse", tool_name: tool, tool_input: ti, cwd}))' "$2" "$3" "$4" "$WT")
  printf '%s\n' "$payload" | env $LEAD_ENV node "$GATE"
  printf '\n[exit %s]\n\n' "$?"
}

gate "lead: git push" lead-session-demo Bash "git push origin soma/fix-login-bug"
gate "lead: git merge" lead-session-demo Bash "git merge main"
gate "teammate: git push (allowed: teammates deliver)" teammate-demo Bash "git push origin soma/fix-login-bug"
gate "teammate: overwrite the guard file" teammate-demo Bash "echo '{}' > .claude/settings.local.json"
gate "teammate: reach the soma bus" teammate-demo mcp__soma__soma_adopt ""
mkdir -p "$SOMA_HOME/leads/fix-login-bug"
: > "$SOMA_HOME/leads/fix-login-bug/BUDGET_TRIPPED"
gate "budget tripped: lead runs the tests" lead-session-demo Bash "npm test"
gate "budget tripped: teammate edits" teammate-demo Edit ""
gate "budget tripped: lead files soma_report (allowed)" lead-session-demo mcp__soma__soma_report ""
rm -f "$SOMA_HOME/leads/fix-login-bug/BUDGET_TRIPPED"
