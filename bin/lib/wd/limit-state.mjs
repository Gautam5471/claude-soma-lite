/**
 * Limit classifier: what a lead's transcript tail says about the seat it is running on.
 *
 * A usage-limit hit is not a dialog and not a pane state. Claude Code ends the turn with a
 * synthetic assistant row — `isApiErrorMessage: true`, `error: 'rate_limit'` — and, from
 * 2.1.238, a machine-readable `quotaLimits` object copied from the response headers. The
 * pane returns to an ordinary idle composer, the Stop hook does not fire and the heartbeat
 * stops with the tools, so this row is the one reliable signal (it was there on every
 * rate-limit hit measured). This module reads it and nothing else. Pure: rows in, one verdict
 * out, no clock of its own except the optional `nowMs` a seat cap falls back to for its boundary.
 *
 * Rules, each pinned by a test:
 *
 * - **The LAST assistant row decides.** A `rate_limit` row followed by a healthy assistant
 *   row is `none`: the lead already resumed (Claude Code's own auto-continue, or a human),
 *   and killing it now would land mid-turn. User and system rows in between do not count —
 *   a teammate's death report arrives as a user row, and it is not a recovery.
 *
 * - **Seconds become milliseconds HERE and only here.** `quotaLimits.resetsAt` is epoch
 *   seconds; `closed_until` in `state/seats.json` and every `Date.now()` comparison are
 *   milliseconds. Every verdict's `resetsAt` is milliseconds. Because this is the one site that
 *   knows the units, it is also the one site that can refuse a `resetsAt` that arrives ALREADY in
 *   milliseconds (`MAX_RESET_SECONDS` below) — multiplied a second time it outlives the fleet and
 *   no downstream guard can tell, because a doubly-converted value is still `>= 1e12`.
 *
 * - **A finite window reset outranks the spend-cap reason it arrives with.** A `quotaLimits`
 *   row can carry both a window type (`rateLimitType: 'five_hour'`) and a cap reason
 *   (`overageDisabledReason: 'org_spend_cap_reached'`), and a fully observed cycle of that
 *   shape resumed 85 s after the five_hour reset — the seat reopened at the window, not
 *   on the 1st. The cap reasons decide only when no usable window reset exists: a seat's
 *   own cap (`org_spend_cap_reached`) closes that seat until the next 1st 00:00Z; the org's
 *   cap (`org_level_disabled_until`) is the fleet-wide freeze. A seat cap's boundary is the
 *   1st after the row's own `timestamp` (falling back to `nowMs`). The reason is read from
 *   `overageDisabledReason` (where the transcripts carry it) or from `rateLimitType` (the
 *   shape the interface contract names), whichever holds it.
 *
 * - **Fail closed for the kill, open for the lead.** Anything this module cannot read is
 *   `unobservable` with a `why` that names the fault, never `none` (which would report a
 *   parked lead healthy) and never a guess at a window (which would kill it). That covers:
 *   no rows, no assistant row, a `rate_limit` row with no `quotaLimits` (builds ≤ 2.1.227
 *   wrote none), a non-finite `resetsAt`, a `resetsAt` too large to be seconds (already
 *   milliseconds), a `rateLimitType` this build has never seen, and
 *   a torn or unparseable entry NEWER than the last assistant row — the reader
 *   (`tokens.readTailRows`) passes `null` for a line it could not parse; an older torn line
 *   is history, a newer one may be the healthy row that would make the answer `none`.
 *
 * - **Not gated on corroboration.** `apiErrorStatus === 429` and `message.model ===
 *   '<synthetic>'` held on every row observed, but the predicate design §3.2 names is
 *   `isApiErrorMessage && error === 'rate_limit'`; gating on the others would turn an
 *   unobserved drift into `none`, the wrong direction. `quotaLimits.status` is likewise not
 *   required: a rejection row IS the rejection.
 */

/** The `anthropic-ratelimit-unified-representative-claim` values Claude Code 2.1.272 knows. */
export const SEAT_WINDOW_TYPES = new Set([
  'five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included', 'overage',
]);

/** A closure is never shorter than this; `seats.close` applies it. */
export const MIN_CLOSE_MS = 5 * 60 * 1000;

/** `overageDisabledReason` values that name a spend cap (the binary's `Mnt` set). */
const CAP_REASONS = new Set(['org_spend_cap_reached', 'org_level_disabled_until']);

/**
 * The top of the epoch-SECONDS band, and so the units gate on `quotaLimits.resetsAt`.
 *
 * 1e11 seconds is the year 5138; 1e11 milliseconds is 1973-03-03. The bands do not overlap anywhere
 * a real value can live, so a `resetsAt` at or above this is either already in MILLISECONDS (any
 * instant since 1973) or a seconds instant three thousand years out — never a window a fleet waits
 * for. A seconds value such as 1440433800 sits at 1.4% of it: two orders of magnitude of headroom.
 *
 * The ceiling is needed because the error is silent in that direction only. Converting a
 * millisecond value again yields `1440433800000 * 1000` = +047615-07-13, which still satisfies the
 * `>= 1e12` epoch-ms bound every downstream guard enforces (the rotation-event builders,
 * `writeBackpressure`), so `seats.close` would write it as `closed_until` and `reopenExpired` would
 * never reopen that seat. A too-SMALL `resetsAt` needs no gate here: it converts to a verdict below
 * 1e12, and those same guards reject it loudly.
 */
