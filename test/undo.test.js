// The app-wide "undo" (undo_stack, db v38): pops the last undoable thing the bot did — a capture, a
// done/drop/snooze/start flip, a logged metric, a timer, a list item — and prints the message stored at
// push time. Stale entries (the target vanished or moved since) are skipped for the next-newest one; a
// drained stack earns the "can't undo" note. "undo" escapes an open dialog (the canonical moment to type
// it is right after "done" armed the feelings question). Diet/metrics undo flows live in their own tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-undo-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage, handleAction } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const {
  insertTask, getTask, listTasks, listNotes, setSnoozed, getOrCreateTelegramUser,
  outcomeTotals, deleteTaskCascade, activeTimers, listChildren,
} = await import('../server/repo.js');
const { setUserFeatures } = await import('../server/settings.js');

migrate();
let tg = 87_000;
const freshUser = () => getOrCreateTelegramUser(tg++, `undo${tg}`);
const say = (u, text) => { clearDialogState(u); return handleMessage({ userId: u, text }); };

test('undo with nothing on the stack says it can’t', async () => {
  const u = freshUser();
  assert.match((await say(u, 'undo')).reply, /Nothing recent to undo/i);
});

test('undo takes back a fresh capture — the task row (not an archive) is gone', async () => {
  const u = freshUser();
  await say(u, 'buy stamps for the letters');
  assert.equal(listTasks(u).length, 1);
  const out = await say(u, 'undo');
  assert.match(out.reply, /↩ Undid that — “buy stamps for the letters” is off your list/);
  assert.equal(listTasks(u).length, 0, 'hard-deleted, not archived');
});

test('undo right after “done” escapes the feelings question, restores the task, and retracts the outcome', async () => {
  const u = freshUser();
  const a = insertTask({ userId: u, summary: 'rake the leaves', category: 'household' });
  await say(u, '/tasks');
  assert.match((await handleMessage({ userId: u, text: 'done 1' })).reply, /✓ Done/);
  // done_feedback is armed now — "undo" must escape it, never be read as "how did that feel?"
  const out = await handleMessage({ userId: u, text: 'undo' });
  assert.match(out.reply, /Not done after all/);
  assert.equal(getTask(u, a.id).status, 'available');
  const totals = Object.fromEntries(outcomeTotals(u).map((r) => [r.outcome, r.n]));
  assert.ok(!totals.done, 'the done outcome left the learning ledger too');
});

test('undo restores a dropped task (card 🗑 button)', async () => {
  const u = freshUser();
  const a = insertTask({ userId: u, summary: 'fix the gate latch', category: 'household' });
  await handleAction(u, `a:drop:${a.id}`);
  assert.equal(getTask(u, a.id).status, 'archived');
  assert.match((await say(u, 'undo')).reply, /Put “fix the gate latch” back on your list/);
  assert.equal(getTask(u, a.id).status, 'available');
});

test('undo un-snoozes a snoozed task; undoing an unsnooze re-snoozes with the SAME wake time', async () => {
  const u = freshUser();
  const a = insertTask({ userId: u, summary: 'descale the kettle', category: 'household' });
  await handleAction(u, `a:snz:${a.id}`);
  assert.equal(getTask(u, a.id).status, 'snoozed');
  assert.match((await say(u, 'undo')).reply, /Unsnoozed “descale the kettle”/);
  assert.equal(getTask(u, a.id).status, 'available');

  const until = Date.now() + 3 * 86_400_000;
  setSnoozed(u, a.id, until);
  await say(u, '/snoozed');
  await say(u, '/unsnooze 1');
  assert.equal(getTask(u, a.id).status, 'available');
  assert.match((await say(u, 'undo')).reply, /Snoozed “descale the kettle” again/);
  const t = getTask(u, a.id);
  assert.equal(t.status, 'snoozed');
  assert.equal(t.snoozed_until, until, 'the original wake time came back');
});

test('LIFO: two captures undo newest-first', async () => {
  const u = freshUser();
  await say(u, 'sharpen the mower blade');
  await say(u, 'order more birdseed');
  assert.match((await say(u, 'undo')).reply, /birdseed/);
  assert.match((await say(u, 'undo')).reply, /mower blade/);
  assert.equal(listTasks(u).length, 0);
});

test('a stale entry is skipped for the next-newest one', async () => {
  const u = freshUser();
  await say(u, 'wash the car');
  await say(u, 'renew the library card');
  const newest = listTasks(u).find((t) => t.summary === 'renew the library card');
  deleteTaskCascade(u, newest.id); // vanished out-of-band (e.g. the web GUI) → its entry is stale
  assert.match((await say(u, 'undo')).reply, /wash the car/, 'undo fell through to the older entry');
  assert.equal(listTasks(u).length, 0);
});

test('undo cancels a just-set timer', async () => {
  const u = freshUser();
  setUserFeatures(u, { timer: true });
  await say(u, 'timer 10 minutes');
  assert.equal(activeTimers(u).length, 1);
  assert.match((await say(u, 'undo')).reply, /Canceled the .* timer/);
  assert.equal(activeTimers(u).length, 0);
});

test('undo takes a just-added list item back off', async () => {
  const u = freshUser();
  setUserFeatures(u, { lists: true });
  await say(u, '/list groceries');
  assert.equal(listChildren(u, null).length, 1);
  assert.match((await say(u, 'undo')).reply, /Took “groceries” back off the list/);
  assert.equal(listChildren(u, null).length, 0);
});

test('undo takes back a note capture', async () => {
  const u = freshUser();
  setUserFeatures(u, { notes: true });
  await say(u, 'note the wifi password is taped to the router');
  assert.equal(listNotes(u, { status: 'new' }).length, 1);
  assert.match((await say(u, 'undo')).reply, /↩ Undid that note/);
  assert.equal(listNotes(u, { status: 'new' }).length, 0);
});
