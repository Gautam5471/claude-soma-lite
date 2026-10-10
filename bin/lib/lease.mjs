/**
 * `state/orch.lease` — the orchestrator lease.
 *
 * Requirement 4 is that *any* Claude Code session can be promoted to orchestrator,
 * including adopting a fleet that is already running. This file is what makes that
 * safe: one record naming the session that owns the fleet, the tmux socket and pane
 * it lives in, how it wants to be woken, and a monotonic `lease_seq`. Two
 * `/soma:promote`s racing each other resolve to one holder and one loser holding the
 * winner's details — never two orchestrators each believing they own the queue.
 *
 * The lock is what does the deciding. `lease_seq` is not a lock-free CAS token: every
 * mutation here runs inside `withFleetLock`, and it is the read-check-write *inside*
 * that critical section which makes the check-and-set atomic. The seq is the receipt —
 * it lets a displaced holder (and the DEMOTED notice the bus send-keys to it) tell
 * "the lease I adopted is still mine" from "someone stole it while I was thinking".
 * Consumers comparing generations must compare `session_id` too: the seq counts
 * generations within one lineage, and `releaseLease` ends the lineage (see there).
 *
 * Reads are deliberately lock-free. `wake()`, the UserPromptSubmit inject hook and
 * `soma status` all call `readLease()` on paths where blocking on the fleet lock would
 * be worse than reading a record one write out of date; tmp+rename is what makes that
 * safe, since a reader sees the whole old record or the whole new one.
 *
 * Nothing here touches tmux. Pane existence is the ground truth for "is that
 * orchestrator still there", but it arrives as the injected `hasPane` predicate of
 * `leaseStale`, so this module stays a side-effect-free unit its callers can test and
 * a hook can import without shelling out.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { p } from './paths.mjs';
import { withFleetLock } from './fleet.mjs';

const leasePath = () => p('state', 'orch.lease');

/** A holder that has not stamped its liveness in this long is presumed gone. */
const STALE_MS = 10 * 60 * 1000;

/**
 * The current lease, or null when the fleet has no orchestrator.
 *
 * Anything that is not a lease record reads as null: absent file, torn JSON, a
 * hand-edited `{}`, a bare `"x"`. That tolerance is the opposite of `readFleet`'s
 * deliberate loudness, and for the opposite reason — fleet.json *is* the fleet and a
 * damaged one must be repaired, while the lease is derived state any session can
 * re-establish with one `soma_adopt`. Throwing here would wedge promotion
 * permanently: `acquireLease` reads before it writes, so a single unparseable byte
 * would stop even `force: true` from taking the fleet back.
 *
 * `session_id` has to be a non-empty string because every other operation keys on it.
 * A record without one is a lease nobody can release, heartbeat, or be refused
 * against — better read as "no holder" and overwritten than honored.
 */
