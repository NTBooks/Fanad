// /today (and the "x" shortcut) files a task due by END OF TODAY; "/tasks today" lists those; and
// "/whatdo today" scopes the suggestion to them. Due-date assertions use isDueToday (not the rendered
// "today" label) so they hold even in the 12am–5am small-hours window where "today" rolls to the next day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-today-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const { defaultUserId, listTasks, getOrCreateTelegramUser } = await import('../server/repo.js');
const { isDueToday } = await import('../server/services/llm/deadline.js');

migrate();
const uid = defaultUserId();
const say = (text) => { clearDialogState(uid); return handleMessage({ userId: uid, text }); };
const taskBySummary = (u, re) => listTasks(u).find((x) => re.test(x.summary));
let tg = 90_000;
const freshUser = () => getOrCreateTelegramUser(tg++, `u${tg}`);

test('"/today <text>" files a task due by end of today', async () => {
  assert.match((await say('/today buy organic milk')).reply, /Filed/);
  const task = taskBySummary(uid, /organic milk/i);
  assert.ok(task && task.due_at, 'the task should carry a due date');
  assert.ok(isDueToday(task), 'the task should be due today');
});

test('the "x" shortcut is the same as /today', async () => {
  assert.match((await say('x call the pharmacy')).reply, /Filed/);
  const task = taskBySummary(uid, /pharmacy/i);
  assert.ok(task && isDueToday(task), 'x should pin the deadline to today');
});

test('bare /today shows a usage hint, files nothing', async () => {
  const before = listTasks(uid).length;
  assert.match((await say('/today')).reply, /Try .*today buy milk/i);
  assert.equal(listTasks(uid).length, before);
});

test('a plain sentence opening with "today" is NOT hijacked — it files as a task', async () => {
  // No slash, no "x" → ordinary capture, never the /today command.
  assert.match((await say('today was a long day and I forgot the trash')).reply, /Filed/);
});

test('"/tasks today" lists only what is due today', async () => {
  const u = freshUser();
  await handleMessage({ userId: u, text: '/today pay the electric bill' });
  await handleMessage({ userId: u, text: 't read a novel sometime' });        // no deadline
  const r = (await handleMessage({ userId: u, text: '/tasks today' })).reply;
  assert.match(r, /electric bill/i);
  assert.doesNotMatch(r, /read a novel/i);
});

test('"/tasks today" with nothing due is gentle', async () => {
  const u = freshUser();
  await handleMessage({ userId: u, text: 't something with no date' });
  assert.match((await handleMessage({ userId: u, text: '/tasks today' })).reply, /Nothing due today/i);
});

test('"/whatdo today" suggests a task that is due today', async () => {
  const u = freshUser();
  await handleMessage({ userId: u, text: '/today water the plants' });
  const r = await handleMessage({ userId: u, text: '/whatdo today' });
  assert.match(r.reply, /💡/);
  assert.match(r.reply, /water the plants/i);
  assert.equal(r.mode, 'suggestion');
});

test('"/whatdo today" with nothing due today says so (even when other tasks exist)', async () => {
  const u = freshUser();
  await handleMessage({ userId: u, text: 't a task with no deadline at all' });
  assert.match((await handleMessage({ userId: u, text: '/whatdo today' })).reply, /Nothing.s due today/i);
});

test('natural "what\'s next today" routes to the today-scoped suggestion', async () => {
  const u = freshUser();
  await handleMessage({ userId: u, text: '/today rinse the recycling' });
  await handleMessage({ userId: u, text: 't paint the shed someday' });          // undated → must be excluded
  const r = await handleMessage({ userId: u, text: "what's next today" });
  assert.match(r.reply, /💡/);
  assert.match(r.reply, /recycling/i);
  assert.doesNotMatch(r.reply, /paint the shed/i);
});

test('plain "/whatdo" is unscoped — it can suggest an undated task', async () => {
  const u = freshUser();
  await handleMessage({ userId: u, text: 't tidy the desk' });       // no deadline
  const r = await handleMessage({ userId: u, text: '/whatdo' });
  assert.match(r.reply, /💡/);
  assert.match(r.reply, /tidy the desk/i);
});
