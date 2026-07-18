// handleAction dispatcher: structured menu taps mutate via the brain's flows, refresh the card, and reach
// the web through route()'s `action` branch. PLAN: interactive menus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-act-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage, handleAction } = await import('../server/chat.js');
const { clearDialogState, getDialogState } = await import('../server/dialog.js');
const { insertTask, getTask, defaultUserId } = await import('../server/repo.js');

migrate();
const uid = defaultUserId();
const mk = (over = {}) => insertTask({ userId: uid, summary: 'mow the lawn', category: 'household', ...over });

test('a:prio sets the priority and returns a refreshed card with buttons', async () => {
  clearDialogState(uid);
  const t = mk();
  const out = await handleAction(uid, `a:prio:${t.id}:3`);
  assert.equal(getTask(uid, t.id).priority, 3);
  assert.ok(out.buttons && out.buttons.length);
  assert.match(out.text, /mow the lawn/);
  assert.match(out.toast, /high/i);
});

test('a:done completes, arms done_feedback, and reuses transitionTask (ref.kind=done)', async () => {
  clearDialogState(uid);
  const t = mk();
  const out = await handleAction(uid, `a:done:${t.id}`);
  assert.equal(getTask(uid, t.id).status, 'done');
  assert.equal(out.ref?.kind, 'done');
  assert.equal(getDialogState(uid)?.type, 'done_feedback'); // the gentle "how did that feel?" beat
  assert.ok(out.buttons);                                   // feedback options surfaced as buttons
});

test('a stale/forged id returns a gentle "gone" card and never throws', async () => {
  clearDialogState(uid);
  const out = await handleAction(uid, 'a:done:99999');
  assert.match(out.text, /anymore/);
  assert.equal(out.buttons, null, 'no “‹ Back to a list” on a gone card — there’s nothing useful to return to');
});

test('m:act navigation changes neither the task nor an open dialog state', async () => {
  clearDialogState(uid);
  const t = mk({ priority: 1 });
  await handleMessage({ text: '/whatdo' });              // open a suggestion dialog
  const before = getDialogState(uid);
  assert.equal(before?.type, 'suggestion_reaction');
  const out = await handleAction(uid, `m:act:${t.id}`);
  assert.ok(out.buttons);
  assert.equal(getTask(uid, t.id).priority, 1);            // unchanged
  assert.deepEqual(getDialogState(uid), before);          // suggestion dialog intact
});

test('web parity: handleMessage({action}) mutates and returns reply + buttons', async () => {
  clearDialogState(uid);
  const t = mk();
  const res = await handleMessage({ action: `a:cat:${t.id}:work`, channel: 'web' });
  assert.equal(getTask(uid, t.id).category, 'work');
  assert.ok(res.buttons && res.buttons.length);
  assert.equal(typeof res.reply, 'string');
});

test('m:steps on a task WITH steps opens the checklist and arms an edit stepping session', async () => {
  const { addTaskStep, getOrCreateTelegramUser, parseSteps } = await import('../server/repo.js');
  const u = getOrCreateTelegramUser(91_001, 'stepsbtn');
  clearDialogState(u);
  const t = insertTask({ userId: u, summary: 'assemble shelf', category: 'household' });
  addTaskStep(u, t.id, 'unbox parts');
  const out = await handleAction(u, `m:steps:${t.id}`);
  assert.match(out.text, /assemble shelf/);
  assert.match(out.text, /unbox parts/);
  assert.ok(out.buttons.flat().some((b) => b.data === `a:step:${t.id}:1`), 'step toggle buttons present');
  const ds = getDialogState(u);
  assert.equal(ds?.type, 'stepping');
  assert.equal(ds?.data?.taskId, t.id);
  assert.equal(ds?.data?.edit, true);
  assert.equal(getTask(u, t.id).status, 'available', 'opening steps does not start the task');
  // The armed session routes a typed "step …" to THIS task.
  const add = await handleMessage({ userId: u, text: 'step attach the legs' });
  assert.match(add.reply, /Step 2 added to .*assemble shelf/);
  assert.deepEqual(parseSteps(getTask(u, t.id)).map((s) => s.text), ['unbox parts', 'attach the legs']);
});

test('m:steps on a stepless task offers the guess and still arms the session', async () => {
  const { getOrCreateTelegramUser } = await import('../server/repo.js');
  const u = getOrCreateTelegramUser(91_002, 'stepsbtn2');
  clearDialogState(u);
  const t = insertTask({ userId: u, summary: 'plan the trip', category: 'other' });
  const out = await handleAction(u, `m:steps:${t.id}`);
  assert.match(out.text, /no steps yet/i);
  const data = out.buttons.flat().map((b) => b.data);
  assert.ok(data.includes(`a:guess:${t.id}`), 'Suggest steps offered');
  assert.ok(data.includes(`m:act:${t.id}`), 'Back to the action menu offered');
  assert.equal(getDialogState(u)?.data?.taskId, t.id);
});

test('the ⋯More submenu and the has-steps action menu both surface 🪜 Steps', async () => {
  const { addTaskStep, getOrCreateTelegramUser } = await import('../server/repo.js');
  const u = getOrCreateTelegramUser(91_003, 'stepsbtn3');
  clearDialogState(u);
  const t = insertTask({ userId: u, summary: 'stepped task', category: 'other' });
  addTaskStep(u, t.id, 'first');
  const more = await handleAction(u, `m:more:${t.id}`);
  assert.ok(more.buttons.flat().some((b) => b.data === `m:steps:${t.id}`), '⋯More carries 🪜 Steps');
  const act = await handleAction(u, `m:act:${t.id}`);
  assert.ok(act.buttons.flat().some((b) => b.data === `m:steps:${t.id}`), 'top menu slot is 🪜 Steps when steps exist');
});

test('m:list re-renders a task listing (back-to-list)', async () => {
  clearDialogState(uid);
  mk();
  await handleMessage({ text: '/tasks' });
  const out = await handleAction(uid, 'm:list');
  const text = typeof out === 'string' ? out : out.text;
  assert.match(text, /mow the lawn|open task/i);
});
