/* Vendored from shared/oceanSim.js — regenerate with: sed "s/^export //" shared/oceanSim.js. Exposes window.mountOcean. */
// The Ocean water simulation — the ONE copy of the sea, shared by two surfaces:
//   · the web app's Ocean theme backdrop (web/src/OceanBackdrop.jsx imports it as a module)
//   · the public /demo signup page (server/routes/demo.js reads THIS FILE off disk, strips the
//     `export ` keywords, and inlines it as a classic script tag — so keep it dependency-free, no
//     imports, no module syntax beyond the leading `export`s. The inliner escapes any script-close
//     sequence, but don't tempt it: an earlier revision of THIS COMMENT spelled the closing tag out
//     and truncated the page at that very character.
//
// A top-down sea that follows YOUR CLOCK — a bright lagoon by day, golden at dawn/dusk, a dark
// night sea raked by the lighthouse's sweeping beam after dark — built the way old PCs actually did it:
// NOT tracked wave objects, but a per-pixel FEEDBACK loop. Two height buffers run the classic
// water convolution every frame
//     next = (left + right + up + down) / 2 - prev,   damped, buffers swapped
// so injected wavefronts genuinely PROPAGATE — they ripple, interfere, reflect, and die on the sand.
// The visible marching crests are just moving lines of energy dropped into the grid; physics does the
// rest. Rendering shades a pre-baked painted seabed by the height field's north-south gradient
// (refracted-light look), whitening into foam where waves pile up in the shallows.
//
// The day/night dressing is POST-PROCESS in the spirit of the early-2000s Java water applets, added
// on top of the base shading and DISTORTED BY THE HEIGHT FIELD rather than drawn statically: after
// dark, the Fanad beam — a lighthouse CONE pivoting from a lantern just above the top edge, each
// pixel's sample OFFSET by the water's E-W gradient (the displaced-column reflection every Java
// lake applet used) so the swells bend and shred the light as it rakes across the sea. The beam
// keeps a real light's rhythm: one quick pass, then a long dark dwell — the wait IS the character.
// The seabed palette itself lerps night↔day (rebaked only when the quantized sun phase moves).
//
// Perf: the whole effect lives on one 96×160 canvas (15.4k cells) stretched over a ≤720px column
// with image-rendering:pixelated — a fixed cost no matter the monitor. ~24fps time-gated, paused on
// hidden tabs, a warmed-up still frame under prefers-reduced-motion, and a self-degrade probe that
// freezes the scene if even this bothers the machine. No filters, no per-frame allocation.

// Portrait grid: the canvas covers a portrait COLUMN (≤720px wide, viewport tall), so the sim runs
// portrait too — cells upscale roughly square instead of smearing vertically.
const OCEAN_W = 96;
const OCEAN_H = 160;
const W = OCEAN_W;
const H = OCEAN_H;
const FRAME_MS = 1000 / 24;
const PHASE_MS = 5000;                // how often the sun phase is re-read from the clock
const SHORE_TOP = H - 16;             // where the shallows begin: heavier damping + foam
const CRESTS = 4;                     // few, big, unhurried waves — Besaid, not the North Sea

// Deterministic "randomness" (no Math.random anywhere — stable, seedable, fast). GOTCHA: tops out
// at 0.5 by construction — bit 31 of h^(h>>16) is always 0 — so thresholds above 0.5 never fire.
const hash = (x, y) => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = ((h ^ (h >> 13)) * 1274126177) | 0;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
};
const fade = (t) => t * t * (3 - 2 * t);
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

