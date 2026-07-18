// Richer task capture (v14): trap MORE — verbatim original_text + a trimmed summary + a fuller
// llm_summary + an inferred mood; manual priority (words / P-numbers); an "on <when>" schedule that sets
// a deadline AND a one-time reminder the scheduler fires once; and a category/difficulty lock for bulk adds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-capture-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const { parsePriority, priorityMark, priorityLabel } = await import('../shared/priority.js');
const { parseOnWhen, parseDeadline, extractDeadline, parseRemindAt } = await import('../server/services/llm/deadline.js');
const { parseTaskMeta, chooseTaskTitle } = await import('../server/ingest.js');
const { fireDueReminders } = await import('../server/scheduler.js');
const { defaultUserId, listTasks, getTask, insertTask, setTaskStatus, latestMood } = await import('../server/repo.js');

migrate();
// Modules are per-user opt-in (default OFF); these behaviour tests run as the root user with all on.
(await import('../server/settings.js')).setUserFeatures(1, { notes: true, lists: true, metrics: true, vouch: true });
const uid = defaultUserId();
const say = (text) => { clearDialogState(uid); return handleMessage({ text }); };
const find = (needle) => listTasks(uid).find((x) => (x.summary || '').includes(needle));

// A weekday name a couple of days in the FUTURE, for the end-to-end say() date tests. "on friday 2pm" run on a
// Friday AFTER 2pm resolves to today-in-the-past → the task expires, dropping off /tasks and clearing its
// 🔔/📅 markers (parseOnWhen picks the this-week occurrence and does not roll past times forward). Two days out
// is never today and is future at any clock time, so these tests stay clock-independent. (The PURE parseOnWhen
// tests below pin the fixed NOW and are unaffected.)
const FUTURE_WEEKDAY = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][(new Date().getDay() + 2) % 7];

// A Sunday, 10:00 — fixed so the weekday/date math is deterministic.
const NOW = new Date(2026, 5, 21, 10, 0, 0, 0).getTime();

// ── pure: priority parsing ──
test('parsePriority reads words and P-numbers (P1 = highest) and strips the cue', () => {
  assert.deepEqual(parsePriority('submit taxes high priority'), { level: 3, clean: 'submit taxes' });
  assert.deepEqual(parsePriority('water plants p3'), { level: 1, clean: 'water plants' });
  assert.equal(parsePriority('finish report priority 2').level, 2);
  assert.equal(parsePriority('urgent: call the bank').level, 3);
  assert.equal(parsePriority('low priority tidy the shed').level, 1);
  assert.equal(parsePriority('buy high-protein food'), null); // "high" without "priority" is not a cue
  assert.equal(priorityLabel(3), 'high');
  assert.match(priorityMark(1), /low/);
});

// ── pure: the list title keeps the user's OWN words, only deferring to the model when too long ──
test('chooseTaskTitle keeps the user’s wording and defers to the LLM label only when too long', () => {
  // a short, normal capture keeps the user's words verbatim even when the model would paraphrase it —
  // this is the "finish eddie video" → "send video to eddie" rewrite we no longer apply
  assert.equal(chooseTaskTitle('finish eddie video', 'send video to eddie'), 'finish eddie video');
  // a rambling brain-dump that wouldn't fit a list row → the model's short label takes over
  const long = 'remember to email sarah the q3 figures and also call the bank about the overdraft before friday';
  assert.ok(long.length > 60);
  assert.equal(chooseTaskTitle(long, 'email Sarah the Q3 figures'), 'email Sarah the Q3 figures');
  // …but never blank the title: if the model gave nothing, keep the user's words even when long
  assert.equal(chooseTaskTitle(long, ''), long);
});

// ── pure: "on <when>" parsing ──
test('parseOnWhen sets a deadline + reminder only when a real date follows "on"', () => {
  const fri = parseOnWhen('call mom on friday 3pm', NOW);
  assert.equal(fri.clean, 'call mom');
  assert.equal(new Date(fri.dueAt).getDay(), 5);          // Friday
  assert.equal(new Date(fri.dueAt).getHours(), 15);       // 3pm
  assert.equal(fri.remindAt, fri.dueAt);                  // with a time, both land on the moment

  const mon = parseOnWhen('water plants on monday', NOW);
  assert.equal(mon.clean, 'water plants');
  assert.equal(new Date(mon.remindAt).getHours(), 9);     // date only → a 09:00 nudge
  assert.equal(new Date(mon.dueAt).getHours(), 23);       // …due end of that day

  assert.equal(parseOnWhen('work on the report', NOW), null);  // "the report" is not a date
  assert.equal(parseOnWhen('turn on the lamp', NOW), null);
  assert.equal(parseOnWhen("check on tuesday's numbers", NOW), null); // mid-sentence date = content, not a schedule
  assert.equal(parseOnWhen('party on friday with cake', NOW), null);  // only a TRAILING "on <when>" schedules
});

