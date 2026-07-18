// Snooze must not be a black hole: /snoozed lists what's tucked away (with when each wakes) and
// /unsnooze N brings one back before its timer — the manual escape hatch /sleeping + /revive already
// give the auto-slept concept. PLAN: unsnooze/unstart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-snoozed-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage, handleAction } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const { insertTask, getTask, setSnoozed, getOrCreateTelegramUser } = await import('../server/repo.js');

migrate();
let tg = 82_000;
const freshUser = () => getOrCreateTelegramUser(tg++, `snz${tg}`);
const say = (u, text) => { clearDialogState(u); return handleMessage({ userId: u, text }); };

test('/snoozed on an empty stash says so gently', async () => {
  const u = freshUser();
  const out = await say(u, '/snoozed');
  assert.match(out.reply, /Nothing snoozed/i);
});

test('😴 button → /snoozed shows the task with a wake time → /unsnooze 1 brings it back to /tasks', async () => {
  const u = freshUser();
  const a = insertTask({ userId: u, summary: 'clean the gutters', category: 'household' });
  await handleAction(u, `a:snz:${a.id}`);            // the card's Snooze button (until tomorrow)
  assert.equal(getTask(u, a.id).status, 'snoozed');
  const open = (await say(u, '/tasks')).reply;
  assert.doesNotMatch(open, /gutters/, 'a snoozed task is out of the open list');

  const listed = (await say(u, '/snoozed')).reply;
  assert.match(listed, /1\.[^\n]*gutters/);
  assert.match(listed, /wakes/i, 'each row says when it comes back');

  const back = (await say(u, '/unsnooze 1')).reply;
  assert.match(back, /Unsnoozed 1 task/);
  const t = getTask(u, a.id);
  assert.equal(t.status, 'available');
  assert.equal(t.snoozed_until, null);
  assert.match((await say(u, '/tasks')).reply, /gutters/, 'back on the open list');
});

test('bare /unsnooze shows the snoozed list (mirror of bare /revive)', async () => {
  const u = freshUser();
  const a = insertTask({ userId: u, summary: 'oil the hinges', category: 'household' });
  setSnoozed(u, a.id, Date.now() + 86_400_000);
  const out = await say(u, '/unsnooze');
  assert.match(out.reply, /1\.[^\n]*hinges/);
});

test('an elapsed snooze wakes on its own and /snoozed no longer shows it', async () => {
  const u = freshUser();
  const a = insertTask({ userId: u, summary: 'water the basil', category: 'household' });
  setSnoozed(u, a.id, Date.now() - 1000);            // timer already past
  const out = await say(u, '/snoozed');
  assert.match(out.reply, /Nothing snoozed/i, 'the pre-listing sweep woke it');
  assert.equal(getTask(u, a.id).status, 'available');
});

test('/unsnooze with a position that no longer resolves is refused, not misapplied', async () => {
  const u = freshUser();
  const a = insertTask({ userId: u, summary: 'sort the mail', category: 'household' });
  setSnoozed(u, a.id, Date.now() + 86_400_000);
  await say(u, '/snoozed');                          // listing: [a] at position 1
  const out = await say(u, '/unsnooze 5');
  assert.match(out.reply, /couldn.t match/i);
  assert.equal(getTask(u, a.id).status, 'snoozed', 'nothing changed');
});
