# Research 02 — loop-engineering deep-read → soma-lite loop-harness foundation

Source: github.com/cobusgreyling/loop-engineering (cloned shallow 2026-07-29 to scratchpad).
MIT license. ~5.5k stars. Fast-moving (v1.5 → v1.7 within weeks; companion repos: memory-engineering, harness-foundry, outerloop, fleet-engineering, goal-engineering).

Purpose of this doc: extract the exact schema/vocabulary, the 7 patterns, the primitives matrix, the Claude Code wiring, cost/budget guidance, and failure-story lessons — then design the soma-lite harness taxonomy a project lead must pick from **the moment it receives a ticket**, and give a fork-vs-borrow verdict.

---

## 1. Repo anatomy (what actually exists)

```
README.md, LOOP.md (dogfood config), STATE.md, loop-budget.md, loop-constraints.md, gate.yaml
patterns/     7 pattern .md files + registry.yaml + registry.schema.json (JSON Schema 2020-12)
docs/         concepts, primitives(+matrix, 8+ tool appendices), loop-design-checklist,
              pattern-picker, operating-loops, safety, failure-modes, anti-patterns, multi-loop
starters/     clone-and-run kits per pattern × tool (.claude/, .codex/, .grok/, opencode variants)
skills/       install-loop, loop-budget, loop-constraints, loop-triage, loop-verifier, minimal-fix
templates/    SKILL.md.* templates, STATE.md/LOOP.md/GOAL.md templates, gate.yaml.template,
              loop-budget/run-log templates, fleet/memory templates
tools/        14 npm packages (Node/TS monorepo): loop (front door), loop-init, loop-audit,
              loop-cost, loop-context, loop-gate, loop-worktree, loop-sync, loop-sandbox,
              loop-action, mcp-server, readiness-core, goal-init, goal-audit
examples/     per-tool wiring (claude-code, codex, cursor, grok, hermes, openclaw, opencode,
              windsurf, github-actions, mcp)
stories/      19 honest win/failure write-ups
```

Core thesis (Steinberger / Boris Cherny quotes): *"Stop prompting. Design the loop."* A loop = harness + schedule + state + verification chain. Concepts vocabulary worth adopting: **intent debt** (skills pay it down), **comprehension debt** (read what the loop ships), **cognitive surrender**, **orchestration tax**, **maker/checker split** ("the implementer never grades its own homework").

---

## 2. The exact pattern schema (patterns/registry.schema.json)

Every pattern in `registry.yaml` is validated against this. Required fields marked *.

| Field | Type / constraint | Meaning |
|---|---|---|
| `id`* | `^[a-z][a-z0-9-]*$` | slug |
| `name`* | string ≥3 | display name |
| `file`* | `[a-z0-9-]+.md` | pattern doc |
| `goal`* | string ≥10 | one-sentence purpose |
| `cadence`* | `^[0-9]+[mhd](-[0-9]+[mhd])?$` e.g. `5m-15m`, `1d` | how often the loop ticks (range allowed) |
| `risk`* | enum low/medium/high | blast-radius class |
| `tools`* | enum list (grok, claude-code, codex, openclaw, opencode, github-actions, cursor, windsurf, aider) | where it runs |
| `skills`* | string list | required SKILL.md packages |
| `state`* | `[A-Za-z0-9-]+.md` | the durable state-file spine (one per loop) |
| `phases`* | string list ≥2 | the run's internal pipeline (e.g. discover→triage→fix→verify→notify) |
| `human_gates`* | string list ≥1 | conditions that force escalation to a human |
| `starter` | path | clone-and-run kit |
| `week_one_mode` | enum **L1/L2/L3** | autonomy level to start at |
| `token_cost` | enum low/medium/high/very-high | tier label |
| `cost` | object | `tokens_noop`*, `tokens_report`*, `tokens_action`*, `stable_fraction` (cacheable share, 0–1), `suggested_daily_cap`*, `early_exit_required`* (bool) |

