// A task mutation flags `refreshList` so a channel can quietly re-render a list it's already showing, and
// refreshedTaskList() does that re-render side-effect-free (a paged slice or the small grouped view; null for
// the counts-overview, which has no row controls to act on). The Telegram adapter edits the tracked list
// message in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-refresh-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage, handleAction, refreshedTaskList } = await import('../server/chat.js');
const { supersedeList, refreshHangingList } = await import('../server/channels/telegram.js');
const { insertTask, getOrCreateTelegramUser } = await import('../server/repo.js');

migrate();
let tg = 70_000;
const freshUser = () => getOrCreateTelegramUser(tg++, `u${tg}`);

test('finishing a listed task flags refreshList; a plain capture does not', async () => {
  const u = freshUser();
  insertTask({ userId: u, summary: 'alpha chore', category: 'household', effortLevel: 'low' });
  insertTask({ userId: u, summary: 'beta chore', category: 'household', effortLevel: 'low' });
  await handleMessage({ userId: u, text: '/tasks' });                 // a hanging list (rows 1 & 2)
  const done = await handleMessage({ userId: u, text: '/done_1' });    // tap a /done_N link → finishes a row
  assert.match(done.reply, /✓ Done/);
  assert.equal(done.refreshList, true, 'a completion flags a list refresh');
  const cap = await handleMessage({ userId: u, text: 'water the ferns sometime' });
  assert.equal(cap.refreshList, false, 'a plain capture is not a list mutation');
});

test('refreshedTaskList re-renders the current list and drops the finished row', async () => {
  const u = freshUser();
  const a = insertTask({ userId: u, summary: 'mop the floor', category: 'household', effortLevel: 'low' });
  insertTask({ userId: u, summary: 'fold the laundry', category: 'household', effortLevel: 'low' });
  await handleMessage({ userId: u, text: '/tasks' });
  await handleAction(u, `a:done:${a.id}`);                            // finish "mop the floor" via a tap
  const view = refreshedTaskList(u);
  assert.ok(view, 'a small list refreshes into a view');
  const text = typeof view === 'string' ? view : view.text;
  assert.doesNotMatch(text, /mop the floor/, 'the finished task is gone from the refreshed list');
  assert.match(text, /fold the laundry/, 'the remaining task stays');
});

test('refreshedTaskList is null for the counts-overview (no rows to act on, would re-arm a dialog)', async () => {
  const u = freshUser();
  for (let i = 0; i < 10; i++) insertTask({ userId: u, summary: `overview item ${i}`, category: 'task', effortLevel: 'low' });
  await handleMessage({ userId: u, text: '/tasks' });                 // > MANY_TASKS → overview
  assert.equal(refreshedTaskList(u), null);
});

test('refreshHangingList edits the tracked list message in place with the fresh list', async () => {
  const u = freshUser();
  const keep = insertTask({ userId: u, summary: 'sweep the porch', category: 'household', effortLevel: 'low' });
  const drop = insertTask({ userId: u, summary: 'shred the mail', category: 'household', effortLevel: 'low' });
  await handleMessage({ userId: u, text: '/tasks' });

  const edits = [];
  const ctx = { chat: { id: 42 }, api: { async editMessageText(chatId, msgId, text) { edits.push({ chatId, msgId, text }); return true; } } };
  supersedeList(ctx, 42, 777);                                        // pretend message 777 is the shown list
  await handleAction(u, `a:done:${drop.id}`);                        // finish one task
  await refreshHangingList(ctx, 42, u);

  assert.equal(edits.length, 1, 'the tracked list message is edited once');
  assert.deepEqual([edits[0].chatId, edits[0].msgId], [42, 777]);
  assert.match(edits[0].text, /sweep the porch/, 'the live task is still there');
  assert.doesNotMatch(edits[0].text, /shred the mail/, 'the finished task is gone from the refreshed list');
});

test('refreshHangingList is a no-op when this chat has no tracked list', async () => {
  const u = freshUser();
  insertTask({ userId: u, summary: 'a lone task', category: 'task', effortLevel: 'low' });
  await handleMessage({ userId: u, text: '/tasks' });
  const ctx = { chat: { id: 99 }, api: { async editMessageText() { throw new Error('should not edit'); } } };
  await refreshHangingList(ctx, 99, u);                               // chat 99 never tracked a list → nothing happens
});

test('web /tasks tags the listing as a task list', async () => {
  const u = freshUser();
  insertTask({ userId: u, summary: 'wash the car', category: 'household', effortLevel: 'low' });
  const list = await handleMessage({ userId: u, text: '/tasks', channel: 'web' });
  assert.equal(list.listing, true, 'a /tasks reply is a listing');
  assert.equal(list.listKind, 'task', 'and it is tagged as a task list so the web swaps the right bubble');
});

test('web completion returns a refreshedListing the client can swap in place (finished row gone)', async () => {
  const u = freshUser();
  insertTask({ userId: u, summary: 'call the dentist', category: 'admin', effortLevel: 'low' });
  insertTask({ userId: u, summary: 'renew the passport', category: 'admin', effortLevel: 'low' });
  // The two rows tie on every hard sort key, so which one ranks as row 1 legitimately depends on
  // created_at down to the millisecond (recency is the relevance tail's decider — newer first, both in
  // the SQL order and cheapRelevance). Read row 1 off the rendered listing instead of assuming it:
  // this test is about the REFRESH dropping the finished row, not about rank order.
  const list = await handleMessage({ userId: u, text: '/tasks', channel: 'web' });
  const first = /1\.[\s\S]*?(call the dentist|renew the passport)/.exec(list.reply)?.[1];
  assert.ok(first, 'the listing names a row 1');
  const other = first === 'call the dentist' ? 'renew the passport' : 'call the dentist';
  const done = await handleMessage({ userId: u, text: '/done_1', channel: 'web' });
  assert.equal(done.refreshList, true, 'a completion still flags the refresh');
  assert.ok(done.refreshedListing, 'web gets the re-rendered list to swap in');
  assert.equal(done.refreshedListing.listing, true);
  assert.equal(done.refreshedListing.listKind, 'task', 'gated so only a task bubble is replaced client-side');
  assert.doesNotMatch(done.refreshedListing.reply, new RegExp(first), 'the finished task is gone from the refreshed list');
  assert.match(done.refreshedListing.reply, new RegExp(other), 'the remaining task stays');
});

test('non-web completion omits refreshedListing (Telegram/Slack re-render via their own adapters)', async () => {
  const u = freshUser();
  insertTask({ userId: u, summary: 'buy milk', category: 'errand', effortLevel: 'low' });
  await handleMessage({ userId: u, text: '/tasks', channel: 'telegram' });
  const done = await handleMessage({ userId: u, text: '/done_1', channel: 'telegram' });
  assert.equal(done.refreshList, true, 'still flagged for the adapter');
  assert.equal(done.refreshedListing, null, 'but no web swap payload');
});
