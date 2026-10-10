/**
 * Trust pre-marking — the one write that keeps a detached `claude` from hanging forever.
 *
 * A freshly created worktree is a directory claude has never seen, so its first act there
 * is the interactive "Do you trust the files in this folder?" dialog. No human is attached
 * to a tmux-detached lead, so the answer never comes and the session sits on that prompt
 * until the watchdog gives up on it. `settings.json` has no say in trust — only `.claude.json`
 * does — so the spawner pre-marks the cwd here, between `git worktree add` and
 * `tmux new-session`.
 *
 * *Which* `.claude.json` is not a detail: `CLAUDE_CONFIG_DIR` moves it, that variable is set
 * on the machine v1 ships to, and marking the wrong one of two files that both exist fails
 * silently into the exact hang above. `configPath` is where that is worked out, and it is the
 * first thing to check if a lead ever meets the dialog anyway.
 *
 * The file is not ours. It is the operator's live claude config: MCP server definitions
 * (`settings-gen` reads them straight back out), account state, and per-project history,
 * `0600` for good reason. Every rule below follows from that:
 *
 * - Read-modify-write, never a fresh document. Unknown top-level keys and sibling project
 *   entries survive verbatim, because a key we do not understand is still load-bearing.
 * - The read-modify-write runs under a lock — `<config>.lock`, hard-linked into place so it
 *   can never be seen half-made, and unlinked by nobody who has not first proved the file is
 *   the one they judged (see the lock section) — and the rename is not the end of it:
 *   re-read, confirm our own entry survived, and redo the whole cycle if it did not.
 * - tmp+rename, so a claude reading the file concurrently sees all of the old bytes or all
 *   of the new ones and never half of either. The pid in the scratch name is the house
 *   idiom (`writeConfig`, `writeFleet`): it keeps two soma processes out of one scratch file.
 * - The scratch file is created with O_EXCL and `fchmod`ed to `0600` on the descriptor we
 *   hold, so a complete copy of the operator's credentials can neither be routed elsewhere
 *   by a symlink planted at that predictable name nor be briefly group-readable.
 * - A config we cannot parse or recognise is a hard error, never a fresh `{}`. Clobbering
 *   the operator's real config to make one spawn succeed is the worst trade in this repo.
 * - Already-trusted is a no-op. Rewriting a 180 KB config to change nothing only widens the
 *   window in which claude's own concurrent write loses the edit.
 */
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import { createFileLock } from './filelock.mjs';

/** Mode of every file this module creates: both scratches, the config, the lock. */
const MODE = 0o600;

/** Mode of the config dir if we have to create it — claude makes its own `0700`. */
const DIR_MODE = 0o700;

