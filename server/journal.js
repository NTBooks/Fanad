// The trend-journal engine (opt-in "journal" module) — the app's heaviest AI feature, built to stay cheap
// forever. A journal is a named stream of daily checklist entries snapshotted from a task template, plus an
// optional daily note. Three AI passes, strictly hierarchical:
//   day    reads the RAW entry (checklist state + note)            → stored day summary
//   week   reads stored DAY summaries only                          → stored week summary (once closed)
//   month  reads stored DAY summaries only                          → stored month summary (once closed)
//   trends reads the journal's rolling dossier + recent rollups     → report + updated dossier
// Old raw entries are never re-fed to the model, and the dossier keeps trend input constant-size no matter
// how old the journal gets. Summaries are lazy (generated when asked) AND swept nightly (runJournalSweep)
// so week/month rollups usually find their day rows ready. Engine only — command parsing lives in
// features/journal.js, following the metrics.js split.
import { chat } from './services/llm/index.js';
import { runAsLlmUser } from './services/llm/context.js';
import { JOURNAL_DAY_SYSTEM, JOURNAL_ROLLUP_SYSTEM, JOURNAL_TRENDS_SYSTEM } from './services/llm/prompts.js';
import { sanitizeForLlm } from './services/llm/sanitize.js';
import {
  getJournal, getJournalById, listJournals, touchJournal, saveJournalDossier,
  getJournalEntry, getJournalEntryById, insertJournalEntry, updateEntryChecklist, appendEntryNote,
  listEntriesBetween, getJournalSummary, saveJournalSummary, listJournalSummaries,
  entriesMissingDaySummary,
} from './repo.js';
import { getSetting, setSetting } from './settings.js';
import { isOwner } from './repo.js';
import { dayStartOf } from '../shared/timeframe.js';

const DAY_MS = 86400000;

