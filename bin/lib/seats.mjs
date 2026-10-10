/**
 * `soma.json.seats` + `state/seats.json` — the seat pool.
 *
 * A seat is a Claude Code config dir (`CLAUDE_CONFIG_DIR`) with its own `.claude.json`,
 * credential and trust marks — one account — whose `projects/` is a symlink into the fleet's
 * shared transcript tree, so any seat can resume any lead. `soma.json.seats` says which dirs
 * are seats; `state/seats.json` remembers which of them are closed (a usage window hit, or an
 * individual spend cap) and until when. The watchdog's `limits` phase is the writer; `pick` is
 * what admission and `rotate()` ask.
 *
 * Three decisions here are load-bearing, and each is a test in `test/seats.test.mjs`:
 *
 * - **Every mutation runs inside `withFleetLock` and publishes by tmp+rename**, copied from
 *   `lease.mjs`'s `writeLease`. The lock serialises the bus (`soma_status`, doctor) and the
 *   watchdog's read-modify-write of one file; the rename is what lets lock-free readers
 *   (`readSeatState`, and `pick` through it) see a whole old pool or a whole new one. No ENOENT
 *   self-heal in the writer, for `writeLease`'s stated reason: `withFleetLock` already
 *   recreated `state/` on the way in to the lock.
 *
 * - **A closure never shrinks, is never shorter than `MIN_CLOSE_MS` and is never longer than
 *   `MAX_CLOSE_MS`.** `resetsAt` was measured non-monotonic (over the 15 real rows, nine at the
 *   true reset and six spread over three later values, each 4.85-4.98 h ahead of its own
 *   timestamp), and a past or garbage value must not reopen a seat the API just refused: `close`
 *   takes `max(untilMs, now + MIN_CLOSE_MS)` and keeps whichever of that and the existing closure
 *   is longer. The floor lives in `wd/limit-state.mjs` beside the classifier that produces
 *   `resetsAt`, so the floor and the signal cannot drift apart; the ceiling lives here, because
 *   it is a fact about what a seat pool may do and not about what the API said (see
 *   `MAX_CLOSE_MS`).
 *
 * - **An unreadable `state/seats.json` fails closed for the kill and open for the lead.** It
 *   reads as `{ seats: [], unreadable: true }`, `pick` answers `null`, and every mutator returns
 *   without writing — the bytes stay on disk for repair, exactly as `readFleet` leaves a torn
 *   checkpoint. tmp+rename means the only way to get there is an outside edit. The lead keeps
 *   running under `autoContinueAtUsageLimit`; the watchdog says what it could not read with one
 *   `ROTATION_UNAVAILABLE { why: 'seats_unreadable' }`, and emits nothing from in here.
 *
 * Seats named in `soma.json` but absent from the state file are open (`closed_until: 0`) and
 * gain a row on their first `close` or `markUnverified`. `soma.json` is authoritative for the
 * label; the copy in the state file is a courtesy for whoever reads it by hand. Rows for a dir
 * `soma.json` no longer names are kept, never picked.
 *
 * `loggedIn` is a file read, never an API call: `oauthAccount` in `<dir>/.claude.json` is what
 * `claude auth login` writes there (key name and value type observed in two real config dirs —
 * see the fixture note in the test file), and
 * a resume into a dir without it loads the session, appends a fake "Not logged in" turn and
 * exits 1 — the same exit code as not-found (design §1.4).
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { loadConfig } from './config.mjs';
import { withFleetLock } from './fleet.mjs';
import { p } from './paths.mjs';
import { MIN_CLOSE_MS } from './wd/limit-state.mjs';

/** A function, not a constant, for the reason `fleet.lockPath` is one: `p()` reads `$SOMA_HOME` lazily. */
export const seatsPath = () => p('state', 'seats.json');

