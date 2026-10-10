/**
 * Revival policy for a lead whose tmux session is gone: `resume` | `fresh` | `giveup`.
 *
 * Pure: a task row, a usage reading and the config in, one word out. The tick captures
 * the death scene, performs the respawn and stamps `attempts`; this only decides which
 * of the three it is, and it decides the same way every time for the same inputs.
 *
 * - **`giveup` after 3 attempts.** Design §10: resume-first, 3 attempts, then one
 *   GAVE_UP event and a toast. An unbounded revival loop on a lead that dies during
 *   startup is a quota leak that looks like progress, so the cap outranks everything
 *   else — a saturated *and* exhausted lead is `giveup`, not `fresh`.
 *
 * - **`fresh` over `resume` once the context is saturated.** `--resume` replays a
 *   session's own history into its context window; past `resumeContextLimit(cfg)` (700k of
 *   a ~1M window) the resumed lead spends its remaining budget re-reading itself and then
 *   dies of the same saturation. A fresh session re-planning from the stored brief is
 *   cheaper and actually finishes. Teams do not survive either path (the prompt
 *   re-establishes them), so the choice is purely about context.
 *
 * **The judged field is `usage.live_context` — current context — and NOT `est_tokens`.**
 * They are different quantities and the difference is not subtle: measured on the
 * operator's own transcript, the same reading carried `est_tokens: 120,527,067` against
 * `live_context: 601,285`. A **200x ratio**. `est_tokens` is cumulative spend over every
 * turn; a lead re-reads its context each turn, so the cumulative figure crosses any
 * context-sized threshold almost immediately and then never comes back. Judging a resume
 * on it made "resume first" (design §10) dead policy for anything but a very early death.
 * The inversion is worst exactly where resuming is cheapest: Claude Code auto-compacts at
 * the window — measured over eight real events it fires at a prompt of median 993,955 and
 * lands at 79,946, **7-9% of peak, on all eight** — so a lead a hundred turns deep sits
 * near 80k of live context with millions cumulative, and is the *best* resume candidate in
 * the fleet. The old comparison refused precisely that lead. `est_tokens` still governs
 * spend, in `wd/budget.mjs`, and the two must never be substituted for one another.
 *
 * **The limit is not computed here.** `resumeContextLimit(cfg)` derives it from
 * `resume_context_fraction` x `resume_context_window`, and that function is the single
 * place that knows the number. There is deliberately no fallback to the removed
 * `resume_token_guard` and no local default: the old key was *removed* rather than
 * redefined, because `config.mjs`'s own header warns that a silent RENAME disarms
 * whichever governor read the old name — and a stale `resume_token_guard: 200000` read as
 * a context limit would reproduce this exact bug while looking configured. A missing key
 * stays a missing key, and `resumeContextLimit` answers for it with the shipped fraction.
 *
 * The guards below both exist because the *silent* failure is the expensive one:
 *
 * - **A non-positive derived limit is refused.** `resumeContextLimit` tolerates a negative
 *   `resume_context_fraction`/`resume_context_window` and passes the sign through, and
 *   `live >= -700000` is true for every lead: resume-first deleted, fleet-wide, by a typo
 *   that still reads like configuration. Refused by name rather than re-derived here.
 * - `task.attempts` is *absent* on a row that has never been revived, which is a real
 *   state and reads as 0. Present-but-unreadable is a different thing — a hand-edited
 *   or half-written checkpoint — and reading `"many"` as 0 would revive that lead
 *   forever. Absent is tolerated; garbage is refused.
 *
 * **`usage.zero_tail_rows` is read and deliberately does not move the verdict.** It counts
 * trailing assistant rows with no usage reading, which is what a session that died on an
 * API or auth error leaves behind (6 of 209 real sessions; two of them masking real context
 * of 113,229 and 125,993, which `live_context` already sees past by skipping the zero tail).
 * So it is a genuine died-abnormally signal — but it bears on neither of this function's two
 * axes. It is not evidence about the *cost* of resuming, and repeat failure is already
 * handled: three attempts and the lead is given up. Branching on it would mean either
 * discarding the context of a lead that died for an external, operator-fixable reason (the
 * expensive direction, and the same inversion this change undoes) or abandoning it early.
 * That is a design decision (§10 fixes the policy at attempts + saturation), not one to
 * inherit from a field arriving in the reading — so the verdict's indifference to it is
 * pinned by test, and the tick is where it belongs: as the annotation on the revival event
 * that tells an operator this lead died mid-call rather than finishing.
 *
 * `usage` is *evidence*, not governance — and like `wd/budget.mjs`, its two failure
 * shapes are different cases with different handling. **No reading at all** (`null`,
 * a lead that died before its transcript existed) means nothing was measured, counts as
 * 0, and lands on resume-first: the documented default when there is no evidence of
 * saturation. **A reading that lost `live_context`** is a contract violation and is refused
 * by name — `readUsage` reports the field on every path, so a 0 invented here would
 * resume a context nobody measured. Garbage in the field is refused for the same reason.
 *
 * The rule, now that there are **two legitimate numbers** on one reading: each field owns
 * its own question and neither is ever re-derived. `est_tokens` owns the *weighting* (it
 * includes `cache_creation_input_tokens` at 1.0) and answers "what has this lead spent" —
 * `wd/budget.mjs` reads it and this module does not. `live_context` owns the *prompt* (its
 * three fields partition one API call, trailing all-zero rows skipped) and answers "how
 * full is this lead's context right now" — this module reads it and the breaker does not.
 * Re-deriving either from `raw` would drift from tokens.mjs; substituting one for the other
 * is the 200x error above, which is worse, because it still looks like a working guard.
 */
