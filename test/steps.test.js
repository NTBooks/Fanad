// Task STEPS — the "step"/"start"/"done N" checklist flow (text path + rendering + auto-complete + escape).
// Multi-turn step flows drive handleMessage directly (NOT a `say`-style helper that clears dialog state each
// turn, which would wipe the stepping session between turns).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-steps-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage, handleAction } = await import('../server/chat.js');
const { clearDialogState, getDialogState } = await import('../server/dialog.js');
const { insertTask, getTask, parseSteps, defaultUserId, getOrCreateTelegramUser } = await import('../server/repo.js');

migrate();
const uid = defaultUserId();
let clock = 1_700_000_000_000;     // monotonic createdAt so "most recent open" is deterministic
let tg = 70_000;
const mk = (over = {}) => insertTask({ userId: uid, summary: 'bake sourdough', category: 'household', createdAt: clock++, ...over });
const mkFor = (u, summary) => insertTask({ userId: u, summary, category: 'household', createdAt: clock++ });
const freshUser = () => getOrCreateTelegramUser(tg++, `u${tg}`);
const send = (text) => handleMessage({ userId: uid, text });
const steps = (id, u = uid) => parseSteps(getTask(u, id));

test('step <text> adds a step under the most-recent open task', async () => {
  clearDialogState(uid);
  const t = mk();
  const out = await send('step feed the starter');
  assert.match(out.reply, /Step 1 added/);
  assert.equal(steps(t.id).length, 1);
  assert.equal(steps(t.id)[0].text, 'feed the starter');
  assert.equal(steps(t.id)[0].done, false);
});

test('steps append in add-order', async () => {
  clearDialogState(uid);
  const t = mk();
  await send('step one');
  await send('step two');
  await send('step three');
  assert.deepEqual(steps(t.id).map((s) => s.text), ['one', 'two', 'three']);
});

test('step <N> <text> targets the Nth task on the current listing', async () => {
  clearDialogState(uid);
  const beta = mk({ summary: 'paint the beta fence' });
  const list = (await send('/tasks')).reply;
  const pos = Number(new RegExp('(\\d+)\\.[^\\n]*beta fence', 'i').exec(list)?.[1]);
  assert.ok(pos, 'the beta task should appear in the listing');
  const out = await send(`step ${pos} sand it first`);
  assert.match(out.reply, /Step 1 added to .*beta fence/);
  assert.deepEqual(steps(beta.id).map((s) => s.text), ['sand it first']);
});

test('substep and subtask aliases also add a step', async () => {
  const u = freshUser();
  clearDialogState(u);
  const t = mkFor(u, 'alias job');
  await handleMessage({ userId: u, text: 'substep first' });
  await handleMessage({ userId: u, text: 'subtask second' });
  assert.deepEqual(steps(t.id, u).map((s) => s.text), ['first', 'second']);
});

test('step with no open task is gentle', async () => {
  const u = freshUser();
  clearDialogState(u);
  const out = await handleMessage({ userId: u, text: 'step do a thing' });
  assert.match(out.reply, /add a task first/i);
});

test('bare "step" shows a usage hint', async () => {
  clearDialogState(uid);
  assert.match((await send('step')).reply, /Add a step/i);
});

test('start renders the checklist + step buttons below the header, and arms stepping', async () => {
  clearDialogState(uid);
  const t = mk({ summary: 'walk the dog' });
  await send('step leash on');
  await send('step out the door');
  const out = await handleAction(uid, `a:start:${t.id}`);
  assert.match(out.text, /Steps:/);
  assert.match(out.text, /☐ 1\. leash on/);
  assert.match(out.text, /☐ 2\. out the door/);
  const data = out.buttons.flat().map((b) => b.data);
  assert.ok(data.includes(`a:step:${t.id}:1`));
  assert.ok(data.includes(`a:step:${t.id}:all`));
  assert.equal(getDialogState(uid)?.type, 'stepping');
});

test('start with zero steps keeps the current behavior (no checklist, no stepping armed)', async () => {
  clearDialogState(uid);
  const t = mk({ summary: 'simple errand' });
  const out = await handleAction(uid, `a:start:${t.id}`);
  assert.match(out.text, /▶ Started/);
  assert.doesNotMatch(out.text, /Steps:/);
  assert.notEqual(getDialogState(uid)?.type, 'stepping');
});

