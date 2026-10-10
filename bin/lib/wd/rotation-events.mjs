/**
 * The six orchestrator-stream events account rotation adds — one list, six builders.
 *
 * This repo has no shared list of event types: `bus-tools.REPORT_TYPES` is what a LEAD may
 * file, `URGENT` / `TERMINAL_EVENTS` / `NEEDS_INPUT` are role sets, and the watchdog emits
 * string literals at each `appendEvent` site. So this module is that list for the rotation
 * feature, and the builders are the one place each payload's shape is written down. Every
 * builder returns exactly the `{type, payload, lead}` record `events.appendEvent(ORCH, …)`
 * takes, so an emit site — the watchdog's limits phase and its revert — reads
 *
 *   deps.appendEvent(ORCH, rotated({ lead, from, to, rateLimitType, resetsAt }));
 *
 * and cannot misspell a field, forget one, or smuggle an extra one: unknown fields are
 * dropped, missing or mis-typed ones THROW. They throw rather than return a value because a
 * wrong shape at an emit site is a programming error, and inside `tick` every phase is
 * wrapped so the throw lands as a `WATCHDOG_ERROR` naming the phase — visible, where a
 * silently mis-shaped event is not. Same stance as the watchdog's `reqNum`.
 *
 * Units: every `resetsAt`, `since` and `until` is epoch MILLISECONDS — the unit `limit-state`
 * converts to, `state/seats.json` stores and `state/backpressure.json` stores — and provably
 * so: a value below MIN_EPOCH_MS is refused, because `quotaLimits.resetsAt` arrives in SECONDS
 * and a seconds value that slipped through would be an event every reader renders as 1970.
 *
 * The same TYPE `BACKPRESSURE` is also emitted by the watchdog's storm branch with a payload
 * that is a superset of the spend-cap shape (`+ evidence`). That site DOES use this builder —
 * it calls `backpressure({reason, since, until})` for the contract's three fields and then
 * spreads `evidence` onto the payload the builder returned, because the builder drops unknown
 * fields and would otherwise swallow it (`bin/soma-watchdog.mjs`, the storm branch). So both
 * BACKPRESSURE writers are pinned here; only the extra field is the storm's own.
 * `WATCHDOG_ERROR` is not a rotation event and is not here.
 *
 * Pure; depends on nothing. `backpressure.mjs` depends on this module — it imports and
 * re-exports MIN_EPOCH_MS rather than spelling its own — and the arrow never points back.
 */

/** The six, in the order the design's §3.8 table lists them. */
export const ROTATION_EVENT_TYPES = Object.freeze([
  'SEAT_CLOSED', 'SEAT_REOPENED', 'ROTATED', 'ROTATION_FAILED', 'ROTATION_UNAVAILABLE', 'BACKPRESSURE',
]);

/**
 * The only values `ROTATION_UNAVAILABLE.why` takes.
 *
 * NOT only `rotate()`'s: the watchdog emits this event from TWO sites. `rotate()` says it for a
 * lead it could not MOVE (all three values), and admission says it with `no_open_seat` for a
 * lead it could not LAUNCH — a queued task on a fleet whose every seat is closed or unverified,
 * which has never rotated and has no `from`. Both dedupe through `saidUnavailable`. A reader who
 * takes this list as "reasons a rotation failed" will mis-read every admission-side row.
 */
export const UNAVAILABLE_WHY = Object.freeze(['no_open_seat', 'thrash', 'seats_unreadable']);

/**
 * The floor for every millisecond field. Anything under it is 2001 in ms or the year 33,000
 * in seconds — either way the units bug. Defined ONCE, here: `backpressure.mjs` imports and
 * re-exports it rather than spelling its own, so the bound `writeBackpressure` applies to the
 * record a BACKPRESSURE announces IS this value, and the event and the file cannot disagree.
 */
export const MIN_EPOCH_MS = 1e12;

/** A value for an error message; never throws on its own (a null-prototype object has no toString). */
const show = (v) => {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : String(v);
  } catch {
    return typeof v;
  }
};

const refuse = (type, field, want, got) => new TypeError(`${type}: ${field} must be ${want}, got ${show(got)}`);

