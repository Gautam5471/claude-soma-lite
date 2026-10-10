# Account rotation — design

**Goal.** A soma fleet runs its leads across several Claude Code accounts ("seats") and moves a lead, with its context intact, from a seat whose usage window has closed to one that is open — and back again as windows reopen — without a human at the pane. Seats are seats in one Team or Enterprise organisation. The orchestrator session is not rotated.

**Status.** Design approved section by section on 2026-09-15 (architecture, components, data flow, error handling, testing). Approach B of three was chosen: rotate on hit, one shared transcript tree.

---

## 1. Measured foundations

Everything below rests on three measurements taken against real transcripts and the installed Claude Code binaries (2.1.220 → 2.1.272). The rows, times and values quoted in this section are illustrative: they have the shape of what was measured, not its content.

### 1.1 What a limit hit looks like

A usage-limit hit is recorded in the session transcript as a synthetic assistant row:

```json
{ "type": "assistant", "isApiErrorMessage": true, "error": "rate_limit", "apiErrorStatus": 429,
  "message": { "model": "<synthetic>", "stop_reason": "stop_sequence", … },
  "quotaLimits": { "status": "rejected", "resetsAt": 1440433800, "rateLimitType": "five_hour", … } }
```

Every real limit row examined, across builds, carries this shape; `quotaLimits` is present from 2.1.238. `rateLimitType` takes the values `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`, `overage`. Spend caps arrive as different reasons: `org_level_disabled_until` renders as *"You've hit your org's monthly spend limit"* and `org_spend_cap_reached` as *"You've hit your individual spend limit"*; **neither carries a reset time** (no spend-cap row examined had one). `resetsAt` is epoch seconds. Weekly windows were observed resetting Thursday 00:00 UTC; the monthly spend cap resets on the 1st at 00:00 UTC.

The pane shows `You've hit your <limit name>` with a reset suffix, e.g. `You've hit your session limit · resets 4:30pm (UTC)`. The transcript row is the reliable signal; the pane text is corroboration.

### 1.2 What soma sees today

Nothing. None of the API-error turn ends examined fired the Stop hook (most ordinary turn ends did), and the `PostToolUse` heartbeat stamps only completed tool calls. Both of soma's liveness signals go silent on a limit hit. A lead sat for days after an organisation spend cap while the fleet reported it healthy.

### 1.3 What Claude Code does on its own

With the `settings.json` boolean **`autoContinueAtUsageLimit`** true and `resetsAt − now ≤ 24 h`, Claude Code arms itself (`Usage limit reached · continuing automatically at <time>`) and resumes 85 s after reset with a synthetic user prompt telling the model to continue. One real event shows the full cycle. Without a reset time it cannot arm.

### 1.4 Moving a session between accounts

`claude --resume <uuid>` finds a transcript **only** by file presence at `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<uuid>.jsonl`; no index is consulted. Copy that one file into another config dir and resume there from the same cwd: full context, same session id, exit 0. The continuation is written only under the resuming dir. A `projects/` directory that is a **symlink** shared between config dirs works for read and append. Session lookup runs before authentication, so a resume into a dir that is not logged in loads the session, appends the prompt and a fake `Not logged in · Please run /login` assistant turn, and exits 1 — the same exit code as not-found.

### 1.5 Where it attaches in soma

`CLAUDE_CONFIG_DIR` is copied from the watchdog's environment into every lead through `ENV_ALLOW`; it is a frozen module constant in `spawn.mjs`'s dependency object and no per-launch path exists. The token meter reads one `claudeConfigRoot()`. The MCP deny enumeration reads a fixed pair of roots (`$HOME/.claude.json` and the current `CLAUDE_CONFIG_DIR`). `revive()` charges `attempts` unconditionally before launching. `backpressure.frozen` gates admission but `state/backpressure.json` has no writer and `paneSignals` is a stub.

---

## 2. Architecture

Rotation is a fleet-level policy over seats, assembled from four pieces that each already have a home.

