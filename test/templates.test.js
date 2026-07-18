// Task templates: save a task as a reusable blueprint, load fresh copies by name, overwrite, retire. The
// calm alternative to recurring tasks — a loaded copy carries the SHAPE (summary/category/effort + steps,
// reset to unchecked) but never a deadline, reminder, or priority (decision #2 in the plan).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-templates-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');
const { clearDialogState, setListing } = await import('../server/dialog.js');
const {
  defaultUserId, listTasks, getTask, insertTask, addTaskStep, parseSteps,
  setTaskSchedule, setTaskPriority, listTemplates, getTemplate,
} = await import('../server/repo.js');

migrate();
const uid = defaultUserId();
const say = (text) => { clearDialogState(uid); return handleMessage({ text }); };

// Seed a task (optionally with steps) and put it at position 1 of the current listing, so "/template 1 …"
// resolves to it. Summaries are unique per test, since tests share one accumulating DB.
function seedTask(summary, steps = []) {
  const task = insertTask({ userId: uid, summary, category: 'home', effortLevel: 'low' });
  for (const s of steps) addTaskStep(uid, task.id, s);
  setListing(uid, 'task', [task.id]);
  return getTask(uid, task.id);
}
const copies = (summary) => listTasks(uid).filter((x) => x.summary === summary);

test('save task #N as a template (with its steps); it shows in /templates', async () => {
  seedTask('bake sourdough', ['feed the starter', 'bake at 230C']);
  const r = await say('/template 1 sourdough');
  assert.match(r.reply, /Saved template/i);
  const tpl = getTemplate(uid, 'sourdough');
  assert.ok(tpl, 'template stored');
  assert.equal(tpl.summary, 'bake sourdough');
  assert.equal(parseSteps({ steps_json: tpl.steps_json }).length, 2);
  assert.match((await say('/templates')).reply, /sourdough/);
});

test('load drops a fresh copy with steps reset; the original is untouched', async () => {
  const orig = seedTask('weekly review', ['clear inbox', 'plan top 3']);
  await say('/template 1 weekly');
  const before = copies('weekly review').length;            // 1 = the original
  assert.match((await say('/template weekly')).reply, /Fresh copy/i);
  const all = copies('weekly review');
  assert.equal(all.length, before + 1, 'a new copy was filed');
  const copy = all.find((x) => x.id !== orig.id);
  assert.equal(copy.status, 'available');
  assert.equal(copy.category, 'home');
  assert.equal(copy.effort_level, 'low');
  const steps = parseSteps(copy);
  assert.equal(steps.length, 2);
  assert.ok(steps.every((s) => !s.done), 'steps reset to unchecked');
  assert.equal(getTask(uid, orig.id).status, 'available');  // original untouched
  assert.equal(parseSteps(getTask(uid, orig.id)).length, 2);
});

test('a loaded copy carries the shape but NO deadline, reminder, or priority', async () => {
  const orig = seedTask('quarterly taxes', ['gather receipts']);
  setTaskSchedule(uid, orig.id, { dueAt: Date.now() + 86400000, dueKind: 'by', remindAt: Date.now() + 3600000 });
  setTaskPriority(uid, orig.id, 3);
  await say('/template 1 taxes');
  await say('/template taxes');
  const copy = copies('quarterly taxes').find((x) => x.id !== orig.id);
  assert.ok(copy, 'a copy was created');
  assert.equal(copy.due_at, null, 'no deadline carried');
  assert.equal(copy.remind_at, null, 'no reminder carried');
  assert.equal(copy.priority, null, 'no priority carried');
});

test('re-saving the same name overwrites (one row, updated fields)', async () => {
  seedTask('packing list v1', ['socks']);
  await say('/template 1 trip');
  seedTask('packing list v2', ['socks', 'charger']);        // new task now at position 1
  const r = await say('/template 1 trip');                  // same name → overwrite
  assert.match(r.reply, /Updated template/i);
  const rows = listTemplates(uid).filter((t) => t.name.toLowerCase() === 'trip');
  assert.equal(rows.length, 1, 'still a single template named "trip"');
  assert.equal(rows[0].summary, 'packing list v2');
  assert.equal(parseSteps({ steps_json: rows[0].steps_json }).length, 2);
});

test('retire removes a template; loading it afterward is graceful', async () => {
  seedTask('spring clean', ['windows']);
  await say('/template 1 spring');
  assert.ok(getTemplate(uid, 'spring'));
  assert.match((await say('/template retire spring')).reply, /Retired/i);
  assert.equal(getTemplate(uid, 'spring'), null);
  assert.match((await say('/template spring')).reply, /No template called/i);
});

test('loading a non-existent template (slash form) is graceful and files nothing', async () => {
  const before = listTasks(uid).length;
  const r = await say('/template does-not-exist-xyz');
  assert.match(r.reply, /No template called/i);
  assert.equal(listTasks(uid).length, before, 'nothing filed');
});

test('slash and bare both load an existing template; a bare non-template phrase still files a task', async () => {
  seedTask('grocery run', ['milk', 'eggs']);
  await say('/template 1 groceries');
  let before = copies('grocery run').length;
  assert.match((await say('template groceries')).reply, /Fresh copy/i);      // bare load
  assert.equal(copies('grocery run').length, before + 1, 'bare "template <name>" loads');
  before = copies('grocery run').length;
  assert.match((await say('/template groceries')).reply, /Fresh copy/i);     // slash load
  assert.equal(copies('grocery run').length, before + 1, 'slash "/template <name>" loads');
  // Bare guard: not a saved template → captured as content, never an error (the mood/lock precedent).
  const taskCount = listTasks(uid).length;
  const r = await say('template my-unsaved-thing-42');
  assert.match(r.reply, /Filed/i);
  assert.equal(listTasks(uid).length, taskCount + 1, 'filed as a task, not eaten as a command');
});
