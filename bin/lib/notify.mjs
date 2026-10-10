/**
 * Desktop notifications — the operator's only out-of-band channel.
 *
 * NEEDS_INPUT, ERROR, a tripped budget, a settled fleet: the handful of events
 * an operator has to hear about while they are looking at something else. The
 * bus wake and the watchdog both call `notify(title, body)`; this module owns
 * exactly two questions — which command pops a notification on this machine,
 * and how the text is made safe for that command.
 *
 * Three transports, one sniff:
 *
 *   darwin      `osascript -e 'display notification …'`  — /usr/bin/osascript
 *               is on every Mac, so nothing to install.
 *   WSL2        `powershell.exe` raw WinRT toast — interop lets a
 *               distro-resident daemon pop a *native Windows* toast. This is
 *               the whole reason isWSL() exists.
 *   otherwise   `notify-send -a soma <title> <body>` — libnotify, i.e. Linux.
 *
 * Every call takes an optional `run(cmd, args, opts?)`, so tests assert which
 * command was chosen without a notification daemon anywhere in sight, and a
 * later transport (ssh to the operator's laptop) drops in without touching a
 * caller.
 *
 * Two contracts the callers lean on, in order of importance:
 *
 *   Never throw. A lost toast must not fail a bus tool call or end the watchdog
 *   loop, so every path — notify-send missing on a headless box, an injected
 *   `run` that blows up, a body whose toString throws — ends in the swallow at
 *   the bottom of `notify`.
 *
 *   Never block. `run` returns the moment the notifier is spawned; nothing here
 *   waits on it, reads it, or holds a handle to it.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/**
 * A notification is a glance, not a log line — every platform renders one or
 * two lines and drops the rest — but a summary arrives with the bus's limits
 * (2000 chars) and may carry newlines from a lead's report. Collapse the
 * whitespace, clamp the length, and every transport gets one tidy argument.
 *
 * (AppleScript does tolerate a raw newline inside a string literal — verified
 * with osacompile — but a Windows command line rebuilt by WSL interop is not
 * something to find out about from an operator's missing toast.)
 */
const MAX_LEN = 300;
const plain = (s) => {
  // Control characters go with the whitespace: a NUL smuggled in through a
  // JSON payload makes spawn reject the whole argument vector, and an escape
  // sequence has no business in a GUI toast.
  const line = (s == null ? '' : String(s)).replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim();
  // '...' rather than '…': the ellipsis is ours, not the operator's, and
  // osascript decodes its argument per locale — which an `env -i` watchdog
  // (see tmux.newSession) does not have.
  return line.length > MAX_LEN ? `${line.slice(0, MAX_LEN - 3)}...` : line;
};

/**
 * Escape one string for an AppleScript literal.
 *
 * Backslash first, or the escape below it gets escaped in turn. AppleScript
 * reads `\` as an escape character, so a body ending in one — `C:\`, a regex
 * `\d+`, a Windows path from a lead's summary — turns our closing quote into a
 * literal and the script stops compiling: `display notification "oops\" with
 * title "soma"` is error -2740 (verified with osacompile). osascript's failure
 * lands in a callback nobody reads, so the operator simply never hears about
 * the event.
 *
 * Double quotes become apostrophes rather than `\"` because this is prose, and
 * because an apostrophe cannot open a string in AppleScript: with `"` gone
 * there is no way out of the literal, and so no way to append
 * `& (do shell script "…")` to it.
 */
const osa = (s) => plain(s).replaceAll('\\', '\\\\').replaceAll('"', "'");

/**
 * Escape one string for a single-quoted PowerShell literal.
 *
 * Here "replace `"` with `'`" alone is exactly backwards: PowerShell *closes* a
 * single-quoted string on a lone quote and escapes it by doubling. A body
 * reading `couldn't finish` would end the string mid-word and turn the toast
 * into a parse error; `x'); iex('calc'); ('` would end it on purpose and run.
 * So double every quote — after folding the double-quote class to `'`, which is
 * a separate problem: powershell.exe is reached through WSL interop, which
 * rebuilds a Windows command line, and the double quote is the character that
 * mangling is famous for. The script we send contains none.
 *
 * And "a quote" is emphatically not just U+0027. PowerShell's tokenizer opens
 * and closes a single-quoted string on U+2018, U+2019, U+201A and U+201B too
 * (and a double-quoted one on U+201C, U+201D, U+201E) — so a summary whose
 * apostrophe is U+2019 rather than U+0027, which is what an LLM writes and what
 * a Jira title carries, sails straight through an ASCII-only escaper and closes
 * the literal: `couldn't finish` merely breaks the toast, the same trick around
 * `iex('calc')` runs it. Both classes are widened below, and every member of
 * them collapses to a doubled *ASCII* pair — so a mixed-class pair cannot
 * straddle the escape either.
 *
 * `$`, backtick and `\` need nothing: they are literal inside a single-quoted
 * PowerShell string. The two quote classes are the whole attack surface.
 */
