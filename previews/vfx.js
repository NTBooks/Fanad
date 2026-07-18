// ── The bench's one trick: a warped rAF clock ────────────────────────────────────────────────────
// mountOcean owns its loop and reads time only from rAF timestamps, so wrapping requestAnimationFrame
// lets the bench steer the sim without touching it: jumping past PHASE_MS (5s) makes the next frame
// re-read the pinned hour immediately, and jumping to a BEAM_PERIOD (16s) boundary starts a pass.
// The height field itself is never reset, so the sea keeps its swells across every jump.
let tOff = 0;
const origRaf = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = (cb) => origRaf((t) => cb(t + tOff));
const now = () => performance.now() + tOff;

// Mirrors of oceanSim.js timings, renamed: ocean.js is a classic script, so its top-level consts
// share this global scope — redeclaring PHASE_MS/BEAM_PERIOD here would kill BOTH scripts.
const SIM_PHASE_MS = 5000;      // how often the sim re-reads the clock
const SIM_BEAM_PERIOD = 16000;  // one beam pass per this many ms

const PRESETS = [
  ['🌒 pre-dawn', 4.5],
  ['🌅 dawn', 6.5],
  ['☀️ noon', 13],
  ['🌇 golden hour', 18.3],
  ['🌆 dusk', 19.2],
  ['🌙 night', 23],
  ['🕐 real clock', null],
];

const readout = document.getElementById('readout');
const slider = document.getElementById('hour');
const presetsEl = document.getElementById('presets');

function currentHour() {
  let h = NaN;
  try { h = parseFloat(localStorage.getItem('fanad-sea-hour')); } catch {}
  return Number.isFinite(h) ? h : null;
}

function paint() {
  const h = currentHour();
  const shown = h ?? (new Date().getHours() + new Date().getMinutes() / 60);
  const hh = String(Math.floor(shown)).padStart(2, '0');
  const mm = String(Math.round((shown % 1) * 60)).padStart(2, '0');
  readout.textContent = (h == null ? 'real ' : 'sea ') + hh + ':' + mm;
  slider.value = shown;
  for (const b of presetsEl.children) {
    b.classList.toggle('on', b._hour == null ? h == null : h != null && Math.abs(b._hour - h) < 0.01);
  }
}

function setHour(h) {
  try {
    if (h == null) localStorage.removeItem('fanad-sea-hour');
    else localStorage.setItem('fanad-sea-hour', String(h));
  } catch {}
  tOff += SIM_PHASE_MS + 100; // past the phase poll — the very next frame rebakes to the new hour
  paint();
}

for (const [label, h] of PRESETS) {
  const b = document.createElement('button');
  b.textContent = label;
  b._hour = h;
  b.onclick = () => setHour(h);
  presetsEl.append(b);
}
slider.oninput = () => setHour(parseFloat(slider.value));

document.getElementById('summon').onclick = () => {
  tOff += SIM_BEAM_PERIOD - (now() % SIM_BEAM_PERIOD); // warp to the next pass boundary
};

setHour(currentHour() ?? 23); // open on night — where the beam lives — unless already pinned
mountOcean(document.getElementById('sea'));