**Seats are configuration.** `soma.json` gains a `seats` array. Each seat is a config dir with its own `.claude.json`, credential and trust marks — that is what makes it an account — and a `projects/` that is a symlink to one shared directory, so every seat can resume every lead's session and the token meter keeps reading one tree. `soma init` runs once per seat and pins the same `SOMA_HOME` and `SOMA_TMUX_SOCKET` into each; this deliberately inverts the one-root-per-fleet pairing `bin/soma.mjs` documents, and doctor learns to enumerate the pool.

**Detection is a transcript read.** A pure classifier over a lead's last assistant rows yields `seat_window`, `spend_cap`, `none` or `unobservable`. The pane census is unchanged and unaware.

**Rotation is a kill and a resume under a different environment**, routed through a new `rotate()` in the watchdog — not through `revive()`, so no revival attempt is charged.

**Spend caps freeze, they do not rotate.** The org cap hits every seat; the tick writes `state/backpressure.json`, admission stops, and the orchestrator learns of it by desktop toast and on its next `soma_inbox` drain — `BACKPRESSURE` is urgent, but the watchdog does not type into the orchestrator's pane; only a lead's `soma_report` reaches `wake()`. Lifting the freeze is a human act: `soma thaw` clears the record, and refuses while the record's reason is a live `storm`, which is the watchdog's to clear.

**Underneath, `autoContinueAtUsageLimit: true` in every lead's settings** is the floor: if rotation is impossible or fails, a `five_hour` hit still recovers within its window.

**The secrets boundary widens by exactly one thing**: the MCP deny enumeration must read every seat's `.claude.json`, or a new seat's personal MCP servers reach teammates undenied.

---

## 3. Components

### 3.1 `bin/lib/seats.mjs` (new) — the pool

Reads `soma.json.seats`. A seat's `label` defaults to `basename(config_dir)` when omitted; `config_dir` may be `~`-prefixed and is resolved once by `resolveConfigDir`, the only `~` expander. Runtime state in `state/seats.json`, written under the fleet lock with the tmp+rename idiom of `lease.mjs`.

```json
{ "seats": [ { "config_dir": "/Users/x/.claude-seat-a", "label": "seat-a",
               "closed_until": 1440433800000, "closed_reason": "five_hour",
               "unverified": false } ] }
```

Interface:
- `pick(now, cfg)` → the FIRST seat in `soma.json` order that is open — not `unverified`, `closed_until <= now` — or `null`. **Changed 2026-09-24**, from "the open seat with the oldest `closed_until` (least recently closed)": the array's order is the PRIORITY order and not a tie-break, so the account the orchestrator shares goes LAST and is reached only when everything above it is closed or unverified. The accepted trade-off is that priority concentrates load rather than spreading it — the head of the file hits its window sooner, and more often. `bin/lib/seats.mjs` `pick` carries the full note.
- `close(dir, untilMs, reason)` — never shortens a closure below `now + 5 min`; emits nothing itself.
- `reopenExpired(now)` → list of seats reopened; idempotent.
- `loggedIn(dir)` → `true | false | null`: presence of `oauthAccount` in `<dir>/.claude.json`; `null` when the file is unreadable. A file read, never an API call.

Depends on `config.mjs`, `paths.mjs`, the fleet lock.

### 3.2 `bin/lib/wd/limit-state.mjs` (new) — the classifier

`classifyLimit(rows)` over the last assistant rows of a transcript, newest last:

