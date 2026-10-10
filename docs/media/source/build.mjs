// Build index.html for the claude-soma-lite showcase from captured, verbatim terminal output.
//
//   node build.mjs            (reads ./captures, writes ./index.html)
//
// Every string shown inside a terminal panel comes from ./captures, which capture.sh recorded
// from the real soma code running in a sandboxed demo fleet. Explanatory cards (the diagram,
// the watchdog list) are authored text whose every claim was checked against bin/ and prompts/.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAP = join(HERE, 'captures');
for (const f of ['InstrumentSerif-Regular.woff2', 'InstrumentSerif-Italic.woff2']) {
  if (!existsSync(join(HERE, 'fonts', f))) {
    console.warn(`fonts/${f} is missing: run sh fetch-fonts.sh first, or the headlines render in Georgia.`);
  }
}
const read = (f) => readFileSync(join(CAP, f), 'utf8');
const json = (f) => JSON.parse(read(f));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\*/g, '&#42;');
const lines = (s) => s.replace(/\r/g, '').replace(/\n+$/, '').split('\n');

// The project's name and where it lives: the ONE place either is written. The title card, the call
// to action, the outro and the page title all read these, so a rename is a one-line rebuild.
const NAME = 'claude-soma-lite';
const REPO_URL = 'github.com/techfreakworm/claude-soma-lite';

/* ------------------------------------------------------------------ the captured material */

// The pty transcript. A terminal shows the echoed EOF (`^D`) erased by the two backspaces that
// follow it, so strip exactly that sequence; CRs go in `lines`.
const upTty = lines(read('05-up-tty.raw').replace(/\^D\x08\x08/g, ''));
const upPromptIdx = upTty.findIndex((l) => l.startsWith('Open the queue'));
const upProjection = upTty.slice(0, upPromptIdx);
const upPrompt = upTty[upPromptIdx].replace(/no$/, '');
const upAnswer = 'no';
const upAbort = upTty[upPromptIdx + 1];
const upNoTty = lines(read('04-up-notty.txt')).at(-1);
const argvLines = Object.fromEntries(lines(read('13-argv.txt')).map((l) => [l.slice(0, l.indexOf(' ')), JSON.parse(l.slice(l.indexOf(' ') + 1))]));
const fanout = json('09-fanout.json');
const harnesses = json('harnesses.json');
const defaults = json('15-config-defaults.json');
// The suite log as capture.sh trimmed it: its head, one `[… N lines elided …]` marker, its tail.
// On screen: the two `>` header lines, ONE visible marker counting every line not shown, the last
// five results, and every summary line verbatim.
const testLog = lines(read('12-npm-test.txt'));
const markerIdx = testLog.findIndex((l) => /^\[… \d+ lines elided …\]$/.test(l));
if (markerIdx < 0) throw new Error('12-npm-test.txt carries no elision marker');
const testHead = testLog.slice(0, markerIdx);
const testTailAll = testLog.slice(markerIdx + 1);
const sumStart = testTailAll.findIndex((l) => l.startsWith('ℹ '));
const testSummary = testTailAll.slice(sumStart);
const testTail = testTailAll.slice(0, sumStart).slice(-5);
if (!testTail.every((l) => l.startsWith('✔'))) throw new Error('the last five suite lines are not results');
const testHeader = testHead.filter((l) => l.startsWith('> '));
const testHidden = (testHead.length - testHeader.length)
  + Number(testLog[markerIdx].match(/\d+/)[0])
  + (sumStart - testTail.length);
const testElided = `[… ${testHidden} lines elided …]`;

// lead-gate: "### label" blocks, each followed by the hook's stdout (one JSON line, or nothing).
const gate = {};
{
  let cur = null;
  for (const l of lines(read('11-gate.txt'))) {
    if (l.startsWith('### ')) { cur = l.slice(4); gate[cur] = null; continue; }
    if (cur && l.startsWith('{')) gate[cur] = JSON.parse(l).hookSpecificOutput;
  }
}
const denyReason = (label) => gate[label]?.permissionDecisionReason;

const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const M = (n) => `${n / 1e6}M`;

/* ------------------------------------------------------------------------- html helpers */

const term = (id, title, body, cls = '') => `
      <div class="term ${cls}" id="${id}">
        <div class="term-bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="term-title">${esc(title)}</span></div>
        <div class="term-body">${body}
        </div>
      </div>`;
const cmd = (id, text, prompt = '$') => `
          <div class="ln cmd" id="${id}"><span class="ps">${esc(prompt)}</span> <span class="typed" data-text="${esc(text)}"></span><span class="caret"></span></div>`;
const out = (ls, cls = '') => ls.map((l) => `
          <div class="ln out ${cls}">${l === '' ? '&#8203;' : esc(l)}</div>`).join('');
