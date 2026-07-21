// done/finish/start followed by WORDS (not a number) must not silently act on an existing task by name.
// The BARE form is natural speech → files a task; only the explicit slash form stays a name-matching command;
// a position ("start 3") always acts. Guards the "too many verbs collide with task statements" fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-verbhijack-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const { insertTask, getTask, getOrCreateTelegramUser } = await import('../server/repo.js');

migrate();
let clock = 1_700_000_000_000;
let tg = 95_000;
const freshUser = () => getOrCreateTelegramUser(tg++, `h${tg}`);
const send = (u, text) => handleMessage({ userId: u, text });
const posOf = (text, rx) => Number(new RegExp('(\\d+)\\.[^\\n]*' + rx, 'i').exec(text)?.[1]);

test('bare "start <words>" never starts an existing task by name — it files instead', async () => {
  const u = freshUser();
  clearDialogState(u);
  const existing = insertTask({ userId: u, summary: 'rebuild the porch', category: 'household', createdAt: clock++ });
  const out = await send(u, 'start rebuild the porch');   // matches an open task by name
  assert.equal(getTask(u, existing.id).status, 'available', 'the existing task must NOT be silently started');
  assert.doesNotMatch(out.reply || '', /^▶ Started/, 'a bare verb+words never starts by name');
});

test('bare "done <words>" never completes an existing task by name', async () => {
  const u = freshUser();
  clearDialogState(u);
  const existing = insertTask({ userId: u, summary: 'wash the dishes', category: 'household', createdAt: clock++ });
  await send(u, 'done wash the dishes');
  assert.notEqual(getTask(u, existing.id).status, 'done', 'the existing task must NOT be silently completed');
});

test('"start N" (a position) still starts that task', async () => {
  const u = freshUser();
  clearDialogState(u);
  const t = insertTask({ userId: u, summary: 'paint the shed', category: 'household', createdAt: clock++ });
  const pos = posOf((await send(u, '/tasks')).reply, 'paint the shed');
  assert.ok(pos, 'the task appears in the listing');
  await send(u, `start ${pos}`);
  assert.equal(getTask(u, t.id).status, 'in_progress');
});

test('the explicit slash form "/start <words>" still matches a task by name (deliberate command)', async () => {
  const u = freshUser();
  clearDialogState(u);
  const t = insertTask({ userId: u, summary: 'seal the driveway', category: 'household', createdAt: clock++ });
  const out = await send(u, '/start seal the driveway');
  assert.equal(getTask(u, t.id).status, 'in_progress', 'slash form is a deliberate command → name-match acts');
  assert.match(out.reply, /Started/);
});

test('"/done <words>" still completes a matching task by name (slash = command)', async () => {
  const u = freshUser();
  clearDialogState(u);
  const t = insertTask({ userId: u, summary: 'take out the recycling', category: 'household', createdAt: clock++ });
  await send(u, '/done take out the recycling');
  assert.equal(getTask(u, t.id).status, 'done');
});
