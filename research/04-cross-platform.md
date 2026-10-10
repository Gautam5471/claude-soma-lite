# 04 — Cross-platform strategy (macOS / Linux / Windows) for claude-soma-lite

Research date: 2026-07-29. Local machine: macOS (Darwin 25.4.0), tmux 3.6a, node v20.18.2, Claude Code 2.1.220.
Primary sources: code.claude.com/docs (setup, agent-teams — fetched today; note `docs.claude.com/en/docs/claude-code/*` now 301s to `code.claude.com/docs/en/*`), learn.microsoft.com (Windows Terminal CLI, WSL), devblogs.microsoft.com (AF_UNIX interop), npm registry, tmux/MSYS2 GitHub issues.

---

## 1. tmux on Windows reality check

**Native tmux does not exist on Windows.** tmux needs `fork()`, POSIX ptys, and Unix domain sockets; every Windows build is a POSIX-emulation build. Viable routes:

### Route A — WSL2, everything inside Linux (recommended, full fidelity)
- tmux from the distro's package manager, Claude Code installed *inside* WSL via the Linux installer (`curl -fsSL https://claude.ai/install.sh | bash`). This is an officially documented configuration: the setup page's Windows table lists **WSL 2** with "Linux toolchains or sandboxed command execution" as the use case, and WSL 2 is the *only* Windows option with sandboxing support ("Native Windows: Sandboxing not supported; WSL 2: Supported").
- Inside WSL, tmux is just tmux-on-Linux: sockets in `/tmp/tmux-$UID/`, send-keys, panes — all identical to the Linux path. soma-lite needs zero Windows-specific code on this route.
- Docs quote: "Open your WSL distribution and run the Linux installer... You install and launch `claude` inside the WSL terminal, not from PowerShell or CMD."

