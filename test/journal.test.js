// The opt-in Journal module (trend journal): named journals, template SNAPSHOT checklists, idempotent
// daily entries, notes, hierarchical AI summaries (day rows feed week/month — raw entries are never
// re-read), the trends pass + rolling dossier, the "j" shortcut, and the nightly sweep. All offline via
// the mock provider (mock.js echoes each journal pass's JSON shape).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-journal-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate, db } = await import('../server/db.js');
const { handleMessage, handleAction } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const {
  defaultUserId, getOrCreateTelegramUser, listTasks, listJournals, getJournal, getJournalEntry,
  insertJournalEntry, getJournalSummary, listJournalSummaries, saveJournalSummary, saveTemplate, getTemplate,
} = await import('../server/repo.js');
const { setUserFeatures } = await import('../server/settings.js');
const { localDateKey, parseChecklist, runJournalSweep, weekKey } = await import('../server/journal.js');
const { dayStartOf } = await import('../shared/timeframe.js');
const { insertTask, addTaskStep } = await import('../server/repo.js');

migrate();
const uid = defaultUserId();
const say = async (text) => { clearDialogState(uid); return handleMessage({ text }); };
const reply = async (text) => (await say(text)).reply;
const journalOn = (on = true) => setUserFeatures(uid, { journal: on });
const DAY = 86400000;
const todayKey = localDateKey();
const dayKey = (offset) => localDateKey(Date.now() + offset * DAY);
// A "now" safely inside today but past the sweep's 01:00 gate, whatever hour the suite runs at —
// noon of the LOGICAL day (02:00 rollover): between midnight and 2am, calendar-noon would be tomorrow.
const NOON = new Date(dayStartOf(Date.now())).setHours(12, 0, 0, 0);

// A template to snapshot from: a task with steps, saved by name (the same path a user takes).
function makeTemplate(name, steps) {
  const task = insertTask({ userId: uid, summary: `blueprint for ${name}` });
  for (const s of steps) addTaskStep(uid, task.id, s);
  return saveTemplate(uid, task.id, name);
}

// ── module gate ──

test('with Journal off, /journal offers the one-tap turn-on', async () => {
  journalOn(false);
  const r = await say('/journal');
  assert.match(r.reply, /Journal is off/i);
  const datas = (r.buttons || []).flat().map((b) => b.data);
  assert.ok(datas.includes('m:optin:journal'), 'offer has a Turn-on-Journal button');
});

test('with Journal off, bare "check the mail" still files as a task', async () => {
  journalOn(false);
  const before = listTasks(uid).length;
  await say('check the mail');
  assert.equal(listTasks(uid).length, before + 1);
});

// ── create · template snapshot · default resolution ──

test('journal new + template snapshots the steps (later template edits never touch the journal)', async () => {
  journalOn();
  makeTemplate('morning-checks', ['walk the dog', 'no dairy breakfast', 'meds']);
  assert.match(await reply('journal new food'), /Started “food”/);
  assert.match(await reply('journal template morning-checks'), /3 items.*snapshotted/s);
  const j = getJournal(uid, 'food');
  assert.deepEqual(parseChecklist(j.checklist_json).map((s) => s.text), ['walk the dog', 'no dairy breakfast', 'meds']);
  // Overwrite the template with different steps — the journal's snapshot must not move.
  makeTemplate('morning-checks', ['completely different']);
  assert.equal(parseChecklist(getTemplate(uid, 'morning-checks').steps_json).length, 1);
  assert.equal(parseChecklist(getJournal(uid, 'food').checklist_json).length, 3, 'journal kept its snapshot');
});

test('a second journal + "journal use" picks the default; bare "journal" lists both', async () => {
  journalOn();
  assert.match(await reply('journal new pepper'), /Started “pepper”/);
  assert.equal(listJournals(uid).length, 2);
  assert.match(await reply('journal use food'), /“food” is now your default/);
  const r = await say('journal');
  assert.match(r.reply, /1\. 📔 food/);
  assert.match(r.reply, /2\. 📔 pepper/);
});

// ── entries: idempotent per day, checklist reset, check/uncheck, note ──

test('"entry" opens today once — a second "entry" returns the SAME row', async () => {
  journalOn();
  const r1 = await say('entry');
  assert.match(r1.reply, /food — \d{4}-\d{2}-\d{2}/);
  assert.match(r1.reply, /1\. ☐ walk the dog/);
  const j = getJournal(uid, 'food');
  const e1 = getJournalEntry(uid, j.id, todayKey);
  await say('entry');
  const e2 = getJournalEntry(uid, j.id, todayKey);
  assert.equal(e1.id, e2.id, 'same entry, not a duplicate');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM journal_entries WHERE journal_id = ?').get(j.id).n, 1);
});

