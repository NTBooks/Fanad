// Advanced /task: explicit category, a trailing deadline that raises priority, and non-judgy expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-task-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const { suggestTask } = await import('../server/rag/index.js');
const { closestCategory } = await import('../shared/categories.js');
const {
  defaultUserId, insertTask, getTask, listTasks, expireDueTasks,
} = await import('../server/repo.js');

migrate();
// Modules are per-user opt-in (default OFF); these behaviour tests run as the root user with all on.
(await import('../server/settings.js')).setUserFeatures(1, { notes: true, lists: true, metrics: true, vouch: true });
const uid = defaultUserId();
const say = (text) => { clearDialogState(uid); return handleMessage({ text }); };

test('/task:category sets the chosen category', async () => {
  const r = await say('/task:health book a dentist appointment');
  assert.match(r.reply, /Filed/);
  assert.match(r.reply, /Health/);
  const t = listTasks(uid).find((x) => x.summary.includes('dentist'));
  assert.equal(t.category, 'health');
  assert.equal(t.due_at, null); // no trailing deadline
});

test('/task without a category falls back to classification', async () => {
  await say('/task email the client about the invoice');
  const t = listTasks(uid).find((x) => x.summary.includes('invoice'));
  assert.equal(t.category, 'work'); // mock classifier → work
});

test('closestCategory resolves synonyms, plurals, and typos (or gives up)', () => {
  assert.equal(closestCategory('chores'), 'household');
  assert.equal(closestCategory('fitness'), 'health');
  assert.equal(closestCategory('fun'), 'recreation');
  assert.equal(closestCategory('errands'), 'errand');
  assert.equal(closestCategory('helth'), 'health');   // typo
  assert.equal(closestCategory('wrk'), 'work');         // prefix-ish / near
  assert.equal(closestCategory('health'), 'health');    // exact
  assert.equal(closestCategory('dentist'), null);       // nothing close → caller classifies instead
});

test('/task:<word> fuzzy-matches the category; a no-match falls back to classification', async () => {
  await say('/task:chores wipe down the counters');
  assert.equal(listTasks(uid).find((x) => x.summary.includes('counters')).category, 'household');
  await say('/task:fitnes go for a long walk');
  assert.equal(listTasks(uid).find((x) => x.summary.includes('long walk')).category, 'health');
  // "dentist" isn't a category → fall back to classifying the body (mock → health for "dentist").
  await say('/task:dentist call the dentist office');
  assert.equal(listTasks(uid).find((x) => x.summary.includes('dentist office')).category, 'health');
});

test('a trailing deadline is captured and surfaced', async () => {
  const r = await say('/task:work send the slides by tomorrow');
  assert.match(r.reply, /⏳ due tomorrow/);
  const t = listTasks(uid).find((x) => x.summary.includes('slides'));
  assert.ok(t.due_at > Date.now(), 'due_at is set in the future');
  assert.equal(t.due_kind, 'by');
});

test('/tasks shows a deadline marker', async () => {
  const list = (await say('/tasks')).reply;
  // Two-line rows now: the name on one line, its meta (incl. the ⏳ deadline mark) on the next.
  assert.match(list, /slides[\s\S]*?⏳ (today|tomorrow)/);
});

test('a live deadline outranks undated work in /whatdo', async () => {
  // Seed a dated task far above the rest by giving it a near deadline directly. Use END OF TODAY (not now+1h,
  // which crosses into tomorrow — and renders "due tomorrow" — when the suite runs late at night).
  const endToday = new Date(); endToday.setHours(23, 59, 0, 0);
  const soon = insertTask({ userId: uid, summary: 'urgent dated thing', category: 'task', effortLevel: 'low', dueAt: endToday.getTime(), dueKind: 'today' });
  const out = await suggestTask({ userId: uid });
  assert.equal(out.recommendation.taskId, soon.id);
  assert.match(out.recommendation.why || '', /due today/);
});

test('a passed deadline retires the task to the "expired" status (non-judgy), out of the open list', async () => {
  const past = insertTask({ userId: uid, summary: 'thing whose time passed', category: 'task', effortLevel: 'low', dueAt: Date.now() - 1000, dueKind: 'by' });
  const n = expireDueTasks(uid);
  assert.ok(n >= 1);
  assert.equal(getTask(uid, past.id).status, 'expired');
  assert.ok(getTask(uid, past.id).expired_at);
  // gone from the open list…
  assert.doesNotMatch((await say('/tasks')).reply, /thing whose time passed/);
  // …and never suggested.
  const out = await suggestTask({ userId: uid });
  assert.notEqual(out.recommendation?.taskId, past.id);
});

test('bare /task gives a usage hint', async () => {
  assert.match((await say('/task')).reply, /Try .*\/task/);
});

test('a trailing deadline works on a plain capture too — not just /task', async () => {
  const r = await say('mail the signed contract by tomorrow');
  assert.match(r.reply, /Filed/);
  assert.match(r.reply, /⏳ due tomorrow/);
  const t = listTasks(uid).find((x) => x.summary.includes('signed contract'));
  assert.ok(t.due_at > Date.now());
  assert.equal(t.due_kind, 'by');
});

test('a plain capture with no deadline stays deadline-free', async () => {
  await say('reorganize the bookshelf');
  const t = listTasks(uid).find((x) => x.summary.includes('bookshelf'));
  assert.equal(t.due_at, null);
});

test('promoting a note carries its trailing deadline onto the task', async () => {
  await say('note submit the rebate form by friday');
  await say('/notes');                 // number the inbox so /promote resolves by position
  const r = await say('/promote 1');   // the rebate note (the only new note) is #1
  assert.match(r.reply, /Promoted/);
  const t = listTasks(uid).find((x) => x.summary.includes('rebate'));
  assert.ok(t.due_at > Date.now());
});

test('/tasks all dumps a flat list — no category headers, no narrowing prompt', async () => {
  for (const x of ['alpha one', 'beta two', 'gamma three', 'delta four', 'epsilon five', 'zeta six']) await say(x);
  const bare = (await say('/tasks')).reply;        // many tasks → bare shows the overview
  const all = (await say('/tasks all')).reply;
  assert.match(bare, /open tasks/i);        // the narrowing overview
  assert.doesNotMatch(all, /open tasks/i);   // /tasks all skips it (flat per-task list)
  assert.doesNotMatch(all, /^[A-Za-z][\w ]* \(\d+\)$/m); // and skips the "Work (3)" group headers
  assert.ok((all.match(/^\d+\. /gm) || []).length >= 6);  // it's a flat, per-task list
});
