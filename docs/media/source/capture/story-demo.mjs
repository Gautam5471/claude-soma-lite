// DEMO ONLY, SANDBOX ONLY. Never point this at a real SOMA_HOME or CLAUDE_CONFIG_DIR.
//
// The story the showcase opens with, driven through soma's real MCP bus (bin/soma-bus.mjs) over
// stdio JSON-RPC, inside the sandbox: an orchestrator takes the lease and queues four tasks, four
// leads report their harness, progress, one question and completion, the orchestrator answers the
// question with soma_send and drains its inbox. Run ONLY through /private/tmp/soma-demo/run (via
// story.sh), so the environment is the sandbox allowlist and nothing else.
//
// Two things stand in for what a real fleet would have, and nothing else does:
//   - no lead is launched. The four rows are marked `spawned` with soma's own
//     fleet.setTaskStatus(), the call soma_spawn makes once admission passes, because the inbox
//     only folds a COMPLETED into `done` for a row that was spawned;
//   - soma_send needs a pane to type into, so story.sh starts one plain `cat` in a tmux session
//     named lead-fix-login-bug on the sandbox socket (soma_demo) before this runs.
// Every task, brief, question, answer and placeholder PR url (example.com) is made up for the demo.
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';

const SB = '/private/tmp/soma-demo';
const refuse = (why) => {
  console.error(`refusing: ${why}`);
  process.exit(1);
};
// The state root, the home and the Claude config must all resolve INSIDE the throwaway sandbox:
// a demo soma_adopt against a live state root would take the live fleet's lease.
const inSandbox = (p, rootOk = false) => {
  try {
    const real = realpathSync(p);
    return real.startsWith(`${SB}/`) || (rootOk && real === SB);
  } catch {
    return false;
  }
};
if (!process.env.SOMA_HOME || !inSandbox(process.env.SOMA_HOME)) refuse(`SOMA_HOME=${process.env.SOMA_HOME} does not resolve inside ${SB}/`);
if (!process.env.CLAUDE_CONFIG_DIR || !inSandbox(process.env.CLAUDE_CONFIG_DIR)) refuse(`CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR} does not resolve inside ${SB}/`);
if (!process.env.HOME || !inSandbox(process.env.HOME, true)) refuse(`HOME=${process.env.HOME} is not the sandbox`);
if (process.env.SOMA_TMUX_SOCKET !== 'soma_demo') refuse('SOMA_TMUX_SOCKET is not soma_demo');
if (process.env.TMUX !== undefined || process.env.TMUX_PANE !== undefined) refuse('TMUX or TMUX_PANE is set');

const BUS = `${SB}/claude-soma-lite/bin/soma-bus.mjs`;
const OUT = process.argv[2];
if (!OUT || !OUT.startsWith(`${SB}/`)) refuse('the output file must be inside the sandbox');

