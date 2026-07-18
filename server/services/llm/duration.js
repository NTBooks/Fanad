// Parse the LENGTH of a one-shot timer — "/timer 10 minutes", "timer 1h 30m pasta", "set a timer for half
// an hour". A deterministic heuristic handles the plain forms (and is the offline + test path); the LLM is
// the fuzzy fallback for everything else ("a quarter hour-ish", "enough for a soft-boiled egg"). Whatever
// text ISN'T the amount becomes the timer's label ("pasta"). Returns { ms, clean } (clean = the label, may
// be '') or null. Mirrors deadline.js's heuristic-first / LLM-fallback shape. See the Timer module in chat.js.
import { chat } from './index.js';
import { TIMER_DURATION_SYSTEM } from './prompts.js';
import { sanitizeForLlm } from './sanitize.js';

const UNIT_MS = { d: 86400000, h: 3600000, m: 60000, s: 1000 };
const WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// One duration chunk: an amount + a unit, with an optional "and a half" rider ("an hour and a half").
// Digits may butt against the unit ("1h30m" — hence the (?![a-z]) tail instead of \b, which a letter→digit
// edge would fail); word amounts REQUIRE a space, so "and" can never half-match as "an d(ays)". Longer unit
// spellings come first so "mins" never half-matches a bare "m"; (?![a-z]) keeps "10 months" from reading as
// "10 m" + "onths".
const NUM = String.raw`(?<![\d.])(\d+(?:\.\d+)?)`;
const WORDS = String.raw`(?<![a-z])(half\s+an?|(?:a\s+)?quarter\s+of\s+an?|a|an|one|two|three|four|five|six|seven|eight|nine|ten)`;
const UNIT = String.raw`(days?|hours?|hrs?|minutes?|mins?|seconds?|secs?|[dhms])`;
// Leading lookbehinds instead of \b: a compact "1h30m" has no word boundary between its chunks, so \b would
// drop everything after the first — the digit path only refuses to start mid-number, the word path mid-word.
const CHUNK = new RegExp(`(?:${NUM}\\s*|${WORDS}\\s+)${UNIT}(?![a-z])(\\s+and\\s+a\\s+half\\b)?`, 'gi');

function amountOf(digits, words) {
  if (digits != null) return Number(digits);
  const w = String(words || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^half an?$/.test(w)) return 0.5;
  if (/quarter of an?$/.test(w)) return 0.25;
  return WORD_NUM[w] ?? null;
}

// Deterministic parser. Sums EVERY chunk it finds ("1h 30m", "1 hour and 15 minutes"); the un-matched
// remainder (minus dangling connectors) is the label. Pure + exported for tests.
export function parseDuration(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  CHUNK.lastIndex = 0;
  let total = 0;
  const spans = [];
  let m;
  while ((m = CHUNK.exec(s))) {
    const n = amountOf(m[1], m[2]);
    const unit = UNIT_MS[m[3][0].toLowerCase()];
    if (n == null || !unit) continue;
    total += n * unit + (m[4] ? 0.5 * unit : 0);
    spans.push([m.index, m.index + m[0].length]);
  }
  if (!spans.length || !(total > 0)) return null;
  let clean = '';
  let pos = 0;
  for (const [a, b] of spans) { clean += s.slice(pos, a); pos = b; }
  clean += s.slice(pos);
  clean = clean.replace(/\s{2,}/g, ' ').trim()
    .replace(/^(?:for|in|and|to)\b\s*/i, '')   // "for 10 min" / "12 min for the pasta" scaffolding
    .replace(/\s*\b(?:for|in|and)$/i, '')
    .replace(/^[\s,;:.–—-]+|[\s,;:.–—-]+$/g, '').trim();
  return { ms: Math.round(total), clean };
}

// A short human label for a span: "10 min", "1 h 30 min", "2 days 3 h". Used on confirmations, the running
// list, and the ding itself (scheduler.js) — one voice everywhere. Sub-minute only appears on a countdown
// display ("under a minute"); timers themselves are floored at one minute (chat.js).
export function durationLabel(ms) {
  if (!(Number(ms) >= 60000)) return 'under a minute';
  const mins = Math.round(Number(ms) / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const mm = mins % 60;
  const bits = [];
  if (d) bits.push(`${d} day${d > 1 ? 's' : ''}`);
  if (h) bits.push(`${h} h`);
  if (mm) bits.push(`${mm} min`);
  return bits.join(' ');
}

// ── LLM fallback for fuzzier phrasing (skipped/ignored under the mock provider) ──
const stripFences = (s) => String(s).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
const SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'fanad_timer', strict: true,
    schema: {
      type: 'object', additionalProperties: false,
      required: ['has_duration', 'minutes', 'label'],
      properties: {
        has_duration: { type: 'boolean' },
        minutes: { type: 'number' },  // fractional ok; 0 when none
        label: { type: 'string' },    // whatever the timer is FOR ('' when none)
      },
    },
  },
};
function withTimeout(promise, ms = 6000) {
  return Promise.race([
    promise,
    new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('llm timeout')), ms); t.unref?.(); }),
  ]);
}

async function llmDuration(text) {
  const raw = await withTimeout(chat({
    messages: [{ role: 'system', content: TIMER_DURATION_SYSTEM }, { role: 'user', content: `Timer request: ${sanitizeForLlm(text)}` }],
    responseFormat: SCHEMA, temperature: 0, maxTokens: 60, purpose: 'timer',
  }));
  const o = JSON.parse(stripFences(raw));
  if (!o || !o.has_duration) return null;
  const mins = Number(o.minutes);
  if (!(mins > 0) || mins > 60 * 24 * 400) return null; // reject absurd spans the model dreamt up
  return { ms: Math.round(mins * 60000), clean: String(o.label || '').trim() };
}

// Heuristic first (deterministic, covers the plain forms); the LLM fills the fuzzy gaps. Unlike the deadline
// extractor there's no cheap pre-gate: the user explicitly asked for a timer, so one LLM round-trip on an
// odd phrasing is the right trade. Best-effort — mock/bad JSON/timeout just means "couldn't read it".
export async function extractDuration(text) {
  const heur = parseDuration(text);
  if (heur) return heur;
  if (!String(text || '').trim()) return null;
  try { const r = await llmDuration(text); if (r) return r; }
  catch (err) {
    if (!(err instanceof SyntaxError)) console.error('timer LLM fallback failed:', err.message);
  }
  return null;
}
