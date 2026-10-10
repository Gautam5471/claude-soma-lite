#!/usr/bin/env node
/**
 * `lead-postcompact.mjs` — the PostCompact hook: re-orient a lead that just lost its
 * memory.
 *
 * Compaction rewrites the conversation into a summary. What survives is whatever the
 * summariser judged important, and the three things a soma lead most needs are
 * exactly the three a summariser drops first: they are old, they were never referred
 * to again, and they read as boilerplate — the task brief it was spawned with, the
 * HARNESS contract it declared (the plan of record *and* the budget reservation the
 * watchdog bound a circuit breaker to), and the standing rule that it may not write
 * code itself. A lead that forgets the third one spends its next turns trying to Edit
 * and being denied by the gate, with no idea why.
 *
 * So the answer is not a reminder of the content — the hook has no way to know it —
 * but a pointer to the tool that re-reads it. `soma_task()` exists for this: it is
 * the lead's re-orientation tool, and this note and the resume prompt are the two
 * places that name it.
 *
 * `additionalContext` is wrapped in a system reminder and inserted into the
 * conversation, so it is read once, before the lead's next turn. Exit 0; a
 * non-zero exit here would surface as an error against a compaction the lead did not
 * ask for and cannot retry. stdin is not read — nothing in the hook payload changes
 * the answer, and not touching it means there is no pipe to block on.
 */
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * The note itself. Exported so the wire-up and the canary can assert on the same
 * string the lead will see, rather than a paraphrase of it.
 *
 * Kept to four clauses on purpose: it is spent from the freshly-compacted context
 * window it is trying to protect.
 */
export const REORIENT = [
  'soma: your context was just compacted, so treat everything above as a lossy summary.',
  'Before doing anything else: call soma_task() to re-read your task brief,',
  're-read your HARNESS contract and standing rules, and remember that you are planning-only —',
  'your teammates do every edit, and progress reaches the orchestrator only through soma_report().',
].join(' ');

/** Is this file the process entry point? `realpath` first, so a symlinked or relative argv still matches. */
function isMain(url) {
  try {
    return typeof process.argv[1] === 'string' && url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  process.stdout.on('error', () => {});
  // No `process.exit()` after the write: stdout to a pipe is asynchronous and exiting
  // discards whatever has not drained, which would hand Claude Code a truncated JSON
  // fragment instead of the note. Letting the loop empty on its own flushes it.
  process.exitCode = 0;
  try {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostCompact', additionalContext: REORIENT },
    }));
  } catch { /* the reader is gone; there is nobody left to tell */ }
}
