#!/bin/sh
# DEMO ONLY, SANDBOX ONLY. Never point this at a real SOMA_HOME or CLAUDE_CONFIG_DIR.
#
# Capture every terminal beat of the showcase video from a sandboxed demo fleet.
#
#   sh capture.sh <out-dir>          (after setup-sandbox.sh; macOS — `script` is BSD-style here)
#
# Resets the sandbox fleet, then runs the real soma code against a toy repo, in story order.
# Nothing launches claude, no watchdog is started, and `soma up` is answered "no".
set -eu
OUT=${1:?usage: capture.sh <out-dir>}
# Pinned, never read from the environment: this script deletes inside $SB below, so it must be the
# sandbox setup-sandbox.sh built and nothing else — not an inherited SB, and not a directory that
# merely happens to hold an executable named `run`.
SB=/private/tmp/soma-demo
HERE=$(cd "$(dirname "$0")" && pwd)
RUN="$SB/run"
[ -f "$SB/.soma-demo-sandbox" ] && [ -x "$RUN" ] || {
  echo "refusing: $SB is not a sandbox built by setup-sandbox.sh (no .soma-demo-sandbox marker)"; exit 1; }
# Before any process starts: the state root the sandbox hands every process must resolve inside
# the sandbox (a demo soma_adopt against a live state root would take the live fleet's lease), and
# no process may carry tmux state (socket soma_demo, named explicitly; no TMUX, no TMUX_PANE).
seen=$("$RUN" sh -c 'printf %s "$SOMA_HOME"')
case "$( (cd "$seen" 2>/dev/null && pwd -P) || printf %s "$seen")/" in
  "$SB"/*) ;;
  *) echo "refusing: SOMA_HOME ($seen) does not resolve inside $SB/"; exit 1 ;;
esac
"$RUN" sh -c '[ "$SOMA_TMUX_SOCKET" = soma_demo ] && [ -z "${TMUX+x}" ] && [ -z "${TMUX_PANE+x}" ]' || {
  echo "refusing: the sandbox environment carries tmux state"; exit 1; }
mkdir -p "$OUT"
cp "$HERE"/bus-demo.mjs "$HERE"/fanout.mjs "$HERE"/gate-demo.sh "$HERE"/argv-demo.mjs "$HERE"/seats-demo.mjs "$SB/work/"

# --- reset the sandbox fleet (sandbox paths only) ---------------------------------------
"$RUN" tmux -L soma_demo kill-session -t scratch 2>/dev/null || true
rm -rf "$SB/.soma" "$SB/repos" "$SB/tmp"
mkdir -p "$SB/.soma" "$SB/repos" "$SB/tmp"

# --- a toy repo with a local bare origin ------------------------------------------------
"$RUN" sh -c '
set -e
cd "$HOME/repos"
git init -q --bare -b main demo-app.git
git init -q -b main demo-app
cd demo-app
git config user.name demo
git config user.email demo
mkdir -p src test
printf "%s\n" "{ \"name\": \"demo-app\", \"private\": true, \"type\": \"module\", \"scripts\": { \"test\": \"node --test\" } }" > package.json
printf "%s\n" "// Toy login check for the soma demo fleet." "const users = new Map([[\"alice\", \"wonderland\"]]);" "export function login(username, password) {" "  return users.get(username) === password;" "}" > src/login.js
printf "%s\n" "import { test } from \"node:test\";" "import assert from \"node:assert/strict\";" "import { login } from \"../src/login.js\";" "test(\"alice can log in\", () => assert.equal(login(\"alice\", \"wonderland\"), true));" > test/login.test.js
printf "# demo-app\n\nA toy repo for the soma demo fleet.\n" > README.md
git add -A && git commit -q -m "demo-app: initial commit"
git remote add origin "$HOME/repos/demo-app.git"
git push -q origin main
'

# --- fleet config and the backlog ---------------------------------------------------------
cat > "$SB/.soma/soma.json" <<EOF
{
  "max_leads": 3,
  "repos": {
    "demo-app": { "path": "$SB/repos/demo-app", "base_branch": "main" }
  }
}
EOF
cat > "$SB/tasks.json" <<'EOF'
[
  { "id": "fix-login-bug", "title": "Login rejects usernames typed with capital letters",
    "repo": "demo-app", "brief": "Make the username check case-insensitive. Write the failing test first.",
    "verify_hint": "npm test" },
  { "id": "add-rate-limit", "title": "Lock an account for 60 s after 5 failed logins",
    "repo": "demo-app", "brief": "Add a per-user failure counter and a 60 s lockout, with tests.",
    "verify_hint": "npm test" },
  { "id": "docs-quickstart", "title": "Add a quickstart to the README",
    "repo": "demo-app", "brief": "Write a five-step quickstart a new contributor can follow.",
    "verify_hint": "a reviewer follows it on a clean clone" },
  { "id": "estimate-sso", "title": "Estimate the work to add single sign-on",
    "repo": "demo-app", "brief": "Report the options, the risks and an estimate. No code.",
    "verify_hint": "every claim has a source" }
]
EOF

# A plain tmux server on the sandbox socket, so `soma status` can read tmux (no lead runs on it).
"$RUN" tmux -L soma_demo new-session -d -s scratch

in_sb() { "$RUN" sh -c "cd $SB && $1"; }
in_sb 'soma enqueue --file tasks.json'    > "$OUT/02-enqueue.txt" 2>&1
in_sb 'soma status'                       > "$OUT/03-status.txt" 2>&1
in_sb 'soma up </dev/null'                > "$OUT/04-up-notty.txt" 2>&1 || true
# Under a pty, answered "no" after the prompt is up: the projection, the prompt, the abort.
(sleep 2; printf 'no\n') | "$RUN" /usr/bin/script -q "$OUT/05-up-tty.raw" "$SB/bin/soma" up >/dev/null 2>&1 || true
"$RUN" node "$SB/work/fanout.mjs"           > "$OUT/09-fanout.json" 2>&1
in_sb 'git -C repos/demo-app worktree list' > "$OUT/10-worktree-list.txt" 2>&1
"$RUN" node "$SB/work/argv-demo.mjs"        > "$OUT/13-argv.txt" 2>&1
in_sb "node work/bus-demo.mjs $SB/work/bus-log.json" > "$OUT/06-bus-steps.json" 2> "$SB/work/bus-stderr.txt"
printf '%s' '{"session_id":"orch-demo","hook_event_name":"UserPromptSubmit","prompt":"how is the fleet doing?","cwd":"'"$SB"'"}' \
  | "$RUN" node "$SB/claude-soma-lite/bin/hooks/orch-inject.mjs" > "$OUT/07-inject.json" 2>&1
"$RUN" sh "$SB/work/gate-demo.sh"         > "$OUT/11-gate.txt" 2>&1
"$RUN" tmux -L soma_demo kill-session -t scratch 2>/dev/null || true
# The suite, in the sandbox copy. TMPDIR goes through the /tmp symlink because one fixture
# needs a symlinked temp dir, exactly like macOS's own /var/folders.
# The full log stays in the sandbox; only its trimmed form reaches $OUT (below), so nothing in
# $OUT ever has to be deleted.
"$RUN" env npm_config_update_notifier=false TMPDIR=/tmp/soma-demo/tmp \
  sh -c "cd $SB/claude-soma-lite && npm test" > "$SB/work/npm-test.full.txt" 2>&1 || true

# Seat rotation, last, so every earlier beat shows the one-account fleet. Two empty seat dirs go
# into soma.json; seats-demo.mjs closes the first through soma's own seats module (as the limits
# phase does on a five_hour hit) and asks pick() for the next. No lead is moved. TZ=UTC keeps
# the printed reset time neutral.
mkdir -p "$SB/seats/seat-a" "$SB/seats/seat-b"
cat > "$SB/.soma/soma.json" <<EOF
{
  "max_leads": 3,
  "repos": {
    "demo-app": { "path": "$SB/repos/demo-app", "base_branch": "main" }
  },
  "seats": [
    { "config_dir": "$SB/seats/seat-a", "label": "seat-a" },
    { "config_dir": "$SB/seats/seat-b", "label": "seat-b" }
  ]
}
EOF
"$RUN" tmux -L soma_demo new-session -d -s scratch
"$RUN" env TZ=UTC node "$SB/work/seats-demo.mjs"   > "$OUT/16-seats-demo.txt" 2>&1
"$RUN" env TZ=UTC sh -c "cd $SB && soma status"    > "$OUT/17-status-seats.txt" 2>&1
"$RUN" tmux -L soma_demo kill-session -t scratch 2>/dev/null || true
# The rotation behaviour as the suite pins it: a name-filtered run of the real tests.
ROT_PATTERN='seat_window: close the seat|a target that is not logged in|no open seat: nothing is killed|three rotations inside an hour|spend_cap through the REAL classifier|soma.json order beats recency'
"$RUN" sh -c "cd $SB/claude-soma-lite && node --test --test-name-pattern='$ROT_PATTERN' test/watchdog.tick.test.mjs test/seats.test.mjs" > "$OUT/18-rotation-tests.txt" 2>&1 || true
printf '%s\n' "$ROT_PATTERN" > "$OUT/18-rotation-pattern.txt"

# What build.mjs reads besides the transcripts: the harness registry and the config defaults,
# both from the sandboxed copy of the code. The suite log is trimmed to its head and tail.
cp "$SB/claude-soma-lite/prompts/harnesses.json" "$OUT/harnesses.json"
"$RUN" node -e 'import("'"$SB"'/claude-soma-lite/bin/lib/config.mjs").then((m) => console.log(JSON.stringify({ max_leads: m.DEFAULTS.max_leads, stagger_s: m.DEFAULTS.stagger_s, tick_ms: m.DEFAULTS.tick_ms, team_size_max: m.DEFAULTS.team_size_max, budgets: m.DEFAULTS.budgets })))' > "$OUT/15-config-defaults.json"
N=$(wc -l < "$SB/work/npm-test.full.txt")
{ head -5 "$SB/work/npm-test.full.txt"; echo "[… $((N - 35)) lines elided …]"; tail -30 "$SB/work/npm-test.full.txt"; } > "$OUT/12-npm-test.txt"
# fanout.mjs prints the worktrees, then the generated guard file; build.mjs reads them as one record.
"$RUN" node -e '
const fs = require("fs"); const s = fs.readFileSync(process.argv[1], "utf8"); const i = s.indexOf("{\n  \"permissions\"");
fs.writeFileSync(process.argv[1], JSON.stringify({ worktrees: JSON.parse(s.slice(0, i)), guard: JSON.parse(s.slice(i)) }, null, 2));' "$OUT/09-fanout.json"

# The story the video opens with, last, on a fresh fleet of four (see story.sh).
sh "$HERE/story.sh" "$OUT"
echo "captured into $OUT"
