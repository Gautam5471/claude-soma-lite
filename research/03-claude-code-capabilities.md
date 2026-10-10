# Claude Code capabilities — ground truth for claude-soma-lite

Researched 2026-07-29 on THIS machine. Local CLI is authoritative:

```
$ claude --version
2.1.220 (Claude Code)
$ which claude
~/.local/bin/claude
```

Docs source: `docs.claude.com/en/docs/claude-code/*` now 301-redirects to
`code.claude.com/docs/en/*` — fetch the latter. Full index: `https://code.claude.com/docs/llms.txt`.

---

## 1. CLI flags (from `claude --help`, v2.1.220)

All flags below confirmed present in local `--help` output unless marked *hidden*.

| Flag | Exists? | Notes (verbatim from --help where quoted) |
|---|---|---|
| `--model <model>` | YES | "Provide an alias for the latest model (e.g. **'fable'**, 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5')." → **the alias `fable` is documented directly in the CLI help.** |
| `--effort <level>` | YES | "Effort level for the current session (**low, medium, high, xhigh, max**)". This is the reasoning-effort flag. (`--effort ultracode` also accepted ≥2.1.203 per docs.) |
| `--permission-mode <mode>` | YES | choices: `"acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"`. Note: CLI uses `manual` (alias for settings' `default`). |
| `--append-system-prompt <prompt>` | YES | "Append a system prompt to the default system prompt" |
| `--system-prompt <prompt>` | YES | full replacement |
| `--system-prompt-file <file>` | YES (*hidden*) | not listed in --help, but `claude --system-prompt-file` errors with `option '--system-prompt-file <file>' argument missing` → flag exists. Also referenced in `--bare` help text: "Explicitly provide context via: --system-prompt[-file], --append-system-prompt[-file] …" |
| `--append-system-prompt-file <file>` | YES (*hidden*) | same probe: `option '--append-system-prompt-file <file>' argument missing` |
| `--mcp-config <configs...>` | YES | "Load MCP servers from JSON files or strings (space-separated)" |
| `--strict-mcp-config` | YES | "Only use MCP servers from --mcp-config, ignoring all other MCP configurations" |
| `--settings <file-or-json>` | YES | "Path to a settings JSON file or a JSON string to load additional settings from" |
| `--setting-sources <sources>` | YES | "Comma-separated list of setting sources to load (user, project, local)" — lets soma-lite exclude user/project settings for leads |
| `--add-dir <directories...>` | YES | "Additional directories to allow tool access to" |
| `--agents <json>` | YES | inline JSON custom agent definitions; also `--agent <agent>` selects one for the session |
| `-p, --print` | YES | non-interactive; "The workspace trust dialog is skipped when Claude is run in non-interactive mode" |
| `--output-format <format>` | YES | print-only: `"text"` (default), `"json"`, `"stream-json"` |
| `--input-format` | YES | print-only: `text` / `stream-json` (realtime streaming input) |
| `--session-id <uuid>` | YES | "Use a specific session ID for the conversation (must be a valid UUID)" |
| `-r, --resume [value]` | YES | "Resume a conversation by session ID, or open interactive picker"; plus `-c/--continue`, `--fork-session` |
| `--dangerously-skip-permissions` | YES | "Bypass all permission checks. Recommended only for sandboxes with no internet access." Plus `--allow-dangerously-skip-permissions` (makes bypass *available* without defaulting to it) |
| `--allowedTools / --disallowedTools` | YES | "Comma or space-separated list of tool names to allow (e.g. \"Bash(git *) Edit\")" |
| `--tools <tools...>` | YES | restrict the built-in toolset itself: `""` disables all, `"default"` all, or names e.g. `"Bash,Edit,Read"` — **stronger than permissions for making a lead planning-only** |
| `--bare` | YES | "Minimal mode: skip hooks, LSP, plugin sync, … CLAUDE.md auto-discovery" — deterministic headless runs |
| `--json-schema <schema>` | YES | structured output validation in -p mode (result in `structured_output` field) |
| `--max-budget-usd <amount>` | YES | print-only spend cap |
| `-w, --worktree [name]` | YES | "Create a new git worktree for this session" |
| `--tmux` | YES | "Create a tmux session for the worktree (requires --worktree). Uses iTerm2 native panes when available; use `--tmux=classic` for traditional tmux." |
| `--remote-control [name]` | YES | "Start an interactive session with Remote Control enabled (optionally named)"; also `claude remote-control` server-mode subcommand |
| `--bg, --background` | YES | "Start the session as a background agent … (manage with `claude agents`)"; `claude agents --json` prints active sessions for scripting |
| `-n, --name <name>` | YES | display name in prompt box / resume picker / terminal title |
| `--fallback-model <model>` | YES | print-only, comma-separated chain |
| `--include-hook-events` | YES | stream-json only: "Include all hook lifecycle events in the output stream" |
| `--forward-subagent-text` | YES | stream-json only: reconstruct subagent transcripts |
| `--no-session-persistence` | YES | print-only |
| `--teammate-mode <mode>` | YES (*hidden*) | docs: "The `--teammate-mode` flag is experimental and doesn't appear in `claude --help`." |

**`claude config` no longer exists as a subcommand** — `claude config --help` just prints the main help. Config surface is now `/config` in-session, settings files, and `--settings`.

`claude mcp --help` subcommands: `add` (with `--transport stdio|sse|http`, `-e KEY=val`, `-H header`, `-s/--scope local|user|project`), `add-json`, `add-from-claude-desktop`, `get`, `list`, `login`, `logout`, `remove`, `reset-project-choices`, `serve`. `claude mcp list/get` show unapproved `.mcp.json` servers as "⏸ Pending approval".

---

## 2. Model + effort pinning

### Settings keys (docs /settings + /model-config, confirmed by this machine's real file)

`~/.claude/settings.json` on this machine (real example):
```json
{
  "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" },
  "model": "fable",
  "effortLevel": "low",
  "teammateMode": "tmux",
  ...
}
```

- **`model`**: settings key; "Accepts model aliases: `opus`, `sonnet`, `haiku`, **`fable`**" or full model IDs. Read once at session start. `/model <alias>` **persists**: "As of v2.1.153, `/model` saves your choice as the default for new sessions by writing the `model` field in your user settings." In `-p` mode `/model` is session-only.
- **`effortLevel`**: settings key; accepts `"low"|"medium"|"high"|"xhigh"` — **docs: "`max` and `ultracode` are session-only and are not accepted here."** Written automatically by `/effort`.
- **CRITICAL for soma-lite (leads pinned to effort max)**: docs quote — "`low`, `medium`, `high`, and `xhigh` persist across sessions when you set them in an interactive session. **`max` provides the deepest reasoning and applies to the current session only, except when set through the `CLAUDE_CODE_EFFORT_LEVEL` environment variable.**" → To pin `max`, launch every lead with `--effort max` **or** `CLAUDE_CODE_EFFORT_LEVEL=max` in its environment (env var "takes precedence over all other methods, then your configured level, then the model default"). You cannot pin max via settings.json.
- **Fable 5 supports effort levels `low, medium, high, xhigh, max`** (model-config table). Default effort is `high`.
- Env vars: `ANTHROPIC_MODEL` (per-session model, "apply only to the session you launch with them"), `CLAUDE_CODE_EFFORT_LEVEL` (`low|medium|high|xhigh|auto`, and works for max per quote above; docs note it doesn't accept `ultracode`), `CLAUDE_CODE_SUBAGENT_MODEL` (overrides model for all subagents incl. workflow agents), `MAX_THINKING_TOKENS=0` "disables thinking, **except on Fable 5**" (Fable 5 always uses adaptive reasoning), `ANTHROPIC_DEFAULT_FABLE_MODEL` (what the `fable` alias resolves to).
- Effort can also be set in **skill/subagent frontmatter** (`effort:` field) — "overriding the session level but not the environment variable".
- Settings precedence: managed > CLI args > `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json`. Permission rules MERGE across scopes (exception).
- Gotcha: Fable-5 safety classifiers can auto-fall-back the session to Opus on cyber/bio-flagged requests ("automatic model fallback") — a "pinned" fable session is not absolutely guaranteed to stay on fable.
- `ultracode` = `/effort ultracode` or `claude --effort ultracode`: `xhigh` + auto-workflow-orchestration, session-only. Relevant since soma-lite wants leads to use workflows.

## 3. Agent teams (docs /agent-teams, v2.1.178+ semantics; local v2.1.220)

- **Enable**: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env var or in settings `env` block. "Agent teams are experimental and disabled by default… Without that variable, no team is set up at session start, no team directories are written, and Claude does not spawn or propose teammates." Already enabled on this machine (user settings).
- **Display modes** via `teammateMode` setting (this machine: `"tmux"`) or hidden `--teammate-mode` flag. Values: `"in-process"` (default since 2.1.179), `"auto"`, `"tmux"`, `"iterm2"` (≥2.1.186, needs `it2` CLI).
  - **tmux panes: Claude Code creates the split panes itself** when in split-pane mode. `"auto"` = "enable split panes when you're already running inside a tmux session, or when your terminal is iTerm2 with the `it2` CLI installed, falling back to in-process otherwise. The `"tmux"` setting enables split-pane mode and auto-detects whether to use tmux or iTerm2."
  - **Not in tmux**: teammates still run, **in-process** — "all teammates run inside your main terminal… Works in any terminal, no extra setup required." Agent panel below prompt input (arrows select, Enter view/message, Esc interrupt, `x` stop, Ctrl+T task list).
- **SendMessage**: teammates message each other directly by name; "Automatic message delivery… The lead doesn't need to poll." Mailbox = JSON file `~/.claude/teams/{team-name}/inboxes/{agent-name}.json`. Receiving agent "is told it came from another Claude session, not from you"; a teammate cannot approve permissions on the user's behalf. Idle teammates auto-notify the lead; API-error failures notify the lead with error text (≥2.1.198).
- **Shared task list**: `~/.claude/tasks/{team-name}/`; states pending/in progress/completed; dependencies; "Task claiming uses file locking to prevent race conditions." Lead assigns or teammates self-claim. Task dir persists for resumed sessions; team config dir (`~/.claude/teams/{team-name}/config.json`, name = `session-` + first 8 chars of session ID) is removed at session end. Don't pre-author config — overwritten.
- **Limits** (verbatim from Limitations):
  - "**One team per session**: a session has exactly one team… You can't create additional named teams or share a team across sessions."
  - "**No nested teams**: teammates cannot spawn their own teammates. Only the lead can manage the team." → soma-lite leads can each run ONE team; teammates cannot recurse.
  - "**Lead is fixed**… can't promote a teammate to lead."
  - "**No session resumption with in-process teammates**: /resume and /rewind do not restore in-process teammates."
  - "**No background subagents from in-process teammates**."
  - No hard teammate-count limit; docs recommend 3–5, 5–6 tasks per teammate.
- **Plan approval / delegate**: "Require plan approval before they make any changes" — teammate stays in read-only plan mode until the **lead approves autonomously** (the designed exception to permission bubbling). Teammate permission prompts otherwise appear in the lead session. Teammates start with the lead's permission mode ("If the lead runs with --dangerously-skip-permissions, all teammates do too"); per-teammate modes only changeable after spawn.
- **Models/effort**: teammates don't inherit lead's `/model` (config: "Default teammate model"), but "Teammates inherit the lead's effort level" (split-pane from ≥2.1.186).
- **Subagent definitions as teammates**: spawn "using the security-reviewer agent type"; honors `tools` allowlist + `model`; `SendMessage` + task tools always available; `skills`/`mcpServers` frontmatter NOT applied to teammates.
- **iTerm2**: yes, native split panes via `it2` CLI (`teammateMode: "iterm2"`, or auto-detected under `"tmux"`/`"auto"`).
- **Windows**: "Split-pane mode isn't supported in VS Code's integrated terminal, **Windows Terminal**, or Ghostty." → on Windows teams run **in-process only** (soma-lite's "tmux teammate panes" pillar is macOS/Linux; Windows degrades to in-process).
- **Hooks for teams**: `TeammateIdle` (exit 2 = keep working), `TaskCreated` / `TaskCompleted` (exit 2 = block + feedback).
- Historical: `TeamCreate`/`TeamDelete` tools no longer exist; `team_name` input on Agent tool accepted but ignored.

## 4. Dynamic workflows (docs /workflows)

- **Availability**: "Dynamic workflows require Claude Code v2.1.154 or later and are available on all paid plans… On Pro, turn them on from the Dynamic workflows row in `/config`." → available in normal local CLI sessions (and "in the CLI, the Desktop app, the IDE extensions, non-interactive mode with `claude -p`, and the Agent SDK").
- A workflow = JavaScript script Claude writes; runtime executes in background; `agent()` spawns one subagent, `pipeline()` one per list item; script saved under `~/.claude/projects/<session>/`.
- **Triggering**: keyword `ultracode` in a *human-typed* prompt, natural language "use a workflow", `/effort ultracode` (auto-orchestrate every substantive task), or saved workflow commands. **Keyword does NOT trigger from `-p` prompts** ("It doesn't start a workflow when it reaches the session another way: a prompt passed with `-p` …") — but workflows themselves DO run in `-p` (no approval prompt there: "Bypass permissions, `claude -p`, Agent SDK: Never. The run starts immediately").
- **Gating/settings**: `/config` rows "Dynamic workflows" (on/off; `disableWorkflows: true` in settings or `CLAUDE_CODE_DISABLE_WORKFLOWS=1`) and "**Dynamic workflow size**" = `workflowSizeGuideline` setting (`unrestricted|small(<5)|medium(<15, default ≥2.1.219)|large(<50)`), settable via `/config workflowSizeGuideline=small` or settings file (≥2.1.219).
- **Limits**: "Up to 16 concurrent agents, fewer on machines with limited CPU cores"; "1,000 agents total per run"; no mid-run user input; script itself has no fs/shell access (agents do). Workflow subagents "always run in `acceptEdits` mode and inherit your tool allowlist, regardless of your session's mode."
- **Resume**: resumable within the same session only ("If you exit Claude Code while a workflow is running, the next session starts the workflow fresh"). Replay caches results in start-order up to first unfinished agent.
- Saved workflows: `.claude/workflows/` (project) or `~/.claude/workflows/` (user) → become `/name` commands; accept `args` global (structured data). Memory note (workflow-args-json-string.md): `args` can arrive as a STRING — parse defensively.
- Monitoring: `/workflows` view (pause `p`, stop `x`, save `s`); "Large workflow" advisory at >25 agents or >1.5M projected tokens.

## 5. Hooks (docs /hooks)

- **Event names** (30 as of 2.1.220): SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, **TeammateIdle**, InstructionsLoaded, ConfigChange, CwdChanged, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, Elicitation, ElicitationResult, SessionEnd.
- **PreToolUse deny** — two ways:
  1. exit 0 + stdout JSON:
     ```json
     {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}
     ```
  2. exit code **2** with message on stderr ("Blocking error: tool call is prevented").
  `permissionDecision` ∈ `deny | allow | ask | defer`; `allow` may carry `updatedInput` to rewrite tool input.
- **SessionStart additionalContext**: `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}` — "Claude Code wraps the string in a system reminder and inserts it into the conversation at the start, before the first prompt." → soma-lite can inject per-lead briefing (ticket, harness choice, role constraints) via a project SessionStart hook instead of only --append-system-prompt.
- **Scoping**: hooks configurable in `~/.claude/settings.json` (all projects), `.claude/settings.json` (per project, committed), `.claude/settings.local.json` (per project, gitignored), managed policy, plugin hooks.json, skill/agent frontmatter. Hook arrays MERGE across sources. `disableAllHooks` kills all.
- Matchers: `*`/empty = all; plain strings/`|`/`,` lists = exact tool names; other chars = JS regex. Handler types: `command`, `http`, `mcp_tool`, `prompt`, `agent`; common fields `if` (permission-rule filter), `timeout`, `statusMessage`.
- Stop hook: can block stop (exit 2 / `decision:"block"`), gets `last_assistant_message` — this is the verify-gate mechanism. TeammateIdle exit 2 = feedback + keep teammate working.

## 6. MCP wiring (docs /mcp)

- **Scopes** (`claude mcp add -s …`): `local` (default; stored in `~/.claude.json` under the project path — "Older versions called this scope `project`"), `project` (`.mcp.json` in repo root, shared), `user` (`~/.claude.json`, all projects). Same-name precedence: single highest-precedence definition wins, "fields are not merged across scopes."
- **.mcp.json approval**: "For security reasons, Claude Code prompts for approval before using project-scoped servers from `.mcp.json` files." Reset with `claude mcp reset-project-choices`. Pending servers show "⏸ Pending approval (run `claude` to approve)". Committed `enableAllProjectMcpServers`/`enabledMcpjsonServers` in project settings are ignored in an untrusted folder (≥2.1.196) — soma-lite leads spawned in fresh worktrees must either pre-trust or use `--mcp-config`.
- **`--mcp-config <files-or-json>` injects servers at launch; `--strict-mcp-config` ignores everything else** → the clean soma-lite path: leads get exactly one orchestrator MCP server, no approval prompt, no inherited user servers. In -p/stream-json, invalid entries are skipped (see `mcp_server_errors` in `system/init`).
- **Transports**: stdio, SSE (deprecated), HTTP (`streamable-http` alias accepted), WebSocket (`type:"ws"`, json-only config, header auth only).
- **Tool naming**: `mcp__<server>__<tool>` (e.g. rules/hooks match `mcp__db__query`); plugin-bundled: `mcp__plugin_<plugin>_<server>__<tool>`.
- **Prompts as slash commands**: "MCP prompts appear with the format `/mcp__servername__promptname`" — args space-separated, e.g. `/mcp__github__pr_review 456`; dynamically discovered.
- `claude mcp serve` runs Claude Code itself as an MCP server. Per-server `timeout` (ms) field; `MCP_TOOL_TIMEOUT` default ≈28h.

## 7. Remote control / attach-from-anywhere (docs /remote-control)

- Three entry points: **`claude remote-control`** (server mode: stays running, prints session URL + QR; `--spawn same-dir|worktree|session`, `--capacity` default 32), **`claude --remote-control` / `--rc [name]`** (normal interactive session also reachable remotely), **`/remote-control` (`/rc`) command** from inside an existing session ("carries over your current conversation history"; Claude Code also posts the session URL).
- Connect: open the session URL in any browser (claude.ai/code) or scan the QR (Claude iOS/Android app). Session appears in claude.ai/code session list with green dot.
- Mechanics: "Claude keeps running locally the entire time"; "outbound HTTPS requests only and never opens inbound ports"; transcript stored on Anthropic servers while connected. Requires Pro/Max/Team/Enterprise claude.ai login (no API keys), api.anthropic.com only, workspace trust accepted, and feature-flag evaluation not disabled (DISABLE_TELEMETRY etc. break it).
- Limitations: one remote session per interactive process (server mode for many); local process must stay alive — docs explicitly suggest tmux: "To keep a session running on a remote machine after you disconnect from SSH, start it inside `tmux` or `screen`." `/config` toggle "Enable Remote Control for all sessions" auto-connects every interactive session. `disableRemoteControl` setting turns it off.
- soma-lite fit: complementary — leads in tmux can each be `--rc`-enabled so the operator can also steer from phone; but soma-lite's stated design (operator attaches to tmux at the GUI) needs none of this.

## 8. Skills & slash commands (docs /skills; example `~/.claude/skills/<name>/SKILL.md`)

- Locations: `~/.claude/skills/<name>/SKILL.md` (user), `.claude/skills/<name>/SKILL.md` (project), plugins (`/plugin:skill`), enterprise. Directory name = command name. **"Custom commands have been merged into skills."** `.claude/commands/deploy.md` and `.claude/skills/deploy/SKILL.md` "both create `/deploy` and work the same way. Your existing `.claude/commands/` files keep working" (same frontmatter supported).
- Frontmatter (all optional; `description` recommended): `name` (display label; command name for plugin skills), `description` (+ `when_to_use`, combined cap 1,536 chars in listing), `argument-hint`, `arguments` (named args), **`disable-model-invocation: true`** (manual `/name` only — this is the auto-trigger switch), **`user-invocable: false`** (hide from `/` menu), **`allowed-tools`** (pre-approved tools for the invoking turn), `disallowed-tools`, **`context: fork`** (run in subagent) + `agent` (which subagent type) + `background` (default true for fork), `model`, `effort`, `paths` (glob-gated auto-load).
- **Auto-trigger vs explicit**: skills load automatically when relevant — "the `description` helps Claude decide when to load the skill automatically" — OR explicitly via `/skill-name`. `disable-model-invocation: true` forces explicit-only.
- Arguments: `$ARGUMENTS` (all; appended as `ARGUMENTS: <value>` if placeholder absent), `$ARGUMENTS[N]`, `$N` shorthand, `$name` (from `arguments:` list); `${CLAUDE_SKILL_DIR}` and `${CLAUDE_PROJECT_DIR}` substituted in body and in `allowed-tools` Bash rules.
- Skills work in `-p` mode: "include `/skill-name` in the prompt string and Claude Code expands it before running."
- Nested `.claude/skills/` below cwd lazy-load after Claude touches that subtree; `--add-dir` loads that dir's skills (settings `additionalDirectories` does NOT).

## 9. Headless orchestration (docs /headless)

- `claude -p "prompt"` runs one non-interactive session; reads stdin (≤10MB); workspace-trust dialog skipped; "Settings files that fail validation are silently ignored in this mode".
- `--output-format`: `text` | `json` (single result: `result`, `session_id`, `total_cost_usd`, per-model cost breakdown; `structured_output` with `--json-schema`) | `stream-json` (NDJSON; needs `--verbose` +optional `--include-partial-messages`; first event `system/init` with model, tools, `mcp_servers[]`, `mcp_server_errors[]`, `plugins[]`, `plugin_errors[]`, `capabilities[]`; `system/api_retry` events; last line = `result` message with cost + session metadata).
- **Hooks work in -p mode**: SessionStart/Setup hook events stream before `system/init`; `--include-hook-events` emits full hook lifecycle into stream-json; SIGTERM "runs SessionEnd hooks, and exits with code 143". Bare mode (`--bare`) is the opt-OUT: "A hook in a teammate's ~/.claude or an MCP server in the project's .mcp.json won't run, because bare mode never reads them."
- **MCP works in -p mode**: project/user MCP loads by default (skipped only under `--bare`); inject explicitly with `--mcp-config` (+ `--strict-mcp-config`).
- Exit codes: non-zero on errors (invalid `--json-schema` → `Error: --json-schema is not a valid JSON Schema`; stdin cap exceeded → "exits with a clear error and a non-zero status"); 143 on SIGTERM. `dontAsk`-denied required tool → run aborts.
- Sessions: `--resume <id>` / `--continue` work in -p; "session ID lookup is scoped to the current project directory and its git worktrees" — run from same dir. `--session-id <uuid>` pre-assigns. Background bash killed ~5s after result; background subagents/workflows waited on (cap 10min, `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`).
- Workflows run in -p with no approval prompt. The `ultracode` keyword does NOT trigger from a -p prompt.

## 10. Sandbox / permissions

- **Rule arrays**: `permissions.allow` / `ask` / `deny` in any settings file. "Rules are evaluated in order: deny, then ask, then allow. The first match in that order determines the outcome" — deny always wins; a broad deny can't carry narrower allow exceptions.
- **Hard-deny Edit/Write for a session — YES**, three mechanisms:
  1. `"permissions": {"deny": ["Edit","Write","NotebookEdit"]}` via `--settings '<json>'` or project settings. "A bare tool name like `Bash` removes the tool from Claude's context entirely, so Claude never sees it." (scoped rules like `Edit(src/**)` leave tool visible, block matching calls). Note ≥2.1.210: path-scoped `Write(path)`/`NotebookEdit(path)` rules are never matched — "Use `Edit(docs/**)` … (Edit rules cover all file-editing tools)"; bare `Write` deny is fine.
  2. `--disallowedTools "Edit,Write,NotebookEdit"` at launch.
  3. `--tools "Bash,Read,Grep,Glob"` — whitelist the built-in toolset without the editing tools at all.
  Caveat: Edit/Read deny rules also cover recognized file-y Bash commands (cat/head/sed…), but "don't apply to arbitrary subprocesses that read or write files indirectly" — a planning-only lead with Bash can still `python -c 'open(...,"w")'`. True read-only needs OS sandboxing or a tight Bash allowlist.
  4. Permission rules "merge across scopes rather than override" and "are enforced by Claude Code, not by the model."
- **Permission modes** (settings key `defaultMode`; CLI `--permission-mode`): `default` (prompt on first use; labeled/aliased **Manual**, ≥2.1.200), `acceptEdits` (auto-accept edits + mkdir/touch/mv/cp in cwd/additionalDirectories), `plan` ("reads files and runs read-only shell commands to explore but doesn't edit your source files"), `auto` (auto-approve w/ background safety classifier), `dontAsk` (auto-DENY anything not pre-allowed — the locked-down headless mode), `bypassPermissions` (skip prompts; still honors explicit `ask` rules + rm -rf / circuit breaker). `permissions.disableBypassPermissionsMode: "disable"` / `disableAutoMode` can forbid those modes.
- Path anchors in rules: `//abs`, `~/home`, `/settings-source-relative`, `./cwd-relative`. `additionalDirectories` extends the read boundary. Read-only Bash builtin set (ls, cat, grep, git-read…) never prompts and is not configurable (add ask/deny rules to gate).
- OS sandboxing (`/sandbox`, docs /sandboxing) exists separately for filesystem/network isolation; `claude remote-control` has `--sandbox`.

---

## Local machine specifics worth keeping

- v2.1.220 installed at `~/.local/bin/claude`; agent teams already enabled; `teammateMode: "tmux"`; user `model: "fable"`, `effortLevel: "low"` (leads must override with `--effort max`).
- `~/.claude.json` holds local/user MCP servers + per-project state.
- 35 user subagent defs in `~/.claude/agents/*.md`; ~40 user skills in `~/.claude/skills/`.

## Design implications for soma-lite (summary)

1. **Lead launch line** ≈ `claude --model fable --effort max --permission-mode plan (or --disallowedTools/--tools) --append-system-prompt-file lead.md --mcp-config soma.json --strict-mcp-config --session-id <uuid> -n <ticket>` inside a tmux session in a worktree; `env CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 CLAUDE_CODE_EFFORT_LEVEL=max` belt-and-braces (env var wins over user's persisted `effortLevel: low`).
2. Effort `max` is NOT persistable in settings — must be per-launch flag or env var. Model `fable` IS a documented alias everywhere (flag, settings, /model).
3. Planning-only leads: `--tools` whitelist or bare-name deny of Edit/Write/NotebookEdit; PLUS PreToolUse hook (`permissionDecision: "deny"`) as defense-in-depth; note Bash subprocess escape hatch.
4. Teams: one per lead session, no nesting, tmux split panes only via teammateMode tmux/auto (macOS/Linux; Windows = in-process fallback), teammates inherit lead's effort automatically.
5. Orchestrator↔lead comms: give leads a stdio MCP server via `--mcp-config` + `--strict-mcp-config` (no .mcp.json approval friction in fresh worktrees); orchestrator can also parse `--output-format stream-json` if leads are headless, but interactive-in-tmux leads talk back via MCP tools.
6. Loop-harness pinning at receipt: SessionStart hook `additionalContext` and/or UserPromptSubmit hook injection; Stop/TeammateIdle hooks (exit 2) enforce the loop.
7. Workflows are on by default on this plan tier and work in -p; gate size with `workflowSizeGuideline`; `ultracode` keyword won't fire from -p prompts — instruct leads in the system prompt to call the Workflow tool instead.
