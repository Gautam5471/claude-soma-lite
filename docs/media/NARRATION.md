# claude-soma-lite showcase: narration script

Narration for `showcase.mp4` (88.5 s, 1080p30). Scene times come from `docs/media/source/timeline.js`
in the claude-soma-lite repo (`T` scene table and the story's `BEATS`, which start at 4.5 s), and were checked
against extracted frames.

- Voice: ElevenLabs "Eric - Smooth, Trustworthy" (premade, American), model `eleven_multilingual_v2`,
  speed 0.9, stability 0.55, similarity 0.75, style 0.1.
- Each clip starts 0.2 s after its scene starts (0.4 s for the title) and ends at least 0.25 s before the next scene.
- Mix loudness-normalised to about -16 LUFS (measured -16.5 LUFS integrated).
- The TTS text for the title spells the name "Claude soma light" so it is pronounced correctly. The script below shows the real name.

| # | scene | scene window (s) | speech (s) | line |
|---|---|---|---|---|
| 0 | Title | 0.0 – 4.0 | 0.40 – 2.8 | Meet claude-soma-lite. One session, a whole fleet. |
| 1 | Story 1/6: promote | 4.5 – 8.5 | 4.70 – 7.53 | First, promote your Claude Code session to orchestrator. |
| 2 | Story 2/6: backlog | 8.5 – 12.0 | 8.70 – 9.70 | Then give it a backlog. |
| 3 | Story 3/6: one lead per task | 12.0 – 16.0 | 12.20 – 14.27 | Soma starts one lead for each task. |
| 4 | Story 4/6: harness and budget | 16.0 – 20.5 | 16.20 – 18.99 | Each lead picks a harness, and that sets its budget. |
| 5 | Story 5/6: parallel work, one question | 20.5 – 27.5 | 20.70 – 25.11 | They work in parallel, and ask only when they need you. You answer once. |
| 6 | Story 6/6: draft PRs | 27.5 – 31.5 | 27.70 – 29.87 | Then come back to draft PRs, ready for your review. |
| 7 | Get started (CTA) | 31.5 – 36.5 | 31.70 – 34.87 | Get started on GitHub: clone, init, up, then promote. |
| 8 | For developers | 36.5 – 39.0 | 36.70 – 37.65 | Now, for developers. |
| 9 | 01 how it fits together | 39.0 – 47.0 | 39.20 – 44.42 | One orchestrator and a fleet of leads talk over one bus, each lead in its own worktree. |
| 10 | 02 spend gate | 47.0 – 54.0 | 47.20 – 51.56 | Before anything starts, soma shows the worst-case spend and waits for you to type yes. |
| 11 | 03 guardrails | 54.0 – 62.5 | 54.20 – 60.53 | Guardrails sit outside the model. A hook checks every tool call and blocks things like a direct push. |
| 12 | 04 budgets and the watchdog | 62.5 – 70.0 | 62.70 – 67.49 | Every lead has a budget breaker, and a watchdog checks the fleet every thirty seconds. |
| 13 | 05 tested | 70.0 – 74.5 | 70.20 – 73.61 | Thirteen hundred sixty-eight tests. Zero runtime dependencies. |
| 14 | 06 seat rotation | 74.5 – 83.0 | 74.70 – 80.48 | Seat rotation is built, but early: when one seat hits its usage limit, soma picks the next. |
| 15 | Outro | 83.0 – 88.5 | 83.20 – 87.47 | Version zero point one, built for supervised use. Read the runbook first. |

Speech times were measured from the final mix with `silencedetect` (-40 dB, 0.25 s). No line runs into the next scene.
No line needed shortening or `atempo`.
