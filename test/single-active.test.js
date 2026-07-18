// ONE task in progress at a time — starting a task pauses any other in_progress sibling back to
// 'available' (enforced in repo.setTaskStatus, the single writer of 'in_progress', so every path — typed
// start, button start, web POST, suggestion-affirm — inherits it). Also covers the stepping-session
// staleness rules that invariant makes load-bearing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-single-active-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage, handleAction } = await import('../server/chat.js');
const { clearDialogState, getDialogState, setDialogState } = await import('../server/dialog.js');
const { insertTask, getTask, parseSteps, setTaskStatus, addTaskStep, getOrCreateTelegramUser, setSnoozed } = await import('../server/repo.js');

migrate();
let clock = 1_700_000_000_000;
let tg = 81_000;
const freshUser = () => getOrCreateTelegramUser(tg++, `sa${tg}`);
const mkFor = (u, summary) => insertTask({ userId: u, summary, category: 'household', createdAt: clock++ });

test('repo: setTaskStatus(in_progress) pauses the other started task (chokepoint invariant)', () => {
  const u = freshUser();
  const a = mkFor(u, 'alpha');
  const b = mkFor(u, 'beta');
  setTaskStatus(u, a.id, 'in_progress');
  setTaskStatus(u, b.id, 'in_progress');
  const pausedA = getTask(u, a.id);
  assert.equal(pausedA.status, 'available');
  assert.equal(pausedA.started_at, null);            // NULLed so a restart stamps a FRESH time
  assert.equal(getTask(u, b.id).status, 'in_progress');
});

test('repo: a failed (not-yours) start does NOT pause siblings as a side effect', () => {
  const u = freshUser();
  const other = freshUser();
  const a = mkFor(u, 'mine');
  const foreign = mkFor(other, 'not mine');
  setTaskStatus(u, a.id, 'in_progress');
  assert.equal(setTaskStatus(u, foreign.id, 'in_progress'), null);
  assert.equal(getTask(u, a.id).status, 'in_progress');
});

test('repo: restarting a paused task stamps a fresh started_at (COALESCE regression)', () => {
  const u = freshUser();
  const a = mkFor(u, 'first');
  const b = mkFor(u, 'second');
  setTaskStatus(u, a.id, 'in_progress', 1000);
  setTaskStatus(u, b.id, 'in_progress', 2000);       // pauses a, NULLs its started_at
  setTaskStatus(u, a.id, 'in_progress', 3000);       // restart
  assert.equal(getTask(u, a.id).started_at, 3000);   // fresh, not the stale 1000
});

test('repo: setTaskStatus(available) clears started_at, and a restart stamps fresh (unstart hygiene)', () => {
  const u = freshUser();
  const a = mkFor(u, 'paused work');
  setTaskStatus(u, a.id, 'in_progress', 1000);
  setTaskStatus(u, a.id, 'available');               // the unstart mutation (typed, button, or web drag)
  const t = getTask(u, a.id);
  assert.equal(t.status, 'available');
  assert.equal(t.started_at, null);
  setTaskStatus(u, a.id, 'in_progress', 3000);
  assert.equal(getTask(u, a.id).started_at, 3000);   // fresh, not the stale 1000 (COALESCE would keep it)
});

test('repo: setTaskStatus(available) clears snoozed_until (unsnooze hygiene)', () => {
  const u = freshUser();
  const a = mkFor(u, 'tucked away');
  setSnoozed(u, a.id, clock + 86_400_000);
  assert.equal(getTask(u, a.id).status, 'snoozed');
  setTaskStatus(u, a.id, 'available');
  const t = getTask(u, a.id);
  assert.equal(t.status, 'available');
  assert.equal(t.snoozed_until, null, 'no phantom wake timer on an unsnoozed task');
});

test('bare "unstart" returns the in-progress task to available and says so', async () => {
  const u = freshUser();
  clearDialogState(u);
  const a = mkFor(u, 'wallpaper the hall');
  setTaskStatus(u, a.id, 'in_progress');
  const out = await handleMessage({ userId: u, text: 'unstart' });
  assert.match(out.reply, /wallpaper the hall/);
  const t = getTask(u, a.id);
  assert.equal(t.status, 'available');
  assert.equal(t.started_at, null);
});