test('start shows original_text + llm_summary only when they meaningfully differ', async () => {
  const u = freshUser();
  clearDialogState(u);
  const rich = insertTask({
    userId: u, summary: 'fix bike', category: 'household', createdAt: clock++,
    originalText: 'the back tire is flat and I should fix the bike before the trip',
    llmSummary: 'Patch or replace the rear tube; check the brake pads while the wheel is off.',
  });
  const o1 = await handleAction(u, `a:start:${rich.id}`);
  assert.match(o1.text, /back tire is flat/);
  assert.match(o1.text, /Patch or replace/);

  const u2 = freshUser();
  clearDialogState(u2);
  const plain = insertTask({ userId: u2, summary: 'water plants', category: 'household', createdAt: clock++, originalText: 'water plants', llmSummary: 'water plants' });
  const o2 = await handleAction(u2, `a:start:${plain.id}`);
  assert.doesNotMatch(o2.text, /📄/);          // original restates the summary → omitted
  assert.ok(!o2.text.includes('\n'));          // just the bare "▶ Started" header
  assert.match(o2.text, /Started:.*water plants/);
});

test('start surfaces the verbatim original even when the LLM title is just a trimmed prefix of it', async () => {
  clearDialogState(uid);
  // The classic failure: the title is a clean PREFIX of your words, so the old substring test hid exactly
  // the trailing context ("…about my crown") the title dropped. It must show now.
  const t = mk({ summary: 'call dentist', originalText: 'call dentist about my crown before friday' });
  const o = await handleAction(uid, `a:start:${t.id}`);
  assert.match(o.text, /📄 call dentist about my crown before friday/);
});

test('done while stepping ticks the next step, not the whole task', async () => {
  const u = freshUser();
  clearDialogState(u);
  const t = mkFor(u, 'clean kitchen');
  await handleMessage({ userId: u, text: 'step wipe counters' });
  await handleMessage({ userId: u, text: 'step mop floor' });
  await handleAction(u, `a:start:${t.id}`);
  const out = await handleMessage({ userId: u, text: 'done' });
  assert.match(out.reply, /Ticked step 1/);
  assert.equal(steps(t.id, u)[0].done, true);
  assert.equal(steps(t.id, u)[1].done, false);
  assert.equal(getTask(u, t.id).status, 'in_progress');
});

test('done <N> <M> ticks those specific steps', async () => {
  const u = freshUser();
  clearDialogState(u);
  const t = mkFor(u, 'pack bag');
  for (const x of ['passport', 'charger', 'socks']) await handleMessage({ userId: u, text: `step ${x}` });
  await handleAction(u, `a:start:${t.id}`);
  await handleMessage({ userId: u, text: 'done 1 3' });
  assert.deepEqual(steps(t.id, u).map((s) => s.done), [true, false, true]);
  assert.equal(getTask(u, t.id).status, 'in_progress');
});

test('done all ticks every step and auto-completes the task', async () => {
  const u = freshUser();
  clearDialogState(u);
  const t = mkFor(u, 'laundry run');
  await handleMessage({ userId: u, text: 'step wash' });
  await handleMessage({ userId: u, text: 'step dry' });
  await handleAction(u, `a:start:${t.id}`);
  const out = await handleMessage({ userId: u, text: 'done all' });
  assert.match(out.reply, /All 2 steps done/);
  assert.match(out.reply, /✓ Done/);
  assert.equal(getTask(u, t.id).status, 'done');
  assert.equal(getDialogState(u)?.type, 'done_feedback');   // normal completion flow armed
});

test('ticking the last open step completes the task', async () => {
  const u = freshUser();
  clearDialogState(u);
  const t = mkFor(u, 'two-step job');
  await handleMessage({ userId: u, text: 'step a' });
  await handleMessage({ userId: u, text: 'step b' });
  await handleAction(u, `a:start:${t.id}`);
  await handleMessage({ userId: u, text: 'done' });            // ticks step 1
  assert.equal(getTask(u, t.id).status, 'in_progress');
  const out = await handleMessage({ userId: u, text: 'done' }); // ticks step 2 → all done
  assert.match(out.reply, /All 2 steps done/);
  assert.equal(getTask(u, t.id).status, 'done');
});

