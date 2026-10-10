# claude-soma orchestration internals — ground truth for soma-lite

Deep-read of `github.com/techfreakworm/claude-soma` (cloned 2026-07-29, `--depth 1`, default branch).
All quotes are verbatim from the repo, read from a local clone.

## Table of contents

1. [System topology in one paragraph](#1-system-topology-in-one-paragraph)
2. [(a) Lead spawn command construction — exact](#2-a-lead-spawn-command-construction--exact)
3. [(b) Orchestrator MCP tools — names and shapes](#3-b-orchestrator-mcp-tools--names-and-shapes)
4. [(c) Orchestrator → lead messaging (send-keys + pane scraping)](#4-c-orchestrator--lead-messaging)
5. [(d) Lead → orchestrator communication (hermes-notify)](#5-d-lead--orchestrator-communication)
6. [(e) Registry / persisted state](#6-e-registry--persisted-state)
7. [(f) Lifecycle: liveness, reconcile, watchdog, reaper, kill, resume](#7-f-lifecycle)
8. [(g) Project templates](#8-g-project-templates)
9. [(h) Linux-only parts that need replacing](#9-h-linux-only-parts)
10. [(i) Agent teams: one-team-per-session, enabling env, team discovery](#10-i-agent-teams)
11. [Misc mechanisms worth stealing](#11-misc-mechanisms-worth-stealing)
12. [Keep / Drop / Replace table for soma-lite](#12-keep--drop--replace-table-for-soma-lite)

---

## 1. System topology in one paragraph

A persistent "channel bot" (`claude --channels plugin:telegram@…` at `--effort low`, tmux session
`hermes` on the **default** tmux socket, systemd unit `claude-soma-channel.service`) acts as the
orchestrator. It loads a `project-orchestrator` MCP server (Python FastMCP, stdio) from
`.mcp.json`. That server spawns **project leads**: each lead is a full interactive `claude` process
at `--effort max`, in a **dedicated tmux server** (`tmux -L soma-lead-<name>`, session
`soma-proj-<name>`), wrapped in a **transient systemd unit** (`claude-soma-lead-<name>.service`,
via `sudo systemd-run`) so it lives in a sibling cgroup — a channel restart cannot kill leads.
State lives in one SQLite file (`/opt/claude-soma/registry.sqlite`). Orchestrator→lead messages are
raw `tmux send-keys`; replies are read by **scraping the pane** (`capture-pane -p`) — there is no
reply bus. Lead→orchestrator is a separate `hermes-notify` MCP tool that POSTs typed lifecycle
events (STARTED/MILESTONE/COMPLETED/NEEDS_INPUT/ERROR) to an HTTP listener on `127.0.0.1:9100`,
persisted to SQLite, and injected into the bot's next turn by a `UserPromptSubmit` hook. Leads run
Claude Code **agent teams** (split tmux panes) via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. A
systemd-timer **watchdog** revives dead leads (`--resume <uuid>` first, fresh spawn fallback,
exponential backoff), and a **reaper** hibernates idle leads and kills runaway ones (turn cap 50,
context cap 200k est. tokens). A multi-VPS layer (ssh forced-command guard) exists but is
server-infra; soma-lite can drop it.

Files that matter most:

| Concern | File |
|---|---|
| Spawn/resume/kill/liveness/team-discovery | `src/claude_soma/mcp_servers/project_orchestrator/spawner.py` |
| MCP tool surface + reconcile + admission | `src/claude_soma/mcp_servers/project_orchestrator/server.py` |
| SQLite registry | `src/claude_soma/mcp_servers/project_orchestrator/registry.py` |
| Watchdog (revive) | `src/claude_soma/mcp_servers/project_orchestrator/watchdog.py` |
| Reaper (hibernate/cap-kill) | `scripts/reaper.py` |
| Lead→orch notify tool | `src/claude_soma/mcp_servers/hermes_notify/server.py` |
| Notify → bot context injection | `scripts/notify_inject.sh` (UserPromptSubmit hook) |
| Notify convention (prepended to EVERY brief) | `system_prompts/lead_notify_convention.md` |
| Messaging skill (send-keys + scrape) | `skills/message-project/SKILL.md` |
| Operator tmux helper | `scripts/somux` |
| Cross-platform analysis | `docs/MULTI_PLATFORM_INSTALL.md` + `src/claude_soma/platform/` |

---

## 2. (a) Lead spawn command construction — exact

### 2.1 The full claude argv (local spawn, `spawner.py::spawn_background_lead`)

```python
claude_argv: list[str] = [
    _claude(),                       # native binary, default /home/ubuntu/.local/bin/claude
    "--session-id", session_uuid,    # uuid4 pinned at spawn => later `--resume <uuid>` works
    "--remote-control", session,     # keeps claude alive after first task + gives claude.ai RC URL
    "--add-dir", str(cwd),
    "--permission-mode", permission_mode,   # default "acceptEdits"
    "--dangerously-skip-permissions",
    "--effort", "max",
    "--setting-sources", "user,project,local",
]
lead_mcp_config = os.environ.get("HERMES_LEAD_MCP_CONFIG", LEAD_MCP_CONFIG_DEFAULT)
if Path(lead_mcp_config).exists():
    claude_argv += ["--mcp-config", lead_mcp_config]
if extra_args:
    claude_argv.extend(extra_args)
claude_argv += ["--", brief]        # `--` REQUIRED: --mcp-config is variadic and would
                                    # swallow the brief as a config path (ENAMETOOLONG crash)
```

Notes:

- **No `--model` flag anywhere.** Leads get the account default model; only effort is pinned
  (`--effort max`). soma-lite wants to ADD `--model fable` explicitly.
- `--remote-control <session-name>` doubles as (1) keep-alive after the first task completes
  (otherwise claude exits) and (2) an attach URL. Verbatim comment: *"project leads stay alive
  after their first task completes (otherwise claude exits) AND get an rc.claude.com URL"*.
- `--session-id` cannot be combined with `--continue` without `--fork-session` (comment in code
  cites the exact CLI error). Fresh spawn = `--session-id`; resume = `--resume <uuid>`.
- The brief is prepended, in `server.py::spawn_project_impl`, with the **notify convention** and
  the template default brief:

```python
composed_brief = (
    _NOTIFY_CONVENTION + "\n\n"          # system_prompts/lead_notify_convention.md
    + tmpl.get("default_brief", "") + "\n\n"
    + brief
)
```

### 2.2 The tmux wrapper (dedicated socket + spawn-time pipe-pane logging)

```python
tmux_argv: list[str] = [
    _tmux(), "-L", socket, "new-session", "-d", "-s", session,
    "-c", str(cwd), *claude_argv,
    ";", "pipe-pane", "-O", "-o", "-t", session,
    f"cat >> {shlex.quote(str(log_path))}",
]
```

- Socket: `soma-lead-<name>` (`LEAD_SOCKET_PREFIX = "soma-lead-"`).
- Session: `soma-proj-<name>` (`TMUX_SESSION_PREFIX = "soma-proj-"`).
- The `;` chains `pipe-pane` into the SAME tmux invocation so the pane is teed
  **from the moment the session is born** to `/var/log/claude-soma/<name>.log`
  (`HERMES_LEAD_LOG_DIR` overridable). `-O` = output only, `-o` = idempotent.
- cwd layout: `HERMES_PROJECTS_ROOT` (default `/home/ubuntu/projects`) `/ <name>`;
  `cwd.mkdir(parents=True, exist_ok=True)` before spawn.

### 2.3 The systemd-run wrapper (Linux-only isolation layer)

```python
return [
    SUDO_BIN, "-n", SYSTEMD_RUN_BIN, "--collect", "--quiet",
    f"--unit={_lead_unit(name)}",              # claude-soma-lead-<name>.service
    "--property=Type=oneshot",
    "--property=RemainAfterExit=yes",
    f"--property=User={LEAD_USER}",
    f"--property=Group={LEAD_GROUP}",
    f"--property=EnvironmentFile=-{LEAD_ENV_FILE}",   # /etc/claude-soma/secrets.env (OAuth token; never argv)
    *list(mem_props or []),                    # optional --property=MemoryMax/MemoryHigh per tier
    f"--setenv=HOME={LEAD_HOME}",
    f"--setenv=PATH={LEAD_PATH}",
    "--setenv=CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1",
    "--setenv=CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=0",
    f"--setenv=HERMES_LEAD_NAME={name}",
    "--",
    *inner_argv,                               # the tmux argv above
]
```

Key env vars set on every lead:

| Env var | Purpose |
|---|---|
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` | **THE flag that enables agent teams** (teammates as split tmux panes) |
| `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=0` | kills faint autosuggest text that send-keys could accidentally submit |
| `HERMES_LEAD_NAME=<name>` | lead self-identity; the notify MCP reads this instead of taking a param |
| `HOME`, `PATH` | fresh systemd unit inherits nothing; claude needs `~/.claude.json`, native bin, git/gh/node |
| `EnvironmentFile=-/etc/claude-soma/secrets.env` | `CLAUDE_CODE_OAUTH_TOKEN` etc. — file, never argv (ps-leak avoidance) |
| (remote guard only) `HERMES_NOTIFY_URL=http://<A-ip>:9100/notify`, `DISABLE_AUTOUPDATER=1`, `OOMScoreAdjust=800` | remote-lead variants |

Rationale for the whole wrapper (from `docs/notes/2026-05-25-project-lead-cgroup-teardown.md`):
the channel unit's `KillMode=control-group` SIGKILLed the shared tmux server, so *"Any restart of
claude-soma-channel.service … instantly kills EVERY running project lead."* Fix: each lead gets its
own transient unit + own tmux server born inside that unit, i.e. a **sibling cgroup**.
Constraint preserved: *"claude needs a real PTY (it drops to `--print` mode on a pipe), which is
why tmux is used."*

### 2.4 Pre-trust of the cwd (critical for detached spawn on ANY platform)

`_pretrust_cwd()` writes `~/.claude.json` (override `HERMES_CLAUDE_GLOBAL_JSON`) before spawning:

```python
projects = data.setdefault("projects", {})
entry = projects.setdefault(str(cwd), {})
entry["hasTrustDialogAccepted"] = True
entry.setdefault("projectOnboardingSeenCount", 0)
```

Atomic write (tempfile + fsync + `os.replace`, chmod 600). Without this, *"a tmux-detached claude
blocks forever waiting for a human to hit Enter"* on the trust dialog. Note the comment:
`~/.claude/settings.json` is **ignored** for trust in 2.1.150 — only `~/.claude.json` counts.

### 2.5 Remote-Control URL capture (pane polling)

```python
RC_URL_RX = re.compile(
    r"https?://claude\.ai/code/session_[A-Za-z0-9_-]+"
    r"|https?://rc\.claude\.com/\S+"
)
RC_URL_POLL_SECONDS = 30
RC_URL_POLL_INTERVAL = 2
```

`_capture_rc_url` polls `tmux -L <socket> capture-pane -p -t <session>` every 2s up to 30s until
the regex matches. (A single capture right after spawn raced with claude's startup output and
silently returned `""` — hence polling.)

### 2.6 Spawn return value

```python
return {"agent_id": session, "rc_url": rc_url, "cwd": str(cwd), "session_uuid": session_uuid}
```

Guards on spawn: `NAME_RX = ^[a-z][a-z0-9-]{0,63}$`, `MAX_BRIEF_CHARS = 100_000`,
`SPAWN_TIMEOUT = 20` s, and a helpful error if the transient unit "already exists" (stale
`active (exited)` unit from a dead lead → tells you to `kill_project` first).

### 2.7 What the LEAD loads (MCP scoping)

`config/claude/lead-mcp.json` = the bot's `.mcp.json` **minus the control-plane servers**, plus
`sequential-thinking`. From `docs/notes/2026-05-26-leads-inherit-all-mcps.md`:

| Lead gets | Excluded — why |
|---|---|
| playwright ×5, voice-stt/tts, sequential-thinking, hermes-notify, grok-image | **hermes-api** (would steal the bot's dashboard unix socket), **project-orchestrator** (a lead could recursively spawn/kill leads and contend on the registry), **telegram** (bot-only via `--settings`) |

A drift-guard test asserts `lead-mcp.json == .mcp.json − {hermes-api, project-orchestrator} + sequential-thinking`.
`--setting-sources user,project,local` gives leads all user-scope skills/agents/plugins; the
channel plugin never loads in leads because it's enabled only via the bot's `--settings` file
(`config/claude/channel-settings.json` → `{"enabledPlugins": {"telegram@claude-plugins-official": true}, "promptSuggestionEnabled": false}`).

**soma-lite takeaway:** the "curated MCP config for children, control-plane servers only for the
orchestrator" split is the load-bearing recursion/hijack guard. Keep it.

### 2.8 The orchestrator's own launch (for contrast)

`scripts/channel-claude.sh` (the bot):

```bash
exec /home/ubuntu/.local/bin/claude \
    --channels "${CHANNEL_PLUGIN}" \
    --continue \
    --settings "${SETTINGS}" \
    --plugin-dir "${SOMA_ROOT}" \
    --add-dir /home/ubuntu/hermes-work \
    --dangerously-skip-permissions \
    --effort low \
    --append-system-prompt-file "${SOMA_ROOT}/system_prompts/responsive_bot.md"
```

Orchestrator at `--effort low` on purpose (`docs/notes/2026-05-29-orchestrator-gates.md`): *"The
bot … is a routing layer, not a worker"*; deep reasoning belongs in dispatched agents/leads. A
`PreToolUse` hook (`orchestrator_gate.sh`, matcher `.*`, fail-open) **denies** heavy tools inline
(Edit/Write/WebFetch/WebSearch/Skill/playwright/package installs/builds/non-localhost curl) to
enforce "dispatch, don't do". For soma-lite, an interactive session promoted to orchestrator can
adopt the same discipline via a PreToolUse deny hook — this is the strongest planning-only
enforcement pattern in the repo (leads-as-planners can reuse the same trick with a different
deny-list: deny Edit/Write, allow delegation tools).

---

## 3. (b) Orchestrator MCP tools — names and shapes

Server: FastMCP `project_orchestrator`, stdio, loaded ONLY by the orchestrator session
(explicitly excluded from lead MCP configs). Callers: the orchestrator's skills
(spawn-project, list-projects, message-project, kill-project, project-status) — i.e. **the
orchestrator calls all of these; leads call none of them.**

| Tool | Input | Output | Notes |
|---|---|---|---|
| `spawn_project(name, type, brief, permission_mode="acceptEdits", host="local", tier="standard")` | name must match `^[a-z][a-z0-9-]{0,63}$` | `{agent_id, rc_url, cwd, type, session_uuid, host, tier}` | Runs safety gate (quota), reconcile, per-host concurrency+memory admission, template resolve, brief composition, spawn, registry upsert |
| `list_projects()` | — | `[{name, agent_id, type, cwd, rc_url, status, spawned_at, idle_for_seconds, estimated_next_turn_cost}]` | Reconciles active-vs-live tmux first (ghost leads flipped to 'dead') |
| `send_to_project(name, message)` | — | `{name, agent_id, sent_at, delivered}` | Local path: two `tmux send-keys` calls (literal text, then Enter). Also bumps idle clock |
| `touch_project(name)` | — | `{name, touched_at}` | Bump `last_activity` when the bot messaged the lead via RAW tmux send-keys (which bypasses `send_to_project`) |
| `kill_project(name, archive=True)` | — | `{name, killed_at}` | kill unit + tmux session, verify dead, retry once, RAISE if still alive (no silent zombie) |
| `resume_project(name, force=False)` | — | `{agent_id, rc_url, cwd, type, session_uuid}` | `--resume <session_uuid>` from cloud; refuses if lead alive or no uuid; context guard >200k est tokens unless `force` |
| `get_status(name)` | — | `{name, agent_id, type, cwd, rc_url, status, host, tier, liveness, spawned_at, idle_for_seconds, estimated_next_turn_cost}` | Reconciles registry vs live tmux |
| `get_transcript(name)` | — | `{name, host, bytes, transcript}` | Tail (≤2 MB) of `/var/log/claude-soma/<name>.log`; symlink/hardlink/FIFO-safe read (`O_NOFOLLOW`, `S_ISREG`, `st_nlink==1`) |
| `get_team_impl(name)` (impl; surfaced via dashboard) | — | `{name, team: [{handle, role, status}]}` | Live pane discovery + persist roster for resume re-establishment |
| `list_template_types()` | — | `[str]` | template file stems |
| `register_routine(name, kind, schedule, …)` | — | `{registered, kind}` | routines bookkeeping (dashboard concern) |

Admission control (`_admit_or_raise`): per-host concurrency cap (`HERMES_MAX_CONCURRENT_PROJECTS`,
default 6) + per-tier memory reservation math against `hosts.json` `ram_mb`/`headroom_mb`/`tier_caps`.
Safety gate (`_check_safety_gate`): refuses spawn/resume when a usage SQLite snapshot says the
Agent-SDK quota ceiling is reached ("SUBSCRIPTION EXHAUSTED"); fail-open if DB missing.

`send_to_project` local delivery, exact:

```python
subprocess.run([tmux, "-L", socket, "send-keys", "-t", session, "-l", message], ...)
subprocess.run([tmux, "-L", socket, "send-keys", "-t", session, "Enter"], ...)
```

---

## 4. (c) Orchestrator → lead messaging

The canonical path is documented in `skills/message-project/SKILL.md`, which is blunt about the
architecture:

> "Project-leads are NOT teammates of the channel bot. … `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
> only lets a lead spawn its own subagents; it does NOT federate the lead into the bot's team. So
> `SendMessage(to: "soma-proj-<name>")` always fails … and there is **no push-back channel** from a
> lead back to the bot. Therefore: deliver by typing into the lead's tmux pane, and read the reply
> by scraping that pane."

### Delivery (two separate send-keys calls — combining text+Enter is unreliable)

```bash
# type the message literally (-l = literal text, no key-name interpretation)
tmux -L soma-lead-<name> send-keys -t soma-proj-<name> -l '<safely-quoted message>'
# submit it as a SEPARATE call
tmux -L soma-lead-<name> send-keys -t soma-proj-<name> C-m
```

Shell-safety rule (verbatim): wrap in single quotes, escape embedded `'` as `'\''` — "exactly what
`shlex.quote` produces". Multi-line messages: each newline is delivered as an Enter, so collapse to
one line to keep a single turn. If text lands but doesn't submit, send one more `C-m` after ~1s.

### Reply reading = pane scraping with NO completion signal

```bash
sleep 4
tmux -L soma-lead-<name> capture-pane -p -t soma-proj-<name>
```

- `capture-pane -p` returns the visible screen (i.e. the tail). For scrollback: `-S -80`.
- **Reply-finished detection is heuristic:** *"If the footer still shows the lead
  working/thinking, `sleep` again and re-capture."* The skill polls "up to a few times"; there is
  no event, no sentinel, no structured completion marker. The pane is "a live TUI, so expect
  box-drawing and a prompt footer around the text."
- The reply-poll is unbounded, so the bot is instructed NOT to run this inline: it dispatches a
  background `Agent` (`run_in_background=true`) to do the send+scrape+relay, acks the user
  immediately.

**soma-lite takeaway:** if leads talk back via MCP tools (the soma-lite plan), the fragile
scrape-for-reply loop can be demoted to a fallback/debug path; keep send-keys as the *delivery*
mechanism (it is robust) and let the lead push completion via a notify-style tool instead of the
orchestrator polling pixels.

Also note `touch_project`: because raw send-keys bypasses the MCP server, the idle clock in the
registry goes stale unless the sender calls `touch_project` after every send-keys (validated bug,
2026-05-29).

### Operator attach (`scripts/somux`)

Pure-bash wrapper: `somux ls` (discovers leads from `/tmp/tmux-$(id -u)/soma-lead-*` sockets +
systemd units), `somux a <name>` (`exec tmux -L soma-lead-<name> attach -t soma-proj-<name>`),
`somux peek <name> [N]` (read-only `capture-pane -p | tail -n N`). This is exactly the GUI-operator
surface soma-lite wants; the only Linux-ism is the systemd-unit discovery/state column and the
hardcoded `TMUX_BIN=/usr/bin/tmux` and socket dir (macOS default is `/private/tmp/tmux-<uid>`,
resolvable via `tmux -L x start-server` semantics; on Windows there is no tmux at all).

---

## 5. (d) Lead → orchestrator communication

Today there IS a lead→orchestrator channel (added after the message-project skill was written):
the `hermes-notify` MCP server, loaded into every lead via `lead-mcp.json`.

### The tool

`mcp__hermes-notify__notify_orchestrator(type, payload) -> {"stored_id": int, "delivered": bool}`

- `type ∈ {STARTED, MILESTONE, COMPLETED, NEEDS_INPUT, ERROR}` with per-type payload validators
  and hard field limits (description ≤500, summary ≤2000, question ≤500, traceback ≤5000,
  ≤10 paths/urls, options ≤5×100 chars, timeout ≤3600 …).
- Lead identity is NOT a parameter: read from `HERMES_LEAD_NAME` env (set at spawn). Raises if
  unset ("only available in spawned project leads").
- Transport: POST JSON `{"lead", "type", "payload_json"}` to
  `HERMES_NOTIFY_URL` (default `http://127.0.0.1:9100/notify`) with optional
  `Authorization: Bearer $HERMES_NOTIFY_TOKEN`. Listener (a thread inside the hermes-api MCP
  server) is *"the durable writer + id owner"* → inserts into `lead_events` in the same
  registry.sqlite and DMs the operator. Never binds 0.0.0.0.
- `notify` failure never raises; remote hosts get a last-resort Discord "degraded webhook".
- Second tool: `set_teammate_handle(handle, role)` — lead self-reports its canonical handle into
  `team_members`.

### The convention (prepended to EVERY lead brief)

`system_prompts/lead_notify_convention.md` — fire STARTED at major-task start, MILESTONE on each
git commit / sub-task ("server throttles delivery to one notification per 5 minutes per lead, so
fire freely"), COMPLETED with paths/urls, NEEDS_INPUT ("Do NOT spin, retry, or guess — block
immediately and fire this"), ERROR on hard failures.

### Closing the loop into the orchestrator's context

`scripts/notify_inject.sh` runs as a **UserPromptSubmit hook** on the bot: queries
`127.0.0.1:9100/events?unread_only=true&limit=20`, formats a compact
`## Recent lead events` block (+ the oldest open NEEDS_INPUT question, FIFO), POSTs `/mark_read`,
enforces a 2000-char budget, and emits:

```json
{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "..."}}
```

Fail-open everywhere (no jq/curl/listener → exit 0 silently). So the orchestrator learns of lead
events **on its next turn**, not by interrupt. (`reaper.py` also inserts synthetic NEEDS_INPUT
events, e.g. "Lead X auto-killed at turns=… respawn or investigate?".)

**soma-lite takeaway:** this is precisely the "leads talk back to the orchestrator via MCP tools"
requirement, already built: a tiny MCP tool in the lead + a store + hook-injection into the
orchestrator. The HTTP hop exists only because the lead's MCP process can't share the orchestrator
session; locally you could keep HTTP-on-loopback or write straight to the shared SQLite (the local
lead and orchestrator share a filesystem — the code already tolerates both patterns, see WAL notes
in §6).

---

## 6. (e) Registry / persisted state

Single SQLite file, `HERMES_ORCH_DB` (default `/opt/claude-soma/registry.sqlite`), shared by the
orchestrator MCP, the hermes-api listener (lead_events), the watchdog, the reaper, the parallelism
ledger, and the dashboard. `registry.py` opens ONE connection with `check_same_thread=False` +
`isolation_level=None`, serialized behind a `threading.Lock`; cross-PROCESS writers (leads via the
ledger) rely on `PRAGMA journal_mode=WAL` + `busy_timeout=5000` (documented in
`docs/lead-parallelism-phase1.md`).

### `projects` table (the core)

```sql
CREATE TABLE IF NOT EXISTS projects (
    name           TEXT PRIMARY KEY,
    agent_id       TEXT NOT NULL,          -- "soma-proj-<name>" (tmux session name)
    type           TEXT NOT NULL,          -- template type
    cwd            TEXT NOT NULL,
    rc_url         TEXT,
    status         TEXT NOT NULL DEFAULT 'active',   -- active | dead | killed
    permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
    host           TEXT NOT NULL DEFAULT 'local',
    tier           TEXT NOT NULL DEFAULT 'standard',
    spawned_at     REAL NOT NULL,
    last_activity  REAL NOT NULL,
    brief          TEXT,                   -- full composed brief (enables fresh respawn)
    session_uuid   TEXT DEFAULT NULL,      -- cloud session id (enables --resume)
    turn_count     INTEGER NOT NULL DEFAULT 0
);
```

Status semantics: `'killed'` = intentional stop, **never revived**; `'dead'` = vanished, watchdog
may revive; `set_status(..., bump_activity=False)` for bookkeeping flips so reconciliation doesn't
reset the idle clock. Upsert `register()` deliberately does NOT touch `session_uuid`.

### Other tables

- `team_members(lead_name, teammate_handle, role, brief, dispatched_at, last_seen_at)` — persisted
  roster used to compose a resume-prompt suffix ("Before you were interrupted, your agent team
  included: … You may want to re-establish your team with the Agent tool.").
- `lead_watchdog(name, consecutive_failures, last_attempt_ts, last_method, last_outcome,
  gaveup_notified)` — revive backoff state.
- `routines(...)` — scheduled-job bookkeeping (dashboard).
- `lead_events` (created by `notify_store.py`) — the notify event log; also used for the
  cheap context estimate: `SUM(LENGTH(payload_json))/4` ≈ tokens (`_estimate_context_tokens`).
- `batch_tasks` (parallelism ledger, Phase 1): `(batch_id, lead_name, task_id,
  contention_class FREE|EXCLUSIVE, brief, worker_agent_id, status
  pending|running|done|failed|skipped, result_summary, error_msg, timestamps)`, with an atomic
  single-UPDATE cap-claim (`claim_slot`, cap default `HERMES_LEAD_TEAM_CAP=3`).

Other persisted state outside SQLite: `~/.claude.json` (trust pre-marking),
`/var/log/claude-soma/<name>.log` (pipe-pane transcripts), `config/claude/hosts.json` (multi-VPS),
`.claude/` per-project memory archived to `/opt/claude-soma/archive/<name>-<ts>` on hibernate.

---

## 7. (f) Lifecycle

### Liveness — "live tmux is the ONLY trustworthy signal"

```python
result = subprocess.run([_tmux(), "-L", socket, "has-session", "-t", session], ...)
return "alive" if result.returncode == 0 else "dead"
```

- Local tool-error → conservatively `"alive"` (a false 'dead' would risk a duplicate respawn).
- Remote is tri-state: rc 0 alive / rc 1 dead / rc 255 (ssh) or 99 (guard DENY) → `"unreachable"`
  → **never revive on ambiguity**.
- The systemd unit state is explicitly NOT liveness: `Type=oneshot`+`RemainAfterExit` reads
  `active (exited)` forever; "systemd never supervises the real claude process (it's a child of
  the daemonized tmux server)" (watchdog docstring).

### Reconciliation (`server.py::_reconcile_active`)

Every `spawn_project` / `list_projects` / `get_status` cross-checks each registry-'active' row
against live tmux and flips vanished leads to `'dead'` (`bump_activity=False`). Ghost leads
therefore never eat the concurrency cap.

### Watchdog (`watchdog.py`, systemd timer `claude-soma-lead-reaper.timer` family)

Design rules (verbatim from module docstring): liveness only from live tmux; `'killed'` never
revived; a live lead never respawned (self-heals status to 'active' instead); revival calls the
low-level spawner fns directly — "NEVER spawn_project_impl (which would enforce the concurrency
cap and re-reconcile)"; `main()` always exits 0.

Per-sweep behavior: for each `list_revivable()` row →
`unreachable` → alert, skip; `alive` → self-heal status; `dead` → backoff check
(`MAX_ATTEMPTS_DEFAULT=3`, `COOLDOWN_SEC_DEFAULT=3600`, one-time "GAVE UP" DM), TOCTOU re-check,
`kill_session` to clear the stale unit, then **resume-first** (`--resume <session_uuid>`) with
fresh-spawn fallback (stored `brief`), then a grace poll (8×1 s) to confirm it actually came up;
success/failure recorded in `lead_watchdog`.

### Reaper (`scripts/reaper.py`, every 6 h)

- `active` + idle > 24 h + tmux **dead** → archive `.claude/` → status `'killed'` (hibernate;
  resumable via stored `session_uuid`). If still alive: skip (raw-send-keys chat doesn't bump the
  registry clock, so idle is unreliable for live leads).
- `active` + alive → runaway caps: `derived_turns` (STARTED events) ≥ `HERMES_LEAD_TURN_CAP=50`
  or est tokens ≥ `HERMES_LEAD_CONTEXT_CAP_TOKENS=200000` → kill + archive + synthetic
  NEEDS_INPUT event to the operator.
- non-active + idle > 7 d → delete registry row.

### Kill (`spawner.kill_session` + `server.kill_project_impl`)

```python
sudo -n systemctl stop claude-soma-lead-<name>.service   # cgroup teardown (tmux server included)
tmux -L soma-lead-<name> kill-session -t soma-proj-<name>  # belt-and-suspenders
```

`kill_project_impl` then verifies liveness, retries the kill once, and **raises** if the lead
survived both attempts (no silent zombie + registry lie).

### Resume

`resume_background_lead`: same wrapper/argv but `--resume <uuid>` instead of
`--session-id`, fixed prompt *"You have been resumed after an interruption. Review your prior work
in this session and continue from where you left off."* + optional team-roster suffix; context
guard `HERMES_RESUME_CONTEXT_GUARD_TOKENS=200000` (force to override); calls `kill_session` first
to clear the lingering `active (exited)` unit.

---

## 8. (g) Project templates

`templates/projects/<type>.json`, loaded by `templates.py` (`load_template`, fallback to
`custom`). Shape (all five files follow it):

```json
{
  "type": "web-scraper",
  "cwd_root": "~/projects",
  "permission_mode": "acceptEdits",
  "default_brief": "You are the lead of a web scraper project. … Coordinate with your teammates database-engineer, backend-engineer, and playwright-engineer via SendMessage.",
  "teammates": [
    {"name": "database-engineer", "agent": "general-purpose", "model": "sonnet"},
    {"name": "backend-engineer", "agent": "general-purpose", "model": "sonnet"},
    {"name": "playwright-engineer", "agent": "general-purpose", "model": "sonnet"}
  ],
  "mcp_servers": ["filesystem", "web-fetch", "playwright-mcp"],
  "skills": ["bs-scraping", "async-helpers"]
}
```

Types shipped: `web-scraper`, `llm-app`, `server-app`, `agentic-coding` (empty teammates,
"Spawn focused subagents (Agent tool) for transient parallel work; no persistent team needed"),
`custom`. **Important:** at runtime only `type`, `default_brief`, and `permission_mode` are
actually consumed by the spawner (`spawn_project_impl`); `teammates`/`mcp_servers`/`skills` are
*advisory content that reaches the lead only through the composed brief / the project-lead agent
doc* — there is no code that provisions teammates or MCP servers from the template. The lead is
expected to `TeamCreate` + `Agent(...)` itself per `agents/project-lead.md`.

`agents/project-lead.md` frontmatter: `model: opus`, `permissionMode: acceptEdits`,
`memory: enabled`, `tools: "*"`. Bootstrap steps: read brief → inspect template
(`HERMES_TEMPLATE_PATH` env — note: **the spawner never actually sets this**, doc drift) →
`TeamCreate(team_name="<name>-team")` → spawn teammates via
`Agent(subagent_type="general-purpose", team_name=…, name=…, prompt=…)` → `TaskCreate` milestones.
Working norms: teammate coordination via `SendMessage` by name; transient work via
`Agent(run_in_background=true)`; milestones to orchestrator (doc says SendMessage via
`HERMES_ORCH_AGENT_ID` — superseded in practice by hermes-notify).

---

## 9. (h) Linux-only parts

`docs/MULTI_PLATFORM_INSTALL.md` already did this audit; its headline: **"cgroup-isolated leads
require Linux + systemd"** — everything else has a documented fallback. Per-item:

| Linux-only mechanism | Where | Cross-platform replacement for soma-lite |
|---|---|---|
| `sudo -n systemd-run --collect --unit=… --property=…` transient unit per lead (cgroup isolation, MemoryMax/High tiers, EnvironmentFile secrets) | `spawner._wrap_in_transient_unit`, guard | **Drop the wrapper entirely.** Plain `tmux -L soma-lead-<name> new-session -d …` already gives a per-lead tmux server that survives the *orchestrator process* dying (tmux servers daemonize; the cgroup problem only existed because the channel was a systemd service with KillMode=control-group). The repo's own fallback table: "OpenRc/`SetsidStrategy` … `setsid` new process group + dedicated `tmux -L` socket; no cgroup" and macOS "detached tmux under its own session". Memory caps: drop or best-effort (`ulimit`). Env: pass `--setenv` equivalents via the spawn environment dict / `tmux new-session -e` (tmux ≥3.2) |
| `systemctl stop/is-active/list-units` in kill/liveness/somux | `kill_session`, `somux` | tmux-only: `tmux -L … kill-server` (kills the whole per-lead server incl. teammate panes) + `has-session` liveness (already the primary signal) |
| `sudoers.d/99-claude-soma-spawner`, `User=ubuntu`, `/home/ubuntu` | units, spawner constants | none needed — run as the invoking user; already env-overridable (`HERMES_LEAD_USER/HOME/PATH`) |
| systemd `.timer`s (watchdog, reaper, healthcheck ×15) | `systemd/` | in-process scheduler thread in the orchestrator MCP server, or on-demand sweeps (run reconcile+watchdog logic inside each tool call — `_reconcile_active` already does half of this), or OS-native (launchd/Task Scheduler) if truly needed |
| FHS paths `/opt/claude-soma`, `/etc/claude-soma/secrets.env`, `/var/log/claude-soma` | everywhere | `platformdirs`-style paths; the repo's own `src/claude_soma/platform/paths.py` (Phase 1, implemented) already maps Linux/macOS/Windows and templates `.mcp.json` — reuse |
| Hardcoded `/usr/bin/tmux`, `/home/ubuntu/.local/bin/claude` | constants (env-overridable via `HERMES_TMUX_BIN`, `HERMES_CLAUDE_BIN`) | `shutil.which` first (the fallbacks already exist in `_claude()`/`_tmux()`) |
| ssh forced-command guard + tailnet + hosts.json tiers | `remote-exec-guard.sh`, `hosts.py`, RemoteRunner | drop (soma-lite is local-only) |
| iptables/OCI, Caddy, apt bootstrap, VNC | scripts/ | drop |
| **Windows: no tmux at all** | MULTI_PLATFORM §7 open question #1 | the repo's own verdict: "the pragmatic call may be 'native Windows = WSL2 only'". claude needs a real PTY ("drops to `--print` mode on a pipe"). soma-lite options: require WSL2 on Windows (repo-endorsed parity path — WSL2 ships tmux+systemd), or a ConPTY holder process (unproven per the doc) |
| socket dir discovery `/tmp/tmux-$(id -u)` in somux | `scripts/somux` | macOS: `${TMPDIR}tmux-<uid>` /(often `/private/tmp/tmux-<uid>`); better: enumerate from the registry DB instead of the socket dir |

Already platform-neutral and reusable as-is: name validation, brief composition, `_pretrust_cwd`,
RC-URL polling, pipe-pane logging (POSIX), send-keys messaging, capture-pane scraping, the whole
SQLite registry, watchdog/reaper logic (minus the unit-stop calls), templates, notify server
(pure HTTP+SQLite), hook JSON contracts.

---

## 10. (i) Agent teams

### One team per session → the two-level topology

The design spec (`docs/superpowers/specs/2026-05-22-hermes-claude-design.md` §4) states the
constraint and the workaround that defines the whole architecture:

> "The Telegram channel session is an **orchestrator**, NOT a team-lead. It spawns multiple
> **independent project-leads** (each is its own Claude Code background session), and each
> project-lead creates its own team. This sidesteps the Claude Code constraint **'one team per
> lead / no nested teams.'**"

So: orchestrator has NO team; each lead has exactly one team. Leads are NOT addressable via
`SendMessage` from the orchestrator (separate processes, separate teams) — hence send-keys.

### Exactly what enables teams in a lead

1. Env var **`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`**, set via the spawn wrapper (`--setenv` in
   the transient unit; both local spawner and remote guard set it). That's the only switch — no
   settings-file key is used for it anywhere in the repo.
2. The lead then runs `TeamCreate(team_name=…)` and `Agent(subagent_type="general-purpose",
   team_name=…, name=…, prompt=…)` per `agents/project-lead.md`.

### Teammates are split panes in the lead's own tmux window

From `discover_team()` (spawner.py) and `docs/KNOWN_BUGS.md` #2:

> "With `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` a lead spawns its teammates as split panes in its
> window … so every pane beyond the lead's own is a teammate."

> "a lead spawns teammates in split tmux panes; those are separate live processes, not part of the
> lead's own transcript. `--resume` restores the LEAD's conversation but does NOT restore the live
> teammates — when the lead died, its team died with it."

Team discovery is therefore pane enumeration, read live (never cached — teammates are ephemeral):

```python
[_tmux(), "-L", socket, "list-panes", "-s", "-t", session,
 "-F", "#{pane_index}\t#{pane_dead}\t#{pane_title}"]
# first pane = the lead; rest = teammates, labelled teammate-<pane_index>, role from pane title
```

(Teammates are deliberately labelled by stable pane identity, NOT self-reported handles — a
positional-substitution bug on 2026-06-16 mis-attributed teammates across leads.)

Team resume: roster persisted in `team_members`; on `resume_project` the prompt gets
*"Before you were interrupted, your agent team included: … You may want to re-establish your team
with the Agent tool."* — i.e. option (a) from KNOWN_BUGS ("teammates are ephemeral; the resumed
lead re-plans and re-dispatches").

Caveat for the orchestrator side (KNOWN_BUGS #1): with agent teams enabled, **every Agent dispatch
is a fresh plugin-loading claude session** — on soma the telegram plugin then hijacked the bot's
poller. soma-lite has no channel plugin, so this class of bug disappears, but the general lesson
stands: children inherit user scope, so anything hazardous in user scope reaches every teammate
(soma's mitigations: `claude-safe.sh` wrapper forcing `--setting-sources project,local`, and
moving the hazard out of user scope).

Also relevant: `hooks are plugin-scoped` (orchestrator-gates note) — "Lead sessions use
`--mcp-config` and never load plugin hooks", so a plugin-delivered PreToolUse gate constrains only
the orchestrator, not leads. In soma-lite, per-role hooks can be delivered via each side's own
settings/plugin-dir.

### Lead-side parallelism discipline (optional layer)

`skills/parallel-tasks/SKILL.md` + `parallelism/ledger.py`: flag-gated
(`HERMES_LEAD_PARALLELISM=1`), classify tasks FREE vs EXCLUSIVE ("when in doubt, EXCLUSIVE"),
durable `batch_tasks` ledger in the shared SQLite, atomic cap-claim (cap 3 default), FREE tasks →
`Agent(run_in_background=True)`, EXCLUSIVE serial. This is the closest existing analogue to
soma-lite's "leads must use the dynamic Workflow tool for parallelizable work" — soma-lite replaces
the custom ledger with the native Workflow tool but should keep the FREE/EXCLUSIVE classification
idea and the "consolidated report when all terminal" convention.

---

## 11. Misc mechanisms worth stealing

- **Composed brief = convention + template + task** (`_NOTIFY_CONVENTION + default_brief + brief`)
  — soma-lite's insertion point for "you are planning-only", "pick a loop harness NOW", "use agent
  teams for coding", "use Workflow for parallel work" standing orders.
- **`--` before the positional brief** — real regression fixed in-repo (variadic `--mcp-config`
  swallowed the brief).
- **Prompt-suggestion kill switch** (`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=0`) — protects
  send-keys-driven panes from ghost input.
- **`estimated_next_turn_cost: 1.50` heuristic** in list/status output — cheap operator signal.
- **Fail-open hooks everywhere** (gate, notify_inject): missing deps or malformed JSON must never
  block a turn; only an explicit `permissionDecision: "deny"` blocks.
- **`DISABLE_AUTOUPDATER=1`** on remote leads (guard) — worth setting on all soma-lite children
  for determinism.
- **kill verify-and-raise** rather than trusting best-effort teardown.
- **Registry status is never ground truth; the process table (tmux) is.**

---

## 12. Keep / Drop / Replace table for soma-lite

### KEEP (concept ports as-is, near-verbatim)

| Item | Why |
|---|---|
| Two-level topology: orchestrator (no team) → N leads (one team each) | The one-team-per-session constraint is unchanged; this is the proven shape |
| Per-lead dedicated tmux server: `tmux -L soma-lead-<name> new-session -d -s soma-proj-<name> -c <cwd> <claude argv>` | Isolation, attach-ability, teammate split panes all hang off this |
| Naming contract: socket `soma-lead-<name>`, session `soma-proj-<name>`, `NAME_RX ^[a-z][a-z0-9-]{0,63}$` | Deterministic coordinates from a bare name; somux depends on it |
| Lead argv skeleton: `--session-id <uuid> --remote-control <session> --add-dir <cwd> --permission-mode <mode> --dangerously-skip-permissions --effort max --setting-sources user,project,local --mcp-config <curated> -- <brief>` | Add `--model fable` (soma never pins model — gap to close); effort max already matches the soma-lite mandate |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` + `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=0` + `HERMES_LEAD_NAME` in child env | The exact team-enablement recipe |
| `_pretrust_cwd` writing `hasTrustDialogAccepted` into `~/.claude.json` (atomic) | Mandatory for any detached spawn on every OS |
| Curated child `--mcp-config` = parent's servers MINUS control-plane (orchestrator MCP itself) PLUS the lead-side notify/reporting server; drift-guard test | The recursion/hijack guard |
| Brief composition: standing-conventions doc + template default_brief + task brief | Insertion point for planning-only / harness-choice / Workflow mandates |
| SQLite registry: `projects` schema (incl. `session_uuid`, `brief`, `status` active/dead/killed semantics, `bump_activity=False` bookkeeping), `team_members`, `lead_watchdog` | Small, battle-tested, WAL-safe |
| Liveness = `tmux has-session` on the lead's socket; conservative-on-error; registry never trusted | Core invariant |
| Reconcile-on-read (`_reconcile_active`) before spawn/list/status | Kills ghost leads without a daemon |
| `--session-id` at spawn → `--resume <uuid>` on revive; resume-first watchdog with fresh-spawn fallback, backoff (3 attempts, 1 h cooldown), grace polls, TOCTOU re-check, 'killed'-never-revived | Complete revival design, platform-neutral |
| Delivery = two `send-keys` calls (`-l` literal, then `C-m`/`Enter` separately), shlex-quote rule, collapse-multiline rule, `touch` after raw sends | Robust input path |
| pipe-pane transcript tee chained into the spawn (`; pipe-pane -O -o -t <sess> "cat >> <log>"`) + capped symlink-safe `get_transcript` tail | Forensics for dead leads; feeds the orchestrator's transcript tool |
| RC-URL capture by polling `capture-pane` with the `claude.ai/code/session_…` regex | Free deep-link for the operator |
| Lead→orch typed events {STARTED, MILESTONE, COMPLETED, NEEDS_INPUT, ERROR} with payload validation + convention doc + UserPromptSubmit injection block (+ mark-read) | This IS "leads talk back via MCP tools"; keep shape, simplify transport |
| Team discovery = `list-panes -F '#{pane_index}\t#{pane_dead}\t#{pane_title}'`, first pane = lead, label `teammate-<idx>` | Only reliable roster; never cache |
| Team-roster persistence + resume-prompt suffix ("re-establish your team") | Cheap answer to teams-don't-resume |
| `somux`-style operator CLI (ls / attach / peek) | Exactly the GUI-operator surface; de-systemd it |
| kill: verify liveness post-kill, retry once, raise if still alive | No silent zombies |
| Concurrency cap with reconcile-first admission (default 6) | Resource sanity; keep even single-host |
| Turn/context runaway caps (STARTED-count ≥50, est-tokens `Σlen(payload_json)/4` ≥200k) + resume context guard | Cheap runaway protection |
| Orchestrator-side PreToolUse deny-gate pattern (fail-open script, deny heavy work inline) | Repurpose as the planning-only enforcement for BOTH orchestrator and leads (deny Edit/Write for leads) |
| FREE/EXCLUSIVE task classification + "when in doubt, EXCLUSIVE" + consolidated terminal report | Feed into Workflow-tool usage conventions |

### DROP (server-only / out of soma-lite scope)

| Item | Why |
|---|---|
| Telegram/Discord channel plugin, channel-settings*.json, poller-hijack machinery (`claude-safe.sh`, bot.pid, healthcheck respawn) | Operator is at the GUI; no chat channel |
| FastAPI dashboard + Next.js frontend + Caddy + SSE + GitHub OAuth + hermes-api MCP bridge/unix socket | "No web dashboard" |
| Multi-VPS: `RemoteRunner`, `remote-exec-guard.sh`, `hosts.json`/`hosts.py`, tailnet, tiers/`tier_caps`, memory-admission math, degraded webhook | Local-only |
| All systemd `.service`/`.timer` units, `deploy-systemd.sh`, sudoers, logrotate, VNC, OCI bootstrap, `enroll_vps_host.sh` | Server infra |
| Voice (whisper/piper MCPs, voice_intake), social/engagement stack, grok-image, markserv, relay | Unrelated product surface |
| `routines` table + schedule-routine + RemoteTrigger backfill | Not in scope |
| Usage-snapshot safety gate (`usage.sqlite` daily quota ceiling) | Optional; drop for v1 (or keep as stub) |
| `--remote-control`'s RC URL as an operator surface (mobile attach) | Nice-to-have only — but NOTE: `--remote-control` may still be wanted purely as the keep-alive; verify current CLI behavior before dropping the flag itself |
| Custom `parallelism/ledger.py` + CLI | Superseded by the native Workflow tool (keep only the classification conventions) |

### REPLACE (needs cross-platform redesign)

| soma mechanism | soma-lite replacement |
|---|---|
| `sudo -n systemd-run --collect --unit=claude-soma-lead-<name>.service --property=… -- tmux …` (cgroup sibling isolation, EnvironmentFile secrets, MemoryMax tiers) | Direct `tmux -L soma-lead-<name> new-session -d …` launched with an explicit env dict (subprocess `env=`, or `tmux new-session -e VAR=val` per var, tmux ≥3.2). The per-lead tmux server already survives orchestrator death (it daemonizes); the cgroup layer only defended against systemd's KillMode. Secrets: rely on the user's normal `claude` auth (keychain/`~/.claude`); no EnvironmentFile needed locally |
| `systemctl stop <unit>` in kill path | `tmux -L soma-lead-<name> kill-server` (tears down lead + all teammate panes in one shot) with `kill-session` fallback; keep verify-and-raise |
| systemd-timer watchdog + reaper daemons | Either (a) fold sweeps into the orchestrator: run watchdog/reaper logic opportunistically inside MCP tool calls (reconcile already works this way), or (b) a single background thread in the orchestrator MCP server process, or (c) Claude-Code-native `/loop`-style periodic prompt. No root, no OS scheduler required for v1 |
| `/opt`, `/etc`, `/var/log` FHS paths + `ubuntu` user | Per-user app dirs (reuse the repo's own `src/claude_soma/platform/paths.py` Linux/macOS/Windows mapping: `~/Library/Application Support|Logs/…`, `%APPDATA%…`, XDG); registry + logs under one `SOMA_HOME` |
| Hardcoded `/usr/bin/tmux`, `/home/ubuntu/.local/bin/claude` | `shutil.which("tmux")`/`which("claude")` first (fallback logic already exists in `_claude()`/`_tmux()`); keep `HERMES_*_BIN`-style env overrides |
| Windows support | Repo's own verdict: parity requires WSL2 ("native Windows = WSL2 only" is the pragmatic call; claude needs a real PTY and there is no tmux). soma-lite: document WSL2 as the Windows path; do NOT attempt ConPTY in v1 |
| lead→orch transport: MCP tool → HTTP `127.0.0.1:9100` listener thread (inside hermes-api) → shared sqlite → UserPromptSubmit hook | Same tool + event schema, but transport simplified for local: lead-side MCP server writes directly to the shared SQLite (WAL + busy_timeout, pattern proven by the ledger), orchestrator hook reads unread rows straight from the DB (no HTTP hop, no port, no bearer token). Keep the HTTP listener design in the back pocket if DB contention bites |
| `message-project` reply loop: sleep + `capture-pane` + "footer looks idle" heuristic | Primary: lead pushes COMPLETED/NEEDS_INPUT via the notify tool (event-driven, no scraping). Keep capture-pane scraping as a debug/`peek` path only. Optionally add a Stop-hook on leads that auto-fires a notify event at end-of-turn — closes the "how do we know the reply finished" gap deterministically instead of heuristically |
| `somux` systemd-unit discovery + `/tmp/tmux-$(id -u)` socket globbing | Enumerate leads from the registry DB; resolve socket dir portably (macOS `TMPDIR`); state column = `has-session` only |
| Template `teammates` list (advisory-only, never provisioned; `HERMES_TEMPLATE_PATH` never actually set — doc drift) | soma-lite templates should carry what leads actually need: loop-harness options, Workflow-usage mandate, planning-only rules — all injected via the composed brief (the only channel that demonstrably works) |
| `agents/project-lead.md` (`model: opus`, tells lead to code via its team) | Rewrite as planning-only lead agent: `model: fable`, effort max pinned at spawn, MUST pick a loop harness on receipt, MUST delegate all coding to agent-team teammates, MUST use Workflow for parallelizable work; enforce with a lead-side PreToolUse deny hook on Edit/Write (pattern from `orchestrator_gate.sh`) |
