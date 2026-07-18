// Task STEPS — the tappable button path (a:step:<id>:<n|all>) + the pure token/keyboard codec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-steps-act-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleAction } = await import('../server/chat.js');
const { clearDialogState, getDialogState } = await import('../server/dialog.js');
const { insertTask, getTask, addTaskStep, parseSteps, defaultUserId } = await import('../server/repo.js');
const { decodeToken, stepsKeyboard } = await import('../server/menu.js');

migrate();
const uid = defaultUserId();
let clock = 1_700_000_000_000;
const mk = (over = {}) => insertTask({ userId: uid, summary: 'mow the lawn', category: 'household', createdAt: clock++, ...over });
const steps = (id) => parseSteps(getTask(uid, id));

test('a:step:<id>:<i> toggles step i and refreshes the checklist', async () => {
  clearDialogState(uid);
  const t = mk();
  addTaskStep(uid, t.id, 'first');
  addTaskStep(uid, t.id, 'second');
  const out = await handleAction(uid, `a:step:${t.id}:1`);
  assert.equal(steps(t.id)[0].done, true);
  assert.match(out.text, /☑ 1\. first/);
  assert.match(out.text, /☐ 2\. second/);
  assert.match(out.toast, /Step 1/);
  assert.equal(getTask(uid, t.id).status, 'available');     // not completed — a step still open
  await handleAction(uid, `a:step:${t.id}:1`);              // tap again → toggles back open
  assert.equal(steps(t.id)[0].done, false);
});

test('a:step:<id>:all completes the task and arms done_feedback', async () => {
  clearDialogState(uid);
  const t = mk();
  addTaskStep(uid, t.id, 'a');
  addTaskStep(uid, t.id, 'b');
  const out = await handleAction(uid, `a:step:${t.id}:all`);
  assert.equal(getTask(uid, t.id).status, 'done');
  assert.match(out.toast, /All steps done/);
  assert.equal(getDialogState(uid)?.type, 'done_feedback');
});

test('tapping the last open step auto-completes the task', async () => {
  clearDialogState(uid);
  const t = mk();
  addTaskStep(uid, t.id, 'only one');
  const out = await handleAction(uid, `a:step:${t.id}:1`);
  assert.equal(getTask(uid, t.id).status, 'done');
  assert.match(out.toast, /All steps done/);
});

test('a:step tokens decode and stepsKeyboard lays out toggles + Done-all + Back', () => {
  assert.deepEqual(decodeToken('a:step:5:1'), { ns: 'a', verb: 'step', taskId: 5, value: '1' });
  assert.deepEqual(decodeToken('a:step:5:all'), { ns: 'a', verb: 'step', taskId: 5, value: 'all' });

  const kb = stepsKeyboard(5, [{ done: true }, { done: false }, { done: false }]);
  const data = kb.flat().map((b) => b.data);
  assert.ok(data.includes('a:step:5:1'));
  assert.ok(data.includes('a:step:5:3'));
  assert.ok(data.includes('a:step:5:all'));
  assert.ok(data.includes('m:act:5'));                       // ‹ Back to the task's action menu
  assert.match(kb.flat().find((b) => b.data === 'a:step:5:1').text, /☑ 1/);  // done → checked box
  assert.match(kb.flat().find((b) => b.data === 'a:step:5:2').text, /☐ 2/);  // open → empty box
  assert.equal(stepsKeyboard(5, []), null);                  // no steps → no keyboard
});