// ── Local-day keys. Server-local time with the app-wide 02:00 rollover (shared/timeframe.dayStartOf):
// a 1am journal line or snack belongs to the evening's day. Weeks start Monday to match resolveTimeframe.
// Keys sort lexicographically = chronologically. ──
export function localDateKey(ts = Date.now()) {
  const d = new Date(dayStartOf(ts));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const keyToDate = (dateKey) => {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(y, m - 1, d, 12); // local noon — round-trips localDateKey exactly, DST-safe for ±day math
};
export function monthKey(dateKey) { return dateKey.slice(0, 7); }
// ISO-8601 week number (Monday start), matching the resolveTimeframe convention. YYYY is the ISO week-year
// (a Jan 1st can belong to the previous year's last week).
export function weekKey(dateKey) {
  const d = keyToDate(dateKey);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); // shift to the Thursday of this week
  const week1 = new Date(d.getFullYear(), 0, 4);       // Jan 4 is always in week 1
  const w = 1 + Math.round(((d - week1) / DAY_MS - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(w).padStart(2, '0')}`;
}
// The 7 date-keys of a week, Monday..Sunday, derived from any day inside it.
export function weekDates(dateKey) {
  const d = keyToDate(dateKey);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
  return Array.from({ length: 7 }, (_, i) => localDateKey(d.getTime() + i * DAY_MS));
}
export function monthDates(dateKey) {
  const [y, m] = dateKey.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  return Array.from({ length: days }, (_, i) => `${dateKey.slice(0, 7)}-${String(i + 1).padStart(2, '0')}`);
}

// ── Checklist + dossier JSON helpers ──
export const parseChecklist = (json) => { try { return JSON.parse(json || '[]') || []; } catch { return []; } };
export const parseDossier = (json) => { try { return JSON.parse(json || '{}') || {}; } catch { return {}; } };
const checkedCount = (items) => items.filter((i) => i.done).length;

// ── Which journal did they mean? Named match → the only one → the one last touched. A miss returns
// { error } copy the caller can hand straight back. ──
export function resolveJournal(userId, name = null) {
  if (name) {
    const j = getJournal(userId, name);
    return j ? { journal: j } : { error: `No journal called “${String(name).trim()}”. Your journals: ${listJournals(userId).map((x) => x.name).join(' · ') || '(none yet — try: journal new food)'}` };
  }
  const all = listJournals(userId);
  if (!all.length) return { error: 'No journals yet. Start one with: journal new <name>   (e.g. journal new food)' };
  if (all.length === 1) return { journal: all[0] };
  const recent = all.slice().sort((a, b) => (b.last_used_at || 0) - (a.last_used_at || 0))[0];
  return { journal: recent };
}

// ── Today's entry, idempotent per (journal, local day): returns the existing row or creates one with the
// journal's checklist copied RESET. A journal with no template yet just gets a note-only entry. ──
export function newEntry(userId, journal, now = Date.now()) {
  const dateKey = localDateKey(now);
  const existing = getJournalEntry(userId, journal.id, dateKey);
  touchJournal(userId, journal.id, now);
  if (existing) return { entry: existing, created: false };
  const blueprint = parseChecklist(journal.checklist_json);
  const checklist = blueprint.map((s) => ({ text: s.text, done: false, completed_at: null }));
  const entry = insertJournalEntry({
    userId, journalId: journal.id, entryDate: dateKey,
    checklistJson: checklist.length ? JSON.stringify(checklist) : null, createdAt: now,
  });
  return { entry, created: true };
}

// Toggle checklist item(s) by 1-based position on an entry. `done` forces a state; null flips.
// Returns { entry, items, changed:[1-based], missing:[1-based] } or null if the entry isn't theirs.
export function toggleEntryItems(userId, entryId, positions, done = null, now = Date.now()) {
  const entry = getJournalEntryById(userId, entryId);
  if (!entry) return null;
  const items = parseChecklist(entry.checklist_json);
  const changed = []; const missing = [];
  for (const pos of positions) {
    const i = Number(pos) - 1;
    if (i < 0 || i >= items.length) { missing.push(Number(pos)); continue; }
    const next = done == null ? !items[i].done : !!done;
    items[i] = { ...items[i], done: next, completed_at: next ? now : null };
    changed.push(i + 1);
  }
  const updated = changed.length ? updateEntryChecklist(userId, entryId, JSON.stringify(items), now) : entry;
  return { entry: updated, items, changed, missing };
}

export function checkAllItems(userId, entryId, now = Date.now()) {
  const entry = getJournalEntryById(userId, entryId);
  if (!entry) return null;
  const items = parseChecklist(entry.checklist_json).map((i) => (i.done ? i : { ...i, done: true, completed_at: now }));
  return { entry: updateEntryChecklist(userId, entryId, JSON.stringify(items), now), items };
}

// Append to today's note, creating today's entry first when needed.
export function noteToday(userId, journal, text, now = Date.now()) {
  const { entry } = newEntry(userId, journal, now);
  return appendEntryNote(userId, entry.id, String(text).trim(), now);
}

// ── AI pass 1: the DAY summary. Stored row wins (idempotent); stats are computed in code — the model only
// adds prose + signals. A day with no entry gets NO row: gaps are counted by the parent rollup instead. ──
const strip = (s) => String(s).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
const SIGNAL_ITEM = {
  type: 'object', additionalProperties: false, required: ['label', 'kind'],
  properties: { label: { type: 'string' }, kind: { type: 'string', enum: ['symptom', 'intake', 'activity', 'skip', 'other'] } },
};
const JOURNAL_DAY_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'journal_day', strict: true,
    schema: {
      type: 'object', additionalProperties: false, required: ['summary', 'signals'],
      properties: { summary: { type: 'string' }, signals: { type: 'array', items: SIGNAL_ITEM } },
    },
  },
};

function entryText(entry) {
  const items = parseChecklist(entry.checklist_json);
  // Item texts and the note are USER words — sanitize what the model sees ([done]/[skipped] markers are
  // ours, added after); the stored entry stays verbatim.
  const lines = items.map((i) => `${i.done ? '[done]' : '[skipped]'} ${sanitizeForLlm(i.text, { maxChars: 200 })}`);
  return [
    `Date: ${entry.entry_date}`,
    items.length ? `Checklist (${checkedCount(items)}/${items.length} done):\n${lines.join('\n')}` : 'Checklist: (none)',
    entry.note ? `Note: ${sanitizeForLlm(entry.note, { maxChars: 1000 })}` : 'Note: (none)',
  ].join('\n');
}

// `budget` (optional, see backfillBudget): a per-REQUEST cap on how many day summaries one rollup/trends
// call may generate. A month rollup can otherwise backfill up to 31 LLM calls in one request — fine for the
// owner, a cost lever for a vouched-in demo guest. Out of budget reads as "no summary yet" (null), the same
// thin-data shape the callers already tolerate; the nightly sweep fills the gap for free later.
export async function ensureDaySummary(userId, journalId, dateKey, now = Date.now(), budget = null) {
  const stored = getJournalSummary(userId, journalId, 'day', dateKey);
  if (stored) return stored;
  const entry = getJournalEntry(userId, journalId, dateKey);
  if (!entry) return null; // no entry that day — a gap, not a row
  if (budget) {
    if (budget.callsLeft <= 0) return null; // cap spent — the nightly sweep will backfill this day
    budget.callsLeft -= 1;
  }
  const raw = await chat({
    messages: [
      { role: 'system', content: JOURNAL_DAY_SYSTEM },
      { role: 'user', content: entryText(entry) },
    ],
    responseFormat: JOURNAL_DAY_SCHEMA, temperature: 0.2, maxTokens: 300, purpose: 'journal-day',
  });
  const o = JSON.parse(strip(raw));
  const items = parseChecklist(entry.checklist_json);
  const stats = {
    checked: checkedCount(items), total: items.length,
    signals: Array.isArray(o.signals) ? o.signals.slice(0, 5) : [],
  };
  const summary = String(o.summary || '').trim();
  // A day still in progress is LIVE-ONLY (same rule as open week/month rollups): storing it would freeze a
  // half-written day, and the nightly sweep is what writes the canonical row once the day has closed.
  if (dateKey >= localDateKey(now)) {
    return { user_id: userId, journal_id: journalId, period: 'day', period_key: dateKey, summary, stats_json: JSON.stringify(stats), live: true };
  }
  return saveJournalSummary({ userId, journalId, period: 'day', periodKey: dateKey, summary, stats });
}

// ── AI pass 2: the WEEK/MONTH rollup — built ONLY from stored day summaries. Stored once the period has
// CLOSED; a request mid-period returns live text without persisting (it would go stale by tomorrow). ──
const ROLLUP_SIGNAL_ITEM = {
  type: 'object', additionalProperties: false, required: ['label', 'kind', 'days'],
  properties: { ...SIGNAL_ITEM.properties, days: { type: 'integer' } },
};
const JOURNAL_ROLLUP_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'journal_rollup', strict: true,
    schema: {
      type: 'object', additionalProperties: false, required: ['summary', 'signals', 'notable'],
      properties: {
        summary: { type: 'string' }, signals: { type: 'array', items: ROLLUP_SIGNAL_ITEM }, notable: { type: 'string' },
      },
    },
  },
};

async function rollup(userId, journalId, period, key, dateKeys, todayKey, budget = null) {
  const stored = getJournalSummary(userId, journalId, period, key);
  if (stored) return stored;
  const from = dateKeys[0]; const to = dateKeys[dateKeys.length - 1];
  // Backfill any entry-bearing day still missing its summary (bounded ≤7/≤31 calls — and by `budget` for a
  // non-owner; usually 0 either way — the nightly sweep runs ahead of us). Today's half-written entry is
  // deliberately excluded: its day summary would freeze mid-day, and this rollup is live-only until the
  // period closes anyway.
  for (const e of listEntriesBetween(userId, journalId, from, to)) {
    if (e.entry_date < todayKey) await ensureDaySummary(userId, journalId, e.entry_date, Date.now(), budget);
  }
  const days = listJournalSummaries(userId, journalId, 'day', from, to);
  if (!days.length) return null;
  const label = period === 'week' ? 'WEEK' : 'MONTH';
  const body = days.map((d) => {
    const st = d.stats_json ? JSON.parse(d.stats_json) : {};
    const sig = (st.signals || []).map((s) => s.label).join(', ');
    return `${d.period_key} (${st.checked ?? '?'}/${st.total ?? '?'} done${sig ? `; signals: ${sig}` : ''}): ${d.summary}`;
  }).join('\n');
  const gaps = dateKeys.filter((k) => k <= todayKey).length - days.length;
  const raw = await chat({
    messages: [
      { role: 'system', content: JOURNAL_ROLLUP_SYSTEM },
      { role: 'user', content: `Build the ${label} summary for ${key}. Days with no entry: ${Math.max(0, gaps)}.\nDAY summaries:\n${body}` },
    ],
    responseFormat: JOURNAL_ROLLUP_SCHEMA, temperature: 0.2, maxTokens: 500, purpose: 'journal-rollup',
  });
  const o = JSON.parse(strip(raw));
  const stats = {
    days: days.length, gaps: Math.max(0, gaps),
    checked: days.reduce((n, d) => n + ((d.stats_json && JSON.parse(d.stats_json).checked) || 0), 0),
    total: days.reduce((n, d) => n + ((d.stats_json && JSON.parse(d.stats_json).total) || 0), 0),
    signals: Array.isArray(o.signals) ? o.signals.slice(0, 8) : [],
    notable: String(o.notable || ''),
  };
  const summary = String(o.summary || '').trim();
  const closed = to < todayKey; // period fully in the past → store; else live-only
  if (closed) return saveJournalSummary({ userId, journalId, period, periodKey: key, summary, stats });
  return { user_id: userId, journal_id: journalId, period, period_key: key, summary, stats_json: JSON.stringify(stats), live: true };
}

export function ensureWeekSummary(userId, journalId, anyDateKey, now = Date.now(), budget = null) {
  return rollup(userId, journalId, 'week', weekKey(anyDateKey), weekDates(anyDateKey), localDateKey(now), budget);
}
export function ensureMonthSummary(userId, journalId, anyDateKey, now = Date.now(), budget = null) {
  return rollup(userId, journalId, 'month', monthKey(anyDateKey), monthDates(anyDateKey), localDateKey(now), budget);
}

// The per-request day-summary backfill budget: the owner runs uncapped (their box, their bill); anyone
// else gets `cap` generated day summaries per rollup/trends request. Mutated in place by ensureDaySummary.
export function backfillBudget(userId, cap = 6) {
  return { callsLeft: isOwner(userId) ? Infinity : cap };
}

// ── AI pass 3: TRENDS. Reads the rolling dossier + recent rollups (constant-size input), writes the
// report AND the updated dossier back. The medical disclaimer is appended in CODE — never left to the
// model's discretion. ──
export const TREND_DISCLAIMER =
  '🩺 These are patterns in what you logged, not medical advice — a real conversation with a doctor (or vet) is the next step if one worries you.';
const JOURNAL_TRENDS_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'journal_trends', strict: true,
    schema: {
      type: 'object', additionalProperties: false, required: ['message', 'hypotheses', 'watch'],
      properties: {
        message: { type: 'string' },
        hypotheses: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false, required: ['pattern', 'support', 'against'],
            properties: { pattern: { type: 'string' }, support: { type: 'string' }, against: { type: 'string' } },
          },
        },
        watch: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

const summaryLine = (s) => {
  const st = s.stats_json ? JSON.parse(s.stats_json) : {};
  const sig = (st.signals || []).map((x) => `${x.label}×${x.days || 1}`).join(', ');
  return `${s.period} ${s.period_key} (${st.days || '?'} days${sig ? `; ${sig}` : ''}): ${s.summary}`;
};

export async function trendReport(userId, journal, now = Date.now()) {
  const todayKey = localDateKey(now);
  const dossier = parseDossier(journal.dossier_json);
  // Make sure the most recent CLOSED week/month rollups exist, then read back the recent window. One
  // shared backfill budget across both — trends is the single most expensive request a non-owner can make,
  // so its day-summary fan-out is capped per request (the sweep finishes the backfill overnight).
  const budget = backfillBudget(userId);
  const lastWeekDay = localDateKey(now - 7 * DAY_MS);
  const prevMonthDay = `${monthKey(localDateKey(new Date(now).setDate(0)))}-01`; // day 0 = last day of prev month
  try { await ensureWeekSummary(userId, journal.id, lastWeekDay, now, budget); } catch { /* thin data is fine */ }
  try { await ensureMonthSummary(userId, journal.id, prevMonthDay, now, budget); } catch { /* thin data is fine */ }
  const weeks = listJournalSummaries(userId, journal.id, 'week', '0000', '9999').slice(-8);
  const months = listJournalSummaries(userId, journal.id, 'month', '0000', '9999').slice(-3);
  // This-week days aren't in any closed rollup yet — include them raw-stats-only so trends aren't blind
  // to the current week (still stored day rows, not raw entries).
  const recentDays = listJournalSummaries(userId, journal.id, 'day', weekDates(todayKey)[0], todayKey);
  if (!weeks.length && !months.length && !recentDays.length) {
    return { message: `“${journal.name}” has no summaries yet — make a few entries first (try: entry), then ask again.`, dossier, thin: true };
  }
  // Deterministic dossier upkeep BEFORE the model looks: fold the current week's day signals into the
  // rolling counts, so the model reasons over numbers code computed, and signal counts survive even if
  // the LLM pass below fails.
  const signals = { ...(dossier.signals || {}) };
  const seenDays = new Set(dossier.countedDays || []);
  for (const d of recentDays) {
    if (seenDays.has(d.period_key)) continue;
    seenDays.add(d.period_key);
    const st = d.stats_json ? JSON.parse(d.stats_json) : {};
    for (const s of st.signals || []) signals[s.label] = (signals[s.label] || 0) + 1;
  }
  const nextDossier = { ...dossier, signals, countedDays: [...seenDays].sort().slice(-45), lastTrendAt: now };
  const counts = Object.entries(signals).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([l, n]) => `${l}: ${n}`).join(', ');
  const input = [
    `Journal: "${journal.name}".`,
    `Rolling dossier — all-time signal day-counts: ${counts || '(none yet)'}. Watch-list: ${(dossier.watch || []).join(', ') || '(empty)'}.`,
    months.length ? `MONTH summaries:\n${months.map(summaryLine).join('\n')}` : null,
    weeks.length ? `WEEK summaries:\n${weeks.map(summaryLine).join('\n')}` : null,
    recentDays.length ? `Current week's day summaries:\n${recentDays.map(summaryLine).join('\n')}` : null,
  ].filter(Boolean).join('\n\n');
  const raw = await chat({
    messages: [
      { role: 'system', content: JOURNAL_TRENDS_SYSTEM },
      { role: 'user', content: input },
    ],
    responseFormat: JOURNAL_TRENDS_SCHEMA, temperature: 0.4, maxTokens: 700, purpose: 'journal-trends',
  });
  const o = JSON.parse(strip(raw));
  nextDossier.watch = [...new Set([...(Array.isArray(o.watch) ? o.watch : []), ...(dossier.watch || [])])].slice(0, 10);
  nextDossier.hypotheses = (Array.isArray(o.hypotheses) ? o.hypotheses : []).slice(0, 4);
  saveJournalDossier(userId, journal.id, nextDossier);
  return { message: `${String(o.message || '').trim()}\n\n${TREND_DISCLAIMER}`, dossier: nextDossier, thin: false };
}