test('parseTaskMeta combines priority + on-schedule and leaves clean task text', () => {
  const meta = parseTaskMeta('finish deck on friday 2pm high priority', NOW);
  assert.equal(meta.text, 'finish deck');
  assert.equal(meta.priority, 3);
  assert.equal(new Date(meta.dueAt).getHours(), 14);
  assert.equal(meta.remindAt, meta.dueAt);
});

// ── pure: "remind me … at <time>" / relative reminders (a PURE reminder — remind_at only, no due_at) ──
test('parseRemindAt pins a clock-time reminder, strips the scaffolding, sets NO deadline', () => {
  const r = parseRemindAt('remind me to call the vet at 9:45pm', NOW);
  assert.equal(r.clean, 'call the vet');
  assert.equal(r.dueAt, null);                       // a reminder is not a deadline → it never auto-expires
  assert.equal(new Date(r.remindAt).getHours(), 21);
  assert.equal(new Date(r.remindAt).getMinutes(), 45);
  assert.equal(new Date(r.remindAt).getDate(), 21);  // 9:45pm is still ahead of 10am Sunday → today
  assert.equal(parseRemindAt('remind me at 6am', NOW).clean, 'remind me'); // bare body → summary falls back
});

test('parseRemindAt rolls a past clock time to tomorrow and handles relative offsets', () => {
  const past = parseRemindAt('remind me to stretch at 9am', NOW); // 9am < 10am now → tomorrow 9am
  assert.equal(new Date(past.remindAt).getDate(), 22);
  assert.equal(new Date(past.remindAt).getHours(), 9);

  const rel = parseRemindAt('remind me to flip the laundry in 30 minutes', NOW);
  assert.equal(rel.clean, 'flip the laundry');
  assert.equal(rel.remindAt, NOW + 30 * 60000);
  assert.equal(parseRemindAt('remind me in 2 hours to check the oven', NOW).remindAt, NOW + 2 * 3600000);
});

test('parseRemindAt needs an explicit "remind me" + a TRAILING time — never hijacks content', () => {
  assert.equal(parseRemindAt('meet sam at the cafe at 5', NOW), null);          // no "remind me"
  assert.equal(parseRemindAt('remind me to call mom', NOW), null);              // no time at all
  assert.equal(parseRemindAt('remind me to read page 5', NOW), null);          // a bare trailing number isn't a time
  assert.equal(parseRemindAt('remind me to look at 3 options today', NOW), null); // time isn't trailing
});

test('parseTaskMeta routes "remind me … at <time>" to remind_at (clean text, no due_at) but lets "on <date>" win', () => {
  const meta = parseTaskMeta('remind me to take the bins out at 8pm', NOW);
  assert.equal(meta.text, 'take the bins out');
  assert.equal(meta.dueAt, null);                       // pure reminder — no deadline, so it won't expire
  assert.equal(new Date(meta.remindAt).getHours(), 20);

  // A real "on <date> <time>" is still owned by parseOnWhen (a Friday deadline+reminder), not the fallback.
  const onDate = parseTaskMeta('remind me to call mom on friday 3pm', NOW);
  assert.equal(new Date(onDate.dueAt).getDay(), 5);     // Friday, not "today"
  assert.equal(onDate.remindAt, onDate.dueAt);
});

test('"remind me … at <time>" via chat sets a future remind_at (no deadline) and shows the 🔔 marker', async () => {
  const r = await say('remind me to call the vet at 9:45pm');
  assert.match(r.reply, /🔔/);
  const t = find('call the vet');
  assert.ok(t, 'task was filed');
  assert.ok(t.remind_at > Date.now(), 'a reminder is set in the future (the scheduler will fire it)');
  assert.equal(t.due_at, null, 'a pure reminder carries no deadline');
});

