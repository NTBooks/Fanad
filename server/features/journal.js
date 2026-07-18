// The Journal module (opt-in): the trend journal's chat surface — command shapes, the daily-entry card
// with its tap-to-check buttons, the note/delete dialogs, and the summary/trend replies. The engine
// (entries, hierarchical AI summaries, the rolling dossier, the nightly sweep) lives in server/journal.js,
// following the metrics.js split. Everything here answers in the module's own voice: no pressure — an
// unticked box is data, not guilt.
import {
  listJournals, createJournal, getJournal, deleteJournal, getJournalById, setJournalTemplate,
  getJournalEntry, getJournalEntryById, getTemplate, listEntriesBetween, touchJournal,
} from '../repo.js';
import {
  resolveJournal, newEntry, toggleEntryItems, checkAllItems, noteToday, parseChecklist,
  ensureDaySummary, ensureWeekSummary, ensureMonthSummary, trendReport, localDateKey, backfillBudget,
} from '../journal.js';
import { setDialogState, clearDialogState, deleteConfirmAnswer } from '../dialog.js';
import { registerFeature } from './registry.js';

const USAGE =
  '📔 Journal — a daily checklist + note that I read for trends over time.\n'
  + '• journal new <name> — start one (e.g. journal new food)\n'
  + '• journal template <template> — set its daily checklist from one of your /templates\n'
  + '• entry — open today’s entry · check 1 2 ticks items · journal note <text> adds to the day\n'
  + '• journal today / yesterday / week / month — AI summaries · journal trends — patterns\n'
  + '(“guide journal” walks you through it. Shortcut: j — “j note had dairy at lunch”.)';

const trunc = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

// ── Rendering ──
function journalLine(userId, j, i) {
  const entries = listEntriesBetween(userId, j.id, '0000-01-01', '9999-12-31');
  const today = entries.some((e) => e.entry_date === localDateKey());
  const bits = [`${i + 1}. 📔 ${j.name}`, `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`];
  if (!j.checklist_json) bits.push('no checklist yet');
  if (today) bits.push('today ✓');
  return bits.join(' · ');
}

function homeReply(userId) {
  const all = listJournals(userId);
  if (!all.length) {
    return `${USAGE}\n\nNo journals yet — “journal new food” starts your first (a pet’s works too: “journal new pepper”).`;
  }
  return {
    text: `📔 Your journals:\n${all.map((j, i) => journalLine(userId, j, i)).join('\n')}\n(“entry” opens today · “journal trends” looks for patterns)`,
    buttons: all.map((j) => [{ text: `📔 ${trunc(j.name, 20)} — open today`, data: `m:jop:${j.id}` }]),
  };
}

function entryCard(userId, journal, entry, { created = false } = {}) {
  const items = parseChecklist(entry.checklist_json);
  const done = items.filter((i) => i.done).length;
  const text = [
    `📔 ${journal.name} — ${entry.entry_date}${created ? ' (fresh entry)' : ''}`,
    items.length ? `Checklist ${done}/${items.length}:\n${items.map((it, i) => `${i + 1}. ${it.done ? '☑' : '☐'} ${it.text}`).join('\n')}` : 'No checklist — “journal template <name>” snapshots one from your /templates.',
    entry.note ? `📝 ${entry.note}` : null,
    '(“check 1 2” ticks items · “journal note <text>” adds to the day)',
  ].filter(Boolean).join('\n');
  const buttons = [
    ...items.map((it, i) => [{ text: `${it.done ? '☑' : '☐'} ${i + 1} · ${trunc(it.text, 24)}`, data: `m:jch:${entry.id}.${i + 1}` }]),
    items.length ? [{ text: '✅ All done', data: `m:jca:${entry.id}` }, { text: '📝 Add note', data: `m:jnt:${entry.id}` }] : [{ text: '📝 Add note', data: `m:jnt:${entry.id}` }],
    [{ text: '🗓 Today', data: `m:jsm:${journal.id}.d` }, { text: '📅 Week', data: `m:jsm:${journal.id}.w` }, { text: '🧭 Trends', data: `m:jtr:${journal.id}` }],
  ];
  return { text, buttons };
}