/**
 * The `.claude.json` claude will actually read, absolute.
 *
 * Hard-coding `$HOME/.claude.json` is not a cosmetic bug, it is the whole failure this module
 * exists to prevent, wearing a disguise: `CLAUDE_CONFIG_DIR` is **set on the machine v1 ships
 * to**, both files exist there, so a trust mark written to the wrong one throws nothing, logs
 * nothing, and leaves every spawned lead sitting on an unanswerable dialog in a detached pane.
 *
 * The location is not one shape, and that is the part to read twice. By default the file sits
 * at `$HOME/.claude.json`, *beside* the config dir (`$HOME/.claude`); under `CLAUDE_CONFIG_DIR`
 * it sits *inside* it. So the join base is the config root when the env names one and `$HOME`
 * when it does not — which is all `env.CLAUDE_CONFIG_DIR || home` says, and why this is not
 * written in terms of a config-*root* helper.
 *
 * **This is the local, temporary copy of that rule, and here is the canonical one it answers
 * to** — `paths.claudeConfigRoot(env)`, which a planned consolidation collapses this onto:
 *
 *     resolve(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))
 *
 * It is quoted rather than duplicated in code because pretrust needs the *file*, not the
 * directory, and nothing here would call a root helper — an unused copy would be dead code
 * inviting the wrong collapse. `settings-gen` carries the other temporary copy (as a
 * two-candidate read, the right shape for a reader). **For that consolidation: deleting this
 * block is not enough — `paths.mjs` needs a `claudeConfigFile(home, env)` beside the root
 * helper, because `join(claudeConfigRoot(env), '.claude.json')` retargets the default case to
 * `$HOME/.claude/.claude.json`, a path that exists on no machine checked, and reintroduces
 * exactly the silent hang this line fixes.**
 *
 * `||` rather than `??` is load-bearing, exactly as in `paths.SOMA_HOME`: an env var forwarded
 * as `''` — which is how `soma up` passes "unset" — has to fall back to `$HOME` instead of
 * resolving against the cwd.
 *
 * `resolve()` is for a related but *different* reason, and the two now DIVERGE deliberately —
 * do not "unify" them. A relative `$CLAUDE_CONFIG_DIR` would make the file we mark depend on
 * the cwd of whoever called us, and a spawner's cwd is not the lead's. Here that is RESOLVED
 * rather than refused, because a spawn step must degrade rather than throw. `paths.SOMA_HOME`
 * takes the opposite policy and REFUSES a relative value outright, because a forked state root
 * splits ten paths at once — including the fleet checkpoint and its lock, so mutual exclusion
 * simply stops existing — and every one of those paths comes out absolute and plausible, so
 * nothing errors. Different blast radius, different answer. Both are correct for their file.
 *
 * Verified behaviourally against claude 2.1.220 on 2026-07-30, not inferred. A run under
 * `CLAUDE_CONFIG_DIR=<tmp>` created `<tmp>/.claude.json` and read-modify-wrote it, preserving a
 * `projects[cwd].hasTrustDialogAccepted` seeded there (both `true` and `false` survived, so it
 * is read, not merely tolerated), while `~/.claude.json` stayed byte-for-byte untouched. And
 * end to end, in the shape the spawner uses: an interactive claude in a *detached tmux pane*,
 * in a directory it had never seen, stopped on "Quick safety check: … 1. Yes, I trust this
 * folder / 2. No, exit" with nobody there to answer — and booted straight to its prompt once
 * this module had marked the cwd in the file resolved here.
 */
const configPath = (home, env) => resolve(join(env.CLAUDE_CONFIG_DIR || home, '.claude.json'));

/**
 * How many read-modify-rename rounds to spend getting our entry to stick.
 *
 * The lock orders us against another soma process, and our confirming read happens while we
 * still hold it, so no writer that respects the lock can have renamed a stale document over
 * ours by the time we look. Every round past the first is therefore for the one writer no
 * lock of ours can order — claude, which rewrites this file on its own schedule and takes
 * nothing. Each round re-reads, so a retry re-applies over whatever claude left.
 *
 * Be honest about its reach: measured against a rewriter that never stops, retrying changes
 * nothing, because the window reopens the moment we return. It is insurance for the one-shot
 * clobber that lands between our rename and our confirming read, and it costs one extra read.
 */
const ATTEMPTS = 5;

/** Lock budget for the whole call, not per attempt: a spawn step must not stall for a minute. */
const LOCK_TIMEOUT_MS = 5000;
/** Gap between acquisition attempts. Holds are one read plus one write, so this is generous. */
const LOCK_RETRY_MS = 10;
/**
 * Age at which a lock is reclaimable whatever its pid says.
 *
 * Liveness alone is not enough, because pids get recycled and this lock lives in claude's own
 * config dir with nothing on the machine cleaning it up. A holder that was SIGKILLed leaves
 * its lock behind; when that pid is later handed to some unrelated long-lived process — trivially
 * likely across a reboot — the lock reads "held by a live process" forever and every future
 * spawn refuses. Measured on the code this replaces: a lock naming pid 1 made `preTrust`
 * throw 3 times out of 3 and stayed exactly where it was.
 *
 * 60 s is twelve times the whole acquire budget and some three orders of magnitude longer
 * than a real hold (one read plus one rename of a ~200 KB file), so no live holder can still
 * be inside a lock this old unless it has been stopped outright — and a spawner SIGSTOP'd
 * for a minute has already lost its lead to the watchdog. A clock jumped forward by more
 * than a minute mid-hold is the one way this misjudges a living holder; the alternative,
 * never reclaiming at all, misjudges every spawn from then on.
 */
const LOCK_STALE_MS = 60_000;