test('"check 1 2" ticks items; "uncheck 2" unticks; out-of-range is called out', async () => {
  journalOn();
  const r = await say('check 1 2');
  assert.match(r.reply, /1\. ☑ walk the dog/);
  assert.match(r.reply, /2\. ☑ no dairy breakfast/);
  assert.match((await say('uncheck 2')).reply, /2\. ☐ no dairy breakfast/);
  assert.match((await say('check 9')).reply, /no item 9/);
});

test('the ☐ button (m:jch) toggles too, and a forged entry id gets a gentle "gone"', async () => {
  journalOn();
  const j = getJournal(uid, 'food');
  const e = getJournalEntry(uid, j.id, todayKey);
  const r = await handleAction(uid, `m:jch:${e.id}.3`);
  assert.match(r.text, /3\. ☑ meds/);
  const forged = await handleAction(uid, 'm:jch:99999.1');
  assert.match(forged.text, /entry’s gone/);
});

test('"journal note …" appends to today (creating the entry if needed); repeats stack', async () => {
  journalOn();
  await say('journal note had dairy at lunch');
  assert.match((await say('journal note headache by 3pm')).reply, /Added to today/);
  const e = getJournalEntry(uid, getJournal(uid, 'food').id, todayKey);
  assert.match(e.note, /had dairy at lunch\nheadache by 3pm/);
});

test('with Journal ON but no positions, "check the mail" still files as a task', async () => {
  journalOn();
  const before = listTasks(uid).length;
  await say('check the mail');
  assert.equal(listTasks(uid).length, before + 1);
});

// ── the j shortcut ──

test('bare "j" opens the journal home; "j note …" lands in today\'s note', async () => {
  journalOn();
  assert.match(await reply('j'), /Your journals/);
  await say('j note pepper limped this morning');
  const e = getJournalEntry(uid, getJournal(uid, 'food').id, todayKey);
  assert.match(e.note, /pepper limped this morning/);
});

// ── summaries: lazy day (stored once, closed days only), hierarchical week ──

test('"journal today" is LIVE-only (no stored row while the day is still moving)', async () => {
  journalOn();
  assert.match(await reply('journal today'), /food · \d{4}-\d{2}-\d{2}/);
  assert.equal(getJournalSummary(uid, getJournal(uid, 'food').id, 'day', todayKey), null);
});

test('a closed day is stored exactly once — asking twice reuses the row', async () => {
  journalOn();
  const j = getJournal(uid, 'food');
  insertJournalEntry({
    userId: uid, journalId: j.id, entryDate: dayKey(-1),
    checklistJson: JSON.stringify([{ text: 'no dairy breakfast', done: false, completed_at: null }]),
    note: 'had dairy at lunch, headache by 3pm',
  });
  await say('journal yesterday');
  const row = getJournalSummary(uid, j.id, 'day', dayKey(-1));
  assert.ok(row, 'yesterday got a stored day summary');
  await say('journal yesterday');
  const again = getJournalSummary(uid, j.id, 'day', dayKey(-1));
  assert.equal(again.created_at, row.created_at, 'second ask reused the stored row');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM journal_summaries WHERE journal_id = ? AND period = 'day'").get(j.id).n, 1);
});

test('hierarchy proof: the week rollup reads stored DAY rows, never raw entries', async () => {
  journalOn();
  const j = getJournal(uid, 'food');
  // The prior test's day row is for YESTERDAY, which falls in LAST week when today is Monday — seed a
  // stored day row for TODAY so the current week always holds one, whatever weekday the suite runs on.
  saveJournalSummary({
    userId: uid, journalId: j.id, period: 'day', periodKey: todayKey,
    summary: 'seeded day summary', stats: { checked: 1, total: 1, signals: [] },
  });
  // Delete every raw entry — the stored day summaries must be enough for the week pass.
  db.prepare('DELETE FROM journal_entries WHERE journal_id = ?').run(j.id);
  const r = await reply('journal week');
  assert.match(r, /food · \d{4}-W\d{2}/);
  assert.match(r, /mock rollup/i);
});

// ── trends: report + disclaimer + dossier update ──

test('"journal trends" reports tentative patterns, appends the disclaimer, and updates the dossier', async () => {
  journalOn();
  const r = await reply('journal trends');
  assert.match(r, /not medical advice/);
  assert.match(r, /doctor \(or vet\)/);
  const d = JSON.parse(getJournal(uid, 'food').dossier_json);
  assert.ok(d.lastTrendAt > 0, 'dossier stamped');
  assert.ok(Array.isArray(d.watch), 'watch-list merged');
});

