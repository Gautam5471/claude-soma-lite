// DEMO ONLY, SANDBOX ONLY. Never point this at a real SOMA_HOME or CLAUDE_CONFIG_DIR.
//
// Drive the real soma MCP bus (bin/soma-bus.mjs) over stdio JSON-RPC, inside the sandbox.
// Run ONLY through /private/tmp/soma-demo/run, so the env is the sandbox allowlist.
import { spawn } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';

const BUS = '/private/tmp/soma-demo/claude-soma-lite/bin/soma-bus.mjs';
const OUT = process.argv[2];
// The state root, the home and the Claude config must RESOLVE inside the sandbox: a demo
// soma_adopt against a live state root would take the live fleet's orchestrator lease.
const inSandbox = (p, rootOk = false) => {
  try {
    const real = realpathSync(p);
    return real.startsWith('/private/tmp/soma-demo/') || (rootOk && real === '/private/tmp/soma-demo');
  } catch {
    return false;
  }
};
for (const k of ['SOMA_HOME', 'CLAUDE_CONFIG_DIR']) {
  if (!process.env[k] || !inSandbox(process.env[k])) throw new Error(`refusing: ${k}=${process.env[k]} does not resolve inside the sandbox`);
}
if (!process.env.HOME || !inSandbox(process.env.HOME, true)) throw new Error(`refusing: HOME=${process.env.HOME} is not the sandbox`);
if (process.env.SOMA_TMUX_SOCKET !== 'soma_demo') throw new Error('refusing: SOMA_TMUX_SOCKET is not soma_demo');
if (process.env.TMUX !== undefined || process.env.TMUX_PANE !== undefined) throw new Error('refusing: TMUX or TMUX_PANE is set');

const log = [];
const start = (label, extraEnv) => {
  const child = spawn(process.execPath, [BUS], { env: { ...process.env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
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
      } else {
        log.push({ who: label, dir: 'notify<-', msg });
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => log.push({ who: label, dir: 'stderr', text: d }));
  const call = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    const req = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    pending.set(id, (res) => {
      log.push({ who: label, dir: 'request->', msg: req });
      log.push({ who: label, dir: 'response<-', msg: res });
      resolve(res);
    });
    child.stdin.write(`${JSON.stringify(req)}\n`);
  });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) })}\n`);
  const tool = async (name, args = {}) => {
    const res = await call('tools/call', { name, arguments: args });
    const text = res?.result?.content?.[0]?.text;
    return text ? JSON.parse(text) : res;
  };
  const init = async () => {
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'soma-demo-driver', version: '0' } });
    notify('notifications/initialized');
  };
  const names = async () => (await call('tools/list', {})).result.tools.map((t) => t.name);
  return { child, call, tool, init, names, close: () => child.stdin.end() };
};

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const steps = [];
const step = (who, what, result) => { steps.push({ who, what, result }); };

// 1. The orchestrator: a candidate bus (what `soma init` registers at user scope), promoted by soma_adopt.
const orch = start('orchestrator', { SOMA_SESSION_ID: 'orch-demo' });
await orch.init();
step('orchestrator', 'tools/list (candidate)', await orch.names());
step('orchestrator', 'soma_adopt {}', await orch.tool('soma_adopt', {}));
await pause(200);
step('orchestrator', 'tools/list (after adopt)', await orch.names());

// 2. Lead fix-login-bug: a lead-role bus, as spawn.mjs mounts it.
const lead = start('lead fix-login-bug', { SOMA_ROLE: 'lead', SOMA_LEAD_NAME: 'fix-login-bug' });
await lead.init();
step('lead fix-login-bug', 'tools/list', await lead.names());
step('lead fix-login-bug', 'soma_task {}', await lead.tool('soma_task', {}));
step('lead fix-login-bug', 'soma_report STARTED', await lead.tool('soma_report', { type: 'STARTED', payload: { summary: 'picked up; reading src/login.js' } }));
step('lead fix-login-bug', 'soma_report HARNESS', await lead.tool('soma_report', {
  type: 'HARNESS',
  payload: {
    harness_id: 'H3',
    autonomy: 'decide-within-ticket',
    verify_command: 'npm test',
    max_iterations: 10,
    budget_class: 'iterate',
    team_plan: [{ role: 'test-writer' }, { role: 'implementer' }, { role: 'verifier', stance: 'default-REJECT' }],
    plan_summary: 'Failing test for a capitalised username first, then fold case in login(), then the verifier runs npm test from a clean state.',
  },
}));
step('lead fix-login-bug', 'soma_report NEEDS_INPUT', await lead.tool('soma_report', {
  type: 'NEEDS_INPUT',
  payload: { question: 'Store usernames lowercased, or only compare case-insensitively at login? I would compare at login and leave stored data alone.' },
}));

// 3. Lead docs-quickstart reports a bad harness first (the bus refuses it), then a valid one.
const lead2 = start('lead docs-quickstart', { SOMA_ROLE: 'lead', SOMA_LEAD_NAME: 'docs-quickstart' });
await lead2.init();
step('lead docs-quickstart', 'soma_report HARNESS (H1 with the wrong class)', await lead2.tool('soma_report', {
  type: 'HARNESS', payload: { harness_id: 'H1', budget_class: 'iterate', autonomy: 'decide-within-ticket', verify_command: 'reviewer follows the quickstart on a clean clone', max_iterations: 1, team_plan: [{ role: 'implementer' }, { role: 'verifier' }], plan_summary: 'one pass' },
}));
step('lead docs-quickstart', 'soma_report HARNESS (H1, standard)', await lead2.tool('soma_report', {
  type: 'HARNESS', payload: { harness_id: 'H1', budget_class: 'standard', autonomy: 'decide-within-ticket', verify_command: 'reviewer follows the quickstart on a clean clone', max_iterations: 1, team_plan: [{ role: 'implementer' }, { role: 'verifier' }], plan_summary: 'Write the five steps, then a verifier follows them on a clean clone.' },
}));
step('lead docs-quickstart', 'soma_report MILESTONE', await lead2.tool('soma_report', { type: 'MILESTONE', payload: { summary: 'quickstart drafted; verifier running it on a clean clone' } }));

// 4. The orchestrator drains its inbox.
step('orchestrator', 'soma_inbox {}', await orch.tool('soma_inbox', {}));
step('orchestrator', 'soma_status {lead: fix-login-bug}', await orch.tool('soma_status', { lead: 'fix-login-bug' }));
step('orchestrator', 'soma_digest {}', await orch.tool('soma_digest', {}));

for (const b of [orch, lead, lead2]) b.close();
await pause(300);
writeFileSync(OUT, JSON.stringify({ steps, log }, null, 2));
console.log(JSON.stringify(steps, null, 2));
