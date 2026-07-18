// Vouch abuse controls for a public demo (chat.js vouchCommand + config.limits): a per-user invite cap, a
// chain-depth rule (guests-of-guests can't invite), a global seat cap, the owner heads-up on every vouch
// they didn't make, and the runtime vouch freeze. The OWNER is exempt from all caps. Exercised through the
// real Telegram gate (handleIncoming), like vouch.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-vlimits-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';
process.env.VOUCH_CAP_PER_USER = '2';
process.env.VOUCH_MAX_DEPTH = '2';
process.env.MAX_VOUCHED_USERS = '6';

const { migrate } = await import('../server/db.js');
const { handleIncoming } = await import('../server/channels/telegram-handler.js');
const { setTelegramConfig, setGuardConfig } = await import('../server/settings.js');
const { setOwnerNotifier } = await import('../server/notifyOwner.js');
const { countActiveVouches, vouchDepthOf } = await import('../server/repo.js');

migrate();
setTelegramConfig({ ownerId: null, allowedUsername: '' });

const notified = [];
setOwnerNotifier(async (text, chatId) => { notified.push({ text, chatId }); });

const say = (text, fromId, username) => handleIncoming({ text, fromId, username });
// A vouched-in guest turns the vouch module on for themselves (it's only auto-on for the owner).
const enroll = async (fromId, username) => {
  assert.match((await say('hello there', fromId, username)).reply, /\S/);
  await say('optin vouch', fromId, username);
};

// alice claims the bot; the owner ignores the per-user cap (3 > 2) — vouching is her job.
test('the owner is exempt from the per-user invite cap', async () => {
  assert.match((await say('first!', 1001, 'alice')).reply, /Filed/);
  for (const h of ['guest_a', 'guest_b', 'guest_c']) assert.match((await say(`vouch @${h}`, 1001, 'alice')).reply, /Vouched/i);
  assert.equal(countActiveVouches('telegram'), 3);
});

test('a guest hits the per-user invite cap', async () => {
  await enroll(1002, 'guest_a');
  assert.match((await say('vouch @carol_one', 1002, 'guest_a')).reply, /Vouched/i);
  assert.match((await say('vouch @carol_two', 1002, 'guest_a')).reply, /Vouched/i);
  assert.match((await say('vouch @carol_three', 1002, 'guest_a')).reply, /all 2 of your invites/i);
  assert.equal(countActiveVouches('telegram'), 5);
});

test('depth rule: a guest-of-a-guest cannot vouch further', async () => {
  assert.equal(vouchDepthOf('guest_a'), 1, 'owner-vouched = depth 1');
  assert.equal(vouchDepthOf('carol_one'), 2, 'vouched by a vouched user = depth 2');
  await enroll(1003, 'carol_one');
  assert.match((await say('vouch @dave_one', 1003, 'carol_one')).reply, /invited guests are off/i);
});

test('the owner is notified of every vouch they did not make (and only those)', async () => {
  const mine = notified.filter((n) => /🤝/.test(n.text));
  assert.equal(mine.length, 2, 'b1’s two vouches pinged the owner; the owner’s own three did not');
  assert.match(mine[0].text, /@guest_a vouched in @carol_one/);
  assert.match(mine[0].text, /5?\/6|\/6/, 'the seats-used tally rides along');
  assert.ok(mine.every((n) => n.chatId === 1001), 'delivered to the owner’s chat id');
});

test('the global seat cap fills the guest list', async () => {
  await enroll(1004, 'guest_b');
  assert.match((await say('vouch @dave_two', 1004, 'guest_b')).reply, /Vouched/i); // seat 6/6
  await enroll(1005, 'guest_c');
  assert.match((await say('vouch @dave_three', 1005, 'guest_c')).reply, /guest list is full/i);
  // The owner can still exceed it deliberately — caps guard against guests, not the host.
  assert.match((await say('vouch @vip', 1001, 'alice')).reply, /Vouched/i);
});

test('the vouch freeze blocks guests (not the owner) until unfrozen', async () => {
  setGuardConfig({ vouchFrozen: true });
  assert.match((await say('vouch @dave_four', 1004, 'guest_b')).reply, /frozen|paused/i);
  assert.match((await say('vouch @vip2', 1001, 'alice')).reply, /Vouched/i);
  setGuardConfig({ vouchFrozen: false });
});
