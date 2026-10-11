# Showcase video

`showcase.mp4` is an 88-second film about claude-soma-lite. It opens with a 27-second story of what
the tool does, told from the user's chair for anyone, then a call to action, then "For developers":
six scenes of real captured output. `showcase.gif` is the story on its own, for the README.
`showcase-poster.png` is the title frame.

| file | what it is |
|---|---|
| `showcase.mp4` | 1920x1080, 30 fps, H.264 High (yuv420p), AAC narration (ElevenLabs voice; script in [NARRATION.md](NARRATION.md)), `+faststart`, 88.5 s |
| `showcase.gif` | 960x540, 12 fps, loops forever, 27.6 s: the story, steps 1 to 6 below |
| `showcase-poster.png` | 1920x1080 still of the title scene |
| `source/` | the composition, the captured output, and the scripts that captured it |

## The story (0:04 to 0:32, and the GIF)

The stage is a re-creation and says so in its corner: "recreated from real soma output · sandboxed
demo". Steps 3 to 6 are also marked "time-lapse": in a real fleet the watchdog starts leads one at a
time after `soma up` (90 s apart by default), and the work itself takes far longer than the seconds
shown. Every word on the stage comes from `source/capture/story-demo.mjs` driving soma's real MCP bus
(`bin/soma-bus.mjs`) in the sandbox. Its record is `source/captures/19-story.json`, and `build.mjs`
stops if that record does not tell the same story, in the same order.

| step | caption | where it comes from |
|---|---|---|
| 1 | Your Claude Code session becomes the orchestrator. | the first step of `/soma-promote`, `soma_adopt`: adopted, wake `notify`; the session's soma tools go from 2 to 12 |
| 2 | Give it a backlog. | `soma_enqueue` with the four demo tasks: queued 4 |
| 3 | soma spins up a fleet, one lead per task. Small print: "after `soma up` · leads start one at a time" | each lead's `STARTED` report; each task row's status, `spawned`, from `soma_status` |
| 4 | Each lead picks a harness for its job, which sets its budget. | each lead's `HARNESS` report, which the bus validates; the orchestrator's first `soma_inbox` binds the harness and budget class to the row (`soma_status`): H3 and H2 iterate, H1 standard, H6 research |
| 5 | They work in parallel and ask only when they need you. | `MILESTONE` reports; fix-login-bug's `NEEDS_INPUT`; the user's answer, which the orchestrator relays with `soma_send` |
| 6 | Come back to draft PRs and reports, ready for your review. Small print: "drafts only · a human reviews and merges" | `COMPLETED` from every lead; the last `soma_inbox` folds every row to `done`; `soma_status` counts 4 done |

Each card shows the lead's latest report, which is an event, in its right-hand chip, and the lead's
task status (`spawned`, then `done`) under its name. The chat panel is not Claude Code's interface:
the user's lines are the demo's input, and the orchestrator's lines restate the bus's replies.

What stands in for a real fleet, and nothing else:

- No lead ran. The four task rows were set to `spawned` with soma's own `fleet.setTaskStatus()`, the
  call `soma_spawn` makes once admission passes, because the inbox folds a `COMPLETED` into `done`
  only for a row that was spawned.
- `soma_send` types into a lead's pane, and the sandbox has no lead. A plain `cat` in a tmux session
  named `lead-fix-login-bug`, on the sandbox's own socket, stood in for it. It prints one line first,
  `demo lead pane (stand-in)`, because soma_send will not type into a pane it cannot read: a blank
  one could be hiding a permission dialog. The bus then typed the answer into it, with its warning
  that the screen "matched no known Claude Code state (unrecognised); typed anyway". A real lead's
  pane is recognised as the Claude Code composer. What the pane received is
  `source/captures/19-story-pane.txt`.
- The draft-PR links the leads reported are `example.com` placeholders. No PR exists anywhere.

## The rest of the film

| time | scene | where the content comes from |
|---|---|---|
| 0:00 | title | — |
| 0:31 | Get started: the repository, "clone · soma init · soma up · /soma-promote", and "v0.1 · built for supervised use · read RUNBOOK.md first" | the steps of the README's Quick start |
| 0:36 | For developers | — |
| 0:39 | 01: how it fits together: operator, orchestrator, MCP bus, leads, watchdog | diagram; every label checked against `bin/` and `prompts/` |
| 0:47 | 02: `soma up` prints the worst-case spend, asks, is answered `no`, and aborts | captured under a pty |
| 0:54 | 03: three PreToolUse denies from the lead gate; generic rules from the deny list written into every worktree; `soma-pr` turning `-fd=false` into `--draft` | captured from `bin/hooks/lead-gate.mjs`, `bin/lib/settings-gen.mjs` and `bin/soma-pr.mjs` |
| 1:02 | 04: a tripped budget: the gate denies the lead and its teammate but still allows `soma_report`; the watchdog's duties on each tick | captured, plus a list written from `bin/soma-watchdog.mjs` and `bin/lib/wd/` |
| 1:10 | 05: `npm test` in the sandbox copy: 1368 tests, 1367 pass, 0 fail, 1 skipped | captured; shown as the log's head, one marker counting the elided lines, the last five results and the full summary |
| 1:14 | 06: seat rotation: the `seats:` line of `soma status` for a two-seat pool, and the rotation tests passing by name | captured; the pool was seeded with `seats.close()`, and no lead was moved. Cross-seat resume is not yet proven by a real rotation (`RUNBOOK.md` §10), and the scene says so |
| 1:23 | outro: v0.1, built for supervised use, read `RUNBOOK.md` first | — |

