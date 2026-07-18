/* ============================================================================
   Fanad preview engine — a tiny player for animated module "commercials".
   Paired with fanad-preview.css.

   A per-module storyboard file calls:

     FanadPreview.play({
       bot:   { name: 'Fanad', avatar: 'F' },   // chat header
       brand: { name: 'Fanad', mark: 'F' },     // top-left badge (defaults to bot)
       hud:   { goal: 2000, unit: 'cal', label: 'Day 1' },   // bottom progress bar; omit for none
       scenes: [ async (fp) => { ... }, ... ]   // played in order, looped forever
     });

   Each scene is `async (fp) => {}`. Await the fp.* primitives; you never have to
   check for cancellation — when the demo restarts (Replay), any in-flight await
   rejects internally and the loop quietly starts over.

   fp primitives:
     fp.sleep(ms)                         wait (ms are auto-scaled by pacing)
     fp.user(text)                        user types + sends a message
     fp.typing(ms)                        bot "typing…" indicator for ms
     fp.bot(html, {fat})            -> el bot bubble; returns the bubble element
     fp.roll(el, from, to, {dur,fmt})     rolling number into el.textContent
     fp.title(lines, {hold, sub})         fullscreen kinetic title card.
                                          lines: array of strings; mark words with
                                          *accent* or _amber_.
     fp.check(text)                 -> str confirm-row HTML ("✓ <text>")
     fp.hud.day(label) / .add(n) / .reset() / .amber()
     fp.dayFlip({from, to})               clock transition; resets hud + chat + day
     fp.overlay(builder, {className})     fullscreen custom scene; builder(root, fp)
                                          may await (staged reveals)
     fp.charts.bars(mount, values, {goal,max,amber,height,goalLabel}) -> {grow()}
     fp.charts.line(mount, values, {min,max,width,height})           -> {draw()}
     fp.clearChat() / fp.reset()          reset chat (+ hud)
   ========================================================================== */