// ── delete: confirm-gated, cascades ──

test('journal delete asks first; "delete" erases the journal + its rows; a bare "yes" does NOT', async () => {
  journalOn();
  assert.match(await reply('journal new scratch'), /Started/);
  // Arm + an ambiguous reply → escapes (never deletes); then arm + explicit confirm → gone.
  await handleMessage({ text: 'journal delete scratch' });
  await handleMessage({ text: 'yes' }); // NOT a valid confirm for deletion — escapes to capture
  assert.ok(getJournal(uid, 'scratch'), 'a bare "yes" never deletes');
  await handleMessage({ text: 'journal delete scratch' });
  const r = await handleMessage({ text: 'delete' });
  assert.match(r.reply, /Deleted “scratch”/);
  assert.equal(getJournal(uid, 'scratch'), null);
});

// ── isolation: another user sees none of it ──

test('journals are per-user: a second account starts empty and cannot touch the first\'s entries', async () => {
  journalOn();
  const other = getOrCreateTelegramUser('777001', 'other');
  setUserFeatures(other, { journal: true });
  assert.equal(listJournals(other).length, 0);
  const j = getJournal(uid, 'food');
  const mine = await handleMessage({ text: 'entry' });
  const e = getJournalEntry(uid, j.id, todayKey);
  const foreign = await handleAction(other, `m:jch:${e.id}.1`);
  assert.match(foreign.text, /entry’s gone/, 'foreign tap is ownership-blocked');
});

// ── the nightly sweep ──

test('runJournalSweep backfills day summaries for closed days, skips failures, and gates per day', async () => {
  journalOn();
  const j = getJournal(uid, 'food');
  db.prepare('DELETE FROM journal_summaries WHERE journal_id = ?').run(j.id);
  db.prepare('DELETE FROM journal_entries WHERE journal_id = ?').run(j.id);
  const mk = (offset, note) => insertJournalEntry({
    userId: uid, journalId: j.id, entryDate: dayKey(offset),
    checklistJson: JSON.stringify([{ text: 'meds', done: true, completed_at: Date.now() }]), note,
  });
  mk(-3, 'fine day');
  mk(-2, '__llm_http_500__ this one breaks the model'); // mock provider failure hook
  mk(-1, 'had dairy, headache');

  const out = await runJournalSweep(NOON);
  assert.equal(out.ran, true);
  assert.equal(out.done.length, 2, 'the two healthy days got rows');
  assert.equal(out.failed, 1, 'the broken day was skipped, not fatal');
  assert.ok(getJournalSummary(uid, j.id, 'day', dayKey(-3)));
  assert.ok(getJournalSummary(uid, j.id, 'day', dayKey(-1)));
  assert.equal(getJournalSummary(uid, j.id, 'day', dayKey(-2)), null, 'failed day left for the next run');

  // A failed run does NOT stamp the day-gate: the next call runs again and retries the miss (still failing
  // here — the note itself is the failure hook — but it must be ATTEMPTED).
  const retry = await runJournalSweep(NOON);
  assert.equal(retry.ran, true);
  assert.equal(retry.failed, 1, 'the broken entry was retried');

  // Heal the entry → clean run → stamped → a third call is a no-op for the rest of the day.
  db.prepare('UPDATE journal_entries SET note = ? WHERE journal_id = ? AND entry_date = ?').run('healed', j.id, dayKey(-2));
  const clean = await runJournalSweep(NOON);
  assert.equal(clean.failed, 0);
  assert.ok(getJournalSummary(uid, j.id, 'day', dayKey(-2)), 'healed day filled in');
  const gated = await runJournalSweep(NOON);
  assert.equal(gated.ran, false, 'clean run stamped the once-a-day gate');
});

test('the sweep runs even for a user who has opted the module OFF (data kept ⇒ summaries kept)', async () => {
  journalOn(false); // hide the module — the data and its overnight upkeep stay
  const j = getJournal(uid, 'food');
  insertJournalEntry({
    userId: uid, journalId: j.id, entryDate: dayKey(-5),
    checklistJson: JSON.stringify([{ text: 'meds', done: false, completed_at: null }]), note: 'quiet day',
  });
  // New local day for the gate: pretend it's tomorrow noon (yesterday's stamp is behind it).
  const out = await runJournalSweep(NOON + DAY);
  assert.equal(out.ran, true);
  assert.ok(getJournalSummary(uid, j.id, 'day', dayKey(-5)), 'opted-out user still got the backfill');
  journalOn();
});
