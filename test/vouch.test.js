// Vouch — grow the access whitelist by personal endorsement, with a kept record of who vouched whom, plus
// the admin cascade-revoke. Exercises the real auth gate (handleIncoming) end-to-end and the repo helpers
// the web admin uses. No live bot needed. See migration v18 + telegram-handler.authorize().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-vouch-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { handleIncoming } = await import('../server/channels/telegram-handler.js');
const { setTelegramConfig } = await import('../server/settings.js');
const {
  isVouched, getActiveVouch, listVouches, listVouchesBy, revokeVouchCascade, addVouch,
} = await import('../server/repo.js');

migrate();

// Fresh owner-claim mode for each run: no manual allowlist, no claimed owner yet.
setTelegramConfig({ ownerId: null, allowedUsername: '' });

const say = (text, fromId, username) => handleIncoming({ text, fromId, username });

// alice is the first chatter → she CLAIMS the bot (owner). Everyone else is a stranger until vouched.
// A turned-away stranger gets NO reply (silent drop — see telegram-handler.handleIncoming).
test('the first chatter claims the bot; a stranger is turned away (silently)', async () => {
  assert.match((await say('water the plants', 1001, 'alice')).reply, /Filed/);
  assert.equal((await say('let me in', 1002, 'bob')).reply, null);
});

test('an authorized user vouches a stranger in, and the record names the voucher', async () => {
  const r = await say('vouch @bob', 1001, 'alice');
  assert.match(r.reply, /Vouched/i);
  assert.ok(isVouched('bob'), 'bob is now on the whitelist');
  assert.equal(getActiveVouch('BOB').voucher_username, 'alice', 'the record names who let bob in (case/@ insensitive)');
  // bob can now actually talk to the bot.
  assert.match((await say('clean the garage', 1002, 'bob')).reply, /Filed/);
});

test('a non-owner opts the vouch module on, then can vouch (the growth mechanism)', async () => {
  // Vouch is a per-user module: ON automatically for the owner (alice), OFF for everyone else until they
  // turn it on. bob is vouched in but NOT the owner, so his first vouch is gently declined…
  assert.match((await say('vouch @carol', 1002, 'bob')).reply, /off|turn it on/i);
  // …until he opts in; then ANY authorized user can vouch others (not just the owner).
  await say('optin vouch', 1002, 'bob');
  assert.match((await say('vouch @carol', 1002, 'bob')).reply, /Vouched/i);
  assert.match((await say('buy stamps', 1003, 'carol')).reply, /Filed/);
  // someone with no endorsement is still blocked — silently.
  assert.equal((await say('hi', 1009, 'dave')).reply, null);
});

test('vouching is idempotent and self-vouch is a no-op', async () => {
  assert.match((await say('vouch @bob', 1001, 'alice')).reply, /already vouched/i);
  assert.match((await say('vouch @alice', 1001, 'alice')).reply, /already in|yourself/i);
});

test('a junk handle is rejected gently (not filed as a task)', async () => {
  assert.match((await say('vouch hi', 1001, 'alice')).reply, /doesn’t look like|username/i);
});

test('bare "vouch" lists who you have vouched in', async () => {
  const r = await say('vouch', 1001, 'alice');
  assert.match(r.reply, /@bob/);          // alice vouched bob
  assert.doesNotMatch(r.reply, /@carol/); // carol was vouched by bob, not alice
  assert.deepEqual(listVouchesBy(getActiveVouch('bob').voucher_user_id), ['bob']);
});

test('cascade revoke pulls the whole subtree but KEEPS the record', async () => {
  // Tree: alice(owner) → bob → carol. Revoking bob must also drop carol.
  const revoked = revokeVouchCascade('bob', { byUserId: 1 });
  assert.deepEqual(revoked.sort(), ['bob', 'carol']);
  assert.equal(isVouched('bob'), false);
  assert.equal(isVouched('carol'), false);
  // Access is actually gone for both… (and they're dropped silently, like any stranger)
  assert.equal((await say('hi again', 1002, 'bob')).reply, null);
  assert.equal((await say('hi again', 1003, 'carol')).reply, null);
  // …but the provenance rows survive (soft delete), stamped with who revoked them.
  const rows = listVouches();
  const bobRow = rows.find((v) => v.username === 'bob');
  assert.ok(bobRow.revoked_at != null && bobRow.revoked_by_user_id === 1, 'bob row is kept, marked revoked');
  assert.ok(rows.find((v) => v.username === 'carol').revoked_at != null);
});

test('re-vouching a revoked handle reactivates it under the new voucher', async () => {
  const res = addVouch({ username: '@Bob', voucherUserId: 1, voucherUsername: 'alice' });
  assert.equal(res.status, 'reactivated');
  assert.ok(isVouched('bob'));
  assert.match((await say('back in', 1002, 'bob')).reply, /Filed/);
});

test('cascade revoke from the OWNER handle clears their whole tree (owner stays owner by id)', async () => {
  // alice is owner by numeric id, not a vouch row, but she is the voucher_username parent of bob.
  await say('vouch @carol', 1002, 'bob'); // rebuild bob → carol edge
  const revoked = revokeVouchCascade('alice', { byUserId: 1 });
  assert.deepEqual(revoked.sort(), ['bob', 'carol']); // alice herself has no vouch row, so not listed
  assert.equal(isVouched('bob'), false);
  assert.match((await say('still owner', 1001, 'alice')).reply, /Filed/, 'the owner is never locked out');
});