// ── The nightly sweep: backfill day summaries for CLOSED days so lazy rollups find them ready. Fired from
// the scheduler's minute tick; gated to once per local day (after 01:00), stamped only after a fully clean
// run so failures retry. Days-only by design — week/month stay lazy (cheap once day rows exist). Sweeps
// every entry-bearing journal regardless of the user's opt-in toggle: opting out hides the module but
// never deletes its data, and summarizing kept data is part of keeping it. ──
const SWEEP_STAMP = 'journal:sweep_day';
const localDayNum = (ts = Date.now()) => Math.floor((ts - new Date(ts).getTimezoneOffset() * 60000) / DAY_MS);
let sweepRunning = false;

export async function runJournalSweep(now = Date.now(), { limit = 10 } = {}) {
  if (sweepRunning) return { ran: false, reason: 'already running' };
  const day = localDayNum(now);
  if (new Date(now).getHours() < 1) return { ran: false, reason: 'before 01:00' };
  if (Number(getSetting(SWEEP_STAMP, -1)) >= day) return { ran: false, reason: 'already swept today' };
  sweepRunning = true;
  const done = []; let failed = 0;
  try {
    for (const row of entriesMissingDaySummary(localDateKey(now), limit)) {
      // Per-entry isolation (the fireDueWakeups pattern): one bad entry or LLM hiccup must not lose the
      // night for every other journal. The missing row simply comes back in tomorrow's worklist.
      try {
        // Run as the entry's owner so the summary's LLM call charges THEIR daily budget (llm/context.js).
        await runAsLlmUser(row.user_id, () => ensureDaySummary(row.user_id, row.journal_id, row.entry_date));
        done.push(`${row.journal_id}:${row.entry_date}`);
      } catch (err) {
        failed += 1;
        console.error(`journal sweep: day summary for entry ${row.id} failed (continuing):`, err.message);
      }
    }
    if (!failed) setSetting(SWEEP_STAMP, day); // clean run → don't re-scan until tomorrow
  } finally {
    sweepRunning = false;
  }
  return { ran: true, done, failed };
}