// 2D value noise on a lattice wrapping every `period` cells — tileable; bakes the textures and shapes
// the injected wavefront profiles so no crest is a clean line.
function vnoise(x, y, period, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = fade(x - xi);
  const fy = fade(y - yi);
  const w = (i, j) => hash((((i % period) + period) % period) + seed * 7919, ((j % period) + period) % period);
  const a = w(xi, yi);
  const b = w(xi + 1, yi);
  const c = w(xi, yi + 1);
  const d = w(xi + 1, yi + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

// ── The sun phase ───────────────────────────────────────────────────────────────────────────────

// Depth ramps, open sea → shallows, one per end of the day. Both are SMOOTH saturated gradients
// (no posterized bands; the painted feel comes from the mottle) sharing the same stop positions so
// they lerp cleanly. Night is the original Besaid-at-night ramp; day is the same lagoon with the sun
// up — brighter and greener, but kept short of white so the dark-glass UI stays readable over it.
const STOPS_NIGHT = [
  [0.00, 8, 30, 56],
  [0.35, 12, 48, 82],
  [0.65, 16, 70, 104],
  [0.85, 24, 96, 122],
  [1.00, 34, 118, 138],
];
const STOPS_DAY = [
  [0.00, 13, 74, 126],
  [0.35, 20, 104, 150],
  [0.65, 30, 138, 166],
  [0.85, 50, 168, 178],
  [1.00, 74, 194, 190],
];

// Where the sun is, from the local wall clock (the theme's own auto mode uses the same clock, so the
// sea and the UI agree about "after dark"). day: 0 = deep night … 1 = full daylight, ramping through
// dawn 05:30–07:30 and dusk 17:30–19:30. warm: the golden-hour bump (peaks mid-ramp, 0 at noon and
// midnight).
// Dev/tuning knob: localStorage 'fanad-sea-hour' (e.g. "13.5") pins the clock — how the four looks
// get eyeballed without waiting for the planet.
function sunPhase() {
  let t;
  try { t = parseFloat(localStorage.getItem('fanad-sea-hour')); } catch { t = NaN; }
  if (!Number.isFinite(t)) { const d = new Date(); t = d.getHours() + d.getMinutes() / 60; }
  const day = fade(clamp01((t - 5.5) / 2)) * (1 - fade(clamp01((t - 17.5) / 2)));
  const warm = day * (1 - day) * 4;
  return { day, warm, key: `${(day * 32) | 0}:${(warm * 16) | 0}` };
}

// ── The Fanad beam ──────────────────────────────────────────────────────────────────────────────

// The lighthouse itself never appears — only its light does. The lantern pivots at a fixed point
// just above the top edge; its cone sweeps the water left → right in one quick pass, then goes dark
// for the rest of the cycle (a real light's rhythm: the flash is brief, the wait is long).
const BEAM_PERIOD = 16000;   // ms from the start of one pass to the start of the next
const BEAM_PASS = 3600;      // ms the cone spends crossing the water — quick against the long dwell
const BEAM_X = W * 0.5;      // the lantern sits mid-width…
const BEAM_Y = -6;           // …this many rows off-canvas (the cone's pivot point)

// Where the beam is within its cycle: null during the dark dwell, else the cone's tilt (as a tan —
// x per row of depth) and an envelope that arrives fast and lets go slowly ("sweeps and fades").
function beamAt(t) {
  const u = (t % BEAM_PERIOD) / BEAM_PASS; // 0→1 across the pass, >1 for the rest of the cycle
  if (u >= 1) return null;
  const env = u < 0.12 ? u / 0.12 : u < 0.4 ? 1 : 1 - fade((u - 0.4) / 0.6);
  return { env, slope: (u * 2 - 1) * 0.62 };
}

// Light blooms drifting on the surface (the "bokeh" half of the scene) — aqua and sun-gold glow.
// At night they carry the scene; in daylight they thin out and the water's own contrast takes over.
const BLOOMS = [
  { r: 42, tint: '120,220,235', a: 0.10, sx: 0.00006, sy: 0.00004, ox: 0.28, oy: 0.30, wx: 0.16, wy: 0.10 },
  { r: 34, tint: '90,180,230', a: 0.08, sx: 0.00004, sy: 0.00006, ox: 0.72, oy: 0.55, wx: 0.14, wy: 0.12 },
  { r: 28, tint: '240,220,150', a: 0.06, sx: 0.00005, sy: 0.00003, ox: 0.48, oy: 0.78, wx: 0.18, wy: 0.06 },
];

// ── Bake-once assets ────────────────────────────────────────────────────────────────────────────

// The painted seabed the light plays over: the night↔day ramp lerped by the sun phase, warmed by the
// golden-hour tint, over a broad static mottle (hand-painted feel, no banding). Returned as raw RGBA —
// the render pass reads it directly. Re-baked only when the quantized phase moves (~every few minutes
// during dawn/dusk, never at noon or midnight), so it stays a bake, not a per-frame cost.
function bakeBackground(day, warm) {
  const data = new Uint8ClampedArray(W * H * 4);
  const wr = warm * 44;
  const wg = warm * 16;
  const wb = warm * -14;
  for (let y = 0; y < H; y++) {
    const fy = y / (H - 1);
    let s = 0;
    while (s + 1 < STOPS_NIGHT.length && fy > STOPS_NIGHT[s + 1][0]) s++;
    const na = STOPS_NIGHT[s];
    const nb = STOPS_NIGHT[Math.min(s + 1, STOPS_NIGHT.length - 1)];
    const da = STOPS_DAY[s];
    const db = STOPS_DAY[Math.min(s + 1, STOPS_DAY.length - 1)];
    const f = nb === na ? 0 : (fy - na[0]) / (nb[0] - na[0]);
    // The low sun reflects hardest offshore (top of the scene), so the warm tint fades shoreward.
    const wk = 1 - fy * 0.5;
    for (let x = 0; x < W; x++) {
      const mottle = (vnoise(x * 0.05, y * 0.05, 8, 42) - 0.5) * 14;
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const n = na[c + 1] + (nb[c + 1] - na[c + 1]) * f;
        const d = da[c + 1] + (db[c + 1] - da[c + 1]) * f;
        data[i + c] = Math.max(0, n + (d - n) * day + [wr, wg, wb][c] * wk + mottle);
      }
      data[i + 3] = 255;
    }
  }
  return data;
}

// A tileable light-on-water shimmer layer (2-octave noise, highlights only) for the painted feel.
function bakeWaterLight(cells, r, g, b, maxA, seed) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x / W) * cells;
      const v = (y / H) * cells;
      let n = vnoise(u, v, cells, seed) * 0.65 + vnoise(u * 2, v * 2, cells * 2, seed + 1) * 0.35;
      n = Math.max(0, (n - 0.34) / 0.66);
      const i = (y * W + x) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b;
      img.data[i + 3] = Math.round(n ** 1.5 * maxA * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function blitScroll(ctx, img, ox, oy, alpha) {
  const x = (((ox | 0) % W) + W) % W;
  const y = (((oy | 0) % H) + H) % H;
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, x - W, y - H);
  ctx.drawImage(img, x, y - H);
  ctx.drawImage(img, x - W, y);
  ctx.drawImage(img, x, y);
  ctx.globalAlpha = 1;
}