const label = (n, text) => `<div class="label"><span class="rule"></span><span class="num">${n}</span><span class="txt">${esc(text)}</span></div>`;
const headline = (text) => `<h2 class="headline">${text.split(' ').map((w) => `<span class="w">${esc(w)}</span>`).join(' ')}</h2>`;
const realTag = (extra = 'sandboxed demo fleet') => `<div class="realtag"><span class="pip"></span>real output · ${esc(extra)}</div>`;

/* ---------------------------------------------------------------------------- the scenes */

// Scene 1 — title. The architecture as a small graph that reads left to right like scene 2's
// diagram: one orchestrator, the MCP bus, three leads. Its wires are straight and orthogonal, so
// nothing radiates from a centre. Fixed coordinates (deterministic) in a 640 × 640 box. It holds
// no text, so the layout audit skips it (its connector check cannot see SVG shapes as endpoints).
const AR = {
  orch: { x: 24, y: 250, w: 156, h: 140 },
  bus: { x: 270, y: 64, w: 44, h: 512 },
  lead: { x: 404, w: 212, h: 104 },
  leadY: [120, 320, 520], // each lead's centre line
  bar: [124, 96, 140], // the line "typed" inside each lead
};
const { x: bx, y: by, w: bw, h: bh } = AR.bus, br = bw / 2, busX = bx + br;
const orchX = AR.orch.x + AR.orch.w, orchCx = AR.orch.x + AR.orch.w / 2, midY = AR.orch.y + AR.orch.h / 2;
// A report rides its lead's wire into the bus, along the bus, and into the orchestrator; a send
// (green) takes the same route back. Each pulse carries its route and start time for timeline.js.
const reportRoute = (i) => [AR.lead.x, AR.leadY[i], busX, AR.leadY[i], busX, midY, orchX, midY];
// The title holds for 4 s, so every pulse lands before the dip into the story.
const PULSES = [
  { lead: 0, at: 2.2 }, { lead: 1, at: 2.45 }, { lead: 2, at: 2.7 },
  { lead: 0, at: 3.05, send: true },
].map((p) => {
  const r = reportRoute(p.lead);
  return { ...p, route: p.send ? [r[6], r[7], r[4], r[5], r[2], r[3], r[0], r[1]] : r };
});
const arch = `
        <svg class="arch" viewBox="0 0 640 640" aria-hidden="true" data-layout-ignore>
          <defs><filter id="arch-blur" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="26"/></filter></defs>
          <rect class="arch-glow" x="${AR.orch.x}" y="${AR.orch.y}" width="${AR.orch.w}" height="${AR.orch.h}" rx="24" filter="url(#arch-blur)"/>
          <path class="arch-wire" id="arch-w-orch" d="M${orchX} ${midY} H${bx}" pathLength="1"/>
          ${AR.leadY.map((y, i) => `<path class="arch-wire lead" id="arch-w${i}" d="M${bx + bw} ${y} H${AR.lead.x}" pathLength="1"/>`).join('\n          ')}
          <rect class="arch-bus-fill" x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${br}"/>
          <path class="arch-bus" d="M${bx} ${by + br} A${br} ${br} 0 0 1 ${bx + bw} ${by + br} V${by + bh - br} A${br} ${br} 0 0 1 ${bx} ${by + bh - br} Z" pathLength="1"/>
          <g class="arch-orch">
            <rect class="arch-card" x="${AR.orch.x}" y="${AR.orch.y}" width="${AR.orch.w}" height="${AR.orch.h}" rx="24"/>
            <path class="arch-prompt" d="M${orchCx - 36} ${midY - 24} L${orchCx - 12} ${midY} L${orchCx - 36} ${midY + 24} M${orchCx} ${midY + 24} H${orchCx + 34}"/>
          </g>
          ${AR.leadY.map((y, i) => `<g class="arch-lead" id="arch-l${i}">
            <rect class="arch-card" x="${AR.lead.x}" y="${y - AR.lead.h / 2}" width="${AR.lead.w}" height="${AR.lead.h}" rx="20"/>
            <path class="arch-chev" d="M${AR.lead.x + 26} ${y - 12} L${AR.lead.x + 38} ${y} L${AR.lead.x + 26} ${y + 12}"/>
            <rect class="arch-bar" x="${AR.lead.x + 52}" y="${y - 5}" width="0" height="10" rx="5" data-w="${AR.bar[i]}"/>
          </g>`).join('\n          ')}
          ${PULSES.map((p, i) => `<circle class="arch-pulse${p.send ? ' down' : ''}" id="arch-p${i}" r="7" cx="${p.route[0]}" cy="${p.route[1]}" data-route="${p.route.join(' ')}" data-at="${p.at}"/>`).join('\n          ')}
        </svg>`;