### Route B — MSYS2 / Git Bash tmux (not viable for soma-lite)
- Git for Windows does **not** ship tmux. The known recipe is: install MSYS2, `pacman -S tmux`, then hand-copy `tmux.exe` + `msys-event-2-1-7.dll` + `msys-event_core-2-1-7.dll` into the Git for Windows tree (documented in community gists/blogs; MSYS2-packages issue #2045, tmux issue #3095).
- Known failure modes: "open terminal failed: not a terminal" unless run under MinTTY specifically; breakage reported across Git versions (e.g. 2.44 users report tmux won't start even with the DLL copy). Fragile by construction.
- Deeper problem: Claude Code on native Windows is a **native win32 console binary** (npm platforms include `win32-x64`, `win32-arm64`; "The installed `claude` binary does not itself invoke Node"). Native Windows console apps inside an MSYS2 pty/MinTTY need winpty-style shims and raw-mode TUIs are notoriously flaky there. Anthropic documents Git Bash only as the **shell for the Bash tool** on native Windows ("Git for Windows is recommended on native Windows so Claude Code can use the Bash tool"), not as a tmux host. Nothing in the docs supports "Claude Code TUI inside MSYS2 tmux".
- Verdict: unsupported, unmaintainable; do not build on it.

### Route C — Cygwin (dead end)
- Cygwin ships a tmux package, but Claude Code has no Cygwin support story at all (docs never mention it; supported shells are "Bash, Zsh, PowerShell, or CMD", where Bash-on-Windows means Git Bash). Same native-binary-under-emulated-pty problem as MSYS2, with a smaller user base. Reject.

### What Anthropic officially supports on Windows (from code.claude.com/docs/en/setup, fetched 2026-07-29)
- OS requirement: "Windows 10 1809+ or Windows Server 2019+".
- **Option 1: Native Windows** — install via PowerShell (`irm https://claude.ai/install.ps1 | iex`) or CMD; also WinGet (`winget install Anthropic.ClaudeCode`). Git for Windows is *optional*: with it, the Bash tool uses Git Bash (`CLAUDE_CODE_GIT_BASH_PATH` override available); without it, Claude Code uses the PowerShell tool. No sandboxing.
- **Option 2: WSL 2** — Linux installer inside the distro; sandboxing supported. (WSL 1 also listed, without sandboxing.)
- The native binary is not Node-hosted at runtime: "the package downloads a native binary that doesn't use your Node.js at runtime". (Matters for topic 4.)

**Conclusion for topic 1:** the only sane tmux-on-Windows route is *tmux inside WSL2 with Claude Code inside WSL2*. It is officially supported end-to-end and makes Windows behave exactly like Linux for soma-lite.

---

## 2. Agent teams split panes on Windows — honest recommendation

From code.claude.com/docs/en/agent-teams (fetched 2026-07-29; agent teams are experimental, gated on `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`):

- Two display modes. **In-process** (the default since v2.1.179): "all teammates run inside your main terminal... Works in any terminal, no extra setup required." **Split panes**: "each teammate gets its own pane... Requires tmux, or iTerm2."
- Explicit limitation, verbatim: "**Split panes require tmux or iTerm2**: the default in-process mode works in any terminal. Split-pane mode isn't supported in VS Code's integrated terminal, **Windows Terminal**, or Ghostty."
- So: **teams work fine without tmux** — verified from docs. In-process teammates are fully functional (agent panel, direct messaging, shared task list); you just don't get side-by-side visible panes.
- `teammateMode` settings: `"in-process"` (default), `"auto"` (split panes when already inside tmux, else in-process), `"tmux"`, `"iterm2"` (v2.1.186+, needs the `it2` CLI). Configurable in `~/.claude/settings.json` or `claude --teammate-mode ...`.
- Docs note on tmux itself: "`tmux` has known limitations on certain operating systems and traditionally works best on macOS."

**Honest Windows recommendation:**
- **First-class: WSL2.** Lead sessions run inside WSL tmux; `teammateMode: "auto"` gives real split-pane teammates because the session is already inside tmux. Full soma-lite fidelity.
- **Fallback: native-Windows degraded mode ("no-panes").** Claude Code runs natively, leads still spawn agent teams but teammates are **in-process** (invisible-pane) — which the docs confirm works in any terminal. soma-lite loses per-teammate visible panes and, critically, loses its own tmux-based lead management (see topics 6/8), so on native Windows the *orchestrator itself* can't use tmux send-keys/wake mechanics. That makes native Windows suitable at most for a "leads only, no orchestrator daemon wake-ups via tmux" mode — see topic 8 for why this collapses.

---

## 3. Windows Terminal `wt` CLI as cosmetic display (native-Windows only)

From learn.microsoft.com/en-us/windows/terminal/command-line-arguments (fetched 2026-07-29): `wt.exe` is genuinely capable as a *launcher*:

- New tab per lead, into an existing window, with a stable title:
  `wt -w soma new-tab --title "lead-task-42" -d C:\work\wt-task-42 claude` — `-w soma` targets (or creates) a named window; each lead gets a tab.
- Split panes: `wt -w soma split-pane -V --title "lead-2" -d C:\work\wt-2 claude` (`-H/-V`, `--size 0.4`, `--title`, `--tabColor`, `-d` all supported); `move-focus`, `focus-tab -t N`, `swap-pane` exist for navigation.
- From WSL you must call it as `cmd.exe /c "wt.exe" ...` (execution aliases don't work inside WSL distros).

**Hard limits:** `wt` can *create* tabs/panes running a command, but there is **no attach/detach** (a closed tab kills the process), **no send-keys equivalent** (no way to inject input into an existing pane from the CLI), and no way to query/scrape pane contents. It's a window-layout launcher, not a multiplexer. So `wt` works as a cosmetic "show me each lead in its own tab" layer for a hypothetical native-Windows mode (leads with in-process teams), but it cannot replace tmux for persistence or for the wake mechanism. Interesting hybrid for WSL2 users: `wt -w soma new-tab --title lead-1 wsl.exe -e tmux attach -t soma-lead-1` — Windows Terminal tabs as *viewers* onto WSL tmux sessions; tmux still owns the processes, closing the tab only detaches.

---

## 4. Bus/daemon runtime: Node vs Python vs pure shell

**Node wins.** Reasoning:

- **Availability.** Claude Code users are the target audience. Nuance discovered in the setup docs: the native installer ships a self-contained binary ("does not itself invoke Node"), so Node is *not literally guaranteed* by every install path — but (a) the npm install path requires Node 22+, (b) virtually every MCP server ecosystem assumes `node`/`npx`, (c) dev machines running multi-agent orchestration will have Node. Mitigation: a `soma doctor` check at setup that verifies `node >= 18`. Node is still by far the highest-probability runtime on all 3 OSes; Python on Windows is a mess (py launcher vs Store stub vs PATH), and pure shell simply does not exist portably on Windows (Git Bash optional; PowerShell would mean maintaining a second implementation).
- **Official MCP SDK.** `@modelcontextprotocol/sdk` — verified via `npm view` today: **v1.30.0, engines `node >= 18`**. It is not zero-dep: 17 runtime deps including `express`, `hono`, `zod`, `ajv`, `jose` (the HTTP transports drag in web frameworks even if you only use stdio). Still a single `npm i` at setup time (~ a few MB), no build step: a plain **`.mjs` file importing `McpServer` + `StdioServerTransport` is a complete server** — no TypeScript, no bundler. Minimal stdio server in the SDK is ~20 lines (`new McpServer({name, version})`, `server.tool(...)`, `server.connect(new StdioServerTransport())`).
- **True zero-dependency option.** MCP's stdio transport is newline-delimited JSON-RPC 2.0 (no Content-Length framing in the current spec). A tools-only server (initialize / tools/list / tools/call, latest protocol version string) is ~150–200 lines of hand-rolled Node with zero `node_modules`. This makes a genuinely **single-file `soma-bus.mjs`** possible: `{"command": "node", "args": ["<abs path>/soma-bus.mjs"]}` in `.mcp.json`, identical on all 3 OSes. Recommended for v1 (also dodges the notorious Windows `npx.cmd` spawn problem: Node's `spawn` won't exec `.cmd` shims without `shell: true`, a recurring MCP-on-Windows failure class — `command: "node"` + absolute script path sidesteps it entirely).
- The spawner half (tmux/session management, worktree creation, notifications) is also naturally Node: `child_process.execFile("tmux", ...)`, `os.homedir()`, `path.join()` handle per-OS differences in one codebase.

**Verdict:** one plain-Node `.mjs` (or two: bus + spawner lib), stdio MCP, hand-rolled JSON-RPC for zero deps (or the official SDK if we accept one `npm i`). No Python, no shell scripts as the core.

---

## 5. Desktop notifications per OS (from a CLI daemon)

| OS | One-liner | Notes |
|---|---|---|
| macOS | `osascript -e 'display notification "lead-3 reported: PR ready" with title "soma" sound name "Glass"'` | `/usr/bin/osascript` present on every Mac (verified locally). Caveat: notifications attribute to "Script Editor"; `terminal-notifier` (brew) gives nicer identity but is NOT preinstalled (verified absent locally) — treat as optional enhancement. |
| Linux | `notify-send -a soma "soma" "lead-3 reported: PR ready"` | libnotify; needs a notification daemon (any desktop env has one). From a detached daemon, `DBUS_SESSION_BUS_ADDRESS` must be set (usually `unix:path=/run/user/$UID/bus`) — capture it at spawn time or default to that path. |
| Windows (native) | `powershell -Command "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null; $x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $x.GetElementsByTagName('text').Item(0).InnerText='soma'; $x.GetElementsByTagName('text').Item(1).InnerText='lead-3 reported'; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('soma').Show([Windows.UI.Notifications.ToastNotification]::new($x))"` | Raw WinRT XML template — **zero install**, works in Windows PowerShell 5.1 (always present). The WinRT projection is unreliable in pwsh 7.x, so invoke `powershell.exe` explicitly, not `pwsh`. BurntToast (`Install-Module BurntToast; New-BurntToastNotification -Text 'soma','lead-3 reported'`) is nicer but is a gallery install — wrong default for a zero-setup tool. |
| Windows (soma in WSL2) | `powershell.exe -Command "...same as above..."` from *inside* WSL | WSL interop lets Linux processes exec Windows binaries; the toast appears as a native Windows notification. This is the payoff: the WSL-resident daemon still notifies the Windows GUI. `wsl-notify-send` exists but is an extra install. |

Implementation: one `notify(title, body)` function switching on `process.platform` + a WSL sniff (`/proc/version` contains "microsoft") to pick the `powershell.exe` branch on WSL.

---

## 6. Process persistence without systemd

Constraints given: machine always on, user logged in. Then:

- **tmux server IS the supervisor.** `tmux new-session -d -s soma-<lead>` detaches from any terminal; the tmux server (one per user per socket dir) survives terminal close, SSH disconnect, GUI terminal crash. Orchestrator, leads, and the bus daemon all live as tmux sessions/panes → `tmux ls` is the process inventory, `tmux attach` is the dashboard. This matches how claude-soma already thinks.
- **launchd / systemd --user / Task Scheduler: not needed for v1.** They only add boot-time autostart and crash-respawn of the tmux server itself. With an always-on, logged-in machine, "run `soma up` once after reboot" is an acceptable contract; document it, don't engineer it. (If ever wanted: launchd LaunchAgent on macOS, `systemd --user` on Linux, Task Scheduler "At log on" on Windows — all just run `tmux new-session -d ...`. Keep as a v2 note.)
- **WSL2 nuance:** the WSL2 VM and distro stay up while any process runs in them — a detached tmux server counts, and modern WSL keeps background daemons alive after the last console closes. Two real gotchas: (a) `wsl --shutdown` / Windows Update reboots kill everything silently — same "re-run soma up" contract; (b) don't rely on WSL's experimental `vmIdleTimeout` semantics; the tmux server holding the distro alive is the mechanism. Optionally register a Task Scheduler logon task running `wsl.exe -d Ubuntu -- tmux new -d -s soma ...` to restore after reboot.
- The MCP bus itself doesn't even need to be a daemon in v1: stdio MCP servers are spawned per Claude session by Claude Code. Anything that must outlive a single session (lead registry, report queue) belongs in files under `~/.soma/`, not in a resident process. If a resident watcher is needed (e.g. to fan-in reports and send-keys the orchestrator), run it as one more detached tmux session — supervised by the same tmux server.

**Recommendation: tmux-as-supervisor, no OS service managers in v1.**

---

## 7. Filesystem / path gotchas

- **git worktrees on Windows: supported and fine** (worktrees have been core git since 2.5). Real gotchas: (a) Windows 260-char MAX_PATH — soma-lite's `~/.soma/worktrees/<ticket>/...` nesting plus node_modules can blow it; mitigation: short worktree root (e.g. `C:\w\` native, irrelevant under WSL) and document `git config --system core.longpaths true` + the `LongPathsEnabled` registry policy. (b) **Never mix WSL git and Windows git on the same worktree tree**: `.git/worktrees/<name>/gitdir` stores an *absolute path*; a worktree added from WSL stores `/home/...` which Windows git can't resolve (and tools mangle it into `C:\mnt\c\...` — see GitWorktree issue #16). Rule: on the WSL route, repo + worktrees live entirely in the Linux fs (`~/...`, not `/mnt/c/...`) — which is also the perf-correct choice (drvfs I/O is slow).
- **Path separators in MCP config JSON:** JSON requires `\\` for backslashes; Node (and most tooling) accepts forward slashes on Windows. Rule: always emit forward slashes or escaped backslashes when generating `.mcp.json`; never hand-concatenate — use `path.join()` and JSON.stringify. Prefer `"command": "node"` + absolute-forward-slash script arg (also avoids the `npx.cmd` spawn-shell issue). On the WSL route this is moot: paths are POSIX.
- **tmux socket paths under WSL:** tmux defaults to `/tmp/tmux-$UID/default` — Linux fs, works. **Never point `tmux -S` at `/mnt/c/...`**: AF_UNIX sockets on drvfs paths can only talk to *Windows* sockets, and Linux-side binds there fail (Microsoft devblog "Windows/WSL Interop with AF_UNIX"). Same rule for any bus socket: keep sockets in `/tmp` or `$XDG_RUNTIME_DIR`. Also: each WSL distro has its own tmux server; soma must pin one distro (default distro) and always go through it.
- **Home-dir conventions:** use Node `os.homedir()` everywhere → `/Users/x` (macOS), `/home/x` (Linux/WSL), `C:\Users\x` (native Windows, `%USERPROFILE%`). State root `~/.soma/` under that. Critical WSL subtlety: WSL home and Windows home are *different directories* — a WSL-resident soma has its `~/.soma` inside the Linux fs and it will not be visible to native-Windows tools at `%USERPROFILE%\.soma` (only via `\\wsl$\<distro>\home\x\.soma`). Decide once: **on Windows, all soma state lives in WSL.** Claude Code's own state (`~/.claude/teams/...`, `~/.claude/tasks/...`) follows the same split — another reason everything must live on one side.

---

## 8. Wake-the-orchestrator mechanics

- The bus must nudge an *interactive* Claude session when a lead reports. On macOS/Linux/WSL: `tmux send-keys -t soma-orch "lead-3 reported: PR #40 ready for review" Enter` — types into the orchestrator's Claude prompt and submits. Battle-tested (claude-soma does exactly this); works identically inside WSL because it's just tmux-on-Linux.
- **Windows-native alternatives: none acceptable.**
  - `wt.exe` has no input-injection or pane-query commands (verified against the full CLI argument reference — it's launch/focus/move only).
  - `WScript.Shell.SendKeys` / PowerShell `System.Windows.Forms.SendKeys`: injects into the *focused* window only — focus-stealing, race-prone, types into whatever the operator is doing. Disqualified.
  - Writing to another console's input buffer (`WriteConsoleInput` via AttachConsole) requires attaching to the target process's console — brittle, breaks under Windows Terminal's conpty, not something to ship.
  - A hooks-based alternative (lead's report triggers a file the orchestrator polls via its own hook/loop) changes the design from push to poll and still can't *wake* an idle interactive session mid-`await`.
- **Conclusion: the orchestrator must live inside tmux, period.** That is the honest architectural constraint, and it decides the Windows story: soma-lite on Windows *is* soma-lite inside WSL2.

---

## Final recommendation — supported-platform matrix

| Capability | macOS | Linux | Windows (WSL2) | Windows (native) |
|---|---|---|---|---|
| Claude Code | ✅ official | ✅ official | ✅ official (Linux install inside WSL) | ✅ official |
| tmux (leads, persistence, wake) | ✅ | ✅ | ✅ (inside WSL; sockets on Linux fs) | ❌ (MSYS2/Cygwin tmux: fragile, unsupported) |
| Agent-team split panes | ✅ tmux / iTerm2 (`it2`) | ✅ tmux | ✅ tmux inside WSL | ❌ (docs: not supported in Windows Terminal) — in-process only |
| `tmux send-keys` wake | ✅ | ✅ | ✅ | ❌ no equivalent |
| git worktrees | ✅ | ✅ | ✅ (keep repos in Linux fs) | ✅ (longpaths caveat) |
| Desktop notifications | ✅ osascript | ✅ notify-send | ✅ powershell.exe toast via WSL interop | ✅ PowerShell toast |
| Bus (Node stdio MCP, single .mjs) | ✅ | ✅ | ✅ | ✅ |

**What "Windows support" should honestly mean for v1:**
> *"Windows is supported via WSL2. Install Claude Code, tmux, git, and soma-lite inside your WSL2 distro; keep repos on the Linux filesystem. Everything then behaves exactly like Linux — split-pane agent teams included — and desktop toasts still pop on your Windows desktop (via `powershell.exe` interop). Optionally open Windows Terminal tabs as viewers onto lead tmux sessions (`wt new-tab wsl.exe -e tmux attach -t <lead>`). Native (non-WSL) Windows is NOT supported in v1: Claude Code runs there, but split panes don't (per Anthropic docs), no tmux means no session persistence, and there is no mechanism to wake an orchestrator session."*

This costs almost zero Windows-specific code (one WSL sniff for the notification branch, path hygiene that Node gives for free) and avoids shipping a degraded, differently-shaped native mode that would double the test matrix. Revisit native Windows only if Anthropic ships a Windows-Terminal-native split-pane/teams story.

### Design decisions this locks in
1. tmux is a hard, load-bearing dependency (supervisor + display + wake channel) → platform floor = "anywhere tmux and Claude Code coexist" = macOS, Linux, WSL2.
2. Runtime = plain Node (`.mjs`), stdio MCP; hand-rolled newline-JSON-RPC for a zero-dep single file, or `@modelcontextprotocol/sdk@1.30.x` (node>=18) if one `npm i` is acceptable. Never `npx` in `.mcp.json` commands.
3. All state under `~/.soma/` resolved via `os.homedir()`; on Windows that means *inside WSL*, one distro, sockets/repos on Linux fs only.
4. `notify(title, body)`: platform switch — osascript / notify-send / powershell.exe raw-XML toast (WSL-interop aware). No BurntToast/terminal-notifier deps by default.
5. No launchd/systemd/Task Scheduler in v1; tmux server is the supervisor; "re-run `soma up` after reboot" is the documented contract.
6. Agent teams: leads run with `teammateMode: "auto"` (split panes since leads are already inside tmux); requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` — teams are experimental and their surface (e.g. TeamCreate/TeamDelete already removed as of v2.1.178) can shift under us; pin/document a known-good Claude Code version range.

### Sources
- https://code.claude.com/docs/en/setup (system requirements; Windows native vs WSL table; Git Bash/PowerShell tool; native binary ≠ Node)
- https://code.claude.com/docs/en/agent-teams (display modes; "Split panes require tmux or iTerm2"; Windows Terminal unsupported for panes; in-process works anywhere; experimental flag)
- https://learn.microsoft.com/en-us/windows/terminal/command-line-arguments (wt new-tab/split-pane/--title/-w; no injection/attach)
- https://devblogs.microsoft.com/commandline/windowswsl-interop-with-af_unix/ (drvfs vs lxfs Unix-socket boundary)
- https://github.com/msys2/MSYS2-packages/issues/2045, https://github.com/tmux/tmux/issues/3095, community gists (MSYS2/Git-Bash tmux fragility)
- https://github.com/zielu/GitWorktree/issues/16 (WSL↔Windows worktree absolute-path mangling); core.longpaths guidance (multiple sources)
- npm registry: `@modelcontextprotocol/sdk` 1.30.0, engines node>=18, dependency list (via `npm view`, 2026-07-29)
- Local verification: tmux 3.6a, node v20.18.2, claude 2.1.220, `/usr/bin/osascript` present, `terminal-notifier`/`notify-send` absent on this Mac