/**
 * One seat's config dir as an absolute path — the codebase's ONE `~` expander. `loadSeats`
 * goes through it for every soma.json entry (spawn's `seatRoots` reaches it only through
 * `loadSeats`, never directly), `soma init --seat` takes it directly, and `buildLeadEnv` refuses
 * a `~`-prefixed CLAUDE_CONFIG_DIR on purpose: a second expander would let `~/seat-a` in
 * soma.json and `--seat ~/seat-a` name two dirs.
 *
 * `~` and `~/…` expand against `homedir()`, because that is how an operator writes a seat and
 * the shell does not expand inside JSON. Anything else goes through `resolve()`: an absolute
 * value is normalised (`/x//y/../z/` and `/x/z` are one seat), a relative one is resolved
 * against this process's cwd — the policy `claudeConfigRoot` takes for `CLAUDE_CONFIG_DIR`, and
 * for the same reason: the caller that matters is a watchdog tick, which must degrade rather
 * than throw.
 *
 * `''` is refused with the sentence, not resolved. `resolve('')` is the cwd, and — worse — an
 * empty `CLAUDE_CONFIG_DIR` is what `claudeConfigRoot` and `buildLeadEnv` both read as *unset*,
 * so a seat spelled `''` would silently be the operator's default `~/.claude` profile wearing a
 * seat label: rotated onto, closed, and reported as a second account that never existed.
 */
export function resolveConfigDir(dir) {
  if (typeof dir !== 'string' || dir === '') {
    throw new TypeError(
      `seats: config_dir must be a non-empty string, absolute or ~-prefixed, got ${JSON.stringify(dir)} — `
      + 'an empty string is what claudeConfigRoot and buildLeadEnv both read as "unset", so a seat '
      + "spelled '' would silently be the default ~/.claude profile wearing a seat label",
    );
  }
  if (dir === '~') return homedir();
  if (dir.startsWith('~/')) return resolve(join(homedir(), dir.slice(2)));
  return resolve(dir);
}

/** A seat as it reads before any closure: the shape every export hands back. */
const openSeat = (config_dir, label) => ({ config_dir, label, closed_until: 0, closed_reason: null, unverified: false });

/**
 * The configured pool, config dirs resolved, in `soma.json` order — which is the PRIORITY order
 * `pick` uses, and not a tie-break: `pick` takes the first entry here that is open.
 *
 * `cfg.seats` is required rather than defaulted, as `admit` requires `cfg.max_leads`: DEFAULTS
 * always carries it, so a cfg without it is not a config, and `?? []` would turn a caller bug
 * into a fleet that silently never rotates. A missing or empty `label` falls back to the dir's
 * basename — a display name, not a governance value, and a deterministic one.
 */
export function loadSeats(cfg) {
  const raw = cfg?.seats;
  if (!Array.isArray(raw)) {
    throw new TypeError(`seats: cfg.seats must be an array, got ${raw === null ? 'null' : typeof raw}`);
  }
  return raw.map((s, i) => {
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      throw new TypeError(`seats: cfg.seats[${i}] must be an object { config_dir, label }, got ${s === null ? 'null' : Array.isArray(s) ? 'array' : typeof s}`);
    }
    const config_dir = resolveConfigDir(s.config_dir);
    const label = typeof s.label === 'string' && s.label !== '' ? s.label : basename(config_dir);
    return openSeat(config_dir, label);
  });
}

/** The three states a seats.json read can end in. Unreadable carries no seats: see the header. */
const UNREADABLE = () => ({ seats: [], unreadable: true });

