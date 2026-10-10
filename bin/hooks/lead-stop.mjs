#!/usr/bin/env node
/**
 * `lead-stop.mjs` — the Stop hook: "this lead just finished a turn".
 *
 * It stamps `heartbeats/<lead>` and nothing else.
 *
 * **Why not an event** (decided: heartbeat only, honoring spec §7's "exactly one writer
 * per stream"): the obvious version of this hook appends a `TURN_END` event to
 * `events/<lead>.ndjson`. That stream already has a writer — the lead's own bus
 * process — and `events.mjs` mints ids from a per-process counter (`${ts}-${seq}`).
 * Two processes appending to one stream mint the *same* id whenever they land in the
 * same millisecond, and a consumer that has parked its cursor on one of them silently
 * skips the other: not a crash, not a warning, just an event that never existed. The
 * lock-free append is only safe because each stream has exactly one writer, so a
 * second writer is a design change, not an implementation detail. If a distinct
 * turn-end *event* is ever needed it belongs in its own stream
 * (`events/<lead>.hook.ndjson`, added to `eventStreams()`) — never the lead's primary one.
 *
 * A heartbeat loses nothing by comparison. The watchdog already keys liveness and
 * stall episodes off this file's mtime (the PostToolUse hook is a bare shell `touch`
 * of the same path), and "the lead replied" is precisely the liveness claim a Stop
 * hook is in a position to make. A lead that talks without calling a tool for twenty
 * minutes — a long planning turn, a lead waiting on teammates — is exactly the lead
 * the PostToolUse touch cannot vouch for and this one can.
 *
 * Never exits non-zero, and never writes to stdout: exit 2 on Stop *blocks the lead
 * from finishing its turn* and feeds stderr back to it as a correction, which is a
 * loop a stuck lead cannot leave. stdin is not read at all, exactly like the shell
 * `touch` hook it sits beside, so there is no pipe to wait on and nothing to hang.
 */
import { closeSync, mkdirSync, openSync, realpathSync, utimesSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { p } from '../lib/paths.mjs';

/**
 * A lead id, and therefore a path segment: `heartbeats/<id>`.
 *
 * Mirrors `fleet.mjs`'s (unexported) `ID_RE`. `orch` is excluded for the same reason
 * `bus-tools.mjs` reserves it: the orchestrator is not a lead, has no heartbeat file,
 * and a session that thinks it is both would stamp liveness for a lead that does not
 * exist.
 */
const LEAD_RE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * `touch(1)`: create if absent, move the mtime forward if not.
 *
 * `utimesSync` on its own fails when the file is absent; opening for append on its
 * own creates the file but does *not* move the mtime of one that already exists — so
 * the second turn of a live lead would stamp nothing and the watchdog would start
 * counting stall strikes against a lead that is working. Both calls are needed.
 *
 * Append rather than truncate: the content is nothing and the mtime is the whole
 * signal, so there is no reason to give a concurrent PostToolUse `touch` a window in
 * which the file is being rewritten.
 *
 * The ENOENT retry is the house self-heal (`events.mjs`, `fleet.mjs`): a state root
 * that has not been `ensureTree()`d yet, or was wiped from under a running fleet,
 * costs one `mkdir` rather than every turn from here on.
 */
function touch(fp) {
  const now = new Date();
  const stamp = () => {
    closeSync(openSync(fp, 'a'));
    utimesSync(fp, now, now);
  };
  try {
    stamp();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    mkdirSync(dirname(fp), { recursive: true });
    stamp();
  }
}

/**
 * Stamp this lead's heartbeat; returns the path stamped, or null if the environment
 * does not describe a lead.
 *
 * Inert rather than loud when `SOMA_LEAD_NAME` is missing or unusable: this hook can
 * be loaded by a session that is not a lead (a hand-edited settings file, a canary,
 * an operator running it by hand), and the honest answer there is to touch nothing.
 *
 * `env` supplies the *identity* only. The state root deliberately still comes from
 * `paths.mjs`, which reads `process.env.SOMA_HOME` lazily on every call: one module
 * knows where soma's state lives, and a hook that resolved its own root could stamp a
 * heartbeat in a directory nothing else reads.
 */
export function beat(env = process.env) {
  const id = env?.SOMA_LEAD_NAME;
  if (typeof id !== 'string' || !LEAD_RE.test(id) || id === 'orch') return null;
  const fp = p('heartbeats', id);
  touch(fp);
  return fp;
}

/** Is this file the process entry point? `realpath` first, so a symlinked or relative argv still matches. */
function isMain(url) {
  try {
    return typeof process.argv[1] === 'string' && url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

// Guarded, so importing `beat` for a test does not stamp a heartbeat as a side effect
// of the import — a hook whose module body has effects is a hook nobody can call twice.
if (isMain(import.meta.url)) {
  try {
    beat(process.env);
  } catch {
    // A stamp that could not be written is a liveness signal the watchdog will miss,
    // which costs a nudge at worst. Reporting it would cost the lead its turn.
  }
  process.exitCode = 0;
}
