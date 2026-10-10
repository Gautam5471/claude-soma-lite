#!/bin/sh
# DEMO ONLY, SANDBOX ONLY. Never point this at a real SOMA_HOME or CLAUDE_CONFIG_DIR.
#
# Capture the story the showcase opens with (story-demo.mjs) on a fresh fleet of four, in the
# sandbox setup-sandbox.sh built. capture.sh calls it last; it also runs on its own:
#
#   sh story.sh <out-dir>
#
# No lead, watchdog or claude runs. One plain `cat` in a tmux session named lead-fix-login-bug, on
# the sandbox socket soma_demo only, stands in for that lead's pane (after printing one neutral
# line) so soma_send has something to type into; what it typed is kept as 19-story-pane.txt.
set -eu
OUT=${1:?usage: story.sh <out-dir>}
# Pinned, never read from the environment: this script deletes inside $SB below.
SB=/private/tmp/soma-demo
HERE=$(cd "$(dirname "$0")" && pwd)
RUN="$SB/run"
[ -f "$SB/.soma-demo-sandbox" ] && [ -x "$RUN" ] || {
  echo "refusing: $SB is not a sandbox built by setup-sandbox.sh (no .soma-demo-sandbox marker)"; exit 1; }

# A fresh state root for the story (sandbox paths only), configured for four leads, no seats.
rm -rf "$SB/.soma"
mkdir -p "$SB/.soma" "$SB/work" "$OUT"

# The state root every sandboxed process sees must resolve INSIDE the sandbox (a demo soma_adopt
# against a live state root would take the live fleet's orchestrator lease), and no process may
# carry tmux state: the socket is soma_demo, named explicitly, and there is no TMUX or TMUX_PANE.
seen=$("$RUN" sh -c 'printf %s "$SOMA_HOME"')
case "$(cd "$seen" 2>/dev/null && pwd -P)/" in
  "$SB"/*) ;;
  *) echo "refusing: SOMA_HOME ($seen) does not resolve inside $SB/"; exit 1 ;;
esac
"$RUN" sh -c '[ "$SOMA_TMUX_SOCKET" = soma_demo ] && [ -z "${TMUX+x}" ] && [ -z "${TMUX_PANE+x}" ]' || {
  echo "refusing: the sandbox environment carries tmux state"; exit 1; }

cat > "$SB/.soma/soma.json" <<EOF
{
  "max_leads": 4,
  "repos": {
    "demo-app": { "path": "$SB/repos/demo-app", "base_branch": "main" }
  }
}
EOF
cp "$HERE/story-demo.mjs" "$SB/work/"

# The stand-in pane, on the sandbox socket only, and proof of which socket that is. It prints one
# neutral line first, as a real lead's pane always shows a screen: a blank one cannot be read, so
# soma_send's gate refuses it (it cannot rule out a permission dialog). With a readable screen
# that matches no Claude Code state, the gate's documented answer is "unrecognised; typed anyway".
: > "$SB/work/pane-fix-login-bug.txt"
"$RUN" tmux -L soma_demo new-session -d -s lead-fix-login-bug "printf 'demo lead pane (stand-in)\\n'; exec cat > $SB/work/pane-fix-login-bug.txt"
# tmux titles a new pane with the machine's hostname, and soma_status reports pane titles (its
# `team` field): name the pane neutrally so no capture carries the machine's name.
"$RUN" tmux -L soma_demo select-pane -t lead-fix-login-bug -T 'demo lead pane'
sock=$("$RUN" tmux -L soma_demo display -p -t lead-fix-login-bug '#{socket_path}')
case "$sock" in
  */soma_demo) ;;
  *) echo "refusing: the stand-in pane is on $sock, not a soma_demo socket"; exit 1 ;;
esac

rc=0
"$RUN" node "$SB/work/story-demo.mjs" "$SB/work/19-story.json" > "$SB/work/story-stdout.txt" 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  "$RUN" env TZ=UTC sh -c "cd $SB && soma status" > "$SB/work/20-story-status.txt" 2>&1 || true
fi
"$RUN" tmux -L soma_demo kill-session -t lead-fix-login-bug 2>/dev/null || true
if [ "$rc" -ne 0 ]; then
  cat "$SB/work/story-stdout.txt"
  exit "$rc"
fi
# Nothing leaves the sandbox that names this machine: checked here, before anything is copied out.
host=$(hostname -s)
if [ -n "$host" ] && LC_ALL=C grep -a -q -i -F "$host" "$SB/work/19-story.json" "$SB/work/20-story-status.txt" "$SB/work/pane-fix-login-bug.txt"; then
  echo "refusing: the capture names this machine; nothing was copied out"
  exit 1
fi
cp "$SB/work/19-story.json" "$OUT/19-story.json"
cp "$SB/work/20-story-status.txt" "$OUT/20-story-status.txt"
cp "$SB/work/pane-fix-login-bug.txt" "$OUT/19-story-pane.txt"
echo "story captured into $OUT (stand-in pane socket: $sock)"