const llmDown = (err) => `⚠️ I couldn’t reach the model for that just now (${err.message}). Your entry is safe — try again in a bit.`;

// ── Commands ──
function openToday(userId, journal) {
  const { entry, created } = newEntry(userId, journal);
  return entryCard(userId, journal, entry, { created });
}

function setTemplateCmd(userId, name) {
  const r = resolveJournal(userId);
  if (r.error) return r.error;
  const tpl = getTemplate(userId, name);
  if (!tpl) return `No template called “${name}” — /templates lists yours, and “template <task N>” saves one.`;
  const steps = parseChecklist(tpl.steps_json).map((s) => ({ text: s.text }));
  if (!steps.length) return `“${tpl.name}” has no steps to copy — add steps to a task and re-save the template first.`;
  setJournalTemplate(userId, r.journal.id, tpl.name, JSON.stringify(steps));
  return `✓ “${r.journal.name}” now uses the “${tpl.name}” checklist (${steps.length} item${steps.length === 1 ? '' : 's'}) — snapshotted, so editing the template later won’t touch this journal. Tomorrow’s entry uses it; “entry” starts today’s.`;
}

async function daySummaryCmd(userId, which, name) {
  const r = resolveJournal(userId, name);
  if (r.error) return r.error;
  const key = which === 'yesterday' ? localDateKey(Date.now() - 86400000) : localDateKey();
  try {
    const s = await ensureDaySummary(userId, r.journal.id, key);
    if (!s) return `No “${r.journal.name}” entry for ${which} — “entry” starts today’s.`;
    return `🗓 ${r.journal.name} · ${key}\n${s.summary}${s.live ? '\n(today’s still moving — I’ll file the day’s final word overnight)' : ''}`;
  } catch (err) { return llmDown(err); }
}

async function rollupCmd(userId, period, name) {
  const r = resolveJournal(userId, name);
  if (r.error) return r.error;
  const fn = period === 'week' ? ensureWeekSummary : ensureMonthSummary;
  try {
    // Non-owners get a per-request cap on the rollup's day-summary backfill (the sweep finishes overnight).
    const s = await fn(userId, r.journal.id, localDateKey(), Date.now(), backfillBudget(userId));
    if (!s) return `No “${r.journal.name}” entries this ${period} yet — a few days of “entry” gives me something to work with.`;
    const icon = period === 'week' ? '📅' : '🗓';
    return `${icon} ${r.journal.name} · ${s.period_key}\n${s.summary}${s.live ? `\n(the ${period} isn’t over — this is a running read)` : ''}`;
  } catch (err) { return llmDown(err); }
}

async function trendsCmd(userId, name) {
  const r = resolveJournal(userId, name);
  if (r.error) return r.error;
  try {
    const out = await trendReport(userId, r.journal);
    return `🧭 ${r.journal.name} — trends\n${out.message}`;
  } catch (err) { return llmDown(err); }
}

// ── Dialogs ──
function handleJournalDelete(userId, text, ds) {
  const ans = deleteConfirmAnswer(text);
  if (!ans) return 'Say “delete” to confirm, or “keep” to cancel.';
  clearDialogState(userId);
  const name = String(ds.data?.name || '');
  if (ans !== 'confirm') return `Kept “${name}” — nothing deleted.`;
  return deleteJournal(userId, name)
    ? `✓ Deleted “${name}” — its entries and summaries went with it.`
    : `Couldn’t find “${name}” anymore — nothing deleted.`;
}

// Each run() re-checks the gate itself: an off module answers with the turn-on offer, never silence
// (the metrics pattern). Bare "journal …" forms match even when off — the offer is the discoverability.
const gated = (fn) => (ctx, hit) => (ctx.isOn('journal') ? fn(ctx, hit) : ctx.offerOn('journal'));