test('bare "unstart" with nothing in progress explains instead of filing a task', async () => {
  const u = freshUser();
  clearDialogState(u);
  const out = await handleMessage({ userId: u, text: 'unstart' });
  assert.match(out.reply, /Nothing.s in progress/i);
});

test('"unstart N" targets a listing position; a not-started position is refused', async () => {
  const u = freshUser();
  clearDialogState(u);
  const a = mkFor(u, 'ongoing chore');
  mkFor(u, 'idle chore');
  setTaskStatus(u, a.id, 'in_progress');
  const list = (await handleMessage({ userId: u, text: '/tasks' })).reply;
  const pos = (name) => Number(new RegExp('(\\d+)\\.[^\\n]*' + name, 'i').exec(list)?.[1]);
  const no = await handleMessage({ userId: u, text: `unstart ${pos('idle')}` });
  assert.match(no.reply, /isn.t started/i);
  const yes = await handleMessage({ userId: u, text: `unstart ${pos('ongoing')}` });
  assert.match(yes.reply, /ongoing chore/);
  assert.equal(getTask(u, a.id).status, 'available');
});

test('the a:unstart button unstarts a live task, but a stale tap on a DONE card never reopens it', async () => {
  const u = freshUser();
  clearDialogState(u);
  const a = mkFor(u, 'buttoned job');
  setTaskStatus(u, a.id, 'in_progress');
  const out = await handleAction(u, `a:unstart:${a.id}`);
  assert.equal(out.toast, 'Unstarted ⏸');
  assert.equal(getTask(u, a.id).status, 'available');
  setTaskStatus(u, a.id, 'done');
  await handleAction(u, `a:unstart:${a.id}`);        // stale card tap after completion
  assert.equal(getTask(u, a.id).status, 'done', 'a stale unstart tap must not resurrect a done task');
});

test('unstart drops a live stepping session pinned to the task (bare "done" no longer ticks its steps)', async () => {
  const u = freshUser();
  clearDialogState(u);
  const a = mkFor(u, 'stepped unstart job');
  addTaskStep(u, a.id, 'the step');
  await handleAction(u, `a:start:${a.id}`);          // arms stepping on a
  assert.equal(getDialogState(u)?.type, 'stepping');
  await handleMessage({ userId: u, text: 'unstart' });
  assert.notEqual(getDialogState(u)?.type, 'stepping');
  assert.equal(getTask(u, a.id).status, 'available');
});

test('typed start of B pauses A and the reply names it', async () => {
  const u = freshUser();
  clearDialogState(u);
  const a = mkFor(u, 'mow the lawn');
  mkFor(u, 'clean gutters');
  await handleAction(u, `a:start:${a.id}`);
  const list = (await handleMessage({ userId: u, text: '/tasks' })).reply;
  const pos = Number(new RegExp('(\\d+)\\.[^\\n]*gutters', 'i').exec(list)?.[1]);
  assert.ok(pos, 'gutters should appear in the listing');
  const out = await handleMessage({ userId: u, text: `start ${pos}` });
  assert.match(out.reply, /▶ Started:.*gutters/);
  assert.match(out.reply, /⏸ Paused:.*mow the lawn/);
  assert.equal(getTask(u, a.id).status, 'available');
});

test('button start (a:start) pauses the sibling too', async () => {
  const u = freshUser();
  clearDialogState(u);
  const a = mkFor(u, 'task one');
  const b = mkFor(u, 'task two');
  await handleAction(u, `a:start:${a.id}`);
  const out = await handleAction(u, `a:start:${b.id}`);
  assert.match(out.text, /Paused:.*task one/);
  assert.equal(getTask(u, a.id).status, 'available');
  assert.equal(getTask(u, b.id).status, 'in_progress');
});