test('re-ticking a done step is a no-op', async () => {
  const u = freshUser();
  clearDialogState(u);
  const t = mkFor(u, 'noop job');
  await handleMessage({ userId: u, text: 'step only' });
  await handleMessage({ userId: u, text: 'step second' });    // 2 steps so one tick doesn't finish it
  await handleAction(u, `a:start:${t.id}`);
  await handleMessage({ userId: u, text: 'done 1' });
  const out = await handleMessage({ userId: u, text: 'done 1' });
  assert.match(out.reply, /already ticked/i);
  assert.equal(getTask(u, t.id).status, 'in_progress');
});

test('stop leaves stepping without completing; steps stay saved', async () => {
  const u = freshUser();
  clearDialogState(u);
  const t = mkFor(u, 'pause job');
  await handleMessage({ userId: u, text: 'step x' });
  await handleMessage({ userId: u, text: 'step y' });
  await handleAction(u, `a:start:${t.id}`);
  const out = await handleMessage({ userId: u, text: 'stop' });
  assert.match(out.reply, /Paused/);
  assert.equal(getDialogState(u), null);
  assert.equal(getTask(u, t.id).status, 'in_progress');
  assert.equal(steps(t.id, u).length, 2);
  assert.equal(steps(t.id, u).filter((s) => s.done).length, 0);
});

test('bare "step" targets the STARTED task even when a newer task exists', async () => {
  const u = freshUser();
  clearDialogState(u);
  const working = mkFor(u, 'started earlier');
  await handleAction(u, `a:start:${working.id}`);
  await handleMessage({ userId: u, text: '/tasks' });           // escapes any session, keeps working started
  const newer = mkFor(u, 'newer arrival');
  const out = await handleMessage({ userId: u, text: 'step the crucial bit' });
  assert.match(out.reply, /added to .*started earlier/);
  assert.equal(steps(working.id, u).length, 1);
  assert.equal(steps(newer.id, u).length, 0);
});

test('bare "step" with nothing started falls back to the newest open task, with an aiming hint', async () => {
  const u = freshUser();
  clearDialogState(u);
  mkFor(u, 'older thing');
  const newest = mkFor(u, 'newest thing');
  const out = await handleMessage({ userId: u, text: 'step first move' });
  assert.match(out.reply, /added to .*newest thing/);
  assert.match(out.reply, /step N <text>/);                     // several candidates → show how to aim
  assert.equal(steps(newest.id, u).length, 1);
});

test('navigating away (/tasks) ends stepping; a later bare done completes the in-progress task', async () => {
  const u = freshUser();
  clearDialogState(u);
  const t = mkFor(u, 'navigate job');
  await handleMessage({ userId: u, text: 'step p' });
  await handleMessage({ userId: u, text: 'step q' });
  await handleAction(u, `a:start:${t.id}`);
  await handleMessage({ userId: u, text: '/tasks' });          // escapes stepping
  assert.notEqual(getDialogState(u)?.type, 'stepping');
  const out = await handleMessage({ userId: u, text: 'done' }); // bare-done global matcher
  assert.match(out.reply, /✓ Done/);
  assert.equal(getTask(u, t.id).status, 'done');
});

test('slash /done N mid-step completes TASK N (the listing), not a step', async () => {
  const u = freshUser();
  clearDialogState(u);
  const a = mkFor(u, 'alpha A');
  const b = mkFor(u, 'bravo B');
  const list = (await handleMessage({ userId: u, text: '/tasks' })).reply;
  const posA = Number(new RegExp('(\\d+)\\.[^\\n]*alpha A', 'i').exec(list)?.[1]);
  await handleMessage({ userId: u, text: 'step b-one' });       // most-recent open = b
  await handleMessage({ userId: u, text: 'step b-two' });
  await handleAction(u, `a:start:${b.id}`);                     // stepping armed on b
  assert.equal(getDialogState(u)?.type, 'stepping');
  await handleMessage({ userId: u, text: `/done ${posA}` });    // slash escapes → completes task A
  assert.equal(getTask(u, a.id).status, 'done');
  assert.equal(getTask(u, b.id).status, 'in_progress');
  assert.equal(steps(b.id, u).filter((s) => s.done).length, 0); // b's steps untouched
});