import { resumeContextLimit } from '../tokens.mjs';

/** Design §10: resume-first, three attempts, then GAVE_UP. */
const MAX_ATTEMPTS = 3;

/**
 * @param {{attempts?: number}} task the fleet row for the dead lead — `attempts` is
 *   genuinely optional: absent means never revived, which reads as 0
 * @param {{live_context: number, zero_tail_rows?: number}|null} usage `readUsage()` for its
 *   session — `live_context` is required when `usage` is an object; `null` for "no session
 *   to read". A `readDirUsage()` aggregate is NOT a valid argument: it has no
 *   `live_context`, deliberately, and is refused by name.
 * @param {{resume_context_fraction?: number, resume_context_window?: number}} cfg merged
 *   config — read only through `resumeContextLimit`, never key by key
 * @returns {'giveup'|'fresh'|'resume'}
 */
export function planRevival(task, usage, cfg) {
  const limit = resumeContextLimit(cfg);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new TypeError(
      `planRevival: resumeContextLimit(cfg) returned ${show(limit)} — a non-positive context limit makes EVERY revival 'fresh' and silently deletes resume-first policy (check resume_context_fraction / resume_context_window)`,
    );
  }
  const attempts = task?.attempts == null ? 0 : reqNum('planRevival: task.attempts', task.attempts);
  const live = measuredContext(usage);

  if (attempts >= MAX_ATTEMPTS) return 'giveup';
  if (live >= limit) return 'fresh';
  return 'resume';
}

/**
 * `live_context` off a `readUsage()` reading — the lead's CURRENT context, not its spend.
 *
 * `usage == null` means there was no session to read (a lead that died before its
 * transcript existed) and counts as 0, which lands on resume-first — the documented
 * default when there is no evidence of saturation. A usage *object* without the field is
 * a contract violation: `readUsage` reports `live_context` on every path, including every
 * failure path (missing session, bad name, empty file, garbage — all `live_context: 0`), so
 * the only way here is a hand-rolled reading. Inventing a 0 would resume a context nobody
 * measured, which is the one outcome this guard exists to prevent.
 *
 * One caller mistake this refusal catches by design: `readDirUsage()` reports `est_tokens`
 * for a whole directory but **deletes** `live_context`, because a directory of transcripts
 * has no single live context. Handed to a per-session revival decision, that aggregate used
 * to read as a perfectly good spend number — now it is named. Read with `Object.hasOwn`, so
 * a forged reading cannot inherit a 0 from a prototype either.
 */
function measuredContext(usage) {
  if (usage == null) return 0;
  if (typeof usage !== 'object') {
    throw new TypeError(`planRevival: usage must be a readUsage() object or null, got ${show(usage)}`);
  }
  if (!Object.hasOwn(usage, 'live_context')) {
    throw new TypeError(
      'planRevival: usage.live_context is missing — readUsage() always reports it, so this reading is not one (a readDirUsage() aggregate has no live_context, deliberately: a directory has no single live context)',
    );
  }
  return reqNum('planRevival: usage.live_context', usage.live_context);
}

/**
 * A required non-negative finite number, tolerating the one string worth keeping.
 *
 * Same rule as `fleet.admit`'s `max_leads` read: a hand-edited `"200000"` in soma.json
 * is fine, but nothing is coerced — `Number(null)`, `Number('')` and `Number([])` are
 * all 0, and a 0 invented here disables the very thing it was supposed to measure.
 */
function reqNum(what, raw) {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    throw new TypeError(`${what} must be a non-negative finite number, got ${show(raw)}`);
  }
  return n;
}

/**
 * A value for an error message: quoted if a string, named by type if not.
 *
 * Not `JSON.stringify`, which throws on a BigInt and on a hostile `toJSON` — an error
 * path that fails while explaining itself is the worst possible time to be clever.
 */
const show = (v) =>
  typeof v === 'string' ? JSON.stringify(v) : v !== null && typeof v === 'object' ? (Array.isArray(v) ? 'array' : 'object') : String(v);
