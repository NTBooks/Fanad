// Detect a deadline at the END of a task's text — "… today", "… by Friday", "… by 5pm", "… by 6/30".
// A deterministic heuristic handles the named/obvious forms (and is the offline + test path); the LLM is
// the fuzzy fallback for everything else ("before the weekend", "by next Tuesday afternoon"). A date that
// appears mid-sentence as CONTENT ("party on Friday") is not a deadline — only trailing ones count.
// Returns { dueAt: epoch-ms, kind: 'today' | 'by' } or null. See advanced /task in chat.js.
import { chat } from './index.js';
import { DEADLINE_SYSTEM } from './prompts.js';
import { sanitizeForLlm } from './sanitize.js';

const DAY = 86400000;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const endOfLocalDay = (ts) => { const d = new Date(ts); d.setHours(23, 59, 59, 999); return d.getTime(); };
const addDays = (ts, n) => { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); };

// "today"/"tonight" said in the small hours (before 5am) usually means the day you'll actually be awake
// for, not the sliver of night that's left — so let it run to the END OF THE NEXT day. (User's rule.)
const NIGHT_ROLLOVER_HOUR = 5;
function todayDeadline(now) {
  return new Date(now).getHours() < NIGHT_ROLLOVER_HOUR ? endOfLocalDay(addDays(now, 1)) : endOfLocalDay(now);
}

// Deterministic parser for the explicit forms. Pure + exported for tests.
export function parseDeadline(text, now = Date.now()) {
  const s = String(text || '').trim().toLowerCase().replace(/[.!?,;:\s]+$/, '');
  let m;

  // today / tonight / end of (the) day  → today (with the small-hours rollover)
  if (/\b(?:by\s+)?(?:today|tonight|end of (?:the )?day|eod)$/.test(s)) {
    return { dueAt: todayDeadline(now), kind: 'today' };
  }
  // tomorrow
  if (/\b(?:by\s+)?tomorrow$/.test(s)) {
    return { dueAt: endOfLocalDay(addDays(now, 1)), kind: 'by' };
  }
  // end of week / this weekend → the upcoming Sunday
  if (/\bby\s+(?:the\s+)?end of (?:the )?week$/.test(s) || /\b(?:by\s+)?(?:this )?weekend$/.test(s)) {
    const daysToSun = (7 - new Date(now).getDay()) % 7;
    return { dueAt: endOfLocalDay(addDays(now, daysToSun)), kind: 'by' };
  }
  // by <weekday>, optionally "next"
  if ((m = /\bby\s+(next\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/.exec(s))) {
    const dow = new Date(now).getDay();
    let delta = (WEEKDAYS.indexOf(m[2]) - dow + 7) % 7; // 0 = that weekday is today
    if (m[1]) delta += 7;                                // "next" → the following week's occurrence
    return { dueAt: endOfLocalDay(addDays(now, delta)), kind: 'by' };
  }
  // by <time> — "by 5pm", "by 17:00", "by 9 am" (no end-of-day; an exact clock time)
  if ((m = /\bby\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s))) {
    let h = Number(m[1]); const min = Number(m[2] || 0); const ap = m[3];
    if (ap === 'pm' && h < 12) h += 12;
    else if (ap === 'am' && h === 12) h = 0;
    else if (!ap && h >= 1 && h <= 7) h += 12; // bare "by 5" → 5pm; deadlines skew later in the day
    const d = new Date(now); d.setHours(h, min, 0, 0);
    let at = d.getTime();
    if (at <= now) at = addDays(at, 1); // already past today → same time tomorrow
    return { dueAt: at, kind: 'by' };
  }
  // by <month> <day> — "by June 30", "by jun 3rd"
  if ((m = /\bby\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(s))) {
    const yr = new Date(now).getFullYear();
    const mk = (y) => new Date(y, MONTHS.indexOf(m[1]), Number(m[2]), 23, 59, 59, 999).getTime();
    const at = mk(yr);
    return { dueAt: at < now ? mk(yr + 1) : at, kind: 'by' }; // already passed this year → next year
  }
  // by M/D or M/D/Y
  if ((m = /\bby\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s))) {
    const mon = Number(m[1]) - 1; const day = Number(m[2]);
    let yr = m[3] ? Number(m[3]) : new Date(now).getFullYear();
    if (yr < 100) yr += 2000;
    const mk = (y) => new Date(y, mon, day, 23, 59, 59, 999).getTime();
    const at = mk(yr);
    return { dueAt: !m[3] && at < now ? mk(yr + 1) : at, kind: 'by' };
  }
  return null;
}