test('batch "start N M" starts only the FIRST position; the rest stay put', async () => {
  const u = freshUser();
  clearDialogState(u);
  const apple = mkFor(u, 'apple job');
  const banana = mkFor(u, 'banana job');
  const cherry = mkFor(u, 'cherry job');
  const list = (await handleMessage({ userId: u, text: '/tasks' })).reply;
  const pos = (name) => Number(new RegExp('(\\d+)\\.[^\\n]*' + name, 'i').exec(list)?.[1]);
  const out = await handleMessage({ userId: u, text: `start ${pos('apple')} ${pos('banana')} ${pos('cherry')}` });
  assert.match(out.reply, /▶ Started:.*apple/);
  assert.match(out.reply, /One thing at a time/);
  assert.equal(getTask(u, apple.id).status, 'in_progress');
  assert.equal(getTask(u, banana.id).status, 'available');
  assert.equal(getTask(u, cherry.id).status, 'available');
});

test('batch "done N M" still completes several at once', async () => {
  const u = freshUser();
  clearDialogState(u);
  const x = mkFor(u, 'xray job');
  const y = mkFor(u, 'yankee job');
  const list = (await handleMessage({ userId: u, text: '/tasks' })).reply;
  const pos = (name) => Number(new RegExp('(\\d+)\\.[^\\n]*' + name, 'i').exec(list)?.[1]);
  const out = await handleMessage({ userId: u, text: `done ${pos('xray')} ${pos('yankee')}` });
  assert.match(out.reply, /✓ Done:.*xray job.*yankee job/);
  assert.equal(getTask(u, x.id).status, 'done');
  assert.equal(getTask(u, y.id).status, 'done');
});

test('starting a stepless task drops a stepping session left by the paused one', async () => {
  const u = freshUser();
  clearDialogState(u);
  const a = mkFor(u, 'stepped job');
  addTaskStep(u, a.id, 'only step');
  const b = mkFor(u, 'stepless job');
  await handleAction(u, `a:start:${a.id}`);           // arms stepping on a
  assert.equal(getDialogState(u)?.type, 'stepping');
  await handleAction(u, `a:start:${b.id}`);           // pauses a; b has no steps
  assert.notEqual(getDialogState(u)?.type, 'stepping');
  const out = await handleMessage({ userId: u, text: 'done' });   // bare done → completes b, NOT a's step
  assert.equal(getTask(u, b.id).status, 'done');
  assert.equal(parseSteps(getTask(u, a.id))[0].done, false);
});

test('a stepping session pinned to a task paused elsewhere (web) is refused and cleared', async () => {
  const u = freshUser();
  clearDialogState(u);
  const a = mkFor(u, 'web-paused job');
  addTaskStep(u, a.id, 'its step');
  const b = mkFor(u, 'web-started job');
  await handleAction(u, `a:start:${a.id}`);           // stepping armed on a
  setTaskStatus(u, b.id, 'in_progress');              // "from the web": pauses a, no chat-side clear
  const out = await handleMessage({ userId: u, text: 'done' });
  assert.match(out.reply, /isn’t in progress anymore/);
  assert.equal(getDialogState(u), null);
  assert.equal(parseSteps(getTask(u, a.id))[0].done, false);
  assert.equal(getTask(u, b.id).status, 'in_progress'); // untouched — the refusal is just a message
});

test('a stepping session on a NOT-started task stays valid while nothing else is started (🪜 edit mode)', async () => {
  const u = freshUser();
  clearDialogState(u);
  const a = mkFor(u, 'someday job');
  setDialogState(u, { type: 'stepping', data: { taskId: a.id } });
  const out = await handleMessage({ userId: u, text: 'step gather tools' });
  assert.match(out.reply, /Step 1 added/);
  assert.equal(parseSteps(getTask(u, a.id))[0].text, 'gather tools');
  assert.equal(getTask(u, a.id).status, 'available'); // adding steps didn't start it
});

test('an edit:true stepping session survives a DIFFERENT task being in progress', async () => {
  const u = freshUser();
  clearDialogState(u);
  const working = mkFor(u, 'current work');
  const other = mkFor(u, 'future work');
  setTaskStatus(u, working.id, 'in_progress');
  setDialogState(u, { type: 'stepping', data: { taskId: other.id, edit: true } });
  const out = await handleMessage({ userId: u, text: 'step sketch the outline' });
  assert.match(out.reply, /Step 1 added/);
  assert.equal(parseSteps(getTask(u, other.id))[0].text, 'sketch the outline');
  assert.equal(getTask(u, working.id).status, 'in_progress');
});