const PS_DQUOTE = /["\u201C\u201D\u201E]/g;
const PS_SQUOTE = /['\u2018\u2019\u201A\u201B]/g;
const ps = (s) => plain(s).replace(PS_DQUOTE, "'").replace(PS_SQUOTE, "''");

/**
 * Where the WSL sniff looks. Overridable *only* so the tests can drive the
 * powershell branch from a Mac; nothing in production sets it, and the name
 * says as much — an earlier review flagged a plainly-named SOMA_* override as an
 * accidental-export vector.
 */
const procVersion = () => process.env.SOMA_PROC_VERSION_TESTONLY || '/proc/version';

/**
 * True on WSL: the kernel version string carries "microsoft" — `Microsoft` on
 * WSL1, `microsoft-standard-WSL2` on WSL2, hence the /i. This one boolean is
 * what lets a distro-resident soma reach the Windows desktop.
 *
 * Guarded because the answer must be a boolean and never an exception: /proc
 * can exist and still be unreadable (hardened kernels, odd containers), and a
 * notifier that throws while deciding *how* to notify is worse than a quiet
 * one.
 */
export function isWSL() {
  try {
    const path = procVersion();
    return existsSync(path) && /microsoft/i.test(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * A session-bus address for notify-send, when the environment has none.
 *
 * libnotify finds the bus through DBUS_SESSION_BUS_ADDRESS, and the watchdog is
 * spawned `env -i` inside tmux (tmux.newSession) — so by the time it wants a
 * toast that variable is usually gone, libnotify falls back to an X11 autolaunch
 * that fails on a Wayland or headless box, and the notification vanishes with
 * exit 0. Point it at the standard per-user socket instead.
 *
 * Only ever when unset: a real address always wins. And the guess is harmless
 * when wrong, because without it the call had no chance anyway.
 */
const dbusEnv = () => {
  if (process.env.DBUS_SESSION_BUS_ADDRESS) return null;
  const dir = process.env.XDG_RUNTIME_DIR || (process.getuid ? `/run/user/${process.getuid()}` : null);
  return dir ? { ...process.env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${dir}/bus` } : null;
};

/**
 * Spawn and forget — the default `run`.
 *
 * `stdio: 'ignore'` plus `unref` is what makes "non-blocking" true rather than
 * nearly true. execFile (the obvious choice) always pipes — it drops a `stdio`
 * option on the floor — and those pipes keep the *caller's* event loop alive
 * until the notifier exits: measured at 30s for a 30s child, unref or not, and
 * notify-send against an unresponsive dbus can sit for 25. Nothing here reads
 * the notifier's output, so nothing should hold a handle to it; an orphaned
 * osascript still posts its notification (verified).
 *
 * The 'error' listener is load-bearing, not decoration. ENOENT — no
 * notify-send on a headless Linux box — arrives as an event, and an unhandled
 * 'error' event is an uncaught exception that would end the watchdog (verified:
 * the same spawn without it exits nonzero on ERR_UNHANDLED_ERROR).
 */
const defaultRun = (cmd, args, opts) => {
  const child = spawn(cmd, args, { stdio: 'ignore', ...opts });
  child.on('error', () => {});
  child.unref();
};

/**
 * Pop a desktop notification. Fire-and-forget: returns immediately, reports
 * nothing, throws never.
 */
export function notify(title, body, run = defaultRun) {
  try {
    // process.platform, not os.platform() — which returns precisely this — so
    // one host can exercise all three branches under test.
    if (process.platform === 'darwin') {
      run('osascript', ['-e', `display notification "${osa(body)}" with title "${osa(title)}"`]);
    } else if (isWSL()) {
      // Raw WinRT, so there is nothing to install: load the type, take template
      // 0 (ToastText01, a single text line — PowerShell coerces the int to the
      // enum), fill its one text node, show it. `> $null` swallows the values
      // those calls return, which would otherwise print into the pipe.
      const toast =
        '[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] > $null; ' +
        '$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(0); ' +
        `$t.GetElementsByTagName('text').Item(0).AppendChild($t.CreateTextNode('${ps(title)}: ${ps(body)}')) > $null; ` +
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('soma').Show([Windows.UI.Notifications.ToastNotification]::new($t))";
      // powershell.exe, never pwsh: the WinRT projection is unreliable in 7.x.
      run('powershell.exe', ['-NoProfile', '-Command', toast]);
    } else {
      // `--` for the reason sendKeys has one: notify-send parses with GOption,
      // so a body that happens to start with `-` is read as a flag and the
      // toast is dropped with a usage error. Nothing else needs escaping — this
      // is an argument vector, not a script. (Known limitation: a daemon that
      // advertises body-markup will try to parse `<` and `&` in the body as
      // markup. Escaping them unconditionally would show `&amp;` on the daemons
      // that don't, and telling the two apart needs a capability query
      // notify-send cannot make, so the text is passed through as written.)
      const args = ['-a', 'soma', '--', plain(title), plain(body)];
      const env = dbusEnv();
      if (env) run('notify-send', args, { env });
      else run('notify-send', args);
    }
  } catch {
    // Deliberately silent, and deliberately the last word: a notification is
    // the least important thing in the run, this module has no logger to
    // complain to, and the watchdog tick that called it has to survive a
    // broken desktop. (Which also means an assertion thrown from an injected
    // `run` is swallowed here — record the call and assert outside it.)
  }
}