/**
 * `state/seats.json`, tolerantly. Lock-free, like `readLease`: `soma_status` and doctor read
 * it on paths where blocking on the fleet lock would be worse than a record one write old, and
 * tmp+rename is what makes that safe.
 *
 * Missing is `{ seats: [] }` — the never-closed pool, and the state a fresh fleet starts in.
 * Anything soma did not write — torn JSON, a non-object, a `seats` that is not an array, a row
 * with no `config_dir`, a `closed_until` that is not a non-negative finite number, an
 * `unverified` that is not a boolean — is `{ seats: [], unreadable: true }`, whole-file: one bad
 * row is an outside edit, and honouring the rows beside it would rotate a lead onto a seat whose
 * closure was in the line that broke. A read error other than ENOENT (EACCES, EISDIR) is
 * unreadable too, not thrown — this runs inside the watchdog tick, and a throw there ends
 * admission for the whole fleet.
 *
 * `closed_until` and `unverified` are guarded the SAME way on purpose: both are governance
 * values, and the RUNBOOK's `seats` row invites an operator to repair this file by hand, so
 * garbage in either is a reachable state. `unverified === true` alone would have normalised
 * `1`, `"yes"`, `"true"`, `"false"`, `{}` and `[]` to `false` — MEASURED — and `pick` would hand
 * the seat back: the permissive reading of the field that says "nobody is logged in" is the
 * unsafe direction. Unreadable is the safe one (`pick` answers `null`, nothing rotates, the
 * bytes stay for repair). Nothing soma writes can trip the guard — MEASURED across `close`,
 * `reopenExpired` and `markUnverified`, every published row carries a boolean, and
 * `markUnverified` already refuses anything else — so this cannot void a file soma wrote.
 *
 * Known fields are normalised so an older row reads with today's shape; unknown fields on a
 * row survive the read-modify-write, for the reason `readFleet` spreads them. `undefined` stays
 * legal for both guarded fields, which is what lets a row written before either existed read
 * with today's shape instead of voiding the pool.
 */
export function readSeatState() {
  let raw;
  try {
    raw = readFileSync(seatsPath(), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { seats: [] };
    return UNREADABLE();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return UNREADABLE();
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.seats)) return UNREADABLE();
  const seats = [];
  for (const r of parsed.seats) {
    if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.config_dir !== 'string' || r.config_dir === '') return UNREADABLE();
    if (r.closed_until !== undefined && !(Number.isFinite(r.closed_until) && r.closed_until >= 0)) return UNREADABLE();
    if (r.unverified !== undefined && typeof r.unverified !== 'boolean') return UNREADABLE();
    seats.push({
      ...r,
      config_dir: r.config_dir,
      label: typeof r.label === 'string' ? r.label : null,
      closed_until: r.closed_until ?? 0,
      closed_reason: typeof r.closed_reason === 'string' ? r.closed_reason : null,
      unverified: r.unverified === true,
    });
  }
  return { seats };
}

/**
 * Publish `state` atomically. Call under `withFleetLock` — `mutateSeats` is the only caller.
 * Byte-for-byte the idiom of `lease.mjs`'s `writeLease`: pid-suffixed scratch so even a caller
 * that skipped the lock cannot interleave into another writer's tmp, then one `rename`, and no
 * ENOENT self-heal because the lock's own creation of `state/fleet.lock` already made the dir.
 */