registerFeature({
  name: 'journal',
  commands: [
    { match: ({ lower }) => /^\/?journals?$/.test(lower),
      run: gated(({ userId }) => homeReply(userId)) },
    { match: ({ t }) => /^\/?journal\s+new\s+(.+)$/i.exec(t),
      run: gated(({ userId }, m) => {
        const name = m[1].trim();
        const j = createJournal(userId, name);
        if (!j) return getJournal(userId, name) ? `You already have a “${name}” journal — “journal use ${name}” switches to it.` : 'What should it be called? Try: journal new food';
        return `📔 Started “${j.name}”. Give it a daily checklist with “journal template <template>” (see /templates), or just “entry” + “journal note <text>” for a note-only journal.`;
      }) },
    { match: ({ t }) => /^\/?journal\s+use\s+(.+)$/i.exec(t),
      run: gated(({ userId }, m) => {
        const j = getJournal(userId, m[1].trim());
        if (!j) return `No journal called “${m[1].trim()}” — bare “journal” lists yours.`;
        touchJournal(userId, j.id);
        return `✓ “${j.name}” is now your default journal — bare “entry” and “check” act on it.`;
      }) },
    { match: ({ t }) => /^\/?journal\s+template\s+(.+)$/i.exec(t),
      run: gated(({ userId }, m) => setTemplateCmd(userId, m[1].trim())) },
    // Today's entry: "/entry" is explicit; bare "entry" only when the module is ON (so the word alone
    // still captures as a task for everyone else); "journal entry [name]" is the fully-spelled form.
    { match: ({ lower, isOn }) => /^\/entry$/.test(lower) || (lower === 'entry' && isOn('journal')),
      run: gated(({ userId }) => { const r = resolveJournal(userId); return r.error || openToday(userId, r.journal); }) },
    { match: ({ t }) => /^\/?journal\s+entry(?:\s+(.+))?$/i.exec(t),
      run: gated(({ userId }, m) => { const r = resolveJournal(userId, m[1]?.trim() || null); return r.error || openToday(userId, r.journal); }) },
    { match: ({ t }) => /^\/?journal\s+note\s+([\s\S]+)$/i.exec(t),
      run: gated(({ userId }, m) => {
        const r = resolveJournal(userId);
        if (r.error) return r.error;
        noteToday(userId, r.journal, m[1].trim());
        return `📝 Added to today’s “${r.journal.name}” note. (“entry” shows the day.)`;
      }) },
    { match: ({ t }) => /^\/?journal\s+(today|yesterday)(?:\s+(.+))?$/i.exec(t),
      run: gated(({ userId }, m) => daySummaryCmd(userId, m[1].toLowerCase(), m[2]?.trim() || null)) },
    { match: ({ t }) => /^\/?journal\s+(week|month)(?:\s+(.+))?$/i.exec(t),
      run: gated(({ userId }, m) => rollupCmd(userId, m[1].toLowerCase(), m[2]?.trim() || null)) },
    { match: ({ t }) => /^\/?journal\s+trends?(?:\s+(.+))?$/i.exec(t),
      run: gated(({ userId }, m) => trendsCmd(userId, m[1]?.trim() || null)) },
    { match: ({ t }) => /^\/?journal\s+delete\s+(.+)$/i.exec(t),
      run: gated(({ userId }, m) => {
        const name = m[1].trim();
        const j = getJournal(userId, name);
        if (!j) return `No journal called “${name}” — bare “journal” lists yours.`;
        const n = listEntriesBetween(userId, j.id, '0000-01-01', '9999-12-31').length;
        setDialogState(userId, { type: 'journal_delete', data: { name: j.name }, prompt: `delete the “${j.name}” journal?` });
        return `⚠️ Delete “${j.name}” and its ${n} entr${n === 1 ? 'y' : 'ies'} + summaries? Say “delete” to confirm, or “keep”.`;
      }) },
    // "check 2 3" / "uncheck 2" — digits only, module ON, and a today-entry must exist (all checked here in
    // match(), the registry contract: a matcher that might decline must decline in match) — so "check the
    // mail" and pre-entry "check 1" still fall through to normal task capture.
    { match: ({ t, userId, isOn }) => {
        const m = /^\/?(check|uncheck)\s+(\d+(?:[\s,]+\d+)*)$/i.exec(t);
        if (!m || !isOn('journal')) return null;
        const r = resolveJournal(userId);
        if (r.error) return null;
        const entry = getJournalEntry(userId, r.journal.id, localDateKey());
        if (!entry) return null;
        return { journal: r.journal, entry, done: !/^\/?un/i.test(m[1]), positions: m[2].split(/[\s,]+/).map(Number) };
      },
      run: ({ userId }, hit) => {
        const out = toggleEntryItems(userId, hit.entry.id, hit.positions, hit.done);
        if (!out) return 'That entry’s gone — “entry” opens today’s.';
        const missNote = out.missing.length ? `\n(no item ${out.missing.join(', ')} — the checklist has ${out.items.length})` : '';
        const card = entryCard(userId, hit.journal, out.entry);
        return { ...card, text: card.text + missNote };
      } },
    // Catch-all LAST: any other "journal …" gets the usage card instead of falling through to capture.
    { match: ({ lower }) => /^\/?journal\b/.test(lower),
      run: gated(() => USAGE) },
  ],
  dialogHandlers: {
    journal_note: (userId, text, ds) => {
      clearDialogState(userId);
      const entry = getJournalEntryById(userId, Number(ds.data?.entryId));
      if (!entry) return 'That entry’s gone — “entry” opens today’s.';
      const journal = getJournalById(userId, entry.journal_id);
      // Notes land on TODAY: a note typed against a stale card from yesterday shouldn't rewrite the past.
      if (entry.entry_date !== localDateKey()) {
        noteToday(userId, journal, text);
        return `📝 Added to today’s “${journal.name}” note (that card was an older day).`;
      }
      noteToday(userId, journal, text);
      return entryCard(userId, journal, getJournalEntryById(userId, entry.id));
    },
    journal_delete: handleJournalDelete,
  },
  menuActions: {
    // All values are journal/entry ROW ids (never task ids); every handler re-resolves with the user_id
    // scope, so a forged or stale id gets a gentle "gone" (the timer `tmr` pattern).
    jch: (userId, d) => { // toggle one checklist item — value is "<entryId>.<pos>"
      const [eid, pos] = String(d.value || '').split('.').map(Number);
      const entry = Number.isInteger(eid) && eid > 0 ? getJournalEntryById(userId, eid) : null;
      if (!entry) return { text: 'That entry’s gone — “entry” opens today’s.', buttons: null, toast: 'Already gone' };
      const out = toggleEntryItems(userId, entry.id, [pos]);
      const journal = getJournalById(userId, entry.journal_id);
      return { ...entryCard(userId, journal, out.entry), toast: out.changed.length ? '✓' : 'No such item' };
    },
    jca: (userId, d) => {
      const entry = getJournalEntryById(userId, Number(d.value));
      if (!entry) return { text: 'That entry’s gone — “entry” opens today’s.', buttons: null, toast: 'Already gone' };
      const out = checkAllItems(userId, entry.id);
      return { ...entryCard(userId, getJournalById(userId, entry.journal_id), out.entry), toast: 'All done ✅' };
    },
    jnt: (userId, d) => { // arm the note dialog — the next message is the note
      const entry = getJournalEntryById(userId, Number(d.value));
      if (!entry) return { text: 'That entry’s gone — “entry” opens today’s.', buttons: null, toast: 'Already gone' };
      setDialogState(userId, { type: 'journal_note', data: { entryId: entry.id }, prompt: 'the next message goes into the note' });
      return { text: '📝 Go ahead — your next message goes into today’s note.' };
    },
    jop: (userId, d) => { // open/create today's entry for a journal
      const journal = getJournalById(userId, Number(d.value));
      if (!journal) return { text: 'That journal’s gone — bare “journal” lists yours.', buttons: null, toast: 'Already gone' };
      return openToday(userId, journal);
    },
    jsm: async (userId, d) => { // summaries — value is "<journalId>.<d|w|m>"
      const [jid, p] = String(d.value || '').split('.');
      const journal = getJournalById(userId, Number(jid));
      if (!journal) return { text: 'That journal’s gone — bare “journal” lists yours.', buttons: null, toast: 'Already gone' };
      if (p === 'd') return daySummaryCmd(userId, 'today', journal.name);
      return rollupCmd(userId, p === 'm' ? 'month' : 'week', journal.name);
    },
    jtr: async (userId, d) => {
      const journal = getJournalById(userId, Number(d.value));
      if (!journal) return { text: 'That journal’s gone — bare “journal” lists yours.', buttons: null, toast: 'Already gone' };
      return trendsCmd(userId, journal.name);
    },
  },
});
