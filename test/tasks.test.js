// /tasks: grouped + sorted by category, and a follow-up that narrows by category/difficulty when there
// are a lot. Tasks are seeded INSIDE the tests (sequential) so each step controls the count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-tasks-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');

migrate();
const say = (text) => handleMessage({ text }); // no auto-clear — we lean on the global dialog across turns

test('a small task list is grouped by category', async () => {
  await say('email the client'); // work
  await say('clean the garage');  // household
  const r = await say('/tasks');
  assert.match(r.reply, /Work/);
  assert.match(r.reply, /Home/); // 'household' now labels as "Home"
  assert.match(r.reply, /\d+\.\s.*client/);
  assert.equal(r.mode, 'capture', 'a small list is shown directly, no follow-up');
});

test('with many tasks, /tasks shows an overview and asks to narrow', async () => {
  for (const s of ['meeting notes', 'do the dishes', 'buy groceries', 'go for a run',
    'call mom', 'fix the sink', 'read a book', 'tidy the kitchen real quick']) await say(s);
  const r = await say('/tasks'); // now 10 open tasks
  assert.match(r.reply, /open tasks/i);
  assert.equal(r.mode, 'filter');
  const chips = r.buttons.flat();
  assert.ok(chips.length > 0, 'offers narrowing buttons');
  assert.ok(chips.some((b) => /\(\d+\)/.test(b.text)), 'chips carry per-kind/difficulty counts');
  assert.ok(chips.some((b) => b.data === 'today'), 'offers a 📅 Today button');
  assert.ok(chips.some((b) => b.data === 'all'), 'offers a 📋 All button');
});

test('answering the follow-up with a category filters the list', async () => {
  const r = await say('work'); // answers the armed task_filter from the previous test
  assert.match(r.reply, /Work/);
  assert.match(r.reply, /client|meeting/);
  assert.doesNotMatch(r.reply, /garage/, 'other categories are excluded');
});

test('/tasks <category> filters directly', async () => {
  assert.match((await say('/tasks errand')).reply, /Errands/);
});

test('/tasks <difficulty> filters by effort', async () => {
  const r = await say('/tasks trivial');
  assert.match(r.reply, /tidy/);
  assert.doesNotMatch(r.reply, /email/);
});

test('an indirect request escapes the narrow prompt (not read as the "task" category)', async () => {
  await say('/tasks');                  // 10 tasks → overview, arms the task_filter prompt
  const r = await say('suggest a task'); // must NOT be parsed as category "task" (Projects)
  assert.doesNotMatch(r.reply, /^Projects \(/m);
  assert.match(r.reply, /💡|How about|Nothing/);
});