function writeSeatState(state) {
  const fp = seatsPath();
  const tmp = `${fp}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, fp);
}

/**
 * Read-modify-write the pool under the fleet lock. `fn(seats)` mutates the rows in place and
 * returns whether anything changed; nothing is written when nothing did, so an idempotent
 * second call leaves the file's bytes — and inode — alone.
 *
 * An unreadable file short-circuits: `fn` never runs, nothing is written, and the unreadable
 * state is what the caller gets back. Overwriting it would "repair" the pool by forgetting
 * every closure in it, and then rotate onto a seat that is still closed.
 */
function mutateSeats(fn) {
  return withFleetLock(() => {
    const state = readSeatState();
    if (state.unreadable) return state;
    if (fn(state.seats)) writeSeatState({ seats: state.seats });
    return { seats: state.seats };
  });
}

/**
 * The label `soma.json` gives `config_dir`, or null when it names no such seat (or cannot be
 * read — a corrupt soma.json already ended the tick at its own `loadConfig()`; the label is a
 * courtesy copy and must not be a second place that throws for it).
 */
function labelFor(config_dir) {
  try {
    return loadSeats(loadConfig()).find((s) => s.config_dir === config_dir)?.label ?? null;
  } catch {
    return null;
  }
}

/** The row for `config_dir`, created open if the file has none. Returns `[row, created]`. */
function rowFor(seats, config_dir) {
  const have = seats.find((s) => s.config_dir === config_dir);
  if (have) return [have, false];
  const row = openSeat(config_dir, labelFor(config_dir));
  seats.push(row);
  return [row, true];
}

/** A clock value that is not a finite number would make every `closed_until` comparison false. */
function reqNow(api, nowMs) {
  if (!Number.isFinite(nowMs)) throw new TypeError(`seats.${api}: nowMs must be a finite epoch-ms number, got ${JSON.stringify(nowMs)}`);
  return nowMs;
}

/**
 * The seat to launch on: the FIRST seat in `soma.json` order that is open here — not
 * `unverified`, and `closed_until <= nowMs`. `null` when no seat is open, when no seat is
 * configured, and when the state file is unreadable. Only `rotate()` tells all three apart: it
 * asks `readSeatState().unreadable` before it asks here, so an unreadable pool is
 * `ROTATION_UNAVAILABLE {why:'seats_unreadable'}` — repair the file — rather than a wait for a
 * reset. Admission asks only `seatsConfigured(cfg)` (an unseated fleet launches seat-blind and
 * emits nothing), and has no unreadable check of its own at `soma-watchdog.mjs:1232`, so it
 * reports an unreadable pool and an all-closed one alike as `no_open_seat` — MEASURED, and the
 * arm that holds it is "admission held because no seat is open" in `watchdog.tick.test.mjs`.
 * `wd/rotation-events.mjs` says the same at `UNAVAILABLE_WHY`; the two must not drift.
 *
 * Priority, not fairness, and the operator asked for it by name: their orchestrator shares one
 * seat's account and they watch its usage, so that seat goes LAST in `soma.json` and leads burn
 * the unwatched one first. The accepted trade-off is that priority CONCENTRATES load — the head
 * of the file hits its window sooner and more often than under the least-recently-closed order
 * this replaced. Nothing downstream alternates: `rotate()` flags the seat it was offered
 * `unverified` and re-asks, so it advances by making the head ineligible, never by taking turns.
 *
 * It returns out of the loop rather than sorting what the loop collected, so the order IS the
 * file's and cannot be re-decided after the fact. `loadSeats` is fully evaluated before the first
 * iteration, so a malformed entry after the seat picked is still the TypeError it always was.
 *
 * `closed_until` answers OPEN or CLOSED here and ranks nothing, which retires a distinction the
 * old sort could not state. "Reopened" named two states with opposite positions in it: a seat
 * `reopenExpired` cleared reads `0`, while a seat whose closure merely EXPIRED still carries its
 * real past epoch-ms and so sorted LAST, behind every never-closed seat — MEASURED, in both seat
 * orders, against the comment that sat here and said both were at 0. They are simply open now,
 * each in its own place in the file.
 *
 * An expired closure the `limits` phase has not yet reopened is open here too: the two
 * questions must agree, or admission would refuse a seat the next tick reopens anyway.
 */
export function pick(nowMs, cfg) {
  reqNow('pick', nowMs);
  const state = readSeatState();
  if (state.unreadable) return null;
  const byDir = new Map(state.seats.map((r) => [r.config_dir, r]));
  for (const seat of loadSeats(cfg)) {
    const row = byDir.get(seat.config_dir);
    const view = row
      ? { ...seat, closed_until: row.closed_until, closed_reason: row.closed_reason, unverified: row.unverified }
      : seat;
    if (view.unverified || view.closed_until > nowMs) continue;
    return view;
  }
  return null;
}

/**
 * The plausibility ceiling on a closure: 32 days, the counterpart of `MIN_CLOSE_MS`'s floor.
 *
 * Carried forward from the limit classifier's review. Its units band closes at 1e11 SECONDS (the
 * year 5138), so a row claiming `quotaLimits.resetsAt: 3.25e10` — the year 3000 — is in band and
 * classifies as an ordinary `seat_window` with `resetsAt` 973 years out. Believing it here would
 * be terminal rather than noisy: `close` never shortens a closure and `reopenExpired` only clears
 * expired ones, so that one row retires the seat from the pool until a human edits
 * `state/seats.json`. The two errors are not symmetric — a closure that is too SHORT self-heals,
 * because the next tick reads the same limit row and closes the seat again, while one that is too
 * LONG is permanent — so the ceiling errs short by construction, which is the safe side.
 *
 * 32 days = the longest legitimate closure plus a day. MEASURED against `nextMonthStartMs` over
 * every month of 2026-2030: the longest verdict the classifier can produce is a `seat_cap`, whose
 * `resetsAt` is 00:00Z on the 1st after the hit and so at most 31 days ahead of it (a hit at
 * 00:00:00.000Z on the 1st of a 31-day month); every other verdict is bounded by its own window —
 * `five_hour` 5 h, the `seven_day` family 7 days. The day of headroom covers the skew between the
 * API clock that stamps `resetsAt` and the host clock this function reads as `nowMs`; a host
 * further out than a day has already broken lease staleness and every budget window. Tighter
 * would reopen a seat whose organisation cannot pay for it until the 1st, and the next tick would
 * close it again — a rotation storm against a seat that cannot serve.
 *
 * It bounds what `close` WRITES, not what is already on disk: an existing longer closure is left
 * alone, because `close` never shortens and because only `close` writes this field — a longer
 * value can only be a hand edit, and this module does not repair hand edits (see `readSeatState`).
 */
export const MAX_CLOSE_MS = 32 * 24 * 60 * 60 * 1000;

/**
 * Close `configDir` until `min(max(untilMs, nowMs + MIN_CLOSE_MS), nowMs + MAX_CLOSE_MS)` for
 * `reason`, and return the whole pool as it now reads.
 *
 * Never shortens: an existing closure at or past the effective time is left as it is, reason
 * included, and nothing is written — so a second tick reading the same limit row is a no-op
 * WHENEVER `untilMs` is neither floored nor capped, and a seat closed to the 1st for `seat_cap`
 * is not pulled back to five hours by a later `five_hour` row.
 *
 * A floored or capped closure is the exception, and it is the one the `limits` phase meets most:
 * its effective time is measured from `nowMs` and not from the row, so it RE-ARMS on every tick
 * and is a real change every tick. MEASURED, four 30 s ticks passing the same `untilMs`: an
 * ordinary `NOW + 3 h` rewrote nothing after the first close; `NOW - 1000` (floored) and
 * `3.25e13` (capped) each rewrote on all three later ticks, `closed_until` sliding 30 s forward
 * every time. Two things follow, and the tests named `a floored closure re-arms…` /
 * `a capped closure re-arms…` pin them: the pool is re-published under the fleet lock on every
 * tick a seat is parked on a stale or absurd row, so a "once per real change" event must dedupe
 * on the closure's time rather than on "the pool changed"; and — WHILE TICKS ARE CLOSER TOGETHER
 * THAN `MIN_CLOSE_MS` — such a seat does not reopen while that row keeps arriving, because the
 * floor re-arms ahead of `nowMs` before `reopenExpired` can clear it: the intent (the API refused
 * this seat as recently as this tick), not a leak.
 *
 * That precondition is load-bearing and its boundary is exact. MEASURED, one floored seat with
 * `reopenExpired` called at the next tick BEFORE that tick's `close`: a gap of 30_000 ms reopens
 * nothing, 299_999 ms reopens nothing, 300_000 ms REOPENS, 600_000 ms REOPENS. The boundary is
 * `MIN_CLOSE_MS` itself, because the floor lands exactly `MIN_CLOSE_MS` ahead of the `nowMs` that
 * armed it and `reopenExpired` clears at `closed_until <= nowMs`. `DEFAULTS.tick_ms` is 30 s — a
 * 10x margin, so the clause holds for the shipped fleet — but `tick_ms` is operator-settable and
 * a stalled or restarted watchdog passes five minutes easily. Past the boundary the seat reopens.
 * That alone is not a rotation hazard — `pick` counts an expired closure as open anyway (see
 * `pick`), so it hands the seat back at the same instant whether or not `reopenExpired` cleared
 * it first, MEASURED — but the clear IS a write and a `SEAT_REOPENED` for a seat the API refused
 * as recently as the row still arriving, so the limits phase must dedupe on the closure's time too.
 *
 * A non-finite `untilMs` closes for exactly the floor rather than writing a
 * `NaN` that `JSON.stringify` would persist as `null` and the next read would refuse as
 * unreadable — the one way this module could corrupt its own file. An absurd `untilMs` closes
 * for exactly the ceiling: see `MAX_CLOSE_MS` for why a believed-but-absurd `resetsAt` is the
 * one input that would otherwise retire a seat for good.
 */
export function close(configDir, untilMs, reason, nowMs = Date.now()) {
  const dir = resolveConfigDir(configDir);
  reqNow('close', nowMs);
  const until = Math.min(Math.max(Number.isFinite(untilMs) ? untilMs : 0, nowMs + MIN_CLOSE_MS), nowMs + MAX_CLOSE_MS);
  const closed_reason = typeof reason === 'string' && reason !== '' ? reason : null;
  return mutateSeats((seats) => {
    const [row, created] = rowFor(seats, dir);
    if (row.closed_until >= until) return created;
    row.closed_until = until;
    row.closed_reason = closed_reason;
    return true;
  });
}

/**
 * Open every seat whose closure has passed and return exactly those, as they now read
 * (`closed_until: 0`, `closed_reason: null`). Idempotent: a second call at the same clock
 * returns `[]` and writes nothing. `unverified` is untouched — it says "not logged in", which
 * no clock clears.
 *
 * `[]` is a two-state answer over a three-state world: it is "nothing expired" AND "the pool
 * could not be read" — an unreadable file reopens nothing and writes nothing, by `mutateSeats`'s
 * design, and says so nowhere in this return. A caller that must tell the two apart reads
 * `readSeatState()` beside this call, whose `unreadable` flag is the third state; the `limits`
 * phase already has it in its deps for exactly that reason.
 */
export function reopenExpired(nowMs = Date.now()) {
  reqNow('reopenExpired', nowMs);
  const reopened = [];
  mutateSeats((seats) => {
    for (const row of seats) {
      if (row.closed_until > 0 && row.closed_until <= nowMs) {
        row.closed_until = 0;
        row.closed_reason = null;
        reopened.push({ ...row });
      }
    }
    return reopened.length > 0;
  });
  return reopened;
}

/**
 * Flag (`true`) or clear (`false`) `unverified` on `configDir`, creating the row if the file
 * has none. Refused rather than coerced for anything else: `markUnverified(dir, undefined)` —
 * a caller that read a field which was not there — would silently CLEAR the flag and put a
 * seat nobody is logged in to back into rotation.
 */
export function markUnverified(configDir, flag) {
  if (flag !== true && flag !== false) {
    throw new TypeError(`seats.markUnverified: flag must be true or false, got ${flag === null ? 'null' : typeof flag}`);
  }
  const dir = resolveConfigDir(configDir);
  return mutateSeats((seats) => {
    const [row, created] = rowFor(seats, dir);
    if (row.unverified === flag) return created;
    row.unverified = flag;
    return true;
  });
}

/**
 * Is anyone logged in to this seat? `true` when `<configDir>/.claude.json` carries an
 * `oauthAccount` object (the mark `claude auth login` leaves — observed by key name and value
 * type in two real config dirs, see the test file's fixture note), `false` when the file parses
 * to an object without one (or with a null one, or an ARRAY), and `null` — could not observe —
 * when the dir or file is absent, unreadable, or not a JSON object. The three answers stay
 * three: doctor renders `null` as `unobserved`, and `rotate()` treats anything but `true` as a
 * seat to skip.
 *
 * The array clause is not pedantry. `typeof [] === 'object'`, so without it `"oauthAccount": []`
 * — which no login writes, only a hand edit or a half-written file can — would read as the
 * POSITIVE verdict, and `rotate()` skips anything but `true`: garbage would say "this seat is
 * usable". The unobservable cases keep answering `null`, never `false`, so the direction that
 * loses the third state is still closed.
 */
export function loggedIn(configDir) {
  const dir = resolveConfigDir(configDir);
  let raw;
  try {
    raw = readFileSync(join(dir, '.claude.json'), 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed.oauthAccount !== null && typeof parsed.oauthAccount === 'object' && !Array.isArray(parsed.oauthAccount);
}