// Build a { dueAt, dueKind, remindAt } for the gentle reschedule PRESETS the interactive menus offer —
// no string round-trip. 'today' honors the small-hours rollover; 'wknd' is the upcoming Sunday (mirroring
// parseDeadline above); 'clear' wipes the deadline. Presets set a DEADLINE only — remindAt stays null.
export function presetDue(kind, now = Date.now()) {
  if (kind === 'clear') return { dueAt: null, dueKind: null, remindAt: null };
  if (kind === 'today') return { dueAt: todayDeadline(now), dueKind: 'today', remindAt: null };
  if (kind === 'tom') return { dueAt: endOfLocalDay(addDays(now, 1)), dueKind: 'by', remindAt: null };
  if (kind === 'wknd') {
    const daysToSun = (7 - new Date(now).getDay()) % 7;
    return { dueAt: endOfLocalDay(addDays(now, daysToSun)), dueKind: 'by', remindAt: null };
  }
  return null;
}

// Build a { remindAt } for the reminder PRESETS the interactive "🔔 Remind" picker offers — gentle,
// time-bearing nudges with no free typing. 'eve' is 6pm today (or tomorrow if it's already evening);
// 'morn' is 9am tomorrow; 'clear' wipes the reminder. A reminder is independent of any deadline (see
// setTaskReminder), so this carries no dueAt. Pure + deterministic, mirroring presetDue.
export function presetRemind(kind, now = Date.now()) {
  if (kind === 'clear') return { remindAt: null };
  if (kind === '1h') return { remindAt: now + 60 * 60000 };
  if (kind === '3h') return { remindAt: now + 3 * 60 * 60000 };
  if (kind === 'eve') {
    const d = new Date(now); d.setHours(18, 0, 0, 0);
    let at = d.getTime(); if (at <= now) at = addDays(at, 1); // already evening → tomorrow evening
    return { remindAt: at };
  }
  if (kind === 'morn') { const d = new Date(addDays(now, 1)); d.setHours(9, 0, 0, 0); return { remindAt: d.getTime() }; }
  return null;
}

// Is this task due (and still live) by the END OF TODAY? "Today" honors the same small-hours rollover as
// /today itself, so a task filed with "x …" at 1am (due = end of the coming day) still counts as today.
// Callers expire past-due tasks first (openTasks / suggestTask), so among LIVE tasks this reads as "due
// between now and the end of today". Shared by the "/tasks today" list and the "what's next today" suggestion.
export function isDueToday(task, now = Date.now()) {
  return !!task && task.due_at != null && !task.expired_at && task.due_at <= todayDeadline(now);
}

// ── "on <when>" scheduling — distinct from a "by <when>" DEADLINE ──
// "call mom on Friday 3pm" pins WHEN the task happens. Per the user's choice it sets BOTH a deadline
// (due_at) AND a one-time reminder (remind_at) the scheduler fires once. We only treat "on …" as a
// schedule when what follows actually parses as a date — so "work on the report" / "turn on the lamp"
// stay ordinary task text. With a clock time → due_at = remind_at = that moment; date only → due_at =
// end of that day, remind_at = 09:00 that morning (a gentle nudge). Returns { dueAt, remindAt, clean }
// (clean = the task text minus the matched phrase) or null. Pure + deterministic (offline/test-safe).
const DOW_RE = '(sun|mon|tue|wed|thu|fri|sat)[a-z]*';
const MON_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
const localMidnight = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

