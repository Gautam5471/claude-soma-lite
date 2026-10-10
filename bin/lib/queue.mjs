/**
 * The queue-pause switch — `soma_queue pause` in one file, both halves.
 *
 * `bus-tools.mjs` already had the round trip and nothing behind it: `soma_queue pause|resume`
 * calls `deps.setQueuePaused(...)` and `soma_status` reads it back through
 * `deps.queuePaused()` to render `queue_paused`. Neither dep was wired anywhere, and the one
 * consumer whose behaviour is supposed to change — the watchdog's admission branch — did not
 * read it at all. So an operator paused the queue, `soma_status` faithfully reported
 * `queue_paused: true`, and admission kept spawning. A flag that is *written* and *displayed*
 * and never *obeyed* is worse than no flag, because the status output actively confirms the
 * operator's false belief.
 *
 * **Both halves live here, and that is the point of the module rather than a convenience.**
 * The alternative — a reader in `soma-watchdog.mjs` and a writer in `soma-bus.mjs` — is two
 * spellings of one path in two processes, which is the same class of fault `paths.SOMA_HOME`
 * refuses a relative root over: nothing errors, both processes are right by their own lights,
 * and the switch simply does not connect. One module, one `queuePausedPath()`, no second
 * spelling.
 *
 * **Presence is the whole protocol**, copied deliberately from `wd/budget.mjs`'s
 * `BUDGET_TRIPPED`: the file exists or it does not, and its contents are a debugging courtesy.
 * That is what lets `queuePaused()` answer a *strict boolean*, which in turn is what makes the
 * two consumers' `=== true` comparisons safe. Had this returned the file's contents, a switch
 * whose body read `"false"` would render `queue_paused: false` in status while freezing the
 * tick — the original defect inverted, and harder to see.
 *
 * **A non-boolean write is refused, never coerced.** The dangerous direction is
 * `setQueuePaused(undefined)` — a caller that read a field which was not there — silently
 * *resuming* a queue an operator paused during a rate-limit incident. Coercion is what makes
 * that silent, so there is none.
 *
 * The file survives a restart on purpose: a paused queue must stay paused across `soma down`
 * and back up, or the pause is a property of one watchdog process rather than of the fleet.
 * It lives under the state root, so it moves with `$SOMA_HOME` like everything else.
 *
 * Known and accepted, for the same reason `BUDGET_TRIPPED` accepts it: an unreadable state
 * directory makes `existsSync` answer false, so the queue reads open. `soma doctor` is where a
 * broken state root is diagnosed; a reader that threw would end the watchdog's tick instead.
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { p } from './paths.mjs';

/**
 * The switch file: `<SOMA_HOME>/state/QUEUE_PAUSED`.
 *
 * A function, not a constant, for the reason `fleet.lockPath` is one: `p()` reads
 * `$SOMA_HOME` lazily and the tests retarget the state root between calls.
 */
export const queuePausedPath = () => p('state', 'QUEUE_PAUSED');

/**
 * Is admission paused? A strict boolean — see the module header on why the type matters.
 *
 * Never throws: it is called from the watchdog's 30 s tick and from `soma_status`.
 */
export const queuePaused = () => existsSync(queuePausedPath());

/**
 * Pause (`true`) or resume (`false`) admission. Returns the resulting state.
 *
 * Idempotent in both directions, because both are things an operator does twice: `soma_queue
 * resume` on an already-open queue is not an error, and a second `pause` must not become a
 * throw that `bus-tools` reports as "the queue switch could not be written".
 */
export function setQueuePaused(paused) {
  if (paused !== true && paused !== false) {
    throw new TypeError(
      `setQueuePaused: paused must be true or false, got ${paused === null ? 'null' : typeof paused}`
      + ' — anything else would have to be coerced, and a coerced falsy value silently RESUMES'
      + ' a queue an operator paused',
    );
  }
  const fp = queuePausedPath();
  if (!paused) {
    try {
      unlinkSync(fp);
    } catch (e) {
      // Already open is the state we were asked for. Anything else is a real fault.
      if (e.code !== 'ENOENT') throw e;
    }
    return false;
  }
  // The same one-mkdir self-heal `events.mjs` and `fleet.mjs` use: a state root that has not
  // been `ensureTree()`d yet — or was wiped from under a running fleet — costs one mkdir, not
  // a refusal to pause. The body is a courtesy for whoever finds the file.
  const body = `paused by soma at ${new Date().toISOString()} (pid ${process.pid})\n`;
  try {
    writeFileSync(fp, body);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, body);
  }
  return true;
}