const MAX_RESET_SECONDS = 1e11;

/**
 * 00:00:00Z on the 1st of the month AFTER the one `nowMs` falls in — the monthly spend cap's
 * boundary (an observed `overageResetsAt` was exactly this value for its month).
 *
 * `Date.UTC(y, m + 1, 1)` rather than `setMonth`: Jan 31 + one month overflows to Mar 3.
 * @param {number} nowMs epoch ms — a parameter, never `Date.now()`
 * @returns {number} epoch ms
 */
export function nextMonthStartMs(nowMs) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    throw new TypeError(`nextMonthStartMs: nowMs must be a finite number, got ${show(nowMs)}`);
  }
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}

/** A value for a message: quoted if a string, named by type if not — never `JSON.stringify` on a hostile value. */
const show = (v) =>
  typeof v === 'string' ? JSON.stringify(v) : v !== null && typeof v === 'object' ? (Array.isArray(v) ? 'array' : 'object') : String(v);

/**
 * @typedef {{kind: 'seat_window', rateLimitType: string, resetsAt: number}
 *         | {kind: 'seat_cap', rateLimitType: 'org_spend_cap_reached', resetsAt: number}
 *         | {kind: 'spend_cap', rateLimitType: 'org_level_disabled_until'}
 *         | {kind: 'none'}
 *         | {kind: 'unobservable', why: string}} LimitVerdict
 */

/**
 * @param {unknown} rows parsed transcript rows, oldest first (the tail of the lead's .jsonl);
 *   `null` for a line that did not parse
 * @param {{nowMs?: number}} [opts] the clock a seat cap's boundary falls back to when the row has no
 *   parseable `timestamp`; defaults to now
 * @returns {LimitVerdict}
 */
export function classifyLimit(rows, { nowMs = Date.now() } = {}) {
  if (!Array.isArray(rows)) return unobservable(`rows is not an array (${show(rows)})`);
  if (rows.length === 0) return unobservable('no rows: the transcript tail is empty');

  let lastIdx = -1;
  for (let i = 0; i < rows.length; i++) if (isObject(rows[i]) && rows[i].type === 'assistant') lastIdx = i;
  if (lastIdx === -1) return unobservable(`no assistant row among ${rows.length} rows`);
  for (let i = lastIdx + 1; i < rows.length; i++) {
    if (!isObject(rows[i])) {
      return unobservable(`row ${i} after the last assistant row is not an object (${show(rows[i])}); a torn or unparseable line hides the newest state`);
    }
  }

  const last = rows[lastIdx];
  if (last.isApiErrorMessage !== true || last.error !== 'rate_limit') return { kind: 'none' };

  const q = last.quotaLimits;
  if (!isObject(q)) {
    return unobservable(`rate_limit row carries no quotaLimits (${show(q)}); Claude Code before 2.1.238 did not write it`);
  }
  const type = q.rateLimitType;
  const secs = q.resetsAt;
  const secsUsable = typeof secs === 'number' && Number.isFinite(secs) && secs < MAX_RESET_SECONDS;
  if (SEAT_WINDOW_TYPES.has(type) && secsUsable) {
    return { kind: 'seat_window', rateLimitType: type, resetsAt: secs * 1000 };   // the one seconds→ms site
  }
  const reason = CAP_REASONS.has(type) ? type : CAP_REASONS.has(q.overageDisabledReason) ? q.overageDisabledReason : null;
  if (reason === 'org_spend_cap_reached') {
    // The cap resets on the 1st after the HIT, so the row's own clock is the right one when it has one;
    // a tick that first reads a last-month row after the boundary must not close the seat a month too long.
    const at = typeof last.timestamp === 'string' ? Date.parse(last.timestamp) : NaN;
    return { kind: 'seat_cap', rateLimitType: 'org_spend_cap_reached', resetsAt: nextMonthStartMs(Number.isFinite(at) ? at : nowMs) };
  }
  if (reason === 'org_level_disabled_until') return { kind: 'spend_cap', rateLimitType: 'org_level_disabled_until' };
  if (SEAT_WINDOW_TYPES.has(type)) {
    if (typeof secs === 'number' && Number.isFinite(secs)) {
      return unobservable(`quotaLimits.resetsAt ${show(secs)} on a ${type} row is too large to be epoch seconds (>= ${MAX_RESET_SECONDS}, the year 5138); it is already epoch MILLISECONDS, and converting it again would close the seat for millennia`);
    }
    return unobservable(`quotaLimits.resetsAt is not a finite number (${show(secs)}) on a ${type} row`);
  }
  return unobservable(`quotaLimits.rateLimitType ${show(type)} is not a known limit and no spend-cap reason is present`);
}

const unobservable = (why) => ({ kind: 'unobservable', why });

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