// Every bus gets this environment and nothing inherited beyond it: the sandbox allowlist, with the
// state root and the tmux socket named explicitly, and no TMUX / TMUX_PANE (so the lease records
// wake=notify and no wake keystroke is typed anywhere).
const ALLOW = ['HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'TMPDIR', 'PATH', 'SOMA_HOME', 'CLAUDE_CONFIG_DIR'];
const busEnv = (extra) => {
  const env = Object.fromEntries(ALLOW.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  Object.assign(env, { SOMA_HOME: process.env.SOMA_HOME, SOMA_TMUX_SOCKET: 'soma_demo' }, extra);
  if (!inSandbox(env.SOMA_HOME) || !inSandbox(env.HOME, true) || !inSandbox(env.CLAUDE_CONFIG_DIR)) refuse('a bus env left the sandbox');
  if ('TMUX' in env || 'TMUX_PANE' in env || env.SOMA_TMUX_SOCKET !== 'soma_demo') refuse('a bus env carries tmux state');
  return env;
};

const fleet = await import(`${SB}/claude-soma-lite/bin/lib/fleet.mjs`);

const start = (extra) => {
  const child = spawn(process.execPath, [BUS], { env: busEnv(extra), stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const pending = new Map();
  let nextId = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  child.stderr.resume();
  const call = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
  });
  const tool = async (name, args = {}) => {
    const res = await call('tools/call', { name, arguments: args });
    const text = res?.result?.content?.[0]?.text;
    return text ? JSON.parse(text) : res;
  };
  const init = async () => {
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'soma-demo-driver', version: '0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  };
  const names = async () => (await call('tools/list', {})).result.tools.map((t) => t.name);
  return { tool, init, names, close: () => child.stdin.end() };
};

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const steps = [];
const step = (who, what, result, args) => {
  steps.push({ who, what, ...(args === undefined ? {} : { args }), result });
  return result;
};
const all = [];
const finish = async (code) => {
  for (const b of all) b.close();
  await pause(300);
  writeFileSync(OUT, JSON.stringify(steps, null, 2));
  if (code) process.exit(code);
};

// 1. The user types /soma-promote: the skill's step 1 is one soma_adopt call on the candidate bus.
const orch = start({ SOMA_SESSION_ID: 'orch-demo' });
all.push(orch);
await orch.init();
step('orchestrator', 'tools/list (candidate)', await orch.names());
const adopt = step('orchestrator', 'soma_adopt {}', await orch.tool('soma_adopt', {}));
if (adopt?.adopted !== true || adopt.wake !== 'notify') {
  console.error('refusing: soma_adopt did not adopt with wake=notify; stopping before anything else runs');
  await finish(1);
}
step('orchestrator', 'tools/list (after adopt)', await orch.names());

// 2. "Here are 4 tickets, get them done": the orchestrator authors the briefs and enqueues them.
const tasks = JSON.parse(readFileSync(`${SB}/tasks.json`, 'utf8'));
step('orchestrator', 'soma_enqueue {tasks}', await orch.tool('soma_enqueue', { tasks }), { tasks: tasks.map((t) => t.id) });

// 3. The fleet. Marked spawned through soma's own fleet module; no lead process is started.
for (const t of tasks) fleet.setTaskStatus(t.id, 'spawned');
step('sandbox', 'fleet.setTaskStatus(id, "spawned") for each task', tasks.map((t) => t.id));
await pause(50);

const leads = {};
for (const t of tasks) {
  leads[t.id] = start({ SOMA_ROLE: 'lead', SOMA_LEAD_NAME: t.id });
  all.push(leads[t.id]);
  await leads[t.id].init();
}
const report = async (id, type, payload) => step(`lead ${id}`, `soma_report ${type}`, await leads[id].tool('soma_report', { type, payload }), { type, payload });

const kickoff = {
  'fix-login-bug': 'picked up; reading src/login.js and its test',
  'add-rate-limit': 'picked up; reading the login path',
  'docs-quickstart': 'picked up; reading the README',
  'estimate-sso': 'picked up; mapping how login works today',
};
for (const t of tasks) await report(t.id, 'STARTED', { summary: kickoff[t.id] });

// 4. Step 0 of prompts/lead.md: each lead picks the first harness row that fits its task. The
//    orchestrator drains them at once, which is what binds each row's budget class.
const harness = {
  'fix-login-bug': { harness_id: 'H3', budget_class: 'iterate', max_iterations: 10, verify_command: 'npm test', plan_summary: 'A failing test for a capitalised username first, then make the check case-insensitive.' },
  'add-rate-limit': { harness_id: 'H2', budget_class: 'iterate', max_iterations: 10, verify_command: 'npm test', plan_summary: 'Add the failure counter and the 60 s lockout, iterating until npm test is green.' },
  'docs-quickstart': { harness_id: 'H1', budget_class: 'standard', max_iterations: 1, verify_command: 'a reviewer follows it on a clean clone', plan_summary: 'Write the five steps in one pass; a verifier follows them on a clean clone.' },
  'estimate-sso': { harness_id: 'H6', budget_class: 'research', verify_command: 'every claim has a source', plan_summary: 'Read-only: the options, the risks and an estimate, as a report. No code.' },
};
for (const t of tasks) await report(t.id, 'HARNESS', harness[t.id]);
step('orchestrator', 'soma_inbox {}', await orch.tool('soma_inbox', {}));
step('orchestrator', 'soma_status {}', await orch.tool('soma_status', {}));

// 5. Work in parallel, and one question; the orchestrator relays the operator's answer.
await report('fix-login-bug', 'MILESTONE', { summary: 'failing test for a capitalised username committed' });
await report('add-rate-limit', 'MILESTONE', { summary: 'failure counter in place; lockout next' });
await report('docs-quickstart', 'MILESTONE', { summary: 'quickstart drafted; verifier following it on a clean clone' });
await report('estimate-sso', 'MILESTONE', { summary: 'three options mapped' });
await report('fix-login-bug', 'NEEDS_INPUT', {
  question: 'Store usernames lowercased, or only compare case-insensitively at login?',
  options: ['lowercase stored usernames', 'compare case-insensitively at login'],
  recommendation: 'compare at login and leave stored data alone',
});
step('orchestrator', 'soma_inbox {}', await orch.tool('soma_inbox', {}));

const answer = { lead: 'fix-login-bug', message: 'Compare at login. Leave stored usernames alone.' };
const sent = step('orchestrator', 'soma_send {lead: fix-login-bug}', await orch.tool('soma_send', answer), answer);
// Typed into the sandbox's stand-in pane and nowhere else, through the gate's documented path for a
// readable screen that is not Claude Code's ("unrecognised; typed anyway"). Never forced: any other
// answer stops the capture here, and the story falls back to a labelled re-creation of this beat.
if (sent?.tmux_target !== 'lead-fix-login-bug' || sent.delivered !== true || sent.pane_state !== 'unrecognised') {
  console.error(`stopping: soma_send answered ${JSON.stringify(sent)}`);
  await finish(1);
}

await report('fix-login-bug', 'MILESTONE', { summary: 'login compares case-insensitively; npm test green' });
await report('add-rate-limit', 'MILESTONE', { summary: 'lockout after 5 failures; npm test green' });

// 6. Done: each lead reports COMPLETED with its draft PR. The urls are placeholders; no PR exists.
const done = {
  'fix-login-bug': { summary: 'usernames match case-insensitively at login; verifier approved', pr_url: 'https://example.com/demo-app/pull/1', paths: ['src/login.js', 'test/login.test.js'] },
  'add-rate-limit': { summary: 'an account locks for 60 s after 5 failed logins; verifier approved', pr_url: 'https://example.com/demo-app/pull/2', paths: ['src/login.js', 'test/rate-limit.test.js'] },
  'docs-quickstart': { summary: 'five-step quickstart; a verifier followed it on a clean clone', pr_url: 'https://example.com/demo-app/pull/3', paths: ['README.md'] },
  'estimate-sso': { summary: 'report: the options, the risks and an estimate', pr_url: 'https://example.com/demo-app/pull/4', paths: ['docs/sso-estimate.md'] },
};
for (const t of tasks) await report(t.id, 'COMPLETED', { ...done[t.id], followups: [] });

step('orchestrator', 'soma_inbox {}', await orch.tool('soma_inbox', {}));
step('orchestrator', 'soma_status {}', await orch.tool('soma_status', {}));

await finish(0);
console.log(`story: ${steps.length} steps written`);