// Re-read the clock and, when the quantized phase actually moved, re-bake the seabed under it.
function updatePhase(sim) {
  const p = sunPhase();
  const rebake = !sim.phase || p.key !== sim.phase.key;
  sim.phase = p;
  if (rebake) {
    sim.bg = bakeBackground(p.day, p.warm);
    sim.img = new ImageData(new Uint8ClampedArray(sim.bg), W, H); // reseed (borders stay sane)
  }
}

function makeSim() {
  // Per-row damping: open water keeps its energy; the shallows eat it (waves die on the sand).
  const dampRow = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    dampRow[y] = y < SHORE_TOP ? 0.984 : 0.984 - ((y - SHORE_TOP) / (H - SHORE_TOP)) * 0.10;
  }
  const sim = {
    cur: new Float32Array(W * H),
    prev: new Float32Array(W * H),
    dampRow,
    phase: null,     // { day, warm, key } — set by updatePhase below
    bg: null,
    img: null,
    tex: {
      swell: bakeWaterLight(4, 110, 195, 220, 0.22, 2),   // broader patches of underwater light
      ripple: bakeWaterLight(14, 140, 215, 235, 0.12, 3),
    },
  };
  updatePhase(sim);
  return sim;
}

// ── The feedback loop ───────────────────────────────────────────────────────────────────────────