const s1 = `
    <section class="scene" data-layout-allow-overflow id="s1">
      <div class="s1-grid">
        <div class="s1-copy">
          <div class="kicker">Node 24+ · macOS · Linux · Windows via WSL2</div>
          <h1 class="wordmark">${[...NAME].map((c) => `<span class="ch">${esc(c)}</span>`).join('')}</h1>
          <p class="pitch">${'One Claude Code session orchestrates a fleet of project leads, working your backlog in parallel.'.split(' ').map((w) => `<span class="w">${esc(w)}</span>`).join(' ')}</p>
          <div class="chips">
            ${['local', 'tmux + git worktrees', 'MCP bus', 'draft PRs only', 'zero runtime deps'].map((c) => `<span class="chip">${esc(c)}</span>`).join('\n            ')}
          </div>
        </div>${arch}
      </div>
    </section>`;

/* --------------------------------------------------------------- the story (19-story.json) */
// The opening story, for anyone: what soma does, from the user's chair. story-demo.mjs drove the
// real bus in the sandbox; no lead ran, so the stage is a RE-CREATION, labelled as one. Every word
// on it is taken from those calls' results, and the build stops if the capture does not tell the
// story the timeline animates (the same leads, the same reports, in the same order).
const story = json('19-story.json');
const stepsOf = (who, what) => story.filter((s) => s.who === who && s.what === what);
const only = (who, what) => {
  const hit = stepsOf(who, what);
  if (hit.length !== 1) throw new Error(`19-story.json: expected one ${who} / ${what}, found ${hit.length}`);
  return hit[0];
};
if (only('orchestrator', 'soma_adopt {}').result.adopted !== true) throw new Error('19-story.json: soma_adopt did not adopt');
const toolsBefore = only('orchestrator', 'tools/list (candidate)').result.length;
const toolsAfter = only('orchestrator', 'tools/list (after adopt)').result.length;
const queued = only('orchestrator', 'soma_enqueue {tasks}').result.queued;
const STORY_LEADS = ['fix-login-bug', 'add-rate-limit', 'docs-quickstart', 'estimate-sso'];
if (queued.join(' ') !== STORY_LEADS.join(' ')) throw new Error(`19-story.json: queued ${queued.join(', ')}`);
const reportsOf = (id) => story.filter((s) => s.who === `lead ${id}` && s.what.startsWith('soma_report '));
const EXPECT = {
  'fix-login-bug': 'STARTED HARNESS MILESTONE NEEDS_INPUT MILESTONE COMPLETED',
  'add-rate-limit': 'STARTED HARNESS MILESTONE MILESTONE COMPLETED',
  'docs-quickstart': 'STARTED HARNESS MILESTONE COMPLETED',
  'estimate-sso': 'STARTED HARNESS MILESTONE COMPLETED',
};
for (const id of queued) {
  const got = reportsOf(id);
  if (got.map((r) => r.args.type).join(' ') !== EXPECT[id]) throw new Error(`19-story.json: ${id} reported ${got.map((r) => r.args.type).join(' ')}`);
  for (const r of got) if (r.result.delivered !== true) throw new Error(`19-story.json: ${id}'s ${r.args.type} was not delivered`);
}
const ask = reportsOf('fix-login-bug').find((r) => r.args.type === 'NEEDS_INPUT').args.payload.question;
const sent = only('orchestrator', 'soma_send {lead: fix-login-bug}');
// Delivered through the gate's documented path for a readable non-Claude screen, never forced.
if (sent.result.delivered !== true || sent.result.tmux_target !== 'lead-fix-login-bug' || sent.result.pane_state !== 'unrecognised') {
  throw new Error('19-story.json: soma_send did not deliver to the stand-in pane');
}
// Three drains: the HARNESS reports (which binds each row's budget class), the question, the
// completions (which fold every row to `done`). Two status reads: after the first, and at the end.
const drains = stepsOf('orchestrator', 'soma_inbox {}').map((s) => s.result);
if (drains.length !== 3 || drains[2].terminal !== queued.length) throw new Error('19-story.json: the last inbox drain did not fold every lead to done');
const [midStatus, finalStatus] = stepsOf('orchestrator', 'soma_status {}').map((s) => s.result);
const rowIn = (status, id) => status.leads.find((r) => r.lead === id);
for (const id of queued) {
  const mid = rowIn(midStatus, id);
  if (mid?.status !== 'spawned' || harnesses[mid.harness]?.budget_class !== mid.budget_class) throw new Error(`19-story.json: ${id} was not spawned with its harness bound after the first drain`);
  const end = rowIn(finalStatus, id);
  if (end?.status !== 'done' || end.harness !== mid.harness || !end.pr_url) throw new Error(`19-story.json: ${id} did not end done, with its harness and a PR url`);
}
const rowFor = (id) => rowIn(finalStatus, id);
const doneCount = finalStatus.counts.done;
const prCount = queued.filter((id) => rowFor(id).pr_url).length;
// The registry's harness names, as the board spells them; a renamed harness stops the build.
const HNAME = { 'ONE-SHOT-PIPELINE': 'one-shot pipeline', 'ITERATE-TO-GREEN': 'iterate to green', 'TDD-LOOP': 'TDD loop', 'RESEARCH-SPIKE': 'research spike' };
const harnessChip = (id) => {
  const r = rowIn(midStatus, id);
  const name = HNAME[harnesses[r.harness].name];
  if (!name) throw new Error(`no board name for ${harnesses[r.harness].name}`);
  return { top: `${r.harness} · ${name}`, sub: `${r.budget_class} budget · ${M(defaults.budgets[r.budget_class].tokens_cap)} tokens` };
};

