#!/bin/sh
# DEMO ONLY, SANDBOX ONLY. Never point this at a real SOMA_HOME or CLAUDE_CONFIG_DIR.
#
# Build the throwaway sandbox the showcase video is captured in.
#
#   sh setup-sandbox.sh /path/to/claude-soma-lite [commit]
#
# Everything lives under /private/tmp/soma-demo (pinned; the drivers name it too). Nothing here
# touches a real SOMA_HOME, CLAUDE_CONFIG_DIR, tmux socket or Claude Code install:
#   - HOME, SOMA_HOME and CLAUDE_CONFIG_DIR all point inside $SB, tmux uses socket soma_demo;
#   - PATH is $SB/bin:/bin, so claude, gh and osascript are NOT reachable (no session can be
#     launched, no PR opened, no desktop toast popped);
#   - the soma code is a `git archive` copy, so captured paths never show your checkout.
set -eu
REPO=${1:?usage: setup-sandbox.sh /path/to/claude-soma-lite [commit]}
REF=${2:-HEAD}
SB=/private/tmp/soma-demo
[ -e "$SB" ] && { echo "refusing: $SB already exists — remove it first"; exit 1; }

mkdir -p "$SB/bin" "$SB/tmp" "$SB/.claude" "$SB/repos" "$SB/claude-soma-lite" "$SB/work"
# The marker capture.sh checks before it deletes anything inside $SB.
printf 'built by setup-sandbox.sh for the claude-soma-lite showcase capture\n' > "$SB/.soma-demo-sandbox"
# A copy, not a symlink, so process.execPath prints a neutral path.
cp "$(command -v node)" "$SB/bin/node"
NPMCLI="$(dirname "$(command -v node)")/../lib/node_modules/npm/bin/npm-cli.js"
printf '#!/bin/sh\nexec %s/bin/node %s "$@"\n' "$SB" "$NPMCLI" > "$SB/bin/npm"
GIT=$(xcrun --find git 2>/dev/null || command -v git)
printf '#!/bin/sh\nexec %s "$@"\n' "$GIT" > "$SB/bin/git"
ln -s "$(command -v tmux)" "$SB/bin/tmux"
for t in env mktemp touch; do ln -s "$(command -v $t)" "$SB/bin/$t"; done
printf '#!/bin/sh\nexec %s/bin/node %s/claude-soma-lite/bin/soma.mjs "$@"\n' "$SB" "$SB" > "$SB/bin/soma"
chmod +x "$SB/bin/npm" "$SB/bin/git" "$SB/bin/soma"
git -C "$REPO" archive "$REF" | tar -x -C "$SB/claude-soma-lite"

cat > "$SB/run" <<EOF
#!/bin/sh
# Every sandboxed command goes through here: nothing from the real environment leaks in.
exec /usr/bin/env -i \\
  HOME=$SB \\
  USER=demo \\
  SHELL=/bin/zsh \\
  TERM=xterm-256color \\
  LANG=en_US.UTF-8 \\
  TMPDIR=$SB/tmp \\
  PATH=$SB/bin:/bin \\
  SOMA_HOME=$SB/.soma \\
  CLAUDE_CONFIG_DIR=$SB/.claude \\
  SOMA_TMUX_SOCKET=soma_demo \\
  "\$@"
EOF
chmod +x "$SB/run"
for t in claude gh osascript; do
  if "$SB/run" sh -c "command -v $t" >/dev/null 2>&1; then echo "refusing: $t is reachable inside the sandbox"; exit 1; fi
done
echo "sandbox ready at $SB"