// Drop energy into the grid: CRESTS wavefronts marching shoreward, each at its OWN speed (real seas
// aren't a metronome), each with a noise-torn profile so no front is a straight line — plus the odd
// offshore "wind poke" that ripples outward on its own.
function inject(sim, t) {
  const { cur } = sim;
  for (let i = 0; i < CRESTS; i++) {
    const speed = 0.004 + hash(i, 7) * 0.008;                    // ~3× spread; a wave takes 1½–4 min
    const p = ((t / 1000) * speed + hash(i, 5)) % 1;             // 0 offshore → 1 at the shore
    const yf = 8 + p * (SHORE_TOP + 4 - 8);
    // A swell line dwells ~80 frames per row at these speeds — the per-frame deposit must be TINY
    // or it piles into hard plateau bars. It also breathes (slow pulse) so the sea heaves rather
    // than conveyor-belts, and the line is bowed, never ruler-straight.
    const pulse = 0.5 + 0.5 * Math.sin(t * 0.0009 + i * 2.1);
    const amp = 0.055 * Math.sin(p * Math.PI) * (0.6 + 0.4 * hash(i, 13)) * pulse;
    if (amp <= 0.002) continue;
    for (let x = 2; x < W - 2; x++) {
      const prof = vnoise(x * 0.03 + i * 137, p * 8, 64, i + 9);
      const bow = Math.sin(x * 0.015 + i * 2.6) * 2.5 + (prof - 0.5) * 4;
      const yx = yf + bow;
      const y0 = yx | 0;
      const sub = yx - y0;
      const v = amp * (0.4 + 0.6 * prof);
      const base = y0 * W + x;
      cur[base - W] += v * 0.35 * (1 - sub);
      cur[base] += v * (1 - sub * 0.5);
      cur[base + W] += v * (0.5 + sub * 0.5);
      cur[base + 2 * W] += v * 0.35 * sub;
    }
  }
}

// The two-buffer water equation in its coefficient form
//     next = 2·cur − prev + C·(neighbors − 4·cur)
// The classic demo kernel is the C = 0.5 special case — waves race across the grid. C sets the
// propagation speed (c = √C cells/step), so a small C gives the big, slow, wide swells we want
// without costing anything. A whisper of viscosity (blend toward the neighbor average) bleeds off
// the checkerboard-frequency mode the discrete kernel loves to keep.
const C = 0.09; // ≈ 0.3 cells/step at 24 steps/s — a swell takes ~13s to cross the open sea
function step(sim) {
  const { cur, prev, dampRow } = sim;
  for (let y = 1; y < H - 1; y++) {
    const damp = dampRow[y];
    const end = y * W + W - 1;
    for (let i = y * W + 1; i < end; i++) {
      const c = cur[i];
      const n = (cur[i - 1] + cur[i + 1] + cur[i - W] + cur[i + W]) * 0.25;
      const next = c * 2 - prev[i] + (n - c) * (C * 4);
      prev[i] = (next * 0.96 + n * 0.04) * damp;
    }
  }
  const swap = sim.cur;
  sim.cur = sim.prev;
  sim.prev = swap;
}