const CAPTIONS = [
  'Your Claude Code session becomes the orchestrator.',
  'Give it a backlog.',
  'soma spins up a fleet, one lead per task.',
  'Each lead picks a harness for its job, which sets its budget.',
  'They work in parallel and ask only when they need you.',
  'Come back to draft PRs and reports, ready for your review.',
];
// Stage geometry (px): the session panel, the bus, four lead cards. timeline.js reads the pulse
// routes from the markup, so the numbers live here only.
const ST = { panel: { x: 104, y: 150, w: 660, h: 600 }, bus: { x: 840, y: 170, w: 44, h: 600 }, card: { x: 956, w: 860, h: 128, y0: 170, gap: 24 } };
const cardY = (i) => ST.card.y0 + i * (ST.card.h + ST.card.gap);
const cardCy = (i) => cardY(i) + ST.card.h / 2;
const panelR = ST.panel.x + ST.panel.w, panelCy = ST.panel.y + ST.panel.h / 2;
const stBusX = ST.bus.x + ST.bus.w / 2;
const upRoute = (i) => [ST.card.x, cardCy(i), stBusX, cardCy(i), stBusX, panelCy, panelR, panelCy];
const downRoute = (i) => { const r = upRoute(i); return [r[6], r[7], r[4], r[5], r[2], r[3], r[0], r[1]]; };
// Seconds into the story (its first beat = 0). The order matches the capture, asserted above.
const ST_PULSES = [
  ...queued.map((_, i) => ({ id: `st-pm${i}`, route: upRoute(i), at: 16.4 + i * 0.2 })),
  { id: 'st-pask', route: upRoute(0), at: 17.7 },
  { id: 'st-pans', route: downRoute(0), at: 21.0, down: true },
  ...queued.map((_, i) => ({ id: `st-pc${i}`, route: upRoute(i), at: 23.3 + i * 0.25 })),
];
// The latest REPORT per lead, by its exact event type (events, not task statuses): the types each
// lead filed, in order, as asserted against EXPECT above.
const EV_KEY = { STARTED: 'started', MILESTONE: 'milestone', NEEDS_INPUT: 'needs', COMPLETED: 'done' };
const evChips = (id) => [...new Set(EXPECT[id].split(' ').filter((t) => t !== 'HARNESS'))].map((t) => [EV_KEY[t],
  t]);
