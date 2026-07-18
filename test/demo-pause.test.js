// The demo kill switches (settings guard blob + the owner's "demo …" chat command): pause shuts every
// non-owner surface — Telegram goes silent (the stranger drop path), the web API 503s — while the owner
// keeps full access on both; resume restores; freeze/unfreeze gates vouching; /web link minting refuses
// while paused. Impersonation is ON here purely so HTTP requests can act as a non-owner (auth mode 'none').
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-pause-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';
process.env.USER_IMPERSONATION = '1';

const express = (await import('express')).default;
const { migrate } = await import('../server/db.js');
migrate();
const apiRouter = (await import('../server/routes/api.js')).default;
const { handleIncoming } = await import('../server/channels/telegram-handler.js');
const { handleMessage } = await import('../server/chat.js');
const { setTelegramConfig, getGuardConfig } = await import('../server/settings.js');
const { getOrCreateTelegramUser } = await import('../server/repo.js');

setTelegramConfig({ ownerId: null, allowedUsername: '' });

const app = express();
app.use(express.json());
app.use('/api', apiRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
after(() => { server.closeAllConnections?.(); server.close(); });

const say = (text, fromId, username) => handleIncoming({ text, fromId, username });

// alice claims the bot (owner); bob is a vouched-in guest.
assert.match((await say('claim', 1001, 'alice')).reply, /Filed/);
await say('vouch @bob', 1001, 'alice');
assert.match((await say('hi from bob', 1002, 'bob')).reply, /Filed/);
const bobId = getOrCreateTelegramUser(1002, 'bob');

test('the demo command is owner-only, and loose phrasing still files as a task', async () => {
  assert.match((await say('demo status', 1001, 'alice')).reply, /access: ▶️ open/);
  assert.match((await say('demo the new build to sarah', 1001, 'alice')).reply, /Filed/, 'owner: non-verb forms file normally');
  assert.match((await say('demo pause', 1002, 'bob')).reply, /Filed/, 'a guest saying "demo pause" just files a task');
  assert.equal(getGuardConfig().demoPaused, false, 'and flips nothing');
});

test('"demo pause" silences guests on Telegram and 503s them on the web; the owner sails through', async () => {
  assert.match((await say('demo pause', 1001, 'alice')).reply, /paused/i);
  assert.equal((await say('anyone home?', 1002, 'bob')).reply, null, 'guest: the stranger drop path');
  assert.match((await say('owner still works', 1001, 'alice')).reply, /Filed/);
  const asBob = await fetch(`${base}/tasks`, { headers: { 'X-Fanad-User': String(bobId) } });
  assert.equal(asBob.status, 503);
  assert.equal((await asBob.json()).code, 'DEMO_PAUSED');
  const asRoot = await fetch(`${base}/tasks`);
  assert.equal(asRoot.status, 200, 'root (the owner) keeps the web');
});

test('/web link minting refuses for a paused guest', async () => {
  // Bypass the channel gate (bob can't even reach the brain while paused) to hit webReply's own guard.
  const out = await handleMessage({ userId: bobId, text: '/web', channel: 'telegram' });
  assert.match(out.reply, /paused/i);
});

test('"demo resume" restores guests on both surfaces', async () => {
  assert.match((await say('demo resume', 1001, 'alice')).reply, /resumed/i);
  assert.match((await say('back again', 1002, 'bob')).reply, /Filed/);
  assert.equal((await fetch(`${base}/tasks`, { headers: { 'X-Fanad-User': String(bobId) } })).status, 200);
});

test('"demo freeze" / "demo unfreeze" gate vouching at runtime', async () => {
  await say('optin vouch', 1002, 'bob');
  assert.match((await say('demo freeze', 1001, 'alice')).reply, /frozen/i);
  assert.match((await say('vouch @carol', 1002, 'bob')).reply, /frozen|paused/i);
  assert.match((await say('demo unfreeze', 1001, 'alice')).reply, /open/i);
  assert.match((await say('vouch @carol', 1002, 'bob')).reply, /Vouched/i);
});

test('the owner-only settings endpoints read and flip the same switches', async () => {
  // demoSignupsPerIp defaults to config.limits (env DEMO_SIGNUPS_PER_IP unset here → the code default of 3).
  assert.deepEqual(await (await fetch(`${base}/settings/guard`)).json(), { vouchFrozen: false, demoPaused: false, demoSignupOpen: false, demoSignupsPerIp: 3 });
  const flip = await fetch(`${base}/settings/guard`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vouchFrozen: true }),
  });
  assert.deepEqual(await flip.json(), { vouchFrozen: true, demoPaused: false, demoSignupOpen: false, demoSignupsPerIp: 3 });
  assert.match((await say('demo status', 1001, 'alice')).reply, /FROZEN/, 'chat and web read the same blob');
  await fetch(`${base}/settings/guard`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vouchFrozen: false }),
  });
});

test('the per-IP seat cap is owner-tunable live via the guard endpoint (and validated)', async () => {
  // A whole number ≥ 0 sticks and overrides the env default…
  const set = await fetch(`${base}/settings/guard`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ demoSignupsPerIp: 5 }),
  });
  assert.equal((await set.json()).demoSignupsPerIp, 5);
  assert.equal(getGuardConfig().demoSignupsPerIp, 5, 'the live config reflects the new cap immediately');
  // …0 means "no limit"…
  const off = await fetch(`${base}/settings/guard`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ demoSignupsPerIp: 0 }),
  });
  assert.equal((await off.json()).demoSignupsPerIp, 0);
  // …and junk (negative / fractional) is rejected with a 400, leaving the stored value untouched.
  const bad = await fetch(`${base}/settings/guard`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ demoSignupsPerIp: -2 }),
  });
  assert.equal(bad.status, 400);
  assert.equal(getGuardConfig().demoSignupsPerIp, 0, 'a rejected write does not change the cap');
});