// Shade the painted seabed by the height field's N-S gradient (light from the top of the scene —
// the refracted-caustics look), whitening into foam where waves pile up in the shallows. After dark
// the Fanad beam rides on the same buffer: a lantern-gold CONE pivoting from just above the top
// edge, each pixel's distance to the spine DISPLACED by the E-W gradient (the classic Java-applet
// reflection), so swells bend and shred the light as it sweeps past. The spine itself is dead
// straight — a lighthouse beam, not a reflection — and the water does all the bending.
// (Daylight deliberately has NO twinkle pass — glint pixels were tried twice and read as visual
// noise over the chat; the day look is carried by the palette, contrast boost, and golden hour.)
function render(ctx, sim, t) {
  const d = sim.img.data;
  const { cur, bg, phase } = sim;
  const sBoost = 1 + 0.35 * phase.day; // the sun punches the crest shading up — daylight water has contrast
  const shadeR = 0.6 + phase.warm * 0.5; // …and golden hour gilds the crest light itself
  for (let y = 1; y < H - 1; y++) {
    const end = y * W + W - 1;
    const foamZone = y >= SHORE_TOP;
    for (let i = y * W + 1; i < end; i++) {
      const j = i * 4;
      // Refraction shading (N-S gradient) + a direct height glow so the crest itself catches light,
      // not only its slopes — that's what makes the fronts read as they march.
      const h = cur[i];
      let s = ((cur[i - W] - cur[i + W]) * 80 + (h > 0 ? h * 45 : h * 15)) * sBoost;
      if (s > 52) s = 52; else if (s < -44) s = -44;
      d[j] = bg[j] + s * shadeR;   // the light leans cyan — sun through tropical water
      d[j + 1] = bg[j + 1] + s * 1.05;
      d[j + 2] = bg[j + 2] + s * 1.15;
      if (foamZone) {
        const f = cur[i] * 3.2 - 0.12;
        if (f > 0) {
          const m = f > 1 ? 1 : f;
          d[j] += 130 * m; d[j + 1] += 145 * m; d[j + 2] += 150 * m;
        }
      }
    }
  }
  // The lantern waits offstage until the sun's ramp is (mostly) done — no beam at golden hour.
  const nightS = clamp01((1 - phase.day - 0.5) * 2);
  const beam = nightS > 0.02 ? beamAt(t) : null;
  if (beam) {
    for (let y = 2; y < SHORE_TOP + 8; y++) {
      const dy = y - BEAM_Y;
      const half = 1.6 + dy * 0.075;                // a CONE: narrow at the lantern, wide at the shore
      const xm = BEAM_X + dy * beam.slope;          // the spine pivots around the lantern
      if (xm < 1 - half || xm > W - 2 + half) continue;
      const amp = nightS * beam.env * (0.35 + 0.65 * (1 - y / (SHORE_TOP + 8))); // brightest near the light
      const x0 = Math.max(1, (xm - half) | 0);
      const x1 = Math.min(W - 2, (xm + half + 1) | 0);
      for (let x = x0; x <= x1; x++) {
        const i = y * W + x;
        // Displaced sampling, but GENTLY: the moonglade's ×90 mirror-shred would annihilate the
        // narrow cone on a lively sea — a direct beam wobbles with the swells, it doesn't shatter.
        const dx = (x + (cur[i + 1] - cur[i - 1]) * 35 - xm) / half;
        let m = 1 - dx * dx;
        if (m <= 0) continue;
        // A raked beam lights the water broadly (unlike the old slope-glitter moonglade): a solid
        // base fill, plus a specular flare on wave faces tilted back toward the lantern.
        const spec = cur[i - W] - cur[i + W];
        const lit = 0.45 + (spec > 0 ? Math.min(spec * 45, 0.8) : 0);
        const k = m * m * amp * lit * 110;
        const j = i * 4;
        d[j] += k; d[j + 1] += k * 0.92; d[j + 2] += k * 0.66; // lantern gold
      }
    }
  }
  ctx.putImageData(sim.img, 0, 0);
}

