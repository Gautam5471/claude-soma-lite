/**
 * The seat pool as ONE record for `soma status` and `soma_status` — the single place that
 * merges `soma.json`'s `seats` with `state/seats.json`, so the CLI and the bus cannot disagree
 * about which seat is open (rule 3 of `bin/soma.mjs`: one spelling).
 *
 * Three states, never two. `unreadable: true` when either file could not be read, and then
 * NOTHING is claimed open — "every seat open" is a claim about the pool, and an unreadable
 * state file is not evidence for it. Otherwise each configured seat lands in one bucket, in
 * config order within the bucket:
 *
 *   unverified — `unverified === true` in state (not logged in; only `claude auth login` under
 *                that CLAUDE_CONFIG_DIR fixes it). Wins over a closure, because it is the one a
 *                human must act on.
 *   closed     — `closed_until > nowMs`, carrying `closed_until` (epoch ms) and `closed_reason`.
 *   open       — everything else: no state row yet (`seats.mjs` treats those as open too), an
 *                expired closure `reopenExpired` has not swept yet, `closed_until === nowMs`.
 *
 * Labels come from `loadSeats` (soma.json's, defaulting to the dir's basename), never from the
 * state row, whose `label` is a courtesy copy that can be `null`. A state row for a seat no
 * longer in `soma.json` is ignored: nothing can pick it. Rows carry `config_dir` because the
 * CLI prints the login command for an unverified seat; `bus-tools` strips it, because a path
 * must not reach the model.
 */
import { loadConfig } from './config.mjs';
import { loadSeats, readSeatState } from './seats.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A reset time the way the pane spells it (`resets 4:30pm`): local time, `h:mmam|pm`.
 *
 * More than 24 h from `nowMs` — IN EITHER DIRECTION — the day is added, and the year too when it
 * is not this one: a weekly window resets on a Thursday and a spend cap on the 1st, and a bare
 * `12:00am` would read as tonight. The same argument is why the year is there. `seats.close`
 * clamps at `MAX_CLOSE_MS`, so soma cannot write a stamp that needs one, but `readSeatState`
 * accepts any finite `closed_until >= 0` and the RUNBOOK invites hand edits of that file:
 * without the year, `Date.UTC(3000, 0, 1, 12, 0)` rendered `Jan 1 12:00pm` in UTC,
 * indistinguishable from a closure four months out. A stamp in the PAST beyond a day gets its
 * date for the mirror-image reason — `summariseSeats` only ever buckets future closures, but this
 * formatter is exported and a bare time for a stamp two days gone reads as tonight.
 *
 * `?` for a non-finite stamp, never `Invalid Date`. A non-finite `nowMs` falls back to the wall
 * clock rather than making every stamp look far away: "I do not know when now is" is not a
 * measurement of how far off the reset is. Local time because that is what the operator's pane
 * shows; the timezone is the process's (`TZ`), which is what lets the tests pin it.
 */
export function clock(ms, nowMs = Date.now()) {
  if (!Number.isFinite(ms)) return '?';
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const d = new Date(ms);
  const h = d.getHours();
  const hm = `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
  if (Math.abs(ms - now) < DAY_MS) return hm;
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year} ${hm}`;
}

/** The empty pool. A fresh object per call, so a caller that mutates one cannot poison the next. */
const empty = () => ({ configured: 0, open: [], closed: [], unverified: [], unreadable: false, why: null });

/**
 * Classify `seats` (from `loadSeats(cfg)`) against `state` (from `readSeatState()`) at `nowMs`.
 * Pure. See the module header for the buckets.
 */
export function summariseSeats(seats, state, nowMs = Date.now()) {
  const cfg = Array.isArray(seats) ? seats : [];
  const out = empty();
  out.configured = cfg.length;
  if (!state || typeof state !== 'object' || state.unreadable === true || !Array.isArray(state.seats)) {
    out.unreadable = true;
    out.why = 'state/seats.json could not be read';
    return out;
  }
  const byDir = new Map();
  for (const row of state.seats) {
    if (row && typeof row === 'object' && typeof row.config_dir === 'string') byDir.set(row.config_dir, row);
  }
  for (const s of cfg) {
    const row = byDir.get(s.config_dir);
    const seat = { label: s.label, config_dir: s.config_dir };
    if (row?.unverified === true) out.unverified.push(seat);
    else if (Number.isFinite(row?.closed_until) && row.closed_until > nowMs) {
      out.closed.push({ ...seat, closed_until: row.closed_until, closed_reason: typeof row.closed_reason === 'string' ? row.closed_reason : null });
    } else out.open.push(seat);
  }
  return out;
}

/**
 * The pool as it stands on disk: `soma.json` through `loadConfig` + `loadSeats`, the runtime
 * state through `readSeatState`. Never throws — a config that will not load is the same third
 * state as a state file that will not parse, with the loader's own sentence as `why` and
 * `configured: null` because the count itself is unknown.
 */
export function seatsSummary(nowMs = Date.now()) {
  let seats;
  let state;
  try {
    seats = loadSeats(loadConfig());
    state = readSeatState();
  } catch (e) {
    return { ...empty(), configured: null, unreadable: true, why: (typeof e?.message === 'string' && e.message !== '') ? e.message : String(e) };
  }
  return summariseSeats(seats, state, nowMs);
}
