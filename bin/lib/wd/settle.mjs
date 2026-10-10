/**
 * Fleet settlement: `'drained'`, `'settled'`, or nothing yet.
 *
 * The two verdicts are different claims about the same fleet (design §10):
 *
 * - **drained** — every task reached a terminal state. The work is finished; the digest
 *   can be final. No quiet window is needed, because there is nothing left to speak.
 * - **settled** — every task is terminal *or* blocked, and nothing has happened for
 *   `settle_minutes` (30). This is the "7 done, 1 failed, 2 need you" fleet: it will
 *   never drain on its own, because two leads are waiting on a human. Without this
 *   verdict it sits silent forever, which is precisely the failure the spec calls out.
 *
 * Judgement calls, all of them in the conservative direction — a fleet reported finished
 * over a lead that is still running is not recoverable by a later tick:
 *
 * - **An empty fleet has not drained.** `[].every()` is true, so the naive reading fires
 *   FLEET_DRAINED on the first tick after `soma up` and digests a fleet that never had
 *   work in it. Never started is not finished.
 * - **A status this soma does not know is neither terminal nor rested.** `fleet.json` is
 *   hand-editable, a newer soma may add states, and `queued`/`spawned` are live by
 *   definition. Membership is tested against a `Set`, never an object indexed by status:
 *   `TERMINAL[t.status]` would report `constructor`, `toString`, `valueOf`,
 *   `hasOwnProperty` and `__proto__` as terminal and declare a live fleet drained. This
 *   build has already shipped one truthiness-indexed registry with that flaw.
 * - **`settle_minutes` must be present.** A renamed key makes `now - last >= NaN` false
 *   forever: no FLEET_SETTLED, no digest, no toast, and nothing anywhere says why.
 *   Refused loudly instead, and eagerly — before any branch can return first.
 *
 * - **`now` and `lastEventTs` are validated eagerly too, and that is not free.** A
 *   `drained` verdict needs neither, so an unreadable `lastEventTs` suppresses a verdict
 *   that did not depend on it: no FLEET_DRAINED, no final digest, and a WATCHDOG_ERROR
 *   every 30 s in their place. Kept deliberately, for two reasons. The pair is the
 *   watchdog's clock — the same numbers the wall-clock cap and the 90 s stagger are
 *   judged against — so a tick holding an unreadable timestamp has more wrong with it
 *   than one verdict, and the first tick is the cheapest place to say so. And moving the
 *   check inside the `settled` branch would hide it until the fleet rests, which is the
 *   moment the verdict finally matters, while making the same inputs answer either a word
 *   or a throw depending on unrelated task statuses. What makes the trade cost nothing in
 *   practice is on the caller: a tick with no events yet must pass a real number (the
 *   fleet's start), never `null` for "nothing to read".
 *
 * Pure: a snapshot, two timestamps and the config in, one word out. No clock of its own.
 */

/** Reached an end state. `blocked` is not here — a human can still unblock it. */
const TERMINAL = new Set(['done', 'failed', 'skipped']);

/** Not going to move without help: terminal, or waiting on a human. */
const RESTED = new Set([...TERMINAL, 'blocked']);

/**
 * @param {{tasks: Array<{status: string}>}} fleet snapshot
 * @param {number} lastEventTs epoch ms of the newest event in any stream
 * @param {number} now epoch ms — a parameter, never `Date.now()`
 * @param {{settle_minutes: number}} cfg merged config
 * @returns {'drained'|'settled'|null}
 */
export function settlement(fleet, lastEventTs, now, cfg) {
  const tasks = fleet?.tasks;
  if (!Array.isArray(tasks)) {
    throw new TypeError(`settlement: fleet.tasks must be an array, got ${tasks === null ? 'null' : typeof tasks}`);
  }
  const quietMs = reqNum('settlement: cfg.settle_minutes', cfg?.settle_minutes) * 60 * 1000;
  const quietFor = reqNum('settlement: now', now) - reqNum('settlement: lastEventTs', lastEventTs);

  if (tasks.length === 0) return null;
  if (tasks.every((t) => TERMINAL.has(t?.status))) return 'drained';
  if (!tasks.every((t) => RESTED.has(t?.status))) return null;
  // `quietFor` can be negative under clock skew, which reads as "something just
  // happened" and holds — the honest answer when the two clocks disagree.
  return quietFor >= quietMs ? 'settled' : null;
}

/**
 * A required non-negative finite number, tolerating the one string worth keeping.
 *
 * Same rule as `fleet.admit`'s `max_leads` read: a hand-edited `"30"` in soma.json is
 * fine, but nothing is coerced — `Number(null)`, `Number('')` and `Number([])` are all
 * 0, and a 0 invented for `settle_minutes` would report every resting fleet instantly.
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