/**
 * The config mutex — `<config>.lock`, beside the file it guards.
 *
 * - **`lockFile` is derived from the key, which is the lock path itself.** The config's
 *   location is a function of `home` and `env`, both per call, so there is nothing to capture
 *   at module scope; the caller resolves the file and hands it over.
 * - **`mode` is `0600`, and `dirMode` `0700`.** Every file this module creates lands in a
 *   directory holding OAuth tokens, and the lock is a hard link of the scratch, so tightening
 *   the scratch on the descriptor is what tightens the lock. `dirMode` matters for the same
 *   reason: if the config dir is wiped mid-call the self-heal must not recreate it
 *   world-readable.
 * - **`staleMs`, which none of the other two locks sets.** See `LOCK_STALE_MS`.
 * - **Not `reentrant`.** Nothing here nests.
 * - **The hard-link diagnosis names claude's config dir, not `SOMA_HOME`.** This lock is the
 *   one that is not under the state root, so "move SOMA_HOME off this volume" would send an
 *   operator to change a setting that has no bearing on where this file lives.
 */
const lock = createFileLock({
  api: 'preTrust',
  label: 'preTrust',
  lockFile: (lp) => lp,
  hardLinks: {
    requirement: (lp) => `${dirname(lp)} — the directory holding claude's config — must be on a filesystem that supports hard links`,
    remedy: 'set CLAUDE_CONFIG_DIR to a directory on a volume that does (this lock lives beside claude\'s config, not in soma\'s state root)',
  },
  timeoutMs: LOCK_TIMEOUT_MS,
  retryMs: LOCK_RETRY_MS,
  staleMs: LOCK_STALE_MS,
  mode: MODE,
  dirMode: DIR_MODE,
});

/** A JSON object — the only shape we will merge into. Arrays and `null` are not it. */
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Best-effort type name for error messages: `array`, `null`, `string`, … */
const kindOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

/**
 * Mark `cwd` as trusted in the `.claude.json` that `env` resolves to, atomically and durably.
 * Returns the path it marked.
 *
 * Idempotent, and safe to call on a config that already has hundreds of projects in it:
 * only `hasTrustDialogAccepted` is added, and only when it is not already `true`. Throws on
 * a config that is unparseable, shaped in a way this code would have to guess at, or that a
 * concurrent writer keeps stealing the entry back out of. A missing config is created.
 *
 * **`env` must be the environment the lead will run under, not necessarily ours.** It decides
 * which file gets marked (see `configPath`), and the two can differ silently: the spawner
 * starts a lead with `env -i` plus an allow-list, so `CLAUDE_CONFIG_DIR` reaches the lead only
 * if it is on that list. Pass the env you are about to hand `tmux new-session`
 * (`preTrust(cwd, home, leadEnv)`) and the mark lands where that lead will look for it; leave
 * it defaulted and we mark where *we* would look, which is right only while the two agree.
 * The returned path is there to be asserted on and logged for exactly that reason.
 *
 * `env` rather than a config-root string, to match the signature of the canonical
 * `paths.claudeConfigRoot(env)` this collapses onto, so a caller has one thing to get right
 * instead of two.
 */
