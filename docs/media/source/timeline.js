      // One paused, seek-safe timeline for the whole film. No clocks, no randomness, no network:
      // every visual state is a pure function of the timeline's time.
      const tl = gsap.timeline({ paused: true });
      const DURATION = 88.5;
      const q = (s, root = document) => root.querySelector(s);
      const qa = (s, root = document) => Array.from(root.querySelectorAll(s));

      /* ------------------------------------------------------------------ helpers */

      // Type a command into `.typed` inside `el`, char by char, driven by a proxy tween.
      function type(el, at, cps = 30) {
        const span = q('.typed', el);
        const caret = q('.caret', el);
        const text = span.getAttribute('data-text');
        const proxy = { n: 0 };
        const dur = Math.max(0.18, text.length / cps);
        const paint = () => { span.textContent = text.slice(0, Math.round(proxy.n)); };
        if (caret) tl.set(caret, { opacity: 1 }, at - 0.25);
        tl.fromTo(proxy, { n: 0 }, { n: text.length, duration: dur, ease: 'none', onUpdate: paint, onComplete: paint, onReverseComplete: paint }, at);
        if (caret) tl.set(caret, { opacity: 0 }, at + dur + 0.3);
        return at + dur;
      }

      // Lines appear one after another, as output does.
      function reveal(els, at, stagger = 0.06, dy = 8) {
        if (!els.length) return at;
        tl.fromTo(els, { opacity: 0, y: dy }, { opacity: 1, y: 0, duration: 0.22, ease: 'power2.out', stagger }, at);
        return at + stagger * (els.length - 1) + 0.22;
      }

      // Count a number up, formatted with thousands separators.
      function countUp(el, to, at, dur) {
        const proxy = { v: 0 };
        const paint = () => { el.textContent = String(Math.round(proxy.v)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
        tl.fromTo(proxy, { v: 0 }, { v: to, duration: dur, ease: 'power2.out', onUpdate: paint, onComplete: paint, onReverseComplete: paint }, at);
      }

      // Section label + headline: the rule draws, the label fades, the words rise.
      function header(scene, at) {
        tl.fromTo(q('.label .rule', scene), { scaleX: 0 }, { scaleX: 1, duration: 0.5, ease: 'expo.out' }, at);
        tl.fromTo(qa('.label .num, .label .txt', scene), { opacity: 0, x: -14 }, { opacity: 1, x: 0, duration: 0.4, ease: 'power2.out', stagger: 0.08 }, at + 0.1);
        tl.fromTo(qa('.headline .w', scene), { opacity: 0, y: 34 }, { opacity: 1, y: 0, duration: 0.55, ease: 'power3.out', stagger: 0.035 }, at + 0.18);
        const tag = q('.realtag', scene);
        if (tag) tl.fromTo(tag, { opacity: 0 }, { opacity: 1, duration: 0.6, ease: 'sine.out' }, at + 1.2);
      }

      // Scene handoff: a true push. Both scenes move together by a full frame, side by side, so they
      // never share pixels and the frame is never empty. The outro alone crossfades.
      function swap(from, to, at, kind = 'push', gap = 0.35) {
        const a = q(from), b = q(to);
        if (kind === 'up') {
          tl.to(a, { y: -1080, duration: 0.6, ease: 'power3.inOut' }, at);
          tl.fromTo(b, { y: 1080, opacity: 1 }, { y: 0, opacity: 1, duration: 0.6, ease: 'power3.inOut' }, at);
        } else if (kind === 'dip') {
          tl.to(a, { opacity: 0, duration: 0.5, ease: 'sine.in' }, at);
          tl.fromTo(b, { opacity: 0, scale: 0.97 }, { opacity: 1, scale: 1, duration: 0.9, ease: 'sine.out' }, at + gap);
        } else {
          tl.to(a, { x: -1920, duration: 0.6, ease: 'power3.inOut' }, at);
          tl.fromTo(b, { x: 1920, opacity: 1 }, { x: 0, opacity: 1, duration: 0.6, ease: 'power3.inOut' }, at);
        }
      }

      // Draw an SVG stroke that carries pathLength="1".
      const draw = (sel, at, dur = 0.35, ease = 'power2.inOut') =>
        tl.fromTo(sel, { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: dur, ease }, at);

      // A dot riding a polyline route from the markup (`data-route`: x0 y0 x1 y1 …), walked by arc
      // length, starting `offset + data-at` seconds in. Pure math on attributes: no DOM measuring.
      function ride(dot, offset = 0, dur = 0.9) {
        const pts = dot.dataset.route.split(' ').map(Number);
        const segs = [];
        let total = 0;
        for (let k = 2; k < pts.length; k += 2) {
          const len = Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]);
          segs.push({ x0: pts[k - 2], y0: pts[k - 1], x1: pts[k], y1: pts[k + 1], len, from: total });
          total += len;
        }
        const proxy = { s: 0 };
        const paint = () => {
          const d = proxy.s * total;
          const g = segs.find((sg) => d <= sg.from + sg.len) || segs[segs.length - 1];
          const f = g.len ? Math.min(1, (d - g.from) / g.len) : 1;
          dot.setAttribute('cx', (g.x0 + (g.x1 - g.x0) * f).toFixed(1));
          dot.setAttribute('cy', (g.y0 + (g.y1 - g.y0) * f).toFixed(1));
        };
        const start = offset + Number(dot.dataset.at);
        tl.set(dot, { opacity: 1 }, start);
        tl.fromTo(proxy, { s: 0 }, { s: 1, duration: dur, ease: 'power1.inOut', onUpdate: paint, onComplete: paint, onReverseComplete: paint }, start);
        tl.set(dot, { opacity: 0 }, start + dur);
        return start + dur;
      }

      /* -------------------------------------------------------------- scene timings */

      // The story (for anyone) leads; the technical half follows the "For developers" break.
      const T = { story: 4.0, cta: 31.5, dev: 36.5, s2: 39.0, s4: 47.0, s8: 54.0, s9: 62.5, s10: 70.0, s11: 74.5, s12: 83.0 };
      swap('#s1', '#story', T.story, 'dip');
      swap('#story', '#cta', T.cta, 'dip', 0.6);
      swap('#cta', '#dev', T.dev, 'push');
      swap('#dev', '#s2', T.s2, 'push');
      swap('#s2', '#s4', T.s4, 'push');
      swap('#s4', '#s8', T.s8, 'up');
      swap('#s8', '#s9', T.s9, 'push');
      swap('#s9', '#s10', T.s10, 'push');
      swap('#s10', '#s11', T.s11, 'up');
      swap('#s11', '#s12', T.s12, 'dip');

      /* --------------------------------------------------------- the shared background */

      // Still through the title and the story (which is also the README's GIF: a still background
      // keeps it small), drifting slowly from the call to action on.
      const DRIFT = T.cta + 0.6;
      tl.fromTo('#glow1', { x: 0, y: 0 }, { x: 180, y: 110, duration: DURATION - DRIFT, ease: 'sine.inOut' }, DRIFT);
      tl.fromTo('#glow2', { x: 0, y: 0 }, { x: -160, y: -80, duration: DURATION - DRIFT, ease: 'sine.inOut' }, DRIFT);
      tl.fromTo('#ghost', { x: 0 }, { x: -120, duration: DURATION - DRIFT, ease: 'none' }, DRIFT);

      /* ------------------------------------------------------------- scene 1: title */
      {
        const s = q('#s1');
        tl.fromTo(q('.kicker', s), { opacity: 0, x: -30 }, { opacity: 1, x: 0, duration: 0.6, ease: 'power3.out' }, 0.2);
        tl.fromTo(qa('.wordmark .ch', s), { opacity: 0, y: 70 }, { opacity: 1, y: 0, duration: 0.7, ease: 'power4.out', stagger: 0.04 }, 0.35);
        tl.fromTo(qa('.pitch .w', s), { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out', stagger: 0.035 }, 1.25);
        tl.fromTo(qa('.chip', s), { opacity: 0, scale: 0.85 }, { opacity: 1, scale: 1, duration: 0.45, ease: 'back.out(1.7)', stagger: 0.08 }, 2.0);
        // The architecture glyph builds left to right: the orchestrator, its wire, the bus, the
        // leads. Opacity, translation, dash offsets and attributes only: no SVG transform origin.
        tl.fromTo('.arch-orch', { opacity: 0, x: -28 }, { opacity: 1, x: 0, duration: 0.55, ease: 'power3.out' }, 0.45);
        tl.fromTo('.arch-glow', { opacity: 0 }, { opacity: 0.42, duration: 0.9, ease: 'power2.out' }, 0.6);
        tl.fromTo('#arch-w-orch', { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.35, ease: 'power2.inOut' }, 0.85);
        tl.fromTo('.arch-bus', { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.7, ease: 'power2.inOut' }, 1.0);
        tl.fromTo('.arch-bus-fill', { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'power1.out' }, 1.3);
        tl.fromTo(qa('.arch-wire.lead'), { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.35, ease: 'power2.inOut', stagger: 0.12 }, 1.4);
        tl.fromTo(qa('.arch-lead'), { opacity: 0, x: 28 }, { opacity: 1, x: 0, duration: 0.5, ease: 'power3.out', stagger: 0.12 }, 1.6);
        qa('.arch-bar').forEach((b, i) => {
          tl.fromTo(b, { attr: { width: 0 } }, { attr: { width: Number(b.dataset.w) }, duration: 0.55, ease: 'steps(8)' }, 2.0 + i * 0.12);
        });
        // Pulses ride the wires: reports (amber) from a lead through the bus into the orchestrator, one
        // send (green) back out.
        qa('.arch-pulse').forEach((p) => ride(p));
        tl.fromTo('.arch-glow', { opacity: 0.42 }, { opacity: 0.62, duration: 0.5, ease: 'sine.inOut', yoyo: true, repeat: 1, immediateRender: false }, 2.9);
      }

      /* -------------------------------------------- the story: what soma does, for anyone */
      // A re-creation from story-demo.mjs's real bus calls (the order is asserted by build.mjs).
      // R is the story's first beat; every time below is seconds after it.
      {
        const R = T.story + 0.5;
        const at = (t) => R + t;
        // Hides are fromTo with the known prior state, never a bare `to`, so a frame seeked out of
        // order renders the same as one played into.
        const hide = (sel, t, from, to, dur = 0.35) => tl.fromTo(sel, from, { ...to, duration: dur, ease: 'power2.in', immediateRender: false }, at(t));
        const cap = (i, t, last = false) => {
          tl.fromTo(`#st-c${i}`, { opacity: 0, y: 26 }, { opacity: 1, y: 0, duration: 0.55, ease: 'power3.out' }, at(t));
          if (!last) hide(`#st-c${i}`, BEATS[i + 1] - 0.4, { opacity: 1, y: 0 }, { opacity: 0, y: -16 }, 0.3);
        };
        const show = (sel, t, from = { opacity: 0, y: 14 }) => tl.fromTo(sel, from, { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out' }, at(t));
        // Event chips: the lead's latest report, crossfaded in place.
        const onCard = {};
        const chip = (i, kind, t) => {
          const box = q(`#st-e${i}`);
          if (onCard[i]) hide(q(`.ev-${onCard[i]}`, box), t, { opacity: 1, scale: 1 }, { opacity: 0 }, 0.14);
          tl.fromTo(q(`.ev-${kind}`, box), { opacity: 0, scale: 0.86 }, { opacity: 1, scale: 1, duration: 0.32, ease: 'back.out(2)', immediateRender: false }, at(t + (onCard[i] ? 0.16 : 0)));
          onCard[i] = kind;
        };
        const BEATS = [0, 4.0, 7.5, 11.5, 16.0, 23.0];
        BEATS.forEach((b, i) => cap(i, b + 0.05, i === BEATS.length - 1));

        tl.fromTo('#story .st-tag', { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'sine.out' }, at(0.2));

        // 1 — /soma-promote: one tool call, and the session holds the fleet lease.
        tl.fromTo('#st-panel', { opacity: 0, x: 526, scale: 1.12 }, { opacity: 1, x: 526, scale: 1.18, duration: 0.6, ease: 'power2.out' }, at(0));
        show('#st-m1', 0.35, { opacity: 0, y: 10 });
        const e1 = type(q('#st-m1'), at(0.5), 16);
        show('#st-m2', e1 - R + 0.45);
        tl.fromTo('#st-badge', { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.4, ease: 'back.out(2.4)' }, e1 + 0.65);

        // 2 — a backlog in plain words; the orchestrator queues it.
        show('#st-m3', 4.3, { opacity: 0, y: 10 });
        const e2 = type(q('#st-m3'), at(4.45), 40);
        show('#st-m4', e2 - R + 0.4);
        tl.fromTo(qa('#st-m4 .st-ids span'), { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.3, ease: 'power2.out', stagger: 0.12 }, e2 + 0.55);

        // 3 — the fleet: the panel steps aside, the bus and one lead per task appear.
        tl.fromTo('#st-panel', { x: 526, scale: 1.18 }, { x: 0, scale: 1, duration: 0.9, ease: 'power3.inOut', immediateRender: false }, at(7.5));
        tl.fromTo('#st-small2', { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'sine.out' }, at(8.2));
        hide('#st-small2', 11.45, { opacity: 1 }, { opacity: 0 }, 0.3);
        draw('#st-w-orch', at(8.3), 0.3);
        tl.fromTo('#st-bus', { opacity: 0, scaleY: 0 }, { opacity: 1, scaleY: 1, duration: 0.55, ease: 'power3.inOut' }, at(8.45));
        tl.fromTo('#st-buslabel', { opacity: 0 }, { opacity: 1, duration: 0.4, ease: 'sine.out' }, at(8.8));
        tl.fromTo('#st-cols', { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'sine.out' }, at(8.9));
        [0, 1, 2, 3].forEach((i) => {
          draw(`#st-w${i}`, at(8.9 + i * 0.18), 0.25);
          tl.fromTo(`#st-l${i}`, { opacity: 0, x: 60 }, { opacity: 1, x: 0, duration: 0.5, ease: 'power3.out' }, at(9.0 + i * 0.2));
          chip(i, 'started', 9.35 + i * 0.2);
          tl.fromTo(`#st-s${i} .ss-spawned`, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: 'sine.out' }, at(9.35 + i * 0.2));
        });

        // 4 — each lead's HARNESS report: the harness it picked, and the budget class that books.
        [0, 1, 2, 3].forEach((i) => tl.fromTo(`#st-h${i}`, { opacity: 0, scale: 0.88 }, { opacity: 1, scale: 1, duration: 0.45, ease: 'back.out(1.8)' }, at(12.0 + i * 0.45)));

        // 5 — parallel work, and the one question: it reaches you, you answer, soma_send delivers it.
        hide('#st-ga', 16.0, { opacity: 1, y: 0 }, { opacity: 0, y: -40 }, 0.45);
        [0, 1, 2, 3].forEach((i) => chip(i, 'milestone', 16.4 + i * 0.2));
        chip(0, 'needs', 17.6);
        show('#st-m5', 18.6);
        show('#st-m6', 19.35, { opacity: 0, y: 10 });
        const e5 = type(q('#st-m6'), at(19.5), 40);
        show('#st-m7', e5 - R + 0.3);
        chip(0, 'milestone', 22.0);
        qa('#story .st-pulse').forEach((p) => ride(p, R));

        // 6 — COMPLETED from every lead; the inbox folds each row to done, with its draft PR.
        tl.fromTo('#st-small5', { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'sine.out' }, at(23.7));
        [0, 1, 2, 3].forEach((i) => chip(i, 'done', 23.3 + i * 0.25));
        // The orchestrator's last soma_inbox folds every row to `done`: the status lines flip together.
        show('#st-m8', 25.0);
        [0, 1, 2, 3].forEach((i) => {
          hide(`#st-s${i} .ss-spawned`, 25.0, { opacity: 1 }, { opacity: 0 }, 0.2);
          tl.fromTo(`#st-s${i} .ss-done`, { opacity: 0, x: -8 }, { opacity: 1, x: 0, duration: 0.35, ease: 'power2.out', immediateRender: false }, at(25.22 + i * 0.08));
        });
      }

      /* ------------------------------------------------ the call to action, the break */
      {
        const t = T.cta;
        tl.fromTo('#cta .cta-kicker', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.7, ease: 'power3.out' }, t + 0.45);
        tl.fromTo('#cta-url', { opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1, duration: 0.6, ease: 'back.out(1.6)' }, t + 0.9);
        tl.fromTo('#cta-steps', { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out' }, t + 1.4);
        tl.fromTo('#cta-status', { opacity: 0 }, { opacity: 1, duration: 0.6, ease: 'sine.out' }, t + 1.8);
      }
      {
        const t = T.dev;
        tl.fromTo('#dev .dev-rule', { scaleX: 0 }, { scaleX: 1, duration: 0.5, ease: 'expo.out' }, t + 0.35);
        tl.fromTo('#dev .dev-title', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power3.out' }, t + 0.45);
        tl.fromTo('#dev .dev-sub', { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'sine.out' }, t + 0.9);
      }

      /* ------------------------------------------------------ scene 2: architecture */
      {
        const t = T.s2, s = q('#s2');
        header(s, t + 0.2);
        tl.fromTo('#d-op', { opacity: 0, x: -50 }, { opacity: 1, x: 0, duration: 0.5, ease: 'power3.out' }, t + 0.8);
        draw('#w-op', t + 1.15, 0.3);
        tl.fromTo('#d-via', { opacity: 0 }, { opacity: 1, duration: 0.4, ease: 'sine.out' }, t + 1.25);
        tl.fromTo('#d-orch', { opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1, duration: 0.6, ease: 'expo.out' }, t + 1.3);
        draw('#w-orch', t + 1.8, 0.3);
        tl.fromTo('#d-bus', { opacity: 0, scaleY: 0 }, { opacity: 1, scaleY: 1, duration: 0.6, ease: 'power3.inOut' }, t + 1.9);
        [0, 1, 2].forEach((i) => {
          tl.fromTo(`#d-lead${i}`, { opacity: 0, x: 90 }, { opacity: 1, x: 0, duration: 0.6, ease: 'power3.out' }, t + 2.4 + i * 0.18);
          draw(`#w-lead${i}`, t + 2.6 + i * 0.18, 0.3);
          draw(`#w-pr${i}`, t + 3.4 + i * 0.1, 0.25);
          tl.fromTo(`#d-pr${i}`, { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.45, ease: 'back.out(2)' }, t + 3.5 + i * 0.1);
        });
        tl.fromTo('#d-prnote', { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'sine.out' }, t + 3.95);
        tl.fromTo('#d-wd', { opacity: 0, scaleX: 0 }, { opacity: 1, scaleX: 1, duration: 0.7, ease: 'expo.inOut' }, t + 4.1);
        tl.fromTo(qa('#d-wd .wd-items span'), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.3, ease: 'power2.out', stagger: 0.1 }, t + 4.6);
        tl.fromTo('#d-legend', { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.45, ease: 'power2.out' }, t + 3.2);
        tl.fromTo(['#d-up', '#d-down'], { opacity: 0 }, { opacity: 1, duration: 0.4, stagger: 0.15 }, t + 5.1);
        // Reports ride the bus up to the orchestrator; an answer rides back down.
        const LY = [80, 260, 440];
        const up = (dot, y, at) => {
          tl.set(dot, { attr: { cx: 740, cy: y }, opacity: 1 }, at);
          tl.to(dot, { keyframes: [
            { attr: { cx: 592, cy: y }, duration: 0.35, ease: 'none' },
            { attr: { cx: 592, cy: 330 }, duration: 0.45, ease: 'none' },
            { attr: { cx: 462, cy: 330 }, duration: 0.3, ease: 'none' },
          ] }, at);
          tl.set(dot, { opacity: 0 }, at + 1.1);
        };
        const down = (dot, at) => {
          tl.set(dot, { attr: { cx: 462, cy: 330 }, opacity: 1 }, at);
          tl.to(dot, { keyframes: [
            { attr: { cx: 592, cy: 330 }, duration: 0.3, ease: 'none' },
            { attr: { cx: 592, cy: 80 }, duration: 0.5, ease: 'none' },
            { attr: { cx: 740, cy: 80 }, duration: 0.35, ease: 'none' },
          ] }, at);
          tl.set(dot, { opacity: 0 }, at + 1.15);
        };
        // One round, inside the scene's 8 s: three reports up, one answer down.
        up('#pulse0', LY[0], t + 5.3);
        up('#pulse1', LY[1], t + 5.7);
        up('#pulse2', LY[2], t + 6.1);
        down('#pulse-down', t + 6.6);
      }

      /* ------------------------------------------------------- scene 4: spend gate */
      {
        const t = T.s4, s = q('#s4');
        header(s, t + 0.2);
        tl.fromTo('#s4-term', { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.6, ease: 'expo.out' }, t + 0.7);
        const e1 = type(q('#s4-c1'), t + 1.2);
        const e2 = reveal(qa('#s4-term .g1'), e1 + 0.2, 0.14);
        const prompt = q('#s4-term .prompt');
        reveal([prompt], e2 + 0.25);
        tl.set(q('.caret', prompt), { opacity: 1 }, e2 + 0.3);
        const e3 = type(prompt, e2 + 1.25, 8);
        reveal(qa('#s4-term .g3'), e3 + 0.35);
        tl.fromTo('#s4-stat', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out' }, e1 + 0.3);
        countUp(q('#s4-num'), 114000000, e1 + 0.35, 1.3);
        tl.fromTo('#s4-call1', { opacity: 0, x: 30 }, { opacity: 1, x: 0, duration: 0.5, ease: 'power2.out' }, t + 4.6);
        tl.fromTo('#s4-quote', { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.7, ease: 'sine.out' }, t + 5.1);
      }

      /* ------------------------------------------------------- scene 8: guardrails */
      {
        const t = T.s8, s = q('#s8');
        header(s, t + 0.2);
        tl.fromTo('#s8-gates .gates-head', { opacity: 0 }, { opacity: 1, duration: 0.4 }, t + 0.7);
        ['r1', 'r2', 'r3'].forEach((r, i) => {
          tl.fromTo(`#s8-gates .${r}`, { opacity: 0, x: -40 }, { opacity: 1, x: 0, duration: 0.5, ease: 'power3.out' }, t + 1.0 + i * 0.9);
          tl.fromTo(`#s8-gates .${r} .g-verdict`, { scale: 0.5 }, { scale: 1, duration: 0.4, ease: 'back.out(2.5)' }, t + 1.35 + i * 0.9);
        });
        tl.fromTo('#s8-guard', { opacity: 0, x: 40 }, { opacity: 1, x: 0, duration: 0.6, ease: 'power2.out' }, t + 3.7);
        tl.fromTo('#s8-pr', { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out' }, t + 5.0);
        tl.fromTo('#s8-pr .pr-out', { opacity: 0 }, { opacity: 1, duration: 0.4, ease: 'sine.out' }, t + 5.6);
      }

      /* ------------------------------------------------ scene 9: budgets, watchdog */
      {
        const t = T.s9, s = q('#s9');
        header(s, t + 0.2);
        tl.fromTo('#s9-term', { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.6, ease: 'expo.out' }, t + 0.7);
        const e1 = type(q('#s9-c1'), t + 1.1, 38);
        ['b0', 'b1', 'b2', 'b3', 'b4'].forEach((b, i) => reveal(qa(`#s9-term .${b}`), e1 + 0.2 + i * 0.45, 0, 6));
        tl.fromTo('#s9-wd .wd-head', { opacity: 0 }, { opacity: 1, duration: 0.4 }, t + 2.6);
        tl.fromTo(qa('#s9-wd .wdi'), { opacity: 0, x: 30 }, { opacity: 1, x: 0, duration: 0.45, ease: 'power2.out', stagger: 0.22 }, t + 2.9);
      }

      /* ------------------------------------------------------------- scene 10: tests */
      {
        const t = T.s10, s = q('#s10');
        header(s, t + 0.2);
        tl.fromTo('#s10-term', { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.6, ease: 'expo.out' }, t + 0.5);
        const e1 = type(q('#s10-c1'), t + 0.9);
        reveal(qa('#s10-term .g1'), e1 + 0.15, 0.08);
        reveal(qa('#s10-term .g2'), e1 + 0.4, 0.07);
        reveal(qa('#s10-term .g3'), e1 + 0.9, 0.06);
        tl.fromTo('#s10-stat', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power3.out' }, e1 + 0.9);
        countUp(q('#s10-num'), Number(q('#s10-num').getAttribute('data-to')), e1 + 0.95, 1.0);
        tl.fromTo('#s10-call', { opacity: 0 }, { opacity: 1, duration: 0.5, ease: 'sine.out' }, e1 + 1.8);
      }

      /* ----------------------------------------------------- scene 11: seat rotation */
      {
        const t = T.s11, s = q('#s11');
        header(s, t + 0.2);
        tl.fromTo('#s11-pool', { opacity: 0, x: -40 }, { opacity: 1, x: 0, duration: 0.55, ease: 'power3.out' }, t + 0.6);
        const e1 = type(q('#s11-c1'), t + 0.95, 36);
        reveal(qa('#s11-pool .p1'), e1 + 0.12);
        const e2 = type(q('#s11-c2'), e1 + 0.45, 30);
        reveal(qa('#s11-pool .p2'), e2 + 0.12, 0.06);
        tl.fromTo('#s11-pool .seatline', { backgroundColor: 'rgba(242, 180, 65, 0)' }, { backgroundColor: 'rgba(242, 180, 65, 0.14)', duration: 0.5, ease: 'sine.out', immediateRender: false }, e2 + 0.9);
        tl.fromTo('#s11-tests', { opacity: 0, x: 40 }, { opacity: 1, x: 0, duration: 0.55, ease: 'expo.out' }, t + 2.9);
        const e3 = type(q('#s11-c3'), t + 3.2, 120);
        reveal(qa('#s11-tests .r1'), e3 + 0.15, 0.16, 6);
        reveal(qa('#s11-tests .r2'), e3 + 1.25, 0.08, 6);
        tl.fromTo('#s11-flow', { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power2.out' }, t + 6.4);
      }

      /* ------------------------------------------------------------- scene 12: outro */
      {
        const t = T.s12;
        tl.fromTo('#s12 .o-mark', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.8, ease: 'power3.out' }, t + 0.5);
        tl.fromTo('#s12 .o-url', { opacity: 0, scale: 0.94 }, { opacity: 1, scale: 1, duration: 0.6, ease: 'back.out(1.6)' }, t + 1.1);
        tl.fromTo('#s12 .o-status', { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.6, ease: 'power2.out' }, t + 1.6);
        tl.fromTo('#s12 .o-line', { opacity: 0 }, { opacity: 1, duration: 0.6, ease: 'sine.out' }, t + 2.0);
        tl.fromTo('#fade', { opacity: 0 }, { opacity: 1, duration: 1.0, ease: 'sine.in' }, DURATION - 1.0);
      }

      window.__timelines['main'] = tl;