export function readLease() {
  let raw;
  try {
    raw = readFileSync(leasePath(), 'utf8');
  } catch (e) {
    // ENOENT is the released state as well as the never-adopted one. Anything else
    // (EACCES, EIO) is an environment fault, not a torn record, and is reported.
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  let lease;
  try {
    lease = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!lease || typeof lease !== 'object' || typeof lease.session_id !== 'string' || lease.session_id === '') {
    return null;
  }
  return lease;
}

/**
 * Publish `lease` atomically. Call under `withFleetLock`: the rename buys a *reader* a
 * whole record, but only the lock stops two writers' read-modify-write cycles from
 * clobbering each other.
 *
 * No ENOENT self-heal here, unlike `fleet.mjs` and `events.mjs`. Every writer arrives
 * through `withFleetLock`, whose own creation of `state/fleet.lock` already self-heals
 * the directory on the way in — so a missing `state/` at this point is a genuine
 * anomaly worth surfacing rather than a third copy of that helper.
 */
function writeLease(lease) {
  const fp = leasePath();
  // pid-suffixed like `writeFleet`/`writeCursor`, so even a caller that skipped the
  // lock cannot interleave into another writer's scratch file.
  const tmp = `${fp}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(lease, null, 2) + '\n');
  renameSync(tmp, fp);
}

/**
 * Claim the fleet for `claim.session_id`.
 *
 * Grants when the lease is absent (or unreadable — see `readLease`), refuses when a
 * record is there and `force` is not set, and on a grant bumps `lease_seq` past
 * whatever the previous record held. A refusal returns the holder, so `soma_adopt` can
 * tell the caller whom to ask — or steal from — instead of just "no".
 *
 * "Grant freely when the recorded pane no longer exists" is deliberately *not* decided
 * here: that needs tmux. The bus composes it out of the two exports —
 * `force: force || leaseStale(readLease(), hasPane)` — which keeps the one side effect
 * on the caller's side of the line and this function pure enough to test.
 */
export function acquireLease(claim, { force = false } = {}) {
  const session_id = claim?.session_id;
  // Validated before the lock, not after: a claim with no session id would write a
  // lease that `readLease` cannot see (JSON.stringify drops `undefined`), which reads
  // as "no holder" to everyone including the session that just adopted — the fleet
  // would look free to the next promoter while the bus behaved as though it were held.
  if (typeof session_id !== 'string' || session_id === '') {
    throw new TypeError(`acquireLease: claim.session_id must be a non-empty string, got ${JSON.stringify(session_id)}`);
  }
  return withFleetLock(() => {
    const cur = readLease();
    if (cur && !force) return { ok: false, holder: cur };

    // Only a pane the record actually carries can be sent keys or compared against a
    // hook's $TMUX_PANE, so a `tmux` claim without one is written as what it really is
    // rather than as a wake path that silently goes nowhere. `degraded` then tells the
    // truth and the operator gets the notify-only warning instead of silence.
    const tmux_pane = claim.tmux_pane || null;
    const wake = claim.wake === 'tmux' && tmux_pane ? 'tmux' : 'notify';

    // A seq that is not a whole number is not a seq: `'3' + 1` is `'31'`, and a NaN
    // makes every later comparison false. Anything unusable restarts the count.
    const prev = Number.isInteger(cur?.lease_seq) && cur.lease_seq >= 0 ? cur.lease_seq : 0;
    const lease_seq = prev + 1;

    // Written field by field rather than `{...claim}`: the record's shape is a contract
    // (bus, watchdog, inject hook and doctor all read it), `undefined` fields would be
    // dropped by JSON.stringify and change that shape across a reload, and a claim
    // cannot smuggle in its own `lease_seq` or `heartbeat_at`.
    writeLease({
      session_id,
      tmux_socket: claim.tmux_socket || null,
      tmux_pane,
      wake,
      lease_seq,
      heartbeat_at: Date.now(),
    });

    // `stolen_from` closes the DEMOTED race. The bus has to send-keys a demotion notice
    // to the pane it just displaced, and reading the old holder *before* calling this
    // would be a read outside the lock — by the time the steal lands, that answer can
    // already be another session's.
    return { ok: true, degraded: wake !== 'tmux', lease_seq, stolen_from: cur ?? null };
  });
}

/**
 * Give up the lease — only if `session_id` is the one holding it.
 *
 * `{released: false}` covers both "there is no lease" and "you are not the holder",
 * which is what a session that was force-stolen from must hear when it later calls
 * `soma_release`: a demoted session may not unmount the orchestrator that replaced it.
 *
 * Removing the file rather than marking it released keeps "free" a single state —
 * `readLease() === null` — for every reader, at the cost of forgetting the seq: the
 * next adopter starts from 1 again. Safe because a stale holder is identified by
 * `session_id`, and a fleet with no orchestrator has no lease lineage for a seq to
 * count generations of.
 */
export function releaseLease(session_id) {
  return withFleetLock(() => {
    const cur = readLease();
    if (!cur || cur.session_id !== session_id) return { released: false };
    rmSync(leasePath(), { force: true });
    return { released: true };
  });
}

/**
 * Stamp the holder's liveness. Silently does nothing when `session_id` is not the
 * holder: the callers are hooks and tool handlers on a session that may have been
 * demoted since it last looked, and throwing there costs a turn for no gain.
 *
 * This is the *orchestrator's* liveness, not a lead's — `heartbeats/<lead>` touch files
 * are a separate mechanism on a separate (20 min) budget. It is what keeps a
 * `wake: 'notify'` holder, which has no pane for `leaseStale` to probe, distinguishable
 * from a crashed one.
 *
 * Rewrites the record it read, so fields a newer soma added survive an older soma's
 * heartbeat instead of being silently dropped.
 */
export function heartbeat(session_id, { pane } = {}) {
  withFleetLock(() => {
    const cur = readLease();
    if (!cur || cur.session_id !== session_id) return;
    cur.heartbeat_at = Date.now();
    /**
     * **The pane is repaired here, because nothing else ever noticed it had gone stale.**
     *
     * MEASURED on a real fleet: the operator resumed the SAME claude session id into a NEW
     * tmux pane (`claude --resume <id>` in a fresh `tmux new-session`). The session id is what
     * the lease is keyed on, so it still matched, the heartbeat kept stamping, and the record
     * read perfectly healthy — `wake: 'tmux'`, a fresh beat, seq intact — while `tmux_pane`
     * still named the pane that died with the previous incarnation. Every push then went to
     * `%41` on a server where `%41` no longer existed, `wake()` hands its `sendKeys` to
     * `fireAndForget`, and so the failure was silent for hours. The `notify` transport fires
     * unconditionally, which is why the operator saw toasts and nothing in the pane.
     *
     * A pane id is per-server and per-incarnation; a session id survives a resume. Those two
     * facts together are the whole defect, and this is the only place that learns the truth
     * often enough to fix it: the holder's own bus reads its pane from its environment, so a
     * heartbeat is the cheapest correct moment to compare them.
     *
     * Narrow on purpose. Only a `wake: 'tmux'` record is touched: a `notify` holder has no
     * pane BY DESIGN (`leaseStale` depends on that distinction), and turning one into a tmux
     * holder is a change of transport, not a repair — `soma_adopt` owns that, and says so.
     * And only the holder reaches this line at all, because of the session_id guard above.
     */
    if (cur.wake === 'tmux' && typeof pane === 'string' && pane !== '' && cur.tmux_pane !== pane) {
      cur.tmux_pane = pane;
    }
    writeLease(cur);
  });
}

/**
 * Is this lease dead — free for the next session to take?
 *
 * Pure, and tmux-free: `hasPane` is injected so the caller owns the side effect, and
 * this stays a predicate a test or a hook can evaluate without shelling out.
 *
 * Pane existence is ground truth *when the record has a pane*. A holder promoted
 * outside tmux legitimately has none (`wake: 'notify'`); probing a pane it never had
 * would make every such orchestrator read as stale the instant it adopted, and the
 * fleet stealable out from under a working session. For those the heartbeat is the only
 * evidence there is, which is the reason `heartbeat()` exists.
 *
 * A record with no usable `heartbeat_at` is stale: unstamped means hand-written or
 * abandoned, and both are better treated as gone than as immortal. A stamp in the
 * future (an NTP step back) reads as fresh — the lenient direction, and the pane check
 * still governs the tmux case.
 */
export function leaseStale(lease, hasPane) {
  if (!lease || typeof lease !== 'object') return true; // no orchestrator at all is the stalest lease of the lot
  if (typeof hasPane !== 'function') {
    throw new TypeError('leaseStale: hasPane must be a (pane) => boolean predicate');
  }
  if (lease.tmux_pane && !hasPane(lease.tmux_pane)) return true;
  const beat = lease.heartbeat_at;
  return !Number.isFinite(beat) || Date.now() - beat > STALE_MS;
}
