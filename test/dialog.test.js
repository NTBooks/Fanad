// The coaching loop + dialog state — the heart of the redesign. Pins the screenshot bug: a suggestion
// followed by "no" must coach, never file a task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-dialog-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');
const { clearDialogState, dialogIsStale } = await import('../server/dialog.js');
const { listTasks, getTask, setSnoozed, sweepSnoozed, defaultUserId } = await import('../server/repo.js');

migrate();
const uid = defaultUserId();
const say = (text) => handleMessage({ text });

// Seed several tasks (statements → captured).
for (const s of [
  'put up the bird net', 'investigate the cloudflare tunnel issue', 'pay eric for the powerwash',
  'water the plants', 'email the dentist', 'sort the recycling',
]) await say(s);

test('THE BUG: /whatdo then "no" coaches instead of filing a task', async () => {
  clearDialogState(uid);
  assert.match((await say('/whatdo')).reply, /💡/);
  const r = await say('no');
  assert.doesNotMatch(r.reply, /Filed/);
  assert.match(r.reply, /smaller|done/i);
  assert.ok(!listTasks(uid).some((t) => t.summary.toLowerCase() === 'no'), 'no task literally named "no"');
});

test('"no" → "something smaller" offers a different task', async () => {
  clearDialogState(uid);
  await say('/whatdo');
  await say('no');
  const r = await say('something smaller');
  assert.match(r.reply, /💡/);
});

test('"yes" starts the suggested task (in_progress)', async () => {
  clearDialogState(uid);
  await say('/whatdo');
  const r = await say('yes');
  assert.match(r.reply, /Started/);
  assert.ok(listTasks(uid).some((t) => t.status === 'in_progress'));
});

test('"not today" snoozes the task', async () => {
  clearDialogState(uid);
  await say('/whatdo');
  const r = await say('not today');
  assert.match(r.reply, /tomorrow/i);
  assert.ok(listTasks(uid).some((t) => t.status === 'snoozed'));
});

test('a real new task typed during a suggestion is captured (abandons the question)', async () => {
  clearDialogState(uid);
  await say('/whatdo');
  const r = await say('buy a new umbrella before the weekend trip');
  assert.match(r.reply, /Filed/);
});

test('the reply payload carries mode + quick-reply options', async () => {
  clearDialogState(uid);
  const s = await say('/whatdo');
  assert.equal(s.mode, 'suggestion');
  assert.ok(s.options.includes('no'));
  clearDialogState(uid);
  const c = await say('alphabetize the spice rack');
  assert.equal(c.mode, 'capture');
});

test('an expired snooze returns to the available pool', () => {
  const t = listTasks(uid).find((x) => x.status === 'available');
  setSnoozed(uid, t.id, Date.now() - 1000); // already in the past
  assert.equal(getTask(uid, t.id).status, 'snoozed');
  sweepSnoozed(uid);
  assert.equal(getTask(uid, t.id).status, 'available');
});

test('dialogIsStale flags a forgotten open question', () => {
  assert.equal(dialogIsStale({ createdAt: Date.now() - 31 * 60 * 1000 }), true);
  assert.equal(dialogIsStale({ createdAt: Date.now() }), false);
});

test('"done" / "did it" on a suggested task completes it', async () => {
  clearDialogState(uid);
  await say('alphabetize the spice rack');
  await say('/whatdo');
  const r = await say('did it');
  assert.match(r.reply, /Done/);
  assert.ok(listTasks(uid).some((t) => t.status === 'done'), 'a task is now marked done');
});

test('THE REGRESSION: after "yes" starts a task, a later "done" completes it (not a new task)', async () => {
  clearDialogState(uid);
  await say('paint the fence');
  await say('/whatdo');
  await say('yes');             // starts the suggested task; the dialog clears
  const r = await say('done');  // no open question → must finish it, never file "done"
  assert.match(r.reply, /Done/);
  assert.doesNotMatch(r.reply, /Filed/);
});

test('a suggestion shows the verbatim task text, not a paraphrase', async () => {
  clearDialogState(uid);
  await say('water the ferns by the door');
  const r = await say('/whatdo');
  assert.match(r.reply, /How about/);
  // the reply must contain a real task summary verbatim (quoted)
  assert.match(r.reply, /“[^”]+”/);
});

test('a completion quietly offers feedback buttons and records the sentiment', async () => {
  clearDialogState(uid);
  await say('refill the bird feeder');
  await say('/whatdo');
  const done = await say('did it');
  assert.match(done.reply, /Done/);
  assert.equal(done.mode, 'done');
  assert.ok(done.options.some((o) => /high five/i.test(o)), 'offers the High five button');
  const fb = await say('High five! 🙌');           // tap a button
  assert.match(fb.reply, /🙌|high five/i);
});

test('ignoring the feedback buttons does not trap you — a new task still files', async () => {
  clearDialogState(uid);
  await say('sweep the porch');
  await say('/whatdo');
  await say('done');                                // completes → arms done_feedback
  const r = await say('buy stamps at the post office'); // not a button → should just capture
  assert.match(r.reply, /Filed/);
});

test('an indirect reference ("let\'s do the X one") asks to confirm, then starts the right task', async () => {
  clearDialogState(uid);
  await say('rebuild the lawnmower');           // a real task (not action-led → filed)
  const ask = await say("let's do the lawnmower one");
  assert.match(ask.reply, /Did you mean/);
  assert.match(ask.reply, /lawnmower/);
  assert.equal(ask.mode, 'confirm');
  const r = await say('start it');
  assert.match(r.reply, /Started/);
  assert.doesNotMatch(r.reply, /Filed/);
});

test('"no, it\'s new" files the original words after a reference prompt', async () => {
  clearDialogState(uid);
  await say('paint the shed');
  await say("let's do the shed one");           // → "Did you mean 'paint the shed'?"
  const r = await say("no, it's new");
  assert.match(r.reply, /Filed/);
});