export function preTrust(cwd, home = homedir(), env = process.env) {
  // A relative or empty cwd would write an entry claude never looks up, i.e. it would
  // report success and still leave the spawn hanging on the dialog. Fail loudly instead.
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new TypeError(`preTrust: cwd must be an absolute path, got ${JSON.stringify(cwd)}`);
  }

  const fp = configPath(home, env);
  const keys = trustKeys(cwd);

  // `CLAUDE_CONFIG_DIR` can name a root claude has not created yet — a fresh machine, or one
  // the operator has just pointed somewhere new — and both the config and our lock live inside
  // it. One idempotent mkdir, `0700` like the one claude makes itself, so that first spawn
  // works rather than failing on the scratch open. `$HOME` in the default case: a no-op.
  mkdirSync(dirname(fp), { recursive: true, mode: DIR_MODE });

  // An unlocked read-modify-write is a lost update waiting to happen: a manual `soma_spawn`
  // racing the watchdog's admission tick (or the canary racing a real spawn) both read the
  // same config, and the second rename drops the first's entry. That lead then meets the
  // trust dialog, hangs detached and dies — the exact failure this module exists to prevent,
  // with preTrust having returned success.
  //
  // A confirming re-read after the rename is NOT enough on its own, and measuring it is the
  // only honest way to see why: five racers all passed their confirmation and one still lost
  // its entry, because a writer holding a stale base can rename after we confirmed. Ordering
  // is the fix, so the cycle runs under a lock, and confirm-and-retry is layered on top for
  // the one writer no lock of ours can order — claude, which rewrites this file on its own
  // schedule.
  //
  // The lock is the house idiom, and now literally the same code (`filelock.mjs`, shared with
  // `withFleetLock` and `withRepoLock`): `<config>.lock` holding the owner's pid, hard-linked
  // into place from a scratch named freshly for every *attempt* — per-pid was the shape this
  // module shipped with, and it was a hole, because a name that outlives one attempt is one a
  // second acquirer can find and link — so its name and its bytes appear in the same instant,
  // and it is never unlinked by anyone who has not first proved the file is the one they
  // judged. A crashed holder's lock is taken over rather than waited on,
  // so `soma down` killing a pane mid-spawn cannot wedge the fleet, and so is one left by a
  // pid that has since been recycled (see `LOCK_STALE_MS`). A live holder makes us throw
  // after LOCK_TIMEOUT_MS, which is the right end for a spawn step: loud, and retried by the
  // watchdog, rather than a lead hanging in the dark.
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (withConfigLock(fp, deadline, () => applyTrust(fp, keys))) return fp;
  }

  throw new Error(
    `preTrust: a concurrent writer keeps dropping ${keys.map((k) => `projects[${k}]`).join(' / ')}` +
      ` from ${fp} (${ATTEMPTS} attempts); refusing to call a cwd trusted when it is not`,
  );
}

/**
 * One read-modify-write cycle. True when the cwd is trusted on disk afterwards.
 *
 * Call under `withConfigLock`. Returns false only when something outside the lock overwrote
 * the rename between publishing and confirming it, which is the caller's cue to try again.
 */
function applyTrust(fp, keys) {
  const j = readDoc(fp);
  const projects = projectsOf(j, fp);
  // Nothing to change: an already-trusted cwd must not cost the operator's config a rewrite.
  if (isTrusted(projects, keys, fp)) return true;

  j.projects = projects;
  // Spread, so every other field of the entry (allowedTools, history, its own mcpServers)
  // rides along; an existing `false` flag is flipped in place rather than moved to the end.
  for (const k of keys) j.projects[k] = { ...entryOf(projects, k, fp), hasTrustDialogAccepted: true };
  // 2-space, no trailing newline — byte-for-byte the format claude writes itself, so our
  // edit does not show up as a whole-file rewrite in the operator's next diff or backup.
  writeAtomic(fp, JSON.stringify(j, null, 2));

  // Confirm rather than assume. Re-reading proves the entry is on disk, and a claude that had
  // read the old document and renamed its own version over ours shows up here as false.
  return isTrusted(projectsOf(readDoc(fp), fp), keys, fp);
}

/** Whether every key claude might use is already marked trusted. */
const isTrusted = (projects, keys, fp) => keys.every((k) => entryOf(projects, k, fp).hasTrustDialogAccepted === true);

/**
 * Every key claude might look itself up under, most likely first.
 *
 * `process.cwd()` is `getcwd(3)`, which hands back a path with every symlink already resolved,
 * so on a `SOMA_HOME` under `/tmp` or `/var/folders` — symlinked on every macOS box — the
 * physical path is what claude asks about, and marking the literal one is a dialog nobody
 * answers. That premise is load-bearing and not verified against claude's source, and being
 * wrong about it costs a silent hang, so when the two differ we mark both: a second 40-byte
 * entry is the cheapest insurance in this file. An unresolvable path (dir not created yet, or
 * a permission stops the walk) leaves the literal string as all we have.
 */
function trustKeys(cwd) {
  let real;
  try {
    real = realpathSync(cwd);
  } catch {
    return [cwd];
  }
  return real === cwd ? [cwd] : [real, cwd];
}

/** The parsed config (`{}` when there is none), root shape checked. */
function readDoc(fp) {
  const raw = readIfPresent(fp);
  const j = raw === null ? {} : parseOrRefuse(raw, fp);
  if (!isPlainObject(j)) refuse(fp, `has a ${kindOf(j)} at its root`);
  return j;
}

