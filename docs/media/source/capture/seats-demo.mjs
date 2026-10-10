// DEMO ONLY, SANDBOX ONLY. Never point this at a real SOMA_HOME or CLAUDE_CONFIG_DIR.
//
// Seeds the sandbox seat pool through soma's own seats module, exactly as the watchdog's limits
// phase does after a five_hour usage-window verdict: close() the lead's seat until its reset, then
// pick() the next seat in soma.json order. No lead is killed or resumed here; nothing is launched.
import { close, loadSeats, pick } from '/private/tmp/soma-demo/claude-soma-lite/bin/lib/seats.mjs';
import { loadConfig } from '/private/tmp/soma-demo/claude-soma-lite/bin/lib/config.mjs';

if (process.env.SOMA_HOME !== '/private/tmp/soma-demo/.soma' || process.env.HOME !== '/private/tmp/soma-demo') {
  throw new Error('refusing: not the sandbox');
}
const now = Date.now();
const cfg = loadConfig();
const [first] = loadSeats(cfg);
close(first.config_dir, now + 2 * 60 * 60 * 1000, 'five_hour', now);
const picked = pick(now, cfg);
console.log(JSON.stringify({ closed: first.label, reason: 'five_hour', picked: picked?.label ?? null }));
