// Chat history persistence + keyset backward pagination (the web UI's infinite scroll-back).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-hist-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleMessage } = await import('../server/chat.js');
const { clearDialogState } = await import('../server/dialog.js');
const { defaultUserId, listMessagesBefore, listMessagesAfter, clearMessages, insertMessage, listTasks } = await import('../server/repo.js');

migrate();
const uid = defaultUserId();
const say = (text) => { clearDialogState(uid); return handleMessage({ text, channel: 'web' }); };

test('both the user turn AND the bot reply are persisted, with roles', async () => {
  await say('water the plants');
  const page = listMessagesBefore(uid, { channel: 'web', limit: 50 });
  const user = page.filter((m) => m.role === 'user');
  const bot = page.filter((m) => m.role === 'bot');
  assert.ok(user.some((m) => m.text === 'water the plants'), 'user message stored');
  assert.ok(bot.length >= 1, 'bot reply stored');
  // The bot reply carries the status chip in raw_json (options/ref intentionally not stored).
  assert.ok(bot.every((m) => m.raw_json == null || 'status' in JSON.parse(m.raw_json)));
});

test("Fanad's decided reaction is stamped onto the stored USER row (web scroll-back parity)", async () => {
  await say('feed the sourdough starter');
  const page = listMessagesBefore(uid, { channel: 'web', limit: 10 });
  const user = page.find((m) => m.role === 'user' && m.text === 'feed the sourdough starter');
  assert.ok(user, 'user row stored');
  assert.equal(JSON.parse(user.raw_json).reaction, '\u{1FAE1}', 'a plain capture stamps the generic 🫡 ack');
  // Bot rows never carry a reaction stamp (that field is the user's own tap-reaction on the client).
  const bots = page.filter((m) => m.role === 'bot' && m.raw_json);
  assert.ok(bots.every((m) => !('reaction' in JSON.parse(m.raw_json))), 'bot rows unstamped');
});

test("a kind:'ack' turn stores no bot bubble but still stamps its emoji on the user row", async () => {
  const r = await say('ok'); // the filler ack: 👍 as a reaction, no reply bubble anywhere
  assert.equal(r.kind, 'ack');
  assert.equal(r.reaction, '👍');
  const page = listMessagesBefore(uid, { channel: 'web', limit: 10 });
  const user = page.find((m) => m.role === 'user' && m.text === 'ok');
  assert.equal(JSON.parse(user.raw_json).reaction, '👍', 'ack emoji persisted for scroll-back');
  assert.ok(!page.some((m) => m.role === 'bot' && m.text === '👍'), 'no bot row for the contentless ack');
});

test('keyset pagination walks backward in oldest→client order without gaps or dupes', async () => {
  for (let i = 0; i < 20; i++) await say(`task number ${i}`); // each adds a user + a bot row
  const PAGE = 8;
  const seen = [];
  let before = null;
  let hasMore = true;
  let guard = 0;
  while (hasMore && guard++ < 50) {
    const rows = listMessagesBefore(uid, { channel: 'web', beforeId: before, limit: PAGE });
    // repo returns newest-first; the API reverses to oldest-first — emulate that here.
    const asc = [...rows].reverse();
    seen.unshift(...asc);
    hasMore = rows.length === PAGE;
    before = asc.length ? asc[0].id : before;
  }
  // ids must be strictly increasing across the fully-walked, de-paginated transcript (no gaps/dupes).
  const ids = seen.map((m) => m.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'globally ordered by id');
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids across pages');
  assert.ok(ids.length >= 42, `walked the whole history (got ${ids.length})`);
});

test('forward poll: listMessagesAfter returns only turns newer than the cursor (oldest-first)', async () => {
  const all = listMessagesBefore(uid, { channel: 'web', limit: 500 });
  const maxId = Math.max(...all.map((m) => m.id));
  assert.equal(listMessagesAfter(uid, { channel: 'web', afterId: maxId }).length, 0, 'nothing newer than the latest id');
  await say('a brand new turn'); // adds a user + bot row, both id > maxId
  const fresh = listMessagesAfter(uid, { channel: 'web', afterId: maxId });
  assert.ok(fresh.length >= 2, 'the new user + bot turns are returned');
  assert.ok(fresh.every((m) => m.id > maxId), 'all strictly newer than the cursor');
  assert.deepEqual(fresh.map((m) => m.id), [...fresh.map((m) => m.id)].sort((a, b) => a - b), 'oldest-first');
});

test('forward poll spans all channels when channel is null (impersonation)', async () => {
  const maxId = Math.max(...listMessagesBefore(uid, { channel: null, limit: 500 }).map((m) => m.id));
  await handleMessage({ userId: uid, text: 'async from telegram', channel: 'telegram' });
  const webOnly = listMessagesAfter(uid, { channel: 'web', afterId: maxId });
  assert.ok(!webOnly.some((m) => m.text === 'async from telegram'), 'web-scoped poll misses the telegram turn');
  const allChan = listMessagesAfter(uid, { channel: null, afterId: maxId });
  assert.ok(allChan.some((m) => m.text === 'async from telegram'), 'all-channel poll catches it');
});

test('channel scoping: a web history query never returns telegram turns', async () => {
  await handleMessage({ userId: uid, text: 'from telegram', channel: 'telegram' });
  const web = listMessagesBefore(uid, { channel: 'web', limit: 200 });
  assert.ok(!web.some((m) => m.text === 'from telegram'), 'telegram turn excluded from web history');
  const tg = listMessagesBefore(uid, { channel: 'telegram', limit: 200 });
  assert.ok(tg.some((m) => m.text === 'from telegram'), 'telegram turn present in telegram history');
});

test('clearMessages: "all" wipes the whole log but keeps tasks (provenance link nulled, FK-safe)', async () => {
  await say('buy a notebook'); // files a task whose source_message_id points at the user message
  const before = listMessagesBefore(uid, { channel: null, limit: 1000 });
  assert.ok(before.length > 0, 'there is history to clear');
  const tasksBefore = listTasks(uid).length;
  assert.ok(tasksBefore > 0, 'there are tasks referencing messages');
  const removed = clearMessages(uid, {}); // no channel, no age → everything, all channels
  assert.equal(removed, before.length, 'removed exactly the rows that existed');
  assert.equal(listMessagesBefore(uid, { channel: null, limit: 1000 }).length, 0, 'history is empty');
  assert.equal(listTasks(uid).length, tasksBefore, 'tasks survive the clear');
});

test('clearMessages: olderThanMs keeps only newer turns', () => {
  const now = Date.now();
  insertMessage({ userId: uid, channel: 'web', text: 'ancient turn', role: 'user', receivedAt: now - 40 * 86400000 });
  insertMessage({ userId: uid, channel: 'web', text: 'recent turn', role: 'user', receivedAt: now - 1 * 86400000 });
  const removed = clearMessages(uid, { olderThanMs: now - 30 * 86400000 });
  assert.equal(removed, 1, 'only the 40-day-old message removed');
  const left = listMessagesBefore(uid, { channel: 'web', limit: 100 });
  assert.ok(left.some((m) => m.text === 'recent turn'), 'recent kept');
  assert.ok(!left.some((m) => m.text === 'ancient turn'), 'ancient gone');
});