/**
 * The `projects` map, shape checked. `?? {}` deliberately treats a null map as absent: null
 * carries no operator data, so replacing it loses nothing, while an array or a string means
 * the schema moved under us and a merge would be a guess.
 */
function projectsOf(j, fp) {
  const projects = j.projects ?? {};
  if (!isPlainObject(projects)) refuse(fp, `has a ${kindOf(j.projects)} "projects"`);
  return projects;
}

/** One project entry, shape checked, `{}` when claude has never seen that cwd. */
function entryOf(projects, key, fp) {
  const entry = projects[key] ?? {};
  if (!isPlainObject(entry)) refuse(fp, `has a ${kindOf(projects[key])} entry for ${key}`);
  return entry;
}

/** Contents of `fp`, or `null` when it does not exist. */
function readIfPresent(fp) {
  try {
    return readFileSync(fp, 'utf8');
  } catch (e) {
    // The first spawn on a machine where claude has never run: there is no config yet, and
    // creating one holding just our project entry is correct. One syscall rather than
    // `existsSync` + read, which also closes the window between the two.
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function parseOrRefuse(raw, fp) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    // Never `{}` on a parse failure: that path ends with the operator's MCP servers, account
    // and history replaced by a one-key file. A torn read or a hand-edit is worth a crash.
    throw new Error(`preTrust: ${fp} is not valid JSON (${e.message}); refusing to overwrite it`, { cause: e });
  }
}

function refuse(fp, what) {
  throw new Error(`preTrust: ${fp} ${what}; refusing to overwrite it`);
}

/**
 * Publish `body` at `fp` via tmp+rename. Readers see one version or the other; a failure
 * anywhere leaves the config untouched and no scratch file behind.
 */
function writeAtomic(fp, body) {
  const tmp = `${fp}.${process.pid}.tmp`;
  try {
    // The scratch name is predictable and sits in a directory that is not ours, so treat
    // anything already at it as hostile rather than as ours to reuse: unlink first (which
    // removes a symlink itself, never its target), then create with O_EXCL, so a symlink
    // re-planted in that gap fails the open instead of routing a full copy of the operator's
    // OAuth tokens somewhere else.
    unlinkIfPresent(tmp);
    const fd = openSync(tmp, 'wx', MODE);
    try {
      // fchmod, not chmod: it narrows the inode we are actually holding rather than whatever
      // the path resolves to by now, and it undoes a umask that masked the mode `open` got.
      fchmodSync(fd, MODE);
      writeFileSync(fd, body);
      // Durability is a bonus, not the contract — atomicity comes from the rename. A mount
      // that refuses fsync must not be the reason a lead fails to spawn.
      try {
        fsyncSync(fd);
      } catch {
        /* best effort */
      }
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, fp);
  } catch (e) {
    unlinkIfPresent(tmp); // a stray copy of the operator's credentials is not acceptable litter
    throw e;
  }
}

function unlinkIfPresent(fp) {
  try {
    unlinkSync(fp);
  } catch {
    /* not there, or already gone */
  }
}

// ---------------------------------------------------------------------------
// The lock. `filelock.mjs` carries the idiom and the eight rules it rests on; the three
// things that are specific to THIS lock are all consequences of one fact — it does not
// live under soma's state root. It sits beside claude's own config, so it follows the
// `home`/`env` arguments rather than `$SOMA_HOME`, it is created `0600` like everything
// else this module writes into a directory full of credentials, and it needs an age-out
// because nothing on the machine cleans that directory up.
// ---------------------------------------------------------------------------

/**
 * Run `fn` with exclusive access to the config. Release is in a `finally`.
 *
 * `deadline` rather than a timeout, because the budget is for the whole `preTrust` call and
 * this is taken once per confirm-and-retry round. `timeoutMs` is passed alongside it purely
 * so a refusal reports the budget an operator set rather than whatever was left of it on the
 * last round.
 *
 * Deliberately NOT re-entrant: nothing here nests, and pretending otherwise would hide a
 * caller that had started to.
 */
const withConfigLock = (fp, deadline, fn) =>
  lock.withLock(`${fp}.lock`, fn, { deadline, timeoutMs: LOCK_TIMEOUT_MS });