- `{ kind: 'seat_window', rateLimitType, resetsAt }` when the **last** assistant row has `isApiErrorMessage && error === 'rate_limit'` and `rateLimitType ∈ {five_hour, seven_day*, overage}` with a finite `resetsAt`. **Units:** `quotaLimits.resetsAt` arrives in epoch *seconds*; the classifier returns epoch *milliseconds* so it compares directly with `Date.now()` and with `closed_until` in `state/seats.json`. The conversion happens in exactly one place, here.
- `{ kind: 'seat_cap', resetsAt: <next 1st 00:00Z after the row's own timestamp> }` for `org_spend_cap_reached` (an individual seat's cap).
- `{ kind: 'spend_cap' }` for `org_level_disabled_until` (the org's cap).

**Where the cap reason actually lives** (measured against all 15 real rows that carry `quotaLimits`): `rateLimitType` is `five_hour` on every one of them, and the cap reason rides in `quotaLimits.overageDisabledReason`. The classifier therefore reads both, and **a window type with a finite `resetsAt` wins even when a cap reason rides along** — Event A resumed 85 s after its `five_hour` reset; closing until the 1st would have parked a seat for a week that reopened in 53 minutes. `seat_cap`/`spend_cap` fire only when no usable window reset exists. Two more `unobservable` causes: a `rate_limit` row with no `quotaLimits` (builds before 2.1.238), and a non-object entry newer than the last assistant row — a torn last line may be the healthy row that makes the answer `none`.
- `{ kind: 'none' }` when the last assistant row is anything else, including a `rate_limit` row followed by a healthy row.
- `{ kind: 'unobservable', why }` when rows are missing, truncated or unparseable.

Pure; depends on nothing. Fixtures are 33 synthetic rows shaped like the measured ones, plus the negative corpus (`authentication_failed`, `server_error`, `invalid_request`, `oauth_org_not_allowed`).

### 3.3 `spawn.mjs`

`launch()` gains `{ configDir }`. It is threaded together into `buildLeadEnv` (overriding only `CLAUDE_CONFIG_DIR`, with `''` still meaning unset), `preTrust` and `trustFileFor` (both must target the same file), and the worktree guard generation (see 3.4). `resumeLead(task, { configDir })` and `spawnLead(task, { configDir })` expose it. The frozen `deps.env` remains the default so every existing caller is unchanged.

### 3.4 `settings-gen.mjs`

`enumerateUserMcpServers(home, env, { roots })` unions every seat's `.claude.json` (top-level and per-project `mcpServers`) plus the fixed pair. `writeLeadSettings` adds `autoContinueAtUsageLimit: true`.

### 3.5 `bin/soma-watchdog.mjs`

A new phase between the pane census and admission:

```
for each spawned row: verdict = classifyLimit(tail(row.lead_session_uuid))
  seat_window | seat_cap → seats.close(row.seat, resetsAt, reason); emit SEAT_CLOSED; rotate(row)
  spend_cap             → writeBackpressure({active:true, reason, since:now, until:null}); emit BACKPRESSURE
  none | unobservable   → nothing
seats.reopenExpired(now) → emit SEAT_REOPENED for each
```

Before any of this, **the stale-row guard**: after a rotation (or any resume of the same session id) the lead has not yet written an assistant row, so the pre-rotation `rate_limit` row is still the newest. When the lead's newest launch (`SPAWNED`/`REVIVED`/`ROTATED`, folded per lead from the orchestrator stream) is later than the last assistant row's timestamp, `seat_window` and `seat_cap` are skipped for that lead. Without this the phase would close the new seat and rotate again until the thrash bound.

`rotate(row)`:
1. `target = seats.pick(now)`; if `null`, emit `ROTATION_UNAVAILABLE` once and return (the lead is left for auto-continue).
2. If `seats.loggedIn(target) !== true`, mark it `unverified`, skip it, try the next; if none remain, as (1).
3. If the row has three rotations in the last hour, as (1) with reason `thrash`.
4. `killSession(row)`; `resumeLead(row, { configDir: target })`; `updateFleet(row.seat = target.label, row.rotations.push(now))`; emit `ROTATED`.
5. On the next tick, if the rotated lead's newest transcript row is an API error that is not `rate_limit`: emit `ROTATION_FAILED`; `resumeLead(row, { configDir: original })` — the original seat is closed, but the process starts and arms auto-continue, restoring the pre-rotation state.

`attempts` is never touched by `rotate()`.

**Every launch site picks a seat**, not only the watchdog's admission, revival and rotation: the bus tools `soma_spawn` and `soma_resume` and the CLI `soma resume` call `seats.pick(now)`, pass `{ configDir }`, and write `seat` on the row. A launch that did not would land on the process environment with `seat: null`, invisible to the pool and rotatable onto the very seat it is on.

### 3.6 Fleet row

New fields, written through `updateFleet`: `seat` (label), `rotations` (array of epoch ms, pruned to the last hour). `soma status` and `soma_status` render `seat` beside `pane_state`, and a closed seat's reset time.

### 3.7 `soma init` and doctor

`soma init --seat <dir>` registers the bus (with the fleet's `SOMA_HOME` and socket pins) and the `/soma-promote` skill into that dir. Doctor gains four checks, each three-state (`ok` / `FAIL` / `unobserved`): `seats readable`, `every seat logged in`, `seat projects/ is the shared tree` (identical `realpath`), `mcp enumeration covers every seat`.

### 3.8 Events

| type | payload | urgent |
|---|---|---|
| `SEAT_CLOSED` | `{seat, reason, resetsAt}` | no |
| `SEAT_REOPENED` | `{seat}` | no |
| `ROTATED` | `{lead, from, to, rateLimitType, resetsAt}` | no |
| `ROTATION_FAILED` | `{lead, from, to, why}` | no |
| `ROTATION_UNAVAILABLE` | `{lead, why}` (once per closure) | no |
| `BACKPRESSURE` | `{reason, since, until}` | **yes** |

`ROTATED` is folded by the orchestrator's history the way `REVIVED` is, moving `revivedAt`, so a `NEEDS_INPUT` filed before the rotation cannot flip the lead to blocked after grace. `BACKPRESSURE` joins `URGENT`: it is the one case where no machine action helps.

---

## 4. Data flow

**Spawn.** Admission picks a task; `spawn()` asks `seats.pick(now)` and launches with that seat's `CLAUDE_CONFIG_DIR`. In the same launch: trust mark into that seat's `.claude.json`, guard file with denies enumerated across every seat, lead settings with `autoContinueAtUsageLimit: true`. The row records `seat`. The transcript lands in the shared tree.

**Hit.** The lead's next call returns 429; Claude Code writes the synthetic row and, if it can, arms auto-continue. The Stop hook and heartbeat go quiet.

**Tick.** After the census, before admission (so a freed slot is never refilled onto a seat that just closed): classify, close, rotate or freeze, reopen — as in 3.5.

**Reopen.** Seats reopen on their own at `closed_until`. **Leads are not moved back proactively**: a healthy lead stays on its seat until that seat closes. Churn is a kill, and kills cost teammates.

---

## 5. Error handling

- **Target not logged in** — checked before any kill (3.5 step 2). After a resume, success is read from **the transcript's first post-rotation assistant row**, not from the process's exit code or stdout: the process lives inside tmux, so its stdout is the pane, and not-found and not-logged-in share exit 1 anyway. A first row that is an API error other than `rate_limit` is the revert trigger (3.5 step 5); a healthy row proves the rotation.
- **Cross-seat resume rejected server-side** — not measurable with one seat. Handled without knowing the cause (3.5 step 5): revert to the original seat, which restores the pre-rotation state exactly.
- **Two spend caps, two meanings** — the org cap freezes the fleet; an individual seat's cap closes that seat until the 1st and rotates normally.
- **Thrash** — three rotations per lead per hour, then auto-continue and `ROTATION_UNAVAILABLE`.
- **Kill timing** — a rate-limited lead is idle, so the kill lands on a quiescent transcript; the last-row rule means a lead Claude already auto-resumed reads `none` and is never killed mid-work. Teammates die with the session; their uncommitted edits stay in the worktree.
- **Bad inputs fail closed for the kill, open for the lead** — unreadable `seats.json`, past or non-monotonic `resetsAt` (observed), unparseable rows: nothing is killed, the lead keeps running. For a torn transcript tail the tail reader hands the classifier a `null` in place of the unparseable line (dropping only a *leading* torn line), the classifier answers `unobservable`, and the tick emits one `WATCHDOG_ERROR { where: 'limits', error }` per lead per launch. Closures are never shorter than five minutes.

---

## 6. Testing

Per-assertion, three-state, every new assertion mutation-checked with a printed and subtracted baseline, every module seam pinned by severing the call.

- **Classifier**: the 33 fixture rows by `rateLimitType`; the negative corpus reads `none`; last-row rule; both spend-cap reasons; truncated tail reads `unobservable`.
- **Pool**: `pick` order; five-minute floor; idempotent reopen; `loggedIn` three states; corrupt state file yields no open seat and one event; lock + tmp+rename pinned as in `lease.test.mjs`.
- **Spawn seam**: one test spawns with a `configDir` and asserts the env, the trust-mark file and the guard file all reflect it; each thread severed in turn must redden its own line. Secrets boundary: a server registered only in a third seat's `.claude.json` appears in every worktree's deny list.
- **Tick**: phase order via a seat that closes mid-tick; `seat_window` resumes through `resumeLead(task,{configDir})` with `attempts` unchanged, and routing through `revive()` must fail; `spend_cap` writes all four `backpressure.json` fields and emits an urgent `BACKPRESSURE`; `unobservable` touches nothing; thrash bound; revert on `ROTATION_FAILED`; `ROTATED` moves `revivedAt`.
- **Doctor/status**: four checks × three states; `seat` and reset time rendered.
- **What no test can reach**: the first real cross-seat rotation needs a second Team seat and a real limit hit. It is added to `RUNBOOK.md` §10 as a bring-up invariant with the transcript rows that prove it.

---

## 7. Provisioning a seat

1. `mkdir <seat-dir> && CLAUDE_CONFIG_DIR=<seat-dir> claude auth login` — an interactive, per-seat step (`claude auth login`: read out of 2.1.276's own command table, where the `auth` command group carries `login`, `logout` and `status`, and no top-level `login` verb exists); a fresh dir inherits nothing.
2. `rm -rf <seat-dir>/projects && ln -s <shared projects dir> <seat-dir>/projects` — the shared tree. For a fleet that already runs, it is the `projects/` of the config dir the fleet runs under.
3. `soma init --seat <seat-dir>` — bus registration and skill.
4. Add `{ "config_dir": "<seat-dir>", "label": "seat-b" }` to `soma.json.seats`.
5. `soma doctor` — the seat checks must read `ok`, not `unobserved`. As built the set is wider than the four this section was written against: `seats readable`, `every seat logged in`, `seat projects is the shared tree`, `mcp enumeration covers every seat`, and `seat pool state readable` (the pool-state read, added because a torn `state/seats.json` has no other voice). RUNBOOK §5.2 and §7.

---

## 8. Out of scope, declared

- **The orchestrator's own limit.** Not detected; the only proxy is lease staleness after ten minutes. Recovering it is a human lease-steal from a session under another seat.
- **Two fleets sharing a seat.** The pool is per `SOMA_HOME`; there is no state location outside a fleet, so fleet A cannot see that fleet B is using a seat.
- **Cross-organisation seats.** The operator's personal Max profile is a different organisation; it is outside this pool. Mixing organisations costs a prompt-cache miss on the first post-rotation turn and raises a terms question this design does not take on.
- **Copying transcripts.** Rejected (approach C); the shared tree removes the step and its torn-file failure mode.

## 9. Open risks

- Whether a seat's server side accepts a conversation another seat started, especially an unfinished tool-use turn with signed thinking blocks. Mitigated by the revert path; retired by the first real rotation.
- Whether a shared `projects/` behaves identically across two *different* accounts. Measured across two dirs of one account; nothing account-specific was found in transcript content except the login email in `session_context`.
- `resetsAt` non-monotonicity. The rows of one limit episode do not all carry the same `resetsAt`: most carry the true reset, and later rows can carry several later values. Those later values sit a little under five hours ahead of the rows' *own* timestamps, bucketed to a ten-minute mark, so "exactly `now + 5 h`" is wrong on its own terms too. The five-minute floor and idempotent reopen make this a nuisance, not a fault; the cost is that a seat closed on a late row reopens later than it needs to.
