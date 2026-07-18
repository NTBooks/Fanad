// Anti-overwhelm listing: counts → drill into a category → a ranked, paginated top-7 slice with
// next/prev; plus auto-sleep of long-untouched low-stakes tasks and /sleeping + /revive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-listing-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { stripTags } = await import('../shared/richtext.js');
const { handleMessage, handleAction } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const {
  defaultUserId, insertTask, setTaskStatus, getTask, sleepStaleTasks, countSleptTasks, listAvailableTasksWithVectors,
} = await import('../server/repo.js');

migrate();
// Modules are per-user opt-in (default OFF); these behaviour tests run as the root user with all on.
(await import('../server/settings.js')).setUserFeatures(1, { notes: true, lists: true, metrics: true, vouch: true });
const uid = defaultUserId();
const say = (text) => { clearDialogState(uid); return handleMessage({ text }); }; // page state survives a dialog clear
const DAY = 86400000;

const datas = (r) => (r.buttons || []).flat().map((b) => b.data);

test('drilling into a big category shows a ranked top-7 slice, per-row action links, and Next/Prev page buttons', async () => {
  for (let i = 1; i <= 12; i++) insertTask({ userId: uid, summary: `work item ${i}`, category: 'work', effortLevel: 'low' });

  const r1 = await say('/tasks work');
  assert.match(stripTags(r1.reply), /Here’s a slice of Work/); // the label is bold now → compare visible text
  assert.match(r1.reply, /Page 1\/2 · showing 1–7 of 12/);
  assert.match(r1.reply, /\/start_1/);                              // tappable per-task actions on each row
  assert.match(r1.reply, /\/done_1/);
  assert.equal((r1.reply.match(/^\d+\. /gm) || []).length, 7, 'seven rows on page 1');
  assert.deepEqual(datas(r1), ['m:page:next', 'm:hide'], 'page 1 offers Next only (no dead-end Prev), plus ✕ Hide');

  // Tapping the Next button pages forward (the path Telegram edits in place).
  const r2 = await handleAction(uid, 'm:page:next');
  assert.match(r2.reply ?? r2.text, /Page 2\/2 · showing 8–12 of 12/);
  const p2 = r2.reply ?? r2.text;
  assert.equal((p2.match(/^\d+\. /gm) || []).length, 5, 'five rows on page 2');
  assert.match(p2, /^1\. /m, 'numbering restarts at 1 on page 2');
  assert.deepEqual(datas(r2), ['m:page:prev', 'm:hide'], 'last page offers Prev only, plus ✕ Hide');

  // "/done_1" (the tappable underscore form) on page 2 resolves to the first row ON SCREEN (the 8th task).
  assert.match((await say('/done_1')).reply, /✓ Done/);

  // Typed "next"/"prev" still work as a fallback.
  assert.match((await say('prev')).reply, /Page 1\/2/);
});

test('the underscore action links route: /start_N begins that row, /done_N finishes it', async () => {
  clearDialogState(uid);
  insertTask({ userId: uid, summary: 'mow the lawn', category: 'household', effortLevel: 'low' });
  await say('/tasks home');                                          // arms the listing (mow the lawn = row 1)
  const started = await say('/start_1');
  assert.match(started.reply ?? started.text, /mow the lawn/);
  assert.ok((started.buttons || []).flat().some((b) => String(b.data).startsWith('a:guess:')),
    'a started card (startedMenu, with Suggest steps) — not a task filed as "1"');
});

test('list replies are flagged listing:true (Telegram keys off this to drop the previous list); others are not', async () => {
  insertTask({ userId: uid, summary: 'pick up the parcel', category: 'errand', effortLevel: 'low' });
  assert.equal((await say('/tasks')).listing, true, '/tasks is a list');
  await say('note the wifi password is taped to the router');
  assert.equal((await say('/notes')).listing, true, '/notes is a list');
  assert.equal((await say('water the plants tonight')).listing, false, 'a plain capture is not a list');
});

test('a small category drills in without a page footer', async () => {
  insertTask({ userId: uid, summary: 'water the ferns', category: 'household', effortLevel: 'low' });
  const r = (await say('/tasks home')).reply; // "home" → household
  assert.match(r, /ferns/);
  assert.doesNotMatch(r, /Page \d/, 'no footer when it fits on one page');
});

test('auto-sleep hides long-untouched low-stakes tasks; protected ones stay awake', async () => {
  const old = insertTask({ userId: uid, summary: 'dusty old idea', category: 'task', effortLevel: 'low', createdAt: Date.now() - 22 * DAY });
  const keep = insertTask({ userId: uid, summary: 'old but important', category: 'task', effortLevel: 'low', priority: 3, createdAt: Date.now() - 30 * DAY });
  const started = insertTask({ userId: uid, summary: 'old in progress', category: 'task', effortLevel: 'low', createdAt: Date.now() - 25 * DAY });
  setTaskStatus(uid, started.id, 'in_progress');
  const dated = insertTask({ userId: uid, summary: 'old with a live deadline', category: 'task', effortLevel: 'low', createdAt: Date.now() - 25 * DAY, dueAt: Date.now() + DAY, dueKind: 'by' });
  const fresh = insertTask({ userId: uid, summary: 'brand new idea', category: 'task', effortLevel: 'low' });

  const slept = sleepStaleTasks(uid);
  assert.ok(slept >= 1);
  assert.ok(getTask(uid, old.id).slept_at, 'old low-stakes task slept');
  assert.equal(getTask(uid, keep.id).slept_at, null, 'high-priority stays awake');
  assert.equal(getTask(uid, started.id).slept_at, null, 'in-progress never sleeps');
  assert.equal(getTask(uid, dated.id).slept_at, null, 'a live deadline never sleeps');
  assert.equal(getTask(uid, fresh.id).slept_at, null, 'recent task stays awake');
});

test('/tasks notes how many are sleeping; /sleeping lists them; /revive brings one back', async () => {
  assert.match((await say('/tasks')).reply, /💤 1 sleeping/);

  const sleeping = (await say('/sleeping')).reply;
  assert.match(sleeping, /dusty old idea/);
  assert.doesNotMatch(sleeping, /old but important/);

  assert.match((await say('/revive 1')).reply, /Revived 1/);
  assert.equal(countSleptTasks(uid), 0, 'nothing left sleeping after revive');
});

test('a slept task is excluded from the suggestion pool — /whatdo can never offer it', () => {
  const t = insertTask({ userId: uid, summary: 'slept candidate', category: 'task', effortLevel: 'low', createdAt: Date.now() - 40 * DAY });
  sleepStaleTasks(uid);
  assert.ok(getTask(uid, t.id).slept_at, 'precondition: it slept');
  // suggestTask reads exactly this pool; slept tasks must not be in it (they stay status='available').
  const pool = listAvailableTasksWithVectors(uid).map((x) => x.id);
  assert.ok(!pool.includes(t.id), 'a slept task is not a suggestion candidate');
});