function drawFrame(ctx, t, sim) {
  inject(sim, t);
  step(sim);
  render(ctx, sim, t);

  // Painted-light overlays on top of the sim: two shimmer layers drifting at a crawl (parallax),
  // then the light blooms (thinned in daylight), the lantern's own glow above its beam, and the
  // waterline glow (a touch brighter under the sun).
  const { day, warm } = sim.phase;
  const nightS = 1 - day;
  blitScroll(ctx, sim.tex.swell, Math.sin(t * 0.00003) * 8, t * 0.0006, 0.8);
  blitScroll(ctx, sim.tex.ripple, -t * 0.0004, t * 0.0016, 0.6);
  for (const b of BLOOMS) {
    const cx = (b.ox + Math.sin(t * b.sx) * b.wx) * W;
    const cy = (b.oy + Math.cos(t * b.sy) * b.wy) * H;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, b.r);
    g.addColorStop(0, `rgba(${b.tint},${(b.a * (0.45 + 0.55 * nightS)).toFixed(3)})`);
    g.addColorStop(1, `rgba(${b.tint},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(cx - b.r, cy - b.r, b.r * 2, b.r * 2);
  }
  const lanternS = clamp01((nightS - 0.5) * 2); // same gate as the beam — the glow is its source
  if (lanternS > 0.02) {
    // A faint idle glow marks where the light lives through the dark dwell; it flares with the pass.
    const beam = beamAt(t);
    const flare = beam ? beam.env : 0;
    const r = 10 + flare * 8;
    const g = ctx.createRadialGradient(BEAM_X, 2, 0, BEAM_X, 2, r);
    g.addColorStop(0, `rgba(246,214,137,${((0.08 + 0.2 * flare) * lanternS).toFixed(3)})`);
    g.addColorStop(1, 'rgba(246,214,137,0)');
    ctx.fillStyle = g;
    ctx.fillRect(BEAM_X - r, 2 - r, r * 2, r * 2);
  }
  ctx.fillStyle = `rgba(190,225,235,${(0.10 + 0.08 * day + 0.04 * warm).toFixed(3)})`;
  ctx.fillRect(0, H - 2, W, 2);
}

// Run the sea on a 96×160 canvas. Returns a stop() for teardown (a no-op after reduced-motion's
// single still frame). Owns the rAF loop, the hidden-tab pause, and the self-degrade probe.
function mountOcean(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const sim = makeSim();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    // Warm the sim up off-screen so the still frame shows a lived-in sea, not a flat one.
    // (More steps than you'd think — the slow-c waves need time to spread into swells.)
    for (let s = 0; s < 400; s++) { inject(sim, s * FRAME_MS); step(sim); }
    drawFrame(ctx, 400 * FRAME_MS, sim);
    return () => {};
  }

  let raf = 0;
  let last = 0;
  let lastPhase = 0;
  let stopped = false;
  // Degrade probe: if the first ~1.5s of frames average out slow (an old PC even this bothers),
  // freeze on the current frame and go fully idle. Measured on our own draw, not global fps.
  let cost = 0;
  let frames = 0;

  const tick = (now) => {
    if (stopped) return;
    raf = requestAnimationFrame(tick);
    if (now - last < FRAME_MS) return;
    last = now;
    if (now - lastPhase > PHASE_MS) { lastPhase = now; updatePhase(sim); }
    const t0 = performance.now();
    drawFrame(ctx, now, sim);
    if (frames >= 0) {
      cost += performance.now() - t0;
      if (++frames >= 36) {
        canvas.dataset.drawMs = (cost / frames).toFixed(2); // surfaced for perf verification
        if (cost / frames > 8) { stopped = true; cancelAnimationFrame(raf); }
        frames = -1; // probe done
      }
    }
  };

  const onVisibility = () => {
    if (stopped) return;
    cancelAnimationFrame(raf);
    if (!document.hidden) raf = requestAnimationFrame(tick);
  };
  document.addEventListener('visibilitychange', onVisibility);
  raf = requestAnimationFrame(tick);
  return () => { stopped = true; cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', onVisibility); };
}

if (typeof window !== "undefined") window.mountOcean = mountOcean;