// Each card's real task STATUS, from soma_status: `spawned` mid-story, `done` (with its draft PR) at the end.
const statusLines = (id) => [
  ['spawned', rowIn(midStatus, id).status],
  ['done', `${rowFor(id).status} · ${rowFor(id).harness === 'H6' ? 'report + draft PR' : 'draft PR'}`],
];
const storyScene = `
    <section class="scene" data-layout-allow-overflow id="story">
      <div class="st-tag"><span class="pip"></span>recreated from real soma output · sandboxed demo</div>
      <div class="st-cols" id="st-cols" style="left:${ST.card.x + 26}px;top:${ST.card.y0 - 36}px"><span>lead · status</span><span>harness · budget class</span><span>latest report</span></div>
      <div class="st-bus" id="st-bus" style="left:${ST.bus.x}px;top:${ST.bus.y}px;width:${ST.bus.w}px;height:${ST.bus.h}px"></div>
      <div class="st-buslabel" id="st-buslabel" style="left:${ST.bus.x - 58}px;top:${ST.bus.y + ST.bus.h + 14}px">soma bus</div>
      <svg class="st-wires" viewBox="0 0 1920 1080" aria-hidden="true" data-layout-ignore>
        <path class="st-wire" id="st-w-orch" d="M${panelR} ${panelCy} H${ST.bus.x}" pathLength="1"/>
        ${queued.map((_, i) => `<path class="st-wire" id="st-w${i}" d="M${ST.bus.x + ST.bus.w} ${cardCy(i)} H${ST.card.x}" pathLength="1"/>`).join('\n        ')}
        ${ST_PULSES.map((p) => `<circle class="st-pulse${p.down ? ' down' : ''}" id="${p.id}" r="9" cx="${p.route[0]}" cy="${p.route[1]}" data-route="${p.route.join(' ')}" data-at="${p.at}"/>`).join('\n        ')}
      </svg>
      <div class="st-panel" id="st-panel" style="left:${ST.panel.x}px;top:${ST.panel.y}px;width:${ST.panel.w}px;height:${ST.panel.h}px">
        <div class="term-bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="term-title">your Claude Code session</span><span class="st-badge" id="st-badge">orchestrator</span></div>
        <div class="st-chat">
          <div class="st-group" id="st-ga">
            <div class="msg you" id="st-m1"><span class="typed" data-text="/soma-promote"></span><span class="caret"></span></div>
            <div class="msg orch" id="st-m2"><b>This session is now the orchestrator.</b><small>soma tools: ${toolsBefore} → ${toolsAfter}</small></div>
            <div class="msg you" id="st-m3"><span class="typed" data-text="Here are ${queued.length} tickets. Get them done."></span><span class="caret"></span></div>
            <div class="msg orch" id="st-m4"><b>Queued ${queued.length} tasks.</b><div class="st-ids">${queued.map((id) => `<span>${esc(id)}</span>`).join('')}</div></div>
          </div>
          <div class="st-group" id="st-gb">
            <div class="msg orch ask" id="st-m5"><b>fix-login-bug asks:</b> ${esc(ask)}</div>
            <div class="msg you" id="st-m6"><span class="typed" data-text="${esc(sent.args.message)}"></span><span class="caret"></span></div>
            <div class="msg orch" id="st-m7"><b>Sent to fix-login-bug.</b></div>
            <div class="msg orch" id="st-m8"><b>${doneCount} done · ${prCount} draft PRs to review.</b></div>
          </div>
        </div>
      </div>
      ${queued.map((id, i) => {
        const h = harnessChip(id);
        return `<div class="st-card" id="st-l${i}" style="left:${ST.card.x}px;top:${cardY(i)}px;width:${ST.card.w}px;height:${ST.card.h}px">
        <div class="st-who"><div class="st-id">${esc(id)}</div><div class="st-status" id="st-s${i}">${statusLines(id).map(([k, t]) => `<span class="ss ss-${k}">${esc(t)}</span>`).join('')}</div></div>
        <div class="st-h" id="st-h${i}"><b>${esc(h.top)}</b><small>${esc(h.sub)}</small></div>
        <div class="st-ev" id="st-e${i}">${evChips(id).map(([k, t]) => `<span class="ev ev-${k}">${t}</span>`).join('')}</div>
      </div>`;
      }).join('\n      ')}
      <div class="st-cap">
        ${CAPTIONS.map((c, i) => `<div class="st-cblock" id="st-c${i}"><div class="st-step">${i + 1} / ${CAPTIONS.length}${i >= 2 ? '<span class="st-lapse"> · time-lapse</span>' : ''}</div><div class="st-line">${esc(c)}</div></div>`).join('\n        ')}
        <div class="st-small" id="st-small2">after <code>soma up</code> · leads start one at a time</div>
        <div class="st-small" id="st-small5">drafts only · a human reviews and merges</div>
      </div>
    </section>`;

// The call to action, then the break into the technical half.
const ctaScene = `
    <section class="scene" data-layout-allow-overflow id="cta">
      <div class="cta">
        <div class="cta-kicker">Get started</div>
        <div class="o-url" id="cta-url">${esc(REPO_URL)}</div>
        <div class="cta-steps" id="cta-steps">clone · soma init · soma up · /soma-promote</div>
        <div class="cta-status" id="cta-status">v0.1 · built for supervised use · read RUNBOOK.md first</div>
      </div>
    </section>`;
const devScene = `
    <section class="scene" data-layout-allow-overflow id="dev">
      <div class="dev">
        <div class="dev-rule"></div>
        <div class="dev-title">For developers</div>
        <div class="dev-sub">how it works, from real captured output</div>
      </div>
    </section>`;

