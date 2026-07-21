// /view N — open a task's full detail card (verbatim original + fuller LLM read + steps) and edit its steps
// WITHOUT starting it. The fix for "it's weird I have to start a task just to look at it / break it down."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-view-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage, handleAction } = await import('../server/chat.js');
const { clearDialogState, getDialogState } = await import('../server/dialog.js');
const { insertTask, getTask, parseSteps, addTaskStep, getOrCreateTelegramUser } = await import('../server/repo.js');

migrate();
let clock = 1_700_000_000_000;   // monotonic createdAt so "most recent open" is deterministic
let tg = 90_000;
const freshUser = () => getOrCreateTelegramUser(tg++, `v${tg}`);
const list = (u) => handleMessage({ userId: u, text: '/tasks' }).then((r) => r.reply);
const posOf = (text, rx) => Number(new RegExp('(\\d+)\\.[^\\n]*' + rx, 'i').exec(text)?.[1]);
const tokens = (out) => (out.buttons || []).flat().map((b) => b.data);

test('/view N shows the full read + steps checklist and NEVER starts the task', async () => {
  const u = freshUser();
  clearDialogState(u);
  const t = insertTask({
    userId: u, summary: 'renew passport', category: 'admin', createdAt: clock++,
    originalText: 'renew passport before the italy trip in september',
    llmSummary: 'Dig out the old passport, get new photos, submit the renewal by the deadline.',
  });
  addTaskStep(u, t.id, 'dig out the old one');
  addTaskStep(u, t.id, 'book a photo booth');

  const pos = posOf(await list(u), 'renew passport');
  assert.ok(pos, 'the task should appear in the listing');
  const out = await handleMessage({ userId: u, text: `/view ${pos}` });

  assert.match(out.reply, /👁/);
  assert.match(out.reply, /renew passport/);
  assert.match(out.reply, /italy trip/);                 // verbatim original_text
  assert.match(out.reply, /Dig out the old passport/);   // fuller llm_summary
  assert.match(out.reply, /Steps \(0\/2\):/);
  assert.match(out.reply, /☐ 1\. dig out the old one/);

  assert.equal(getTask(u, t.id).status, 'available');    // the whole point: viewing never starts it
  assert.notEqual(getDialogState(u)?.type, 'stepping');  // and viewing doesn't arm a stepping session
});

test('/view_N appears as a tappable control on every listing row', async () => {
  const u = freshUser();
  clearDialogState(u);
  insertTask({ userId: u, summary: 'mow the lawn', category: 'household', createdAt: clock++ });
  const text = await list(u);
  const pos = posOf(text, 'mow the lawn');
  assert.match(text, new RegExp(`👁 /view_${pos}\\b`));
});

test('/view card buttons: 🪜 Steps for a stepped task, 💡 Suggest steps for a stepless one', async () => {
  const u = freshUser();
  clearDialogState(u);
  const stepped = insertTask({ userId: u, summary: 'stepped chore', category: 'household', createdAt: clock++ });
  addTaskStep(u, stepped.id, 'first');
  const bare = insertTask({ userId: u, summary: 'bare chore', category: 'household', createdAt: clock++ });

  const listText = await list(u);
  const outStep = await handleMessage({ userId: u, text: `/view ${posOf(listText, 'stepped chore')}` });
  assert.ok(tokens(outStep).includes(`m:steps:${stepped.id}`), 'stepped task offers the 🪜 Steps opener');

  const outBare = await handleMessage({ userId: u, text: `/view ${posOf(listText, 'bare chore')}` });
  assert.ok(tokens(outBare).includes(`a:guess:${bare.id}`), 'stepless task offers 💡 Suggest steps');
});

test('opening 🪜 Steps from a /view card edits the checklist without starting the task', async () => {
  const u = freshUser();
  clearDialogState(u);
  const t = insertTask({ userId: u, summary: 'plan the trip', category: 'admin', createdAt: clock++ });
  addTaskStep(u, t.id, 'pick dates');

  await handleMessage({ userId: u, text: `/view ${posOf(await list(u), 'plan the trip')}` });
  const stepCard = await handleAction(u, `m:steps:${t.id}`);       // tap 🪜 Steps on the card
  assert.match(stepCard.text, /🪜/);
  assert.equal(getDialogState(u)?.type, 'stepping');
  assert.equal(getDialogState(u)?.data?.edit, true);               // edit-mode: survives a context switch

  const added = await handleMessage({ userId: u, text: 'step book the hotel' });
  assert.match(added.reply, /added/i);
  assert.deepEqual(parseSteps(getTask(u, t.id)).map((s) => s.text), ['pick dates', 'book the hotel']);
  assert.equal(getTask(u, t.id).status, 'available');              // edited, still never started
});

test('/details is an accepted alias for /view', async () => {
  const u = freshUser();
  clearDialogState(u);
  const t = insertTask({ userId: u, summary: 'file taxes', category: 'admin', createdAt: clock++ });
  const out = await handleMessage({ userId: u, text: `/details ${posOf(await list(u), 'file taxes')}` });
  assert.match(out.reply, /👁/);
  assert.match(out.reply, /file taxes/);
  assert.equal(getTask(u, t.id).status, 'available');
});

test('bare /view and an out-of-range /view N steer the user back to a list', async () => {
  const u = freshUser();
  clearDialogState(u);
  assert.match((await handleMessage({ userId: u, text: '/view' })).reply, /Which one/i);

  insertTask({ userId: u, summary: 'only task', category: 'household', createdAt: clock++ });
  await list(u);
  assert.match((await handleMessage({ userId: u, text: '/view 99' })).reply, /isn’t on the list|isn't on the list/i);
});