(function () {
  const CANCEL = Symbol('cancel');
  let gradSeq = 0;

  function play(config) {
    // Robust whether the <script> runs before or after the body exists (inline single-file vs shell).
    if (!document.body) { document.addEventListener('DOMContentLoaded', () => play(config)); return; }
    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const SPEED = reduced ? 0.18 : 1.5; // >1 = slower, more watchable pacing

    const bot = config.bot || { name: 'Fanad', avatar: 'F' };
    const brand = config.brand || { name: bot.name, mark: bot.avatar, logo: bot.logo };
    const hudCfg = config.hud || null;

    // Logo (an <img>) beats the letter fallback for both the badge and the chat avatar.
    const brandMark = brand.logo
      ? '<img class="mk" src="' + esc(brand.logo) + '" alt="">'
      : '<span class="mk">' + esc(brand.mark || 'F') + '</span>';
    const avatarInner = bot.logo ? '<img src="' + esc(bot.logo) + '" alt="">' : esc(bot.avatar || 'F');

    // Optional lower-right call-to-action (e.g. { label: 'Demo Signup', href: '/demo' }).
    const cta = config.cta || null;
    const ctaHtml = cta
      ? '<a class="cta-btn" href="' + esc(cta.href || '#') + '"' +
          (/^https?:/i.test(cta.href || '') ? ' target="_blank" rel="noopener"' : '') + '>' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg> ' +
          esc(cta.label || 'Learn more') + '</a>'
      : '';

    // ---- scaffold -----------------------------------------------------------
    const app = document.createElement('div');
    app.className = 'fanad-app' + (reduced ? ' reduced' : '');
    app.innerHTML =
      '<div class="sea" aria-hidden="true"><canvas width="96" height="160"></canvas></div>' +
      '<div class="brand-badge">' + brandMark + ' ' + esc(brand.name || '') +
        (brand.module ? ' <span class="brand-mod">' + esc(brand.module) + '</span>' : '') + '</div>' +
      '<div class="phone-wrap">' +
        '<div class="phone"><div class="screen">' +
          '<div class="tg-header">' +
            '<div class="avatar' + (bot.logo ? ' avatar--logo' : '') + '">' + avatarInner + '</div>' +
            '<div class="tg-meta"><span class="tg-name">' + esc(bot.name || '') + '</span>' +
            '<span class="tg-status">online</span></div>' +
          '</div>' +
          '<div class="chat"></div>' +
        '</div></div>' +
        (hudCfg ?
          '<div class="hud"><div class="hud-top">' +
            '<span class="hud-day">' + esc(hudCfg.label || 'Day 1') + '</span>' +
            '<span class="hud-cal"><b>0</b> / ' + hudCfg.goal + ' ' + esc(hudCfg.unit || '') + '</span>' +
          '</div><div class="bar"><div class="bar-fill"></div><div class="bar-goal"></div></div></div>'
          : '') +
      '</div>' +
      '<div class="layer titlecard"><div class="kinetic"></div></div>' +
      '<div class="layer dayflip"><div class="clock">' +
        '<svg viewBox="0 0 100 100" aria-hidden="true">' +
          '<circle cx="50" cy="50" r="46" fill="none" stroke="rgba(123,226,168,.25)" stroke-width="3"/>' +
          '<circle class="clock-ring" cx="50" cy="50" r="46" fill="none" stroke="var(--green)" stroke-width="3" stroke-linecap="round" stroke-dasharray="289" stroke-dashoffset="289"/>' +
          '<g class="sun"><line x1="50" y1="50" x2="50" y2="20" stroke="var(--amber-soft)" stroke-width="4" stroke-linecap="round"/>' +
          '<line x1="50" y1="50" x2="72" y2="50" stroke="#eaf7ee" stroke-width="3" stroke-linecap="round"/></g>' +
          '<circle cx="50" cy="50" r="4" fill="var(--green)"/>' +
        '</svg><div class="flip-caption"></div>' +
      '</div></div>' +
      '<div class="layer custom-scene"></div>' +
      '<div class="corner-actions">' +
        '<button class="replay" aria-label="Replay the demo">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v4h4"/></svg> Replay' +
        '</button>' + ctaHtml +
      '</div>';
    document.body.appendChild(app);

    const el = {
      chat:    app.querySelector('.chat'),
      status:  app.querySelector('.tg-status'),
      hudDay:  app.querySelector('.hud-day'),
      hudCal:  app.querySelector('.hud-cal'),
      barFill: app.querySelector('.bar-fill'),
      title:   app.querySelector('.titlecard'),
      kinetic: app.querySelector('.kinetic'),
      dayflip: app.querySelector('.dayflip'),
      custom:  app.querySelector('.custom-scene'),
      replay:  app.querySelector('.replay'),
    };

    // Mount the shared Ocean sim as the backdrop (ocean.js exposes window.mountOcean).
    const seaCanvas = app.querySelector('.sea canvas');
    if (seaCanvas && typeof window.mountOcean === 'function') {
      try { window.mountOcean(seaCanvas); } catch (e) { console.error('[fanad-preview] ocean mount failed:', e); }
    }

    // ---- run token / cancellation ------------------------------------------
    let runCounter = 0;

    function makeFp(token) {
      const live = () => token === runCounter;
      const sleep = (ms) => new Promise((res, rej) => {
        setTimeout(() => (live() ? res() : rej(CANCEL)), ms * SPEED);
      });

      const roll = (node, from, to, opts = {}) => {
        const fmt = opts.fmt || ((v) => Math.round(v));
        const dur = opts.dur || 700;
        const start = performance.now();
        return new Promise((res, rej) => {
          (function frame(now) {
            if (!live()) { rej(CANCEL); return; }
            let p = Math.min(1, (now - start) / (dur * SPEED));
            p = 1 - Math.pow(1 - p, 3);
            node.textContent = fmt(from + (to - from) * p);
            if (p < 1) requestAnimationFrame(frame); else res();
          })(start);
        });
      };

      const timeNow = () => '9:0' + (1 + Math.floor(Math.random() * 8)) + ' AM';

      function bubble(side, opts = {}) {
        const row = document.createElement('div');
        row.className = 'row ' + side;
        const b = document.createElement('div');
        b.className = 'bubble' + (opts.fat ? ' fat' : '');
        if (opts.html !== undefined) b.innerHTML = opts.html; else b.textContent = opts.text || '';
        row.appendChild(b);
        el.chat.appendChild(row);
        el.chat.scrollTop = el.chat.scrollHeight;
        return b;
      }

      const bot = (html, opts = {}) => bubble('in', { html, fat: opts.fat });

      async function typing(ms) {
        el.status.textContent = 'typing…'; el.status.classList.add('typing');
        const row = document.createElement('div'); row.className = 'row in';
        const b = document.createElement('div'); b.className = 'bubble typing-b';
        b.innerHTML = '<i></i><i></i><i></i>';
        row.appendChild(b); el.chat.appendChild(row); el.chat.scrollTop = el.chat.scrollHeight;
        try { await sleep(ms); } finally { row.remove(); el.status.classList.remove('typing'); el.status.textContent = 'online'; }
      }

      async function user(text) {
        const b = bubble('out', { html: '<span class="txt"></span><span class="time">' + timeNow() + ' <span class="tick">✓✓</span></span>' });
        const span = b.querySelector('.txt');
        const step = reduced ? text.length : 1;
        for (let i = 0; i <= text.length; i += step) {
          span.textContent = text.slice(0, i);
          el.chat.scrollTop = el.chat.scrollHeight;
          await sleep(reduced ? 2 : 38);
        }
        span.textContent = text;
      }

      async function title(lines, opts = {}) {
        el.kinetic.innerHTML = '';
        lines.forEach((line, li) => {
          const ln = document.createElement('span'); ln.className = 'line';
          line.trim().split(/\s+/).forEach((raw, wi) => {
            let cls = '', tok = raw;
            if (tok.length > 1 && tok[0] === '*' && tok[tok.length - 1] === '*') { cls = 'accent'; tok = tok.slice(1, -1); }
            else if (tok.length > 1 && tok[0] === '_' && tok[tok.length - 1] === '_') { cls = 'amberw'; tok = tok.slice(1, -1); }
            const w = document.createElement('span'); w.className = 'w' + (cls ? ' ' + cls : ''); w.textContent = tok;
            w.style.setProperty('--i', wi); w.style.setProperty('--l', li);
            ln.appendChild(w);
          });
          el.kinetic.appendChild(ln);
        });
        if (opts.sub) {
          const s = document.createElement('span'); s.className = 'sub'; s.textContent = opts.sub;
          const lastLen = lines[lines.length - 1].trim().split(/\s+/).length;
          s.style.setProperty('--sd', lines.length + lastLen * 0.27);
          el.kinetic.appendChild(s);
        }
        el.title.classList.add('show');
        await sleep(opts.hold || 1800);
        el.title.classList.remove('show');
        await sleep(560);
      }

      // ---- HUD ----
      let total = 0;
      const goal = hudCfg ? hudCfg.goal : 0;
      const unit = hudCfg ? (hudCfg.unit || '') : '';
      const renderHud = () => { if (hudCfg) el.hudCal.innerHTML = '<b>' + total + '</b> / ' + goal + ' ' + unit; };
      const hud = {
        day(label) { if (hudCfg) el.hudDay.textContent = label; },
        reset() {
          total = 0;
          if (!hudCfg) return;
          el.hudCal.classList.remove('amber'); el.barFill.classList.remove('amber');
          el.barFill.style.width = '0%'; renderHud();
        },
        amber() {
          if (!hudCfg) return;
          el.hudCal.classList.add('amber'); el.barFill.classList.add('amber'); el.barFill.style.width = '100%';
        },
        async add(n) {
          if (!hudCfg) return;
          const from = total; total += n;
          el.barFill.style.width = Math.min(100, (total / goal) * 100) + '%';
          const b = el.hudCal.querySelector('b') || el.hudCal;
          await roll(b, from, total, { dur: 700 });
          renderHud();
        },
      };

      async function dayFlip(opts = {}) {
        const df = el.dayflip;
        const ring = df.querySelector('.clock-ring');
        const sun = df.querySelector('.sun');
        df.querySelector('.flip-caption').innerHTML = esc(opts.from || '') + ' <b>→</b> ' + esc(opts.to || '');
        df.classList.add('show');
        void ring.offsetWidth;
        ring.style.transition = 'stroke-dashoffset 1.4s ease';
        ring.style.strokeDashoffset = '0';
        sun.classList.remove('spin'); void sun.offsetWidth; sun.classList.add('spin');
        try {
          await sleep(1500);
          hud.reset(); clearChat(); hud.day(opts.to || '');
          ring.style.transition = 'none'; ring.style.strokeDashoffset = '289'; sun.classList.remove('spin');
          await sleep(350);
        } finally { df.classList.remove('show'); }
        await sleep(560);
      }

      async function overlay(builder, opts = {}) {
        const layer = el.custom;
        layer.className = 'layer custom-scene ' + (opts.className || '');
        layer.innerHTML = '';
        layer.classList.add('show');
        try { await builder(layer, fp); }
        finally { layer.classList.remove('show'); }
        await sleep(560);
      }

      // ---- chart helpers ----
      const charts = {
        bars(mount, values, o = {}) {
          const max = o.max || Math.max.apply(null, values) * 1.05;
          const height = o.height || 150;
          const amber = o.amber || [];
          const wrap = document.createElement('div'); wrap.className = 'goalline';
          if (o.goal != null) {
            const gm = document.createElement('div'); gm.className = 'goalmark';
            gm.innerHTML = '<span>' + esc(String(o.goalLabel != null ? o.goalLabel : o.goal)) + '</span>';
            gm.style.top = (height - (o.goal / max) * height + 12) + 'px';
            wrap.appendChild(gm);
          }
          const bc = document.createElement('div'); bc.className = 'barchart'; bc.style.height = height + 'px';
          const cols = [];
          values.forEach((v, i) => {
            const cell = document.createElement('div'); cell.className = 'bc' + (amber.indexOf(i) >= 0 ? ' amber' : '');
            const col = document.createElement('div'); col.className = 'col';
            col.dataset.h = Math.round((v / max) * height); col.style.height = '0';
            cell.appendChild(col); bc.appendChild(cell); cols.push(col);
          });
          wrap.appendChild(bc); mount.appendChild(wrap);
          return {
            grow(stagger) {
              stagger = stagger || 80;
              cols.forEach((c, i) => setTimeout(() => { if (live()) c.style.height = c.dataset.h + 'px'; }, i * stagger * SPEED));
            },
          };
        },
        line(mount, values, o = {}) {
          const min = o.min != null ? o.min : Math.min.apply(null, values) - 0.5;
          const max = o.max != null ? o.max : Math.max.apply(null, values) + 0.5;
          const W = o.width || 420, H = o.height || 170, pad = 14;
          const xs = (i) => pad + i * ((W - 2 * pad) / (values.length - 1));
          const ys = (v) => pad + (max - v) / (max - min) * (H - 2 * pad);
          let d = 'M ' + xs(0) + ' ' + ys(values[0]);
          values.forEach((v, i) => { if (i > 0) d += ' L ' + xs(i) + ' ' + ys(v); });
          const gid = 'fpgrad' + (gradSeq++);
          const box = document.createElement('div'); box.className = 'weight-wrap';
          box.innerHTML =
            '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
              '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
                '<stop offset="0" stop-color="rgba(52,209,122,.35)"/><stop offset="1" stop-color="rgba(52,209,122,0)"/>' +
              '</linearGradient></defs>' +
              '<path class="warea" style="fill:url(#' + gid + ')" d="' + d + ' L ' + xs(values.length - 1) + ' ' + H + ' L ' + xs(0) + ' ' + H + ' Z"></path>' +
              '<path class="wpath" d="' + d + '"></path>' +
              '<g class="wend"><circle cx="' + xs(values.length - 1) + '" cy="' + ys(values[values.length - 1]) + '" r="6"/></g>' +
            '</svg>';
          mount.appendChild(box);
          const wpath = box.querySelector('.wpath'), warea = box.querySelector('.warea'), wend = box.querySelector('.wend');
          return {
            draw() { void wpath.offsetWidth; wpath.style.strokeDashoffset = '0'; warea.style.opacity = '1'; wend.style.opacity = '1'; },
          };
        },
      };

      function clearChat() { el.chat.innerHTML = ''; }

      const fp = {
        token, reduced, speed: SPEED,
        sleep, roll, user, typing, bot, bubble, title, hud, dayFlip, overlay, charts, clearChat,
        check: (text) => '<div class="confirmpop"><span class="ck">✓</span> ' + text + '</div>',
        reset() { clearChat(); hud.reset(); },
        el,
      };
      return fp;
    }

    async function run() {
      const token = ++runCounter;
      [el.title, el.dayflip, el.custom].forEach((l) => l.classList.remove('show'));
      const fp = makeFp(token);
      try {
        while (token === runCounter) {
          for (const scene of config.scenes) {
            await scene(fp);
            if (token !== runCounter) return;
          }
          await fp.sleep(400);
        }
      } catch (e) { if (e !== CANCEL) console.error('[fanad-preview] scene error:', e); }
    }

    el.replay.addEventListener('click', run);
    run();
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  window.FanadPreview = { play };
})();