// Scene 2 — the architecture, every label checked against bin/.
const LEADS = ['fix-login-bug', 'add-rate-limit', 'docs-quickstart'];
const LEAD_Y = [10, 190, 370];
const s2 = `
    <section class="scene" data-layout-allow-overflow id="s2">
      ${label('01', 'how it fits together')}
      ${headline('One orchestrator, a fleet of leads, one bus.')}
      <div class="diagram">
        <svg class="wires" viewBox="0 0 1712 690" aria-hidden="true">
          <path class="wire" id="w-op" d="M230 118 L230 168" pathLength="1"/>
          <path class="wire" id="w-orch" d="M462 330 L548 330" pathLength="1"/>
          ${LEAD_Y.map((y, i) => `<path class="wire" id="w-lead${i}" d="M636 ${y + 70} L740 ${y + 70}" pathLength="1"/>`).join('\n          ')}
          ${LEAD_Y.map((y, i) => `<path class="wire" id="w-pr${i}" d="M1416 ${y + 70} L1500 ${y + 70}" pathLength="1"/>`).join('\n          ')}
          ${[0, 1, 2].map((i) => `<circle class="pulse" id="pulse${i}" r="9" cx="0" cy="0"/>`).join('\n          ')}
          <circle class="pulse down" id="pulse-down" r="9" cx="0" cy="0"/>
        </svg>
        <div class="node-card op" id="d-op">
          <div class="nc-title">operator, at a terminal</div>
          <div class="nc-line">soma init · doctor · enqueue</div>
          <div class="nc-line">soma up · status · digest</div>
        </div>
        <div class="via" id="d-via">/soma-promote</div>
        <div class="node-card orch" id="d-orch">
          <div class="nc-kicker">orchestrator</div>
          <div class="nc-big">a Claude Code session</div>
          <div class="nc-line">promoted in one tool call: it takes the fleet lease</div>
          <div class="nc-line">${esc('12 soma_* tools: enqueue · spawn · inbox · send · kill · resume …')}</div>
          <div class="nc-line">reads reports with soma_inbox, answers with soma_send</div>
        </div>
        <div class="busbar" id="d-bus"><span>MCP bus</span><small>soma-bus.mjs · stdio JSON-RPC</small></div>
        <div class="bus-note up" id="d-up">↑ soma_report</div>
        <div class="bus-note down" id="d-down">↓ soma_send</div>
        ${LEADS.map((id, i) => `<div class="node-card lead" id="d-lead${i}" style="top:${LEAD_Y[i]}px">
          <div class="nc-title amber">lead · ${id}</div>
          <div class="nc-pair"><span>tmux</span>lead-${id}</div>
          <div class="nc-pair"><span>worktree</span>soma/${id}</div>
        </div>
        <div class="pr" id="d-pr${i}" style="top:${LEAD_Y[i] + 42}px">draft PR</div>`).join('\n        ')}
        <div class="lead-legend" id="d-legend">every lead: <b>opus · effort max</b> · its own agent team · ${esc('3 soma_* tools')}</div>
        <div class="pr-note" id="d-prnote">soma-pr: always --draft</div>
        <div class="watchdog" id="d-wd">
          <div class="wd-title">watchdog</div>
          <div class="wd-items">
            <span>every ${defaults.tick_ms / 1000} s</span><span>admit ≤ max_leads, ${defaults.stagger_s} s apart</span><span>revive dead leads</span><span>meter budgets</span><span>rotate seats on usage limits</span>
          </div>
        </div>
      </div>
    </section>`;

// Scene 4 — the spend gate.
const worst = 114000000;
const s4 = `
    <section class="scene" data-layout-allow-overflow id="s4">
      ${label('02', 'spend gate')}
      ${headline('Worst case first. Then you type yes.')}
      <div class="row s4-row">
        ${term('s4-term', 'sandboxed demo shell', `${cmd('s4-c1', 'soma up')}${out(upProjection, 'g1')}
          <div class="ln out g2 prompt"><span>${esc(upPrompt)}</span><span class="typed" data-text="${upAnswer}"></span><span class="caret"></span></div>${out([upAbort], 'g3 warn')}`, 'wide')}
        <div class="col-right s4-side">
          <div class="stat" id="s4-stat"><div class="stat-num" id="s4-num">0</div><div class="stat-cap">est_tokens · worst case at max_leads 3</div></div>
          <div class="callout" id="s4-call1"><b>No <code>--yes</code> flag.</b> With no terminal to ask, <code>soma up</code> refuses:</div>
          <div class="quote" id="s4-quote">“${esc(upNoTty.slice(upNoTty.indexOf('soma will not'), upNoTty.indexOf('Run `soma up`') - 1))}”</div>
        </div>
      </div>
      ${realTag()}
    </section>`;

// Scene 8 — guardrails: the PreToolUse gate and the worktree deny list.
const gateRow = (cls, who, tool, input, reason) => `<div class="grow ${cls}">
          <div class="g-head"><span class="g-who">${esc(who)}</span><span class="g-tool">${esc(tool)}</span><span class="g-in">${esc(input)}</span><span class="g-verdict">deny</span></div>
          <div class="g-reason">${esc(reason)}</div>
        </div>`;
const deny = fanout.guard.permissions.deny;
const allow = fanout.guard.permissions.allow;
const shownDeny = ['Bash(gh pr create*)', 'Bash(gh pr merge*)', 'Bash(gh pr ready*)', 'Bash(git push*origin main)', 'Bash(git push*origin develop)', 'Bash(*.ssh/id_*)', 'Read(~/.aws/**)'];
for (const r of shownDeny) if (!deny.includes(r)) throw new Error(`guard file lacks ${r}`);
const prArgv = argvLines.PR;
const s8 = `
    <section class="scene" data-layout-allow-overflow id="s8">
      ${label('03', 'guardrails')}
      ${headline('Guardrails sit outside the model.')}
      <div class="row s8-row">
        <div class="gates" id="s8-gates">
          <div class="gates-head">bin/hooks/lead-gate.mjs, the PreToolUse hook on every tool call</div>
          ${gateRow('r1', 'lead', 'Bash', 'git push origin soma/fix-login-bug', denyReason('lead: git push'))}
          ${gateRow('r2', 'teammate', 'Bash', "echo '{}' > .claude/settings.local.json", denyReason('teammate: overwrite the guard file'))}
          ${gateRow('r3', 'teammate', 'MCP', 'mcp__soma__soma_adopt', denyReason('teammate: reach the soma bus'))}
        </div>
        <div class="guard" id="s8-guard">
          <div class="guard-head">.claude/settings.local.json, written into every worktree</div>
          <pre class="guard-body"><span class="gk">"deny"</span>: [ <span class="gc">${deny.length} rules</span>
${shownDeny.map((r) => `  <span class="gd">"${esc(r)}"</span>,`).join('\n')}
  <span class="gc">…</span> ],
<span class="gk">"allow"</span>: [ <span class="ga">"${esc(allow.find((r) => r.startsWith('Bash(node */')))}"</span>, <span class="gc">…</span> ]</pre>
          <div class="pr-box" id="s8-pr">
            <div class="pr-in">soma-pr --title "Fix login for capitalised usernames"</div>
            <div class="pr-in">        <b>-fd=false --draft=false</b></div>
            <div class="pr-out">→ gh ${esc(prArgv.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' '))}</div>
          </div>
        </div>
      </div>
      ${realTag('hook decisions and generated rules from the sandbox')}
    </section>`;