const record = (type, args) => {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw refuse(type, 'fields', 'an object', args);
  return args;
};
const str = (type, field, v) => {
  if (typeof v !== 'string' || v === '') throw refuse(type, field, 'a non-empty string', v);
  return v;
};
const strOrNull = (type, field, v) => (v === null ? null : str(type, field, v));
const ms = (type, field, v) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < MIN_EPOCH_MS) {
    throw refuse(type, field, 'an epoch-ms number >= 1e12 (a value in seconds is the units bug)', v);
  }
  return v;
};
const msOrNull = (type, field, v) => (v === null ? null : ms(type, field, v));
const oneOf = (type, field, v, allowed) => {
  if (!allowed.includes(v)) throw refuse(type, field, `one of ${allowed.join(', ')}`, v);
  return v;
};

/** A seat's window or cap closed it. `reason` is the row's `rateLimitType`, or `seat_cap`. The fleet's event: no lead. */
export function seatClosed(args) {
  const T = 'SEAT_CLOSED';
  const a = record(T, args);
  return {
    type: T,
    payload: { seat: str(T, 'seat', a.seat), reason: str(T, 'reason', a.reason), resetsAt: ms(T, 'resetsAt', a.resetsAt) },
    lead: null,
  };
}

/** `seats.reopenExpired` reopened a seat. `seat` is the LABEL (the caller resolves it through config). The fleet's event: no lead. */
export function seatReopened(args) {
  const T = 'SEAT_REOPENED';
  const a = record(T, args);
  return { type: T, payload: { seat: str(T, 'seat', a.seat) }, lead: null };
}

/**
 * A lead was killed and resumed under another seat. `from` may be null: a row spawned before
 * seats existed carries `seat: null` (fleet-row contract), and its first rotation comes from
 * nowhere nameable. `to` is always the seat `pick()` chose, so it is never null.
 */
export function rotated(args) {
  const T = 'ROTATED';
  const a = record(T, args);
  const lead = str(T, 'lead', a.lead);
  return {
    type: T,
    payload: {
      lead,
      from: strOrNull(T, 'from', a.from),
      to: str(T, 'to', a.to),
      rateLimitType: str(T, 'rateLimitType', a.rateLimitType),
      resetsAt: ms(T, 'resetsAt', a.resetsAt),
    },
    lead,
  };
}

/**
 * The tick after a ROTATED found an API error that is not a rate limit, and the lead is being
 * reverted. `from` is the seat that rejected the resume — always a real seat, `pick()` chose
 * it. `to` is the original seat the lead goes back to, and may be null: a row spawned before
 * seats existed is reverted onto the spawner's own environment, which has no label.
 */
export function rotationFailed(args) {
  const T = 'ROTATION_FAILED';
  const a = record(T, args);
  const lead = str(T, 'lead', a.lead);
  return {
    type: T,
    payload: { lead, from: str(T, 'from', a.from), to: strOrNull(T, 'to', a.to), why: str(T, 'why', a.why) },
    lead,
  };
}

/** No rotation was possible; the lead is left to `autoContinueAtUsageLimit`. Emitted once per closure by the caller. */
export function rotationUnavailable(args) {
  const T = 'ROTATION_UNAVAILABLE';
  const a = record(T, args);
  const lead = str(T, 'lead', a.lead);
  return { type: T, payload: { lead, why: oneOf(T, 'why', a.why, UNAVAILABLE_WHY) }, lead };
}

/**
 * The org spend cap: every seat is closed at once, admission is frozen, a human has to act.
 * `until` is null when the cap carries no reset (measured: 9 of 9 real rows).
 *
 * The spend-cap shape only. The storm branch's BACKPRESSURE carries `+ evidence` and is not
 * built here (see the module comment).
 */
export function backpressure(args) {
  const T = 'BACKPRESSURE';
  const a = record(T, args);
  return {
    type: T,
    payload: { reason: str(T, 'reason', a.reason), since: ms(T, 'since', a.since), until: msOrNull(T, 'until', a.until) },
    lead: null,
  };
}