**Autonomy levels** (the single most reusable concept):
- **L1 Report** — triage → state file only, no auto-action (checklist §1–3,5)
- **L2 Assisted** — small auto-fixes, verifier + worktree + max attempts mandatory (§1–7)
- **L3 Unattended** — runs with nobody watching; requires denylist, budget, run log, metrics, kill switch (all 10 checklist sections). loop-audit refuses L3 until `loop-budget.md` + `loop-run-log.md` + LOOP.md budget section exist.

**Stop/escalation machinery is NOT in the pattern schema** — it lives in the circuit-breaker (`loop-context`) parameters and `loop-constraints.md`/`gate.yaml`:
- `--max-iterations` (default 10) — hard iteration cap
- `--stagnation` (default 3) — same error N× in a row → escalate
- `--no-progress` (default 5) — N consecutive failures → escalate
- `--token-budget` — cumulative token cap (resolvable from pattern via `--budget-from-pattern <id> --budget-level L2`)
- Exit-code convention across all their tools: **0 = continue/allowed, 2 = escalate, 1 = tool error**. Control scripts chain `loop-context --check && loop-gate check && act`.

---

## 3. All 7 patterns with parameter values (registry.yaml, verbatim values)

| id | goal (short) | cadence | risk | phases | human_gates | wk1 | tier | noop/report/action tokens | daily cap | early-exit req |
|---|---|---|---|---|---|---|---|---|---|---|
| `pr-babysitter` | shepherd PRs through review/CI/rebase/merge | 5m–15m | med | discover, triage, fix, verify, notify | security, payments, auth, max-fix-attempts | L1 | high | 3k / 80k / 250k | 2M | yes |
| `daily-triage` | prioritized morning scan (CI, issues, commits, chat) | 1d–2h | low | report, act-small-wins, escalate | design-decisions, multi-file-refactors | L1 | low | 5k / 50k / 200k | 100k | no |
| `ci-sweeper` | react to failing CI with minimal fixes | 5m–15m | med | detect, classify, fix, verify, escalate | infra-failures, max-attempts, security-tests | L2 | very-high | 5k / 50k / 200k | 1M | yes |
| `post-merge-cleanup` | tech-debt follow-up after merges | 1d–6h | low | scan-merges, prioritize, fix-small, ticket-large | architectural-debt, feature-flags, large-diffs | L1 | low | 5k / 40k / 150k | 200k | no |
| `dependency-sweeper` | safe dep/CVE updates with gates | 6h–1d | med | scan, triage-risk, patch-safe, verify-worktree, escalate-risky | major-bumps, high-sev-cve, denylisted-packages, max-attempts | L2 | med | 5k / 60k / 300k | 500k | yes |
| `changelog-drafter` | draft categorized release notes | 1d | low | scan-merges, categorize, draft, review, publish | breaking-changes, security, major-features, marketing-sensitive | L1 | low | 5k / 35k / 80k | 100k | no |
| `issue-triage` | dedupe/prioritize/label incoming issues | 2h–1d | low | discover, dedupe, score, propose-labels, human-review | security, p0-p1, ambiguous-duplicates, stale-closures | L1 | low | 3k / 30k / 60k | 80k | no |

Recurring structure inside each pattern doc (the implicit "pattern template"): Goal · Scheduling · Required Skills · State (file + example schema) · Typical Cycle · Circuit Breaker (L2 patterns) · Verification Strategy · Human Handoff Points · Tool-Specific Notes · Failure Modes & Mitigations table · Cost Profile table · Success Metrics · **Post-Run Critique** (self-improvement section: false positives, missed items, one adjustment for next run — daily-triage and changelog-drafter have it).