// Scene 9 — budgets and the watchdog.
const tripReason = denyReason('budget tripped: lead runs the tests');
const s9 = `
    <section class="scene" data-layout-allow-overflow id="s9">
      ${label('04', 'budgets and the watchdog')}
      ${headline(`A breaker on every lead. A watchdog every ${defaults.tick_ms / 1000} s.`)}
      <div class="row s9-row">
        ${term('s9-term', 'sandboxed demo shell · lead-gate.mjs after a budget trip', `${cmd('s9-c1', ': > "$SOMA_HOME/leads/fix-login-bug/BUDGET_TRIPPED"')}
          <div class="ln out note b0">the file the watchdog writes when a lead spends 100 % of its class</div>
          <div class="ln out b1"><span class="g-who">lead</span> Bash npm test  <span class="pill deny">deny</span></div>
          <div class="ln out b2 reason">${esc(tripReason)}</div>
          <div class="ln out b3"><span class="g-who">teammate</span> Edit  <span class="pill deny">deny</span> <span class="dimj">same reason: teammates are bound by the same breaker</span></div>
          <div class="ln out b4"><span class="g-who">lead</span> mcp__soma__soma_report  <span class="pill ok">allowed</span> <span class="dimj">so it can still report and wind down</span></div>`, 'wide')}
        <div class="wdlist" id="s9-wd">
          <div class="wd-head">soma-watchdog.mjs, each tick</div>
          <div class="wdi"><b>every ${defaults.tick_ms / 1000} s</b>one snapshot, eight pure decision functions</div>
          <div class="wdi"><b>admit</b>max_leads (default ${defaults.max_leads}), one per tick, ${defaults.stagger_s} s stagger</div>
          <div class="wdi"><b>revive</b>resume first; 3 attempts, then GAVE_UP</div>
          <div class="wdi"><b>meter</b>BUDGET event at 80 %; BUDGET_TRIPPED at 100 %</div>
          <div class="wdi"><b>rotate</b>a usage limit closes the lead's seat and moves it to the next open one; cross-seat resume not yet proven by a real rotation (RUNBOOK §10)</div>
          <div class="wdi"><b>backpressure</b>the org spend cap freezes admission until <code>soma thaw</code></div>
          <div class="wdi"><b>pane census</b>flags dialogs and bare shells in lead panes</div>
        </div>
      </div>
      ${realTag('gate decisions from the sandbox · watchdog list from bin/')}
    </section>`;

// Scene 10 — the suite.
const testsN = Number((testSummary.find((l) => l.startsWith('ℹ tests')) || '').replace(/\D/g, ''));
const s10 = `
    <section class="scene" data-layout-allow-overflow id="s10">
      ${label('05', 'tested')}
      ${headline(`${fmt(testsN)} tests. Zero runtime dependencies.`)}
      <div class="row s10-row">
        ${term('s10-term', 'sandboxed demo shell · a git archive copy of the repo', `${cmd('s10-c1', 'npm test')}${out(testHeader, 'g1 dimline')}${out([testElided], 'g1 elided')}${out(testTail, 'g2 tick wrap')}${out(testSummary, 'g3 sum')}`, 'wide')}
        <div class="col-right s10-side">
          <div class="stat" id="s10-stat"><div class="stat-num" id="s10-num" data-to="${testsN}">0</div><div class="stat-cap">node:test cases, run in the sandbox</div></div>
          <div class="callout small" id="s10-call">The 1 skip needs the operator’s own Claude Code transcripts, and the sandbox has none.</div>
        </div>
      </div>
      ${realTag()}
    </section>`;