// ── end-to-end via the chat brain ──
test('a feeling in words is trapped: original kept verbatim, summary filed, fuller detail saved, mood read', async () => {
  await say("I need to do laundry, but I'm exhausted");
  const t = find('laundry');
  assert.ok(t, 'task was filed');
  assert.match(t.original_text, /I need to do laundry, but I'm exhausted/); // verbatim original
  assert.ok(t.llm_summary && t.llm_summary.length, 'a fuller paragraph is saved');
  assert.match(latestMood(uid, 0) || '', /😫/); // "exhausted" → 😫 (word list; the LLM is the fuzzy fallback)
});

test('manual priority lands on the row and the summary stays clean (cue stripped before classify)', async () => {
  await say('call the plumber high priority');
  const t = find('plumber');
  assert.equal(t.priority, 3);
  assert.doesNotMatch(t.summary, /priority/i); // "high priority" never reaches the list label
  assert.match((await say('renew passport p1')).reply, /🔴 high/); // filed line shows the marker
});

test('"on <weekday> <time>" via chat sets remind_at AND due_at and shows the 🔔 marker', async () => {
  const r = await say(`prep slides on ${FUTURE_WEEKDAY} 2pm`);
  assert.match(r.reply, /🔔/);
  const t = find('prep slides');
  assert.ok(t.remind_at > Date.now(), 'reminder set in the future');
  assert.ok(t.due_at > Date.now(), 'deadline set too (both)');
});

test('a due reminder fires exactly once, queues a wake-up, and never re-fires', async () => {
  const t = insertTask({ userId: uid, summary: 'take the meds', category: 'health', effortLevel: 'low', remindAt: Date.now() - 1000 });
  const fired = await fireDueReminders(Date.now(), { send: () => {} });
  assert.ok(fired.some((x) => x.includes('take the meds')), 'reminder fired');
  assert.ok(getTask(uid, t.id).reminded_at, 'stamped as reminded');
  const again = await fireDueReminders(Date.now(), { send: () => {} });
  assert.ok(!again.some((x) => x.includes('take the meds')), 'does not fire a second time');
});

// ── category / difficulty lock ──
test('a category lock pins every add until /unlock', async () => {
  await say('/lock work');
  await say('buy potting soil');           // mock would call this an errand
  assert.equal(find('potting soil').category, 'work');
  await say('/unlock');
  await say('water the ferns');
  assert.notEqual(find('ferns').category, 'work'); // guessing again
});

test('a difficulty lock pins effort too', async () => {
  await say('/lock high');
  await say('quick email reply');          // mock would call this trivial ("quick")
  assert.equal(find('email reply').effort_level, 'high');
  await say('/unlock');
});

test('"lock the front door" is a task, not a lock command', async () => {
  const r = await say('lock the front door');
  assert.match(r.reply, /Filed/);
  assert.ok(find('lock the front door'));
});

test('/lock <unknown word> mints a brand-new category, locks to it, and persists it', async () => {
  const { getSetting } = await import('../server/settings.js');
  const { loadCustomCategories } = await import('../server/categories.js');
  const cats = await import('../shared/categories.js');

  const r = await say('/lock gardening');            // a word no built-in category covers
  assert.match(r.reply, /New category/i);
  assert.match(r.reply, /Gardening/);

  // It's first-class now: the classifiable list, the label map, and the fuzzy matcher all know it.
  assert.ok(cats.CATEGORIES.includes('gardening'));
  assert.equal(cats.CATEGORY_LABELS.gardening, 'Gardening');
  assert.equal(cats.closestCategory('gardening'), 'gardening');

  // New adds land in it while the lock holds.
  await say('plant the tomatoes');
  assert.equal(find('tomatoes').category, 'gardening');
  await say('/unlock');

  // Persisted (survives a restart): stored in app_settings, and a fresh load re-registers it with no dupes.
  assert.ok((getSetting('custom_categories', []) || []).some((m) => m.key === 'gardening'));
  loadCustomCategories();
  assert.equal(cats.CATEGORIES.filter((c) => c === 'gardening').length, 1);
});

test('/lock with a multi-word phrase does not mint a junk category', async () => {
  const cats = await import('../shared/categories.js');
  const before = cats.CATEGORIES.length;
  const r = await say('/lock the front door');       // slash form reaches lockCommand
  assert.match(r.reply, /couldn't read/i);
  assert.equal(cats.CATEGORIES.length, before);      // nothing added
});

test('/remcat deletes a custom category, moves its tasks to the destination, and un-persists it', async () => {
  const { getSetting } = await import('../server/settings.js');
  const cats = await import('../shared/categories.js');

  await say('/lock pottery');                         // mint + lock to a custom category
  await say('throw a bowl');
  const movedTask = find('throw a bowl');
  assert.equal(movedTask.category, 'pottery');
  await say('/unlock');

  const r = await say('/remcat pottery household');   // remove it, send its tasks to Home
  assert.match(r.reply, /Removed category/i);
  assert.match(r.reply, /custom/i);
  assert.match(r.reply, /1 task/);                    // exactly the one task moved

  assert.ok(!cats.CATEGORIES.includes('pottery'));    // gone from the live taxonomy
  assert.equal(getTask(uid, movedTask.id).category, 'household'); // its task was reassigned
  assert.ok(!(getSetting('custom_categories', []) || []).some((m) => m.key === 'pottery')); // un-persisted
});

test('/remcat defaults the destination to "other" and retires a BUILT-IN category permanently', async () => {
  const { getSetting } = await import('../server/settings.js');
  const { loadCustomCategories } = await import('../server/categories.js');
  const cats = await import('../shared/categories.js');

  const t = insertTask({ userId: uid, summary: 'file the receipts', category: 'admin', effortLevel: 'low' });
  const r = await say('/remcat admin');               // no destination → defaults to 'other'
  assert.match(r.reply, /built-in/i);
  assert.match(r.reply, /Other/);

  assert.ok(!cats.CATEGORIES.includes('admin'));       // retired from the live set
  assert.equal(cats.closestCategory('admin'), null);   // and from the fuzzy matcher (its synonyms went too)
  assert.equal(getTask(uid, t.id).category, 'other');  // its task moved to the catch-all

  // The retirement is persisted and re-applied on a fresh boot.
  assert.ok((getSetting('disabled_categories', []) || []).includes('admin'));
  loadCustomCategories();
  assert.ok(!cats.CATEGORIES.includes('admin'));

  // …and re-adding it via /lock brings it back (un-retires).
  await say('/lock admin');
  assert.ok(cats.CATEGORIES.includes('admin'));
  await say('/unlock');
});

test('/remcat refuses to remove the "other" catch-all and rejects unknown categories', async () => {
  assert.match((await say('/remcat other')).reply, /catch-all|can.t be removed/i);
  assert.match((await say('/remcat nope-not-real')).reply, /No current category/i);
});

// ── single-word finish/stop words close the started task (the "end" → filed-a-task bug) ──
test('"end" (and other finish words) complete the most-recently-started task, like "done"', async () => {
  const t = insertTask({ userId: uid, summary: 'rake the leaves', category: 'household', effortLevel: 'low' });
  setTaskStatus(uid, t.id, 'in_progress');
  const r = await say('end');
  assert.match(r.reply, /✓ Done/);
  assert.match(r.reply, /rake the leaves/);
  assert.equal(getTask(uid, t.id).status, 'done');
});

test('a bare finish word with nothing in progress files NO task (and no bogus deadline)', async () => {
  const before = listTasks(uid).length;
  const r = await say('end'); // the only started task is now done → nothing in progress
  assert.match(r.reply, /nothing in progress|don't see/i);
  assert.equal(listTasks(uid).length, before, 'no junk task filed');
});

test('a bare "end" carries no deadline — it never defaults to "due today"', async () => {
  assert.equal(parseDeadline('end'), null);           // deterministic parser: not a deadline
  assert.equal(await extractDeadline('end'), null);    // and the (mock) LLM path adds none
});

test('"finish <thing>" with no matching task files the REMAINDER as a task — the verb is stripped', async () => {
  const r = await say('finish edits on Yolosapiens');
  assert.match(r.reply, /Filed/);
  const t = find('Yolosapiens');
  assert.ok(t, 'the task was captured, not rejected');
  assert.doesNotMatch(t.summary, /\bfinish\b/i, 'no verb-polluted "finish edits…" summary');
});

// The leading slash is an OPTIONAL prefix — it must not change the outcome. "/finish <unknown>" used to
// error and file nothing while bare "finish <unknown>" captured; now both capture identically.
test('"/finish <unknown>" behaves exactly like the bare form — captures, never diverges', async () => {
  const before = listTasks(uid).length;
  const r = await say('/finish Zorbax');
  assert.match(r.reply, /Filed/);
  assert.equal(listTasks(uid).length, before + 1, 'slash and bare forms agree — both file a task');
  assert.ok(find('Zorbax'), 'the remainder is filed, not the verb');
});

// ── stray acknowledgments with nothing pending are not tasks (double-sent "no" bug) ──
test('a stray "no" with nothing to answer is acknowledged, never filed as a task', async () => {
  const before = listTasks(uid).length;
  const r = await say('no'); // say() clears any dialog first → exactly the "second no" situation
  assert.equal(r.reply, '👍');
  assert.equal(listTasks(uid).length, before, 'no task called "no" was created');
});

test('other bare fillers (yes/ok/sure/nvm) and "thanks" never become tasks', async () => {
  const before = listTasks(uid).length;
  for (const w of ['yes', 'ok', 'sure', 'nope', 'nvm']) {
    assert.equal((await say(w)).reply, '👍', `"${w}" should be a gentle ack`);
  }
  assert.match((await say('thanks')).reply, /Anytime/);
  assert.equal(listTasks(uid).length, before, 'no filler word was filed');
});