Notable per-pattern wisdom:
- pr-babysitter: classify checks as passing/failing/pending/**absent-unknown** — zero returned checks is not green; "the loop only proposes; human merges".
- ci-sweeper: flake vs regression classification before fixing; never run full sweep when CI is green (no-op exit in ~5k tokens); "best entry loop, worst unattended loop".
- issue-triage gets a `loop-intake` skill: when a work item is **too vague to verify "done"**, ask one question at a time / escalate rather than guess — directly relevant to soma-lite ticket intake.

---

## 4. Primitives matrix — content + Claude Code column

Five building blocks + memory (docs/primitives.md, primitives-matrix.md):

| Primitive | Job | Claude Code realization |
|---|---|---|
| Automations / Scheduling | discovery+triage on cadence | `/loop`, scheduled tasks, cron, hooks, GitHub Actions |
| Run-until-done | keep working until a verifiable condition holds | `/goal <condition>` — **a fresh model checks the stop condition** (maker/checker at the goal layer) |
| Worktrees | safe parallel execution | `git worktree`, `--worktree`, `isolation: worktree` on subagents |
| Skills | persistent project knowledge (pays down intent debt) | `SKILL.md` in `.claude/skills/` |
| Plugins & Connectors | reach into real tools | MCP servers + plugins |
| Sub-agents | maker/checker split | `.claude/agents/*.md`, **agent teams** |
| + Memory / State | durable spine outside any conversation | `STATE.md`, `AGENTS.md`, progress files, Linear via MCP |

Matrix covers 8 primary tools + appendices for Windsurf, Aider, Roo (sunset), Continue, Cline, Zed, Gemini CLI, Copilot, Amazon Q, Devin — i.e. **most of the repo's bulk is cross-tool mapping soma-lite doesn't need**.

Key doctrine: "minimal viable loop = scheduling + one triage skill + state file; add worktrees when changing code, verifier when acting autonomously, connectors when driving tickets — each primitive added only after the previous proved its value."

---

## 5. How the claude-code starter actually wires a loop

`starters/minimal-loop-claude/` contains only 5 files — **it is convention, not code**:
- `.claude/skills/loop-triage/SKILL.md` — triage skill with a strict 4-section output format (High-Priority / Watch / Noise / State Updates) and rules ("signal, not invention").
- `.claude/agents/loop-verifier.md` — checker subagent, `model: inherit`, default stance **REJECT**, must run tests itself ("do not trust the implementer's claim"), verdict enum `APPROVE | REJECT | ESCALATE_HUMAN` with evidence block.
- `STATE.md.example`, `LOOP.md` (team-facing config table: pattern/cadence/status/command), `README.md`.

Invocation is **in-session dynamic scheduling, not headless**:
```
/loop 1d Run $loop-triage. Read STATE.md first. Append high-priority and watch items.
Update Last run timestamp. Do not auto-fix anything in week one.
```
`/goal All tests on main pass and lint is clean` is the run-until-done alternative for one-shot get-green sessions.
Constraints wiring: `/loop 1d Run $loop-constraints, then $loop-triage …` — the `loop-constraints` skill reads `loop-constraints.md` (binding plain-English rules: draft-PR-only, path denylist, max 3 attempts, 80% budget → report-only, kill-switch check) **before** any action skill.

The GitHub Actions path is explicitly a placeholder: `examples/github-actions/daily-triage.yml` says "Wire this step to your agent harness" — the repo's own dogfood `daily-triage.yml` doesn't even call an LLM; it's a deterministic script that runs `loop-audit --json` and regenerates STATE.md. **There is no turnkey headless `claude -p` loop anywhere in the repo.** The runnable substance is:
1. file conventions (STATE.md, LOOP.md, loop-budget.md, loop-run-log.md, loop-constraints.md, gate.yaml, loop-ledger.json),
2. skill/agent prompt templates,
3. small deterministic Node CLIs chained by exit code in a control script.

### The npm CLIs (tools/) — what each does
| CLI | Function | Local value to soma-lite |
|---|---|---|
| `loop` | front door: init/doctor/status/audit/cost wrappers | low (scaffolding UX) |
| `loop-init` | scaffold starter by pattern×tool; auto-adds loop-guard skill + seeded `loop-ledger.json` for fix-capable patterns; loop-intake for vague-input patterns | low–med (idea worth porting, not the tool) |
| `loop-audit` | 0–100 Loop Ready score over ~19 file/activity signals; exit 2 if <40; caps L3 without budget files | med (a "harness readiness" lint is a good idea) |
| `loop-cost` | daily token estimate from registry cost block; **orchestration multipliers: single 1×, maker-checker 2×, parallel:N = N+1, debate:R = 1+R**; caching scenario via `stable_fraction` | med (formula worth stealing) |
| `loop-context` | **circuit breaker + deterministic context manager**: reads `loop-ledger.json` {goal, attempts[{iteration, action, outcome, error, tokensUsed}]}; `--check` exit 0/2; `--inject` compact context block; `--prune` window+trace-trim; dependency-free | **HIGH — the one tool soma-lite would actually run** |
| `loop-gate` | policy gate: `gate.yaml` denylist globs + maxFiles + autoMergeAllowlist; `check --action commit|merge|auto-merge --paths …` exit 0/2; deliberately history-blind (pairs with loop-context) | high (concept), medium (tool — trivially reimplementable) |
| `loop-worktree` | worktree-per-attempt manifest (`create/mark/cleanup/gc/list`) + **advisory path locks** (`lock --paths … --owner … --ttl`, deadlock detection) for multi-loop collision | med — soma-lite has its own worktree layer, but the *lock* + *status manifest* (active/rejected/escalated/merged/stale) ideas apply |
| `loop-sync` | STATE.md ↔ LOOP.md drift detection | low |
| `loop-action`, `loop-sandbox`, `mcp-server`, `readiness-core`, goal-* | GH Action shim, sandbox helper, MCP resource server for patterns/skills, shared scoring lib, goal-engineering siblings | low |

---

## 6. Cost & budget guidance (operating-loops.md + loop-budget.md + checklist §8)

- **Cadence is a linear multiplier**: 5m vs 1d = 288× runs/day. CI sweeper at 15m without early exit ⇒ worst case >5M tokens/day.
- **Golden rule**: triage pass cheap, spawn sub-agents only when state says actionable; empty watchlist → exit in <5k tokens (`early_exit_required` on all high-cadence patterns).
- Budget file (`loop-budget.md`): per-loop max runs/day, max tokens/day, max sub-agent spawns/run; **on exceed**: pause schedulers, append run-log event, notify human. Kill switch = `loop-pause-all` label/flag checked at run start.
- Soft threshold: at 80% of daily cap → degrade to report-only (encoded in loop-constraints).
- Run log (`loop-run-log.md` or JSON): run_id, pattern, duration, items_found, actions_taken, escalations, tokens_estimate, outcome — append-only.
- When to slow/pause/kill: false-positive rate >30%, same item escalated 2+× in 48h, prod incident in progress, cost>value 2 weeks, team mutes bot. Kill checklist: delete scheduler → archive state with `status: retired` → post-mortem story.
- Verifier economics: "stronger model on verifier = worth it for unattended"; verifier runs dominate dependency-sweeper cost (full `npm ci && npm test`).

---

## 7. Failure-story lessons (stories/ + failure-modes.md + anti-patterns.md)

- **why-we-killed-ci-sweeper**: `/loop 5m` on red main, no L1 phase, verifier in same session, no branch allowlist, no daily budget → 8M tokens/48h, 11 PRs, 3 symptom fixes, 1 near-prod-breaker. Fix: event-driven trigger, report-only week, separate verifier, 2M/day cap, `main`-only allowlist.
- **score-climbs-then-budget-burns**: Loop Ready 15→92 in an afternoon, then premature L2 at 15m cadence burned 6–8M tokens on one flaky test. Lessons: **score ≠ permission** (readiness measures scaffold, not license); "L1 until boring"; budget must be a **hard stop enforced outside the model's goodwill**; same-session verifier = maker grading own homework; STATE.md and run log disagreeing about "done" is a red flag.
- **quant-loop-the-verifier-problem** (the deepest one): an LLM verifier opining on a backtest cannot catch overfitting — **maker/checker only works when the checker measures something the maker structurally cannot fake** (out-of-sample stats there; independently-run tests here). The checker must be mechanical and non-overridable where possible; an LLM may narrate the gate, never overturn it. "That refusal is the product."
- failure-modes catalog (S1 annoying / S2 harmful / S3 critical): Infinite Fix Loop, State Rot (prune every run, validate IDs live), **Verifier Theater** (vague "looks good", doesn't run tests), Notification Fatigue, Token Burn, Over-Reach/wrong scope, Comprehension-Debt Spiral, Cognitive Surrender, **Parallel Collision** (two loops, same files → worktrees + path locks), **Escalation Failure** (escalation written to state nobody reads → must ping a channel; alert if waiting >24h).
- anti-patterns top 10: same agent implements+verifies; no attempt cap; vague triage; L3 before L1 quality; shared state without schema; write-everything MCP scope; no kill switch; fixing flakes with code; auto-merge without allowlist; no run log.
- Checklist red flags: >3 automated attempts without progress; verifier == implementer session; no state file ("amnesia every run"); notify on every run.

---

## 8. ANALYSIS — bridging to soma-lite: the harness taxonomy

### The shape mismatch, precisely
loop-engineering's 7 patterns are **standing repo-ops loops**: infinite-horizon, cadence-driven, discovery-first ("what needs attention?"), where the loop itself finds work. A soma-lite project lead receives the opposite: a **bounded, pre-discovered work item** (a Jira ticket) that must reach a terminal state (draft PR + verified). LE even names this split: *"loops discover, goals finish"* — and points bounded work at its sibling repo goal-engineering (`/goal`, GOAL.md, goal-verifier, fresh-model stop-condition check). So the correct bridge is: **soma-lite harnesses are goal-shaped executions described in loop-engineering's schema vocabulary**, with LE's standing-loop machinery reserved for exactly one harness (the post-PR babysitter) and for the orchestrator's own backlog cadence.

What transfers unchanged: autonomy levels L1/L2/L3 · phases · human_gates · state-file spine · maker/checker with a mechanical, non-fakeable gate · circuit-breaker parameters (max_iterations / stagnation / no_progress / token_budget) · exit-code 0/2 convention · gate.yaml denylist + maxFiles + allowlist · cost block {noop, report, action, daily cap, early_exit} · run ledger · post-run critique · "escalation must ping, not just write".

What must be added: an **iteration mode** axis (LE hardcodes "recurring on cadence"; tickets need one-shot / until-gate / rounds / poll), a **verify block** (LE leaves verification as prose; soma-lite leads must pick the gate before planning), and a **primitive binding** (which Claude Code looping mechanism executes it).

### Proposed soma-lite harness schema (`harnesses/registry.yaml`, extends LE registry.schema.json)

```yaml
harnesses:
  - id: iterate-to-green            # LE: id, ^[a-z][a-z0-9-]*$
    goal: ...                       # LE: goal
    shape: bounded                  # NEW: bounded | standing   (LE patterns are all standing)
    iteration:                      # NEW (replaces LE `cadence` for bounded work)
      mode: until-gate              # one-shot | until-gate | rounds | poll
      interval: null                # only for poll mode, LE cadence syntax ^[0-9]+[mhd]$
      max_iterations: 10            # LE loop-context defaults
      stagnation: 3
      no_progress: 5
    verify:                         # NEW: the gate, chosen at intake
      kind: mechanical              # mechanical | reviewer | human   (quant-story: prefer mechanical)
      command: "<repo verify gate>" # must be runnable, exit-code based
      independent: true             # checker ≠ maker session (anti-pattern #1)
    autonomy: L2                    # LE week_one_mode enum L1/L2/L3
    risk: medium                    # LE risk enum
    phases: [...]                   # LE phases
    stop_conditions: [...]          # NEW: explicit terminal states (success + escalation)
    human_gates: [...]              # LE human_gates
    primitive: workflow-loop        # NEW: agent-team | workflow-loop | in-session-/loop | cron
    state: harness-state.md         # LE state
    cost:                           # LE cost block, unchanged semantics
      tokens_noop: ...; tokens_report: ...; tokens_action: ...
      suggested_ticket_cap: ...     # renamed from daily cap: budget is per-TICKET for bounded shapes
      early_exit_required: ...
```

### The six soma-lite harnesses

**H1. ONE-SHOT-PIPELINE** — `plan → build → verify → draft-PR` (linear, single pass, ≤1 retry).
- *Pick when*: ticket is well-specified, small/medium, acceptance criteria clear, a runnable verify command exists, low-risk paths. The default for refined backlog tickets (cf. the 43 rework-with-drafts tickets).
- *Stop*: draft PR open + verifier APPROVE; or first verify FAIL after one retry → escalate to orchestrator with loop-context `--inject` summary. Never merges (draft-only standing rule).
- *Budget*: single `tokens_action` × maker-checker 2× (loop-cost multiplier); no daily dimension.
- *Primitive*: **agent-team task list** — lead (planning-only) writes the plan + task list; implementer teammate in the worktree; independent verifier teammate (port LE's `loop-verifier.md` prompt verbatim: default REJECT, run tests yourself, APPROVE/REJECT/ESCALATE_HUMAN).

**H2. ITERATE-TO-GREEN** — red→green loop until a mechanical gate passes.
- *Pick when*: there IS a deterministic gate (tests/lint/build/e2e — e.g. a Stop-hook verify gate) and the path from red to green is expected to take multiple attempts (flaky repro, migration fixes, CI-red tickets).
- *Stop*: gate exit 0 (success) OR breaker trips: max_iterations 10 / same-error 3× / 5 consecutive failures / ticket token cap → escalate with pruned ledger. Ledger (`loop-ledger.json`) appended every attempt; breaker checked **before** each retry, mechanically.
- *Budget*: per-iteration `tokens_action` estimate × max_iterations as the reserve; hard cap enforced by the breaker, not model goodwill.
- *Primitive*: **Workflow loop-until-dry** (dynamic workflow re-dispatching a fix agent while gate is red) or an in-session while-loop chaining `loop-context --check` → fix → gate; agent team does the fixing, the gate does the judging.

**H3. TDD-LOOP** — specialization of H2 with phases `[write-failing-test, implement-to-green, refactor, full-suite]`.
- *Pick when*: new behavior or bugfix whose correctness is expressible as tests first (most feature tickets; pairs with superpowers:test-driven-development). The failing test IS the non-fakeable gate the quant story demands — the checker measures something the maker cannot fake, because the test predates the implementation.
- *Stop*: new tests pass + full suite green + verifier scope check (no unrelated files, no disabled tests — LE "no cheating" rule); breaker as H2 but per-phase.
- *Budget*: as H2 + one report-tier pass for test authoring.
- *Primitive*: agent-team with test-writer and implementer as **separate teammates** (test written before implementer spawns), Workflow for the green loop.

**H4. REVIEW-FIX-LOOP** — implement → independent review → fix findings → re-review, bounded rounds.
- *Pick when*: no mechanical gate captures correctness (refactors, security-adjacent, subtle concurrency, unfamiliar code, prod-touching config) — the reviewer is the gate. Risk med/high tickets, denylist-adjacent paths.
- *Stop*: review round with zero CONFIRMED findings → draft PR; or max_rounds 3 → escalate with open findings (LE: ">3 attempts without progress" red flag). Reviewer must be a fresh session/agent each round (verifier-theater mitigation), findings must cite failure scenarios.
- *Budget*: `tokens_action` × (1+R) — LE's debate:R multiplier, warn above 2×.
- *Primitive*: agent-team with dedicated reviewer teammate (or /code-review skill in a fresh subagent); rounds sequenced by the lead's task list.

**H5. BABYSITTER-FOLLOWUP** — the only *standing* harness: after the draft PR opens, poll CI + review comments every N minutes, propose minimal fixes, ping orchestrator on human-needed items.
- *Pick when*: terminal phase of any other harness where the PR must actually land, or CI is slow/flaky, or reviewers are async. Direct port of LE `pr-babysitter` with its parameters: cadence 5–15m, `tokens_noop` 3k with **early-exit required**, absent-checks ≠ green, max 3 fix attempts per failure, watchlist-empty → self-delete the schedule.
- *Stop*: PR green + review-clean → report to orchestrator (never merge — draft-only rule); or idle-too-long / attempts-exceeded → escalate. Daily token cap applies here (this one has a daily dimension).
- *Primitive*: **in-session `/loop 10m`** dynamic scheduling in the lead's tmux session, or CronCreate/Monitor for detached polling; state in `pr-babysitter-state.md` per LE schema.

**H6. RESEARCH-SPIKE (L1 report-only)** — investigate → structured report → recommendation; no code writes.
- *Pick when*: ticket is a question, RCA, refinement, or estimate (frequent in this backlog: RCAs, cost analyses, plan reviews). Maps to LE's L1 doctrine and the loop-triage output format (High-Priority / Watch / Noise / State-Updates → adapt to Findings / Open-Questions / Recommendation / Evidence).
- *Stop*: report written + open questions listed; token cap at `tokens_report` tier. No verifier needed (human reads the report) — LE: "Phase 1 report-only: human reads STATE.md."
- *Primitive*: agent-team of parallel read-only researchers (Workflow fan-out), lead synthesizes.

### The intake decision — `harness-select` (the moment a lead receives a ticket)
Port LE's `loop-intake` insight: **a ticket too vague to verify "done" gets clarified or escalated before any harness runs.** Then a short decision table, executed as the lead's first action, recorded in the ticket state file:

1. Is the deliverable a report, not code? → **H6 RESEARCH-SPIKE**.
2. Is "done" checkable by a runnable command?
   - yes, and behavior is test-specifiable first → **H3 TDD-LOOP**;
   - yes, but tests exist / gate is repo-level (get CI green) → **H2 ITERATE-TO-GREEN**;
   - no mechanical gate → **H4 REVIEW-FIX-LOOP**.
3. Small, crisp, low-risk, single pass plausible? → **H1 ONE-SHOT-PIPELINE** (cheapest; degrade to H2/H4 on first failure rather than starting heavy).
4. Always: on draft-PR open, attach **H5 BABYSITTER-FOLLOWUP** unless the orchestrator will hand the PR off.
5. Regardless of harness: gate.yaml denylist paths / >10 files / security-payments-auth ⇒ `human_gates` fire → orchestrator escalation (MCP ping, not just a state-file line — LE Escalation Failure mode).

The chosen harness + parameters (max_iterations, verify command, token cap) is the lead's **first message back to the orchestrator** — it doubles as the cost reservation (a reserve-before budget pattern) and lets the orchestrator veto (e.g. downgrade autonomy on prod-adjacent repos).

---

## 9. VERDICT — FORK vs BORROW

**BORROW the schema and vocabulary into a small soma-lite-owned registry. Do not fork the repo.** Optionally consume 1–2 of their published npm CLIs as pinned utilities.

Reasoning:
1. **The runnable core is tiny; the repo is mostly cross-tool documentation.** Of ~230 files, the durable engineering value is: `registry.schema.json` (~100 lines), `gate.yaml` (~30), the loop-verifier/loop-triage/loop-constraints prompt templates (~200 lines total), the circuit-breaker parameter set, and the L1/L2/L3 + cost-block vocabulary. Everything else — 8-tool matrices, 12 tool appendices, Grok/Codex/OpenClaw starters, showcase site, star-history CI, 14-package npm release machinery — is weight soma-lite would delete on day one. Forking means carrying that weight or diverging instantly (worst of both).
2. **Their looping primitives are superseded by Claude Code natives in soma-lite's design.** Scheduling → in-session `/loop`/Workflow/cron; sub-agents → agent teams; worktrees → soma-lite already owns tmux+worktree lifecycle; skills → `.claude/skills`. The starters exist precisely to paper over tools that *lack* these primitives.
3. **Upstream drift is fast and orthogonal.** v1.5→v1.7 in weeks, plus an expanding companion-repo constellation (harness-foundry, outerloop, fleet-engineering) pulling the schema toward *their* ecosystem (`.foundry/stack.yaml`, Foundry CTAs baked into loop-init output). A fork tracks churn soma-lite doesn't want; a borrowed schema is frozen at our semantics.
4. **The two tools worth running are published, dependency-free, and MIT** — `@cobusgreyling/loop-context` (circuit breaker + ledger prune/inject; deterministic, no LLM, cross-platform Node) and `@cobusgreyling/loop-gate` (glob policy gate). Use them via pinned `npx` (Node is already a soma-lite dependency for Claude Code) or reimplement in <200 lines each inside soma-lite's MCP server if we want zero npm surface. Either way: no fork needed. `loop-worktree`'s advisory path-lock design should be reimplemented natively in soma-lite's worktree manager (we own that layer).
5. **What we owe upstream**: MIT attribution in our registry header, and the vocabulary — keeping field names (`phases`, `human_gates`, `autonomy` L1–L3, `cost.tokens_*`, breaker knob names) compatible means their docs/stories remain readable as our extended manual, and future upstream patterns (they take pattern PRs) can be hand-ported in minutes.

**Concrete borrow list for soma-lite:**
- `harnesses/registry.yaml` + `harness.schema.json` — LE schema + the `shape/iteration/verify/stop_conditions/primitive` extensions from §8.
- `gate.yaml` template verbatim (denylist/maxFiles/autoMergeAllowlist) — enforced in the lead's pre-PR step and by the orchestrator.
- `loop-verifier.md` agent prompt (default-REJECT checker) and `loop-constraints.md` template (binding plain-English rules read at session start) — both slot straight into `.claude/agents` / project root.
- `loop-ledger.json` shape + breaker semantics (exit 0/2), via pinned `loop-context` or a native port.
- The cost model: {noop, report, action} × orchestration multiplier (maker-checker 2×, parallel N+1, rounds 1+R) with per-ticket caps + hard-stop budget — feeds the lead's harness-selection message and the orchestrator's fleet budget.
- Doctrine one-liners for the lead system prompt: "L1 until boring", "score ≠ permission", "the checker must measure what the maker cannot fake", "empty watchlist exits in <5k tokens", "escalations ping, never just write".

**Open questions for the design panel** (feeding workflow step 3/4):
- Should H1→H2/H4 degradation be automatic (lead self-reselects harness after first failure) or orchestrator-approved? (LE precedent: graduation between L-levels is human-gated.)
- Per-ticket token caps: who sets them — harness defaults, orchestrator per-ticket, or a reserve-before ledger? Recommend harness default + orchestrator override, reserve-before/reconcile-after.
- Does the babysitter (H5) live in the lead's session (dies with it) or as a detached cron owned by the orchestrator after lead handback? Detached-cron survives lead teardown; in-session is simpler. Recommend: lead runs it while alive, hands the watchlist to the orchestrator at teardown.
- Reimplement loop-context/loop-gate natively vs pinned npx: pinned npx is fastest to MVP; native port removes a supply-chain dependency on a fast-moving personal-account npm scope. Lean native-port for v1 given the orchestrator's security posture.