// Scene 11 — seat rotation: the seat pool through `soma status`, and the behaviour as the suite
// pins it. The pool is seeded by seats.close() — what the limits phase calls — and no lead moves.
const seatsDemo = lines(read('16-seats-demo.txt'));
const statusSeats = lines(read('17-status-seats.txt'));
const statusHead = statusSeats.slice(0, statusSeats.findIndex((l) => l === ''));
if (!statusHead.some((l) => l.startsWith('seats: '))) throw new Error('17-status-seats.txt has no seats: line');
const rotPattern = lines(read('18-rotation-pattern.txt'))[0];
const rotLog = lines(read('18-rotation-tests.txt'));
const rotTicks = rotLog.filter((l) => l.startsWith('✔'));
// The summary is cut after `fail` (the lines after it are contiguous), so ONE marker sits exactly
// where the cut is and counts what it hides. Same for the status excerpt: its header is shown and
// everything after the first blank line is counted, never dropped silently.
const rotSumStart = rotLog.findIndex((l) => l.startsWith('ℹ '));
const rotFailIdx = rotLog.findIndex((l) => l.startsWith('ℹ fail '));
if (rotSumStart < 0 || rotFailIdx < rotSumStart) throw new Error('18-rotation-tests.txt has no summary through `fail`');
const rotSummary = rotLog.slice(rotSumStart, rotFailIdx + 1);
const rotElided = `[… ${rotLog.length - (rotFailIdx + 1)} lines elided …]`;
if (rotLog.slice(0, rotSumStart).length !== rotTicks.length) throw new Error('18-rotation-tests.txt has lines other than results before its summary');
const statusElided = `[… ${statusSeats.length - statusHead.length} lines elided …]`;
const rotCmd = `node --test --test-name-pattern='${rotPattern}' test/watchdog.tick.test.mjs test/seats.test.mjs`;
const s11 = `
    <section class="scene" data-layout-allow-overflow id="s11">
      ${label('06', 'seat rotation')}
      ${headline('Seat rotation — built, early, supervised use.')}
      <div class="row s11-row">
        ${term('s11-pool', 'sandboxed demo shell · two seats in soma.json', `${cmd('s11-c1', 'node work/seats-demo.mjs')}${out(seatsDemo, 'p1')}${cmd('s11-c2', 'soma status')}${statusHead.map((l) => `
          <div class="ln out p2${l.startsWith('seats: ') ? ' hot seatline' : ''}">${esc(l)}</div>`).join('')}
          <div class="ln out p2 elided">${esc(statusElided)}</div>`, 'pool')}
        ${term('s11-tests', 'sandboxed demo shell · the rotation tests, by name', `
          <div class="ln cmd" id="s11-c3"><span class="ps">$</span> <span class="typed" data-text="${esc(rotCmd)}"></span><span class="caret"></span></div>${out(rotTicks, 'r1 tick wrap')}${out(rotSummary, 'r2 sum')}${out([rotElided], 'r2 elided')}`, 'tests')}
      </div>
      <div class="flow" id="s11-flow">A usage-limit hit closes that seat until its reset (at least 5 min); the lead is killed and resumed, same session, under the first open, logged-in seat in soma.json order (at most 3 moves an hour). No open seat: it stays put. The org spend cap freezes admission until <code>soma thaw</code>. Cross-seat resume is not yet proven by a real rotation (RUNBOOK §10).</div>
      ${realTag('seat pool seeded in the sandbox with seats.close(); no lead was moved')}
    </section>`;

// Scene 12 — outro, carrying the honest status line.
const s12 = `
    <section class="scene" data-layout-allow-overflow id="s12">
      <div class="outro">
        <div class="o-mark">${esc(NAME)}</div>
        <div class="o-url">${esc(REPO_URL)}</div>
        <div class="o-status">v0.1 · built for supervised use · read RUNBOOK.md first</div>
        <div class="o-line">Node 24+ · tmux ≥ 3.2 · git ≥ 2.31 · macOS · Linux · Windows via WSL2</div>
      </div>
    </section>`;

/* ----------------------------------------------------------------------------- the page */

const DURATION = 88.5;
const css = readFileSync(join(HERE, 'styles.css'), 'utf8');
const timeline = readFileSync(join(HERE, 'timeline.js'), 'utf8');

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <title>${esc(NAME)} showcase</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
${css}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${DURATION}" data-width="1920" data-height="1080">
      <div id="bg" aria-hidden="true" data-layout-ignore>
        <div class="bg-grid"></div>
        <div class="bg-glow g1" id="glow1"></div>
        <div class="bg-glow g2" id="glow2"></div>
        <div class="bg-ghost" id="ghost">soma</div>
        <div class="bg-vignette"></div>
      </div>
${[s1, storyScene, ctaScene, devScene, s2, s4, s8, s9, s10, s11, s12].join('\n')}
      <div id="fade" aria-hidden="true"></div>
    </div>
    <script>
${timeline}
    </script>
  </body>
</html>
`;
writeFileSync(join(HERE, 'index.html'), html);
console.log(`wrote index.html (${html.length} bytes, ${DURATION}s)`);