function applyTime(baseMidnight, hStr, minStr, ap) {
  if (hStr == null) return { at: null, hasTime: false };
  let h = Number(hStr); const min = Number(minStr || 0);
  const a = ap ? ap[0].toLowerCase() : '';
  if (a === 'p' && h < 12) h += 12;
  else if (a === 'a' && h === 12) h = 0;
  else if (!a && h >= 1 && h <= 7) h += 12; // bare "3" skews afternoon, mirroring the deadline parser
  if (h > 23 || min > 59) return { at: null, hasTime: false };
  const d = new Date(baseMidnight); d.setHours(h, min, 0, 0);
  return { at: d.getTime(), hasTime: true };
}

export function parseOnWhen(text, now = Date.now()) {
  const s = String(text || '');
  const dowBase = (m) => {
    const dow = WEEKDAYS.indexOf(m[2].toLowerCase().slice(0, 3));
    let delta = (dow - new Date(now).getDay() + 7) % 7;
    if (m[1]) delta += 7;                       // "next <weekday>" → the following week
    return localMidnight(addDays(now, delta));
  };
  const monBase = (m) => {
    const mon = MONTHS.indexOf(m[1].toLowerCase().slice(0, 3)); const day = Number(m[2]);
    const yr = new Date(now).getFullYear();
    const mk = (y) => { const d = new Date(y, mon, day); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const at = mk(yr); return at < localMidnight(now) ? mk(yr + 1) : at;  // already passed → next year
  };
  const mdBase = (m) => {
    const mon = Number(m[1]) - 1; const day = Number(m[2]);
    let yr = m[3] ? Number(m[3]) : new Date(now).getFullYear(); if (yr < 100) yr += 2000;
    const mk = (y) => { const d = new Date(y, mon, day); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const at = mk(yr); if (Number.isNaN(at)) return null;
    return !m[3] && at < localMidnight(now) ? mk(yr + 1) : at;
  };
  const matchers = [
    { re: /\bon\s+(?:today|tonight)\b/i, base: () => localMidnight(now) },
    { re: /\bon\s+tomorrow\b/i, base: () => localMidnight(addDays(now, 1)) },
    { re: new RegExp(`\\bon\\s+(?:(next)\\s+)?${DOW_RE}\\b`, 'i'), base: dowBase },
    { re: new RegExp(`\\bon\\s+${MON_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'), base: monBase },
    { re: /\bon\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/i, base: mdBase },
  ];
  for (const { re, base } of matchers) {
    const m = re.exec(s);
    if (!m) continue;
    const baseMidnight = base(m);
    if (baseMidnight == null) continue;
    // An optional clock time immediately following the date phrase ("… friday 3pm", "… 6/30 at 15:00").
    const after = s.slice(m.index + m[0].length);
    const tm = /^\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m?\.?|p\.?m?\.?)?(?=\s|$)/i.exec(after);
    let consumedEnd = m.index + m[0].length;
    let at = null; let hasTime = false;
    if (tm) {
      const r = applyTime(baseMidnight, tm[1], tm[2], tm[3]);
      if (r.hasTime) { at = r.at; hasTime = true; consumedEnd += tm[0].length; }
    }
    // Trailing-only, exactly like deadlines: "feed cat on friday" schedules, but a date used mid-sentence
    // as content ("check on tuesday's numbers", "party on friday with cake") must NOT — so only accept the
    // match when nothing but punctuation follows it.
    if (!/^[\s.,!?;:]*$/.test(s.slice(consumedEnd))) return null;
    const dueAt = hasTime ? at : endOfLocalDay(baseMidnight);
    const remindAt = hasTime ? at : baseMidnight + 9 * 60 * 60000; // 09:00 that day
    const clean = (s.slice(0, m.index) + s.slice(consumedEnd))
      .replace(/\s{2,}/g, ' ').replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '').trim();
    return { dueAt, remindAt, clean };
  }
  return null;
}

// ── "remind me … at <time>" / "remind me in <n> min|hours" — a pure one-time reminder ──
// A reminder is NOT a deadline: it sets remind_at ALONE (no due_at), so the scheduler nudges you once at the
// moment, but the task is never retired as "expired" for a passing deadline — you can still do it afterward.
// An absolute clock time with no date lands on today, rolled to tomorrow if already past (mirroring the
// "by <time>" deadline); a relative offset is added to now. Requires the explicit words "remind me" so an
// ordinary "meet at 5" or "read page 5" stays plain task text. Only a TRAILING clock time counts, exactly
// like deadlines/parseOnWhen, so a mid-sentence "look at 3 options" isn't read as a time. The date-bearing
// "on Friday 3pm" form is handled by parseOnWhen FIRST; this catches the dateless clock/relative form it
// leaves behind. Returns { remindAt, dueAt: null, clean } (clean = text minus the scaffolding) or null.
// Pure + deterministic (offline/test-safe).
const cleanRemind = (t) => (String(t)
  .replace(/\bremind\s+me(?:\s+to)?\b/i, ' ')   // drop the "remind me [to]" scaffolding
  .replace(/\s{2,}/g, ' ')
  .replace(/^[\s,;:.–—-]+|[\s,;:.–—-]+$/g, '')
  .replace(/\s+(?:at|by|@)$/i, '')              // drop a dangling "at"/"by"/"@" the removed time left behind
  .trim()) || 'remind me';

export function parseRemindAt(text, now = Date.now()) {
  const s = String(text || '');
  if (!/\bremind\s+me\b/i.test(s)) return null; // an explicit request only — never hijack a bare "at <time>"

  // Relative: "in 30 minutes", "in 2 hours", "in 1 hr". Inherently future → no rollover.
  let m = /\bin\s+(\d{1,3})\s*(minutes?|mins?|hours?|hrs?|h)\b/i.exec(s);
  if (m) {
    const n = Number(m[1]);
    const at = now + (/^h/i.test(m[2]) ? n * 3600000 : n * 60000);
    return { remindAt: at, dueAt: null, clean: cleanRemind(s.slice(0, m.index) + s.slice(m.index + m[0].length)) };
  }

  // Absolute clock at the END: "… at 9:45pm" / "… 9 pm" (am/pm present → the "at" is optional), or
  // "… at 17:00" / "… at 9" ("at" present → a 24h/bare hour is fine). Trailing-anchored.
  m = /\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\s*$/i.exec(s)
   || /\s+at\s+(\d{1,2})(?::(\d{2}))?\s*$/i.exec(s);
  if (m) {
    const r = applyTime(localMidnight(now), m[1], m[2], m[3]);
    if (!r.hasTime) return null;
    let at = r.at;
    if (at <= now) at = addDays(at, 1); // already past today → the same clock time tomorrow
    return { remindAt: at, dueAt: null, clean: cleanRemind(s.slice(0, m.index)) };
  }
  return null;
}

// A short, human label for a deadline relative to now: "today", "tomorrow", "Fri", "Jun 30".
export function dueLabel(dueAt, now = Date.now()) {
  if (!dueAt) return '';
  const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
  const startDue = new Date(dueAt); startDue.setHours(0, 0, 0, 0);
  const days = Math.round((startDue.getTime() - startToday.getTime()) / DAY);
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return DOW_LABEL[new Date(dueAt).getDay()];
  return `${MONTH_LABEL[new Date(dueAt).getMonth()]} ${new Date(dueAt).getDate()}`;
}

// Day + clock for a one-time reminder: "today 09:00", "Fri 15:00", "Jun 30 08:30".
export function whenLabel(at, now = Date.now()) {
  if (!at) return '';
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0'); const mm = String(d.getMinutes()).padStart(2, '0');
  return `${dueLabel(at, now)} ${hh}:${mm}`;
}

// ── LLM fallback for fuzzier phrasing (skipped/ignored under the mock provider) ──
const stripFences = (s) => String(s).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
const SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'fanad_deadline', strict: true,
    schema: {
      type: 'object', additionalProperties: false,
      required: ['has_deadline', 'due_date', 'due_time', 'kind'],
      properties: {
        has_deadline: { type: 'boolean' },
        due_date: { type: 'string' },  // 'YYYY-MM-DD' or ''
        due_time: { type: 'string' },  // 'HH:mm' (24h) or '' for end-of-day
        kind: { type: 'string', enum: ['today', 'by', 'none'] },
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

async function llmDeadline(text, now) {
  const d = new Date(now);
  const ctx = `Current date-time: ${d.toString()} (today is ${DOW_LABEL[d.getDay()]}).`;
  const raw = await withTimeout(chat({
    messages: [{ role: 'system', content: DEADLINE_SYSTEM }, { role: 'user', content: `${ctx}\nTask: ${sanitizeForLlm(text)}` }],
    responseFormat: SCHEMA, temperature: 0, maxTokens: 60, purpose: 'deadline',
  }));
  const o = JSON.parse(stripFences(raw));
  if (!o || !o.has_deadline) return null;
  // The model is over-eager to default vague text to "today" (e.g. a bare "end" came back as due today).
  // Every REAL trailing today/tonight/eod is already caught deterministically before we ever call the LLM,
  // so only honor a model "today" when the text actually contains a same-day word — otherwise fall through
  // and require a concrete date. (Fixes "shouldn't default to due today".)
  if (o.kind === 'today') {
    if (/\b(today|tonight|tonite|eod|cob|end of (?:the )?day)\b/i.test(text)) return { dueAt: todayDeadline(now), kind: 'today' };
    // not a real "today" — fall through; use a concrete date if the model gave one, else reject below.
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.due_date || '')) return null;
  const [Y, M, D] = o.due_date.split('-').map(Number);
  let hh = 23; let mm = 59; let ss = 59; let ms = 999;
  // The model renders a date-only deadline ("by Friday") with a near-midnight clock time (e.g. 23:50) — its
  // way of saying "end of day". Keep a genuine daytime time, but snap anything from 23:00 on back to the
  // end-of-day sentinel so it stays a date-only deadline (an all-day → 5pm calendar block, not an 11:50 PM event).
  if (/^\d{1,2}:\d{2}$/.test(o.due_time || '')) {
    const [h, mi] = o.due_time.split(':').map(Number);
    if (h < 23) { hh = h; mm = mi; ss = 0; ms = 0; }
  }
  const at = new Date(Y, M - 1, D, hh, mm, ss, ms).getTime();
  if (Number.isNaN(at) || at < now - DAY || at > now + 400 * DAY) return null; // reject past/absurd
  return { dueAt: at, kind: 'by' };
}

// Cheap gate: does the END of the text look like it carries a deadline? Keeps the capture hot-path off
// the LLM for plainly date-less notes ("clean the garage"). Generous on purpose — a false yes just costs
// one "no deadline" round-trip; a false no would silently miss one. (The deterministic forms are already
// handled before this is consulted, so this only guards the fuzzy LLM fallback.)
const DEADLINE_HINT = /\b(by|due|end|today|tonight|tonite|tomorrow|tmrw|deadline|eod|cob|noon|midnight|weekend|week|weeks|month|months|next|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\d{1,2}\s*(?:am|pm)\b|\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}/i;
export function mightHaveDeadline(text) {
  return DEADLINE_HINT.test(String(text || '').toLowerCase().slice(-30));
}

// Heuristic first (deterministic, covers the named forms); the LLM fills the fuzzy gaps, but only when
// the tail looks temporal — so an ordinary date-less capture never pays for an LLM call.
export async function extractDeadline(text, now = Date.now()) {
  const heur = parseDeadline(text, now);
  if (heur) return heur;
  if (!mightHaveDeadline(text)) return null;
  try { const r = await llmDeadline(text, now); if (r) return r; }
  catch (err) {
    // Best-effort by design (mock / bad JSON / timeout), but a provider outage silently dropping fuzzy
    // deadlines (no due date, no reminder) deserves a trace. SyntaxError = the mock's expected output.
    if (!(err instanceof SyntaxError)) console.error('deadline LLM fallback failed:', err.message);
  }
  return null;
}
