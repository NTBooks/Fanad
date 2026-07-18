// Telegram vouch identity pinning (migration v31 + repo.isVouchedTelegram + telegram-handler): the vouch
// key is the MUTABLE @username, so the first authorized contact stamps the sender's immutable numeric id
// onto the row. After that a rename keeps them in, a squatter on the lapsed handle stays out, and a
// revoke → re-vouch resets the pin so the NEW holder of the handle gets it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-pin-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleIncoming } = await import('../server/channels/telegram-handler.js');
const { setTelegramConfig } = await import('../server/settings.js');
const { getActiveVouch, revokeVouchCascade, isVouchedTelegram } = await import('../server/repo.js');

migrate();
setTelegramConfig({ ownerId: null, allowedUsername: '' });

const say = (text, fromId, username) => handleIncoming({ text, fromId, username });

const BOB = 2002; // the real bob
const SQUATTER = 9999; // takes the @bob handle later

test('the first authorized contact pins the vouch to the sender’s numeric id', async () => {
  assert.match((await say('claim', 1001, 'alice')).reply, /Filed/); // owner
  await say('vouch @bob', 1001, 'alice');
  assert.equal(getActiveVouch('bob').vouched_telegram_id, null, 'unpinned until bob actually shows up');
  assert.match((await say('water the plants', BOB, 'bob')).reply, /Filed/);
  const row = getActiveVouch('bob');
  assert.equal(Number(row.vouched_telegram_id), BOB, 'pinned on first contact');
  assert.ok(row.pinned_at != null);
});

test('a rename keeps the pinned user in (the id is the key now, not the handle)', async () => {
  assert.match((await say('still me, new handle', BOB, 'bobby')).reply, /Filed/);
  assert.ok(isVouchedTelegram({ username: 'anything_else', telegramId: BOB }));
});

test('a squatter on the vouched handle is refused — silently, like any stranger', async () => {
  assert.equal((await say('let me in', SQUATTER, 'bob')).reply, null);
  assert.equal(Number(getActiveVouch('bob').vouched_telegram_id), BOB, 'the pin did not move');
});

test('revoke cuts the pinned user off; re-vouch resets the pin for the handle’s NEW holder', async () => {
  revokeVouchCascade('bob', { byUserId: 1 });
  assert.equal((await say('hello?', BOB, 'bobby')).reply, null, 'the pinned id is out once revoked');
  await say('vouch @bob', 1001, 'alice'); // re-vouch the handle
  assert.equal(getActiveVouch('bob').vouched_telegram_id, null, 'reactivation cleared the stale pin');
  // Whoever holds @bob NOW claims the fresh vouch on first contact — that's the squatter here, by design:
  // a vouch names a handle until its first contact pins a person.
  assert.match((await say('hi, I am bob now', SQUATTER, 'bob')).reply, /Filed/);
  assert.equal(Number(getActiveVouch('bob').vouched_telegram_id), SQUATTER);
  // …and the OLD holder's id no longer rides the handle's vouch.
  assert.equal((await say('what about me', BOB, 'bobby')).reply, null);
});