The skipped test reads the operator's own Claude Code transcripts, and the sandbox has none.

## How it was captured

Every terminal panel in the developer half is real output from the real code, copied verbatim from
`source/captures/`. The only edits:

- Every panel that leaves lines out says so with a `[… N lines elided …]` row that counts them:
  the suite log (its head, the marker, the last five results, the full summary), the `soma status`
  excerpt in the rotation scene, and the rotation run's summary.
- An argv is joined on spaces, with the one token that contains spaces shown quoted.
- The pty transcript of `soma up` loses the echoed EOF (`^D` followed by two backspaces), which a
  terminal erases on screen anyway.

Nothing was retyped or invented.

The captures come from a throwaway demo fleet, not from anyone's real state:

- `source/capture/setup-sandbox.sh` builds `/private/tmp/soma-demo` (the path is pinned). It holds a
  `git archive` copy of this repository, a copy of the `node` binary, a `git` wrapper, a `tmux` symlink,
  a toy repo `demo-app` with a local bare origin, and the `.soma-demo-sandbox` marker that the capture
  scripts check before they delete anything inside the sandbox.
- Every command runs through `env -i` with an explicit allowlist. `HOME`, `SOMA_HOME` and
  `CLAUDE_CONFIG_DIR` all point inside the sandbox; `SOMA_TMUX_SOCKET=soma_demo`, with no `TMUX` or
  `TMUX_PANE`; `USER=demo`; `PATH` is the sandbox's own `bin/` plus `/bin`, so `claude`, `gh` and
  `osascript` cannot be reached. Before any bus starts, the scripts refuse unless `SOMA_HOME`
  resolves inside the sandbox.
- Nothing launched a Claude Code session or started a watchdog. `soma up` was answered `no`, and
  nothing was pushed or opened on GitHub.
- The bus, hook, builder, seat and story demos are small drivers that feed demo inputs to the real
  modules: `bus-demo.mjs`, `gate-demo.sh`, `fanout.mjs`, `argv-demo.mjs`, `seats-demo.mjs` and
  `story-demo.mjs` (run by `story.sh`). Their task ids, briefs, questions, answers, seat labels and
  session ids (`orch-demo`, `00000000-…-000000000001`) are made up for the demo.
- `capture.sh` still records `02`, `03`, `06`, `07` and `10`, for beats this cut no longer shows.
  Two of those steps also leave state that later beats read: `02` queues the demo tasks, and `06`
  takes the sandbox lease that the rotation scene's `orchestrator:` line reports. `19-story-pane.txt`
  and `20-story-status.txt` are kept as evidence of the story capture and are not shown.

## Re-rendering

You need macOS (the capture uses BSD `script`), Node 24+, tmux, git, ffmpeg, and network access
for `npx hyperframes@0.8.143`. The capture scripts are demo-only: never point them at a real
`SOMA_HOME` or `CLAUDE_CONFIG_DIR`.

```bash
# 1. Build the sandbox from a checkout (refuses to reuse an existing /private/tmp/soma-demo)
sh docs/media/source/capture/setup-sandbox.sh "$PWD"

# 2. Capture every beat (story.sh, the opening story, runs last), then use the result as the input
sh docs/media/source/capture/capture.sh /tmp/soma-captures
cp /tmp/soma-captures/* docs/media/source/captures/

# 3. Fetch the headline font, generate index.html, and render a master
cd docs/media/source
sh fetch-fonts.sh
node build.mjs
npx hyperframes@0.8.143 lint
npx hyperframes@0.8.143 render --quality delivery --output /tmp/showcase-master.mp4

# 4. Encode the deliverables: the film, the story alone as the GIF, the title frame as the poster
ffmpeg -i /tmp/showcase-master.mp4 -c:v libx264 -preset slow -crf 22 -tune animation \
  -pix_fmt yuv420p -profile:v high -movflags +faststart -an ../showcase.mp4
ffmpeg -i /tmp/showcase-master.mp4 -filter_complex \
  "[0:v]trim=4.5:32.05,setpts=PTS-STARTPTS,scale=960:540:flags=lanczos,fps=12,split[s0][s1];\
   [s0]palettegen=max_colors=160:stats_mode=diff[p];\
   [s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 ../showcase.gif
ffmpeg -ss 3.5 -i /tmp/showcase-master.mp4 -frames:v 1 ../showcase-poster.png

# 5. Remove the sandbox
rm -rf /private/tmp/soma-demo
```

A fresh capture carries new timestamps, commit hashes and test counts, and the GIF's trim points
assume the scene timings in `source/timeline.js`. Check both before you commit. The project name
and the repository link on screen are one constant each at the top of `source/build.mjs`.

## Fonts and credits

- Headlines are set in **Instrument Serif**, from Google Fonts, under the SIL Open Font License 1.1.
  The font files are not committed: `source/fetch-fonts.sh` downloads them into `source/fonts/`,
  and without them the headlines fall back to Georgia.
- Terminal text is set in JetBrains Mono, which HyperFrames embeds at render time.
- Built with HyperFrames 0.8.143 (the `hyperframes` npm package) and GSAP 3.14.2.
