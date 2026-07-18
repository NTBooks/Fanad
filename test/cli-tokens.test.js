// CLI claim tokens: mint/resolve lifecycle, the identity rules (no notebooks, no unknown
// users — at mint AND at resolve), revocation/expiry, and the request plumbing: cliTokenMiddleware →
// apiAuthGate → resolveActingUserId, in both auth modes. The token is the terminal client's whole login,
// so these guards ARE its security model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-clitok-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate, db } = await import('../server/db.js');
const auth = await import('../server/auth.js');
const { setAuthConfig } = await import('../server/settings.js');
const { defaultUserId, getOrCreateTelegramUser, createNotebook } = await import('../server/repo.js');
const { resolveActingUserId } = await import('../server/actingUser.js');
const { handleMessage } = await import('../server/chat.js');
migrate();

const root = defaultUserId();
const lastRow = () => db.prepare('SELECT * FROM cli_tokens ORDER BY id DESC LIMIT 1').get();

test('mint → resolve; fnd1_ prefix; the DB stores only a hash, never the token', () => {
  const token = auth.mintCliToken(root, { label: 'laptop' });
  assert.ok(token.startsWith('fnd1_'), 'recognizable prefix');
  const r = auth.resolveCliToken(token);
  assert.equal(r.userId, root);
  const row = lastRow();
  assert.notEqual(row.token_hash, token, 'raw token must not be stored');
  assert.equal(row.token_hash.length, 64, 'sha256 hex');
  assert.equal(row.label, 'laptop');
  assert.ok(Number(row.expires_at) > Date.now() + 89 * 86400000, 'default TTL ~90 days');
  assert.equal(auth.resolveCliToken('fnd1_not-a-real-token'), null);
  assert.equal(auth.resolveCliToken('not-even-prefixed'), null);
});

test('ttlDays 0 = non-expiring; a positive TTL sets expires_at', () => {
  const token = auth.mintCliToken(root, { ttlDays: 0 });
  assert.equal(lastRow().expires_at, null);
  assert.ok(auth.resolveCliToken(token), 'non-expiring token resolves');
  auth.mintCliToken(root, { ttlDays: 7 });
  const week = lastRow();
  assert.ok(Number(week.expires_at) > Date.now() && Number(week.expires_at) < Date.now() + 8 * 86400000);
});

test('mint refuses unknown users and notebooks', () => {
  assert.throws(() => auth.mintCliToken(999999), /No such user/);
  assert.throws(() => auth.mintCliToken(0), /No such user/);
  const nb = createNotebook(root, 'tokens-test-nb').notebook;
  assert.throws(() => auth.mintCliToken(nb.id), /notebook/i);
});

test('an expired token is rejected but the row is KEPT for the admin list', () => {
  const token = auth.mintCliToken(root, { label: 'stale' });
  db.prepare('UPDATE cli_tokens SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, lastRow().id);
  assert.equal(auth.resolveCliToken(token), null);
  const row = db.prepare('SELECT * FROM cli_tokens WHERE label = ?').get('stale');
  assert.ok(row, 'expired rows are not swept — the list still tells the story');
});

test('revoke kills the token; revoking twice reports false; the row stays listed', () => {
  const token = auth.mintCliToken(root, { label: 'to-revoke' });
  const id = lastRow().id;
  assert.ok(auth.resolveCliToken(token), 'live before revoke');
  assert.equal(auth.revokeCliToken(id), true);
  assert.equal(auth.resolveCliToken(token), null, 'dead after revoke');
  assert.equal(auth.revokeCliToken(id), false, 'already revoked');
  const listed = auth.listCliTokens().find((t) => t.id === id);
  assert.ok(listed.revoked_at != null, 'soft revoke — row visible with its state');
});

test('resolve re-checks the identity row: a user who BECAME a notebook is rejected (defense in depth)', () => {
  const uid = getOrCreateTelegramUser(777001, 'tokenuser');
  const token = auth.mintCliToken(uid);
  assert.ok(auth.resolveCliToken(token), 'live while a normal account');
  db.prepare('UPDATE users SET parent_user_id = ? WHERE id = ?').run(root, uid);
  assert.equal(auth.resolveCliToken(token), null, 'notebook-shaped rows never authenticate');
  db.prepare('UPDATE users SET parent_user_id = NULL WHERE id = ?').run(uid);
});

test('cliTokenMiddleware stamps req.cliAuth from the Authorization header; garbage is ignored', () => {
  const token = auth.mintCliToken(root);
  const run = (headers) => {
    const req = { headers };
    auth.cliTokenMiddleware(req, null, () => {});
    return req.cliAuth;
  };
  // The surface is an owner OPT-IN, default OFF: a perfectly valid token is not honored until enabled.
  assert.equal(run({ authorization: `Bearer ${token}` }), null, 'default off — tokens ignored');
  setAuthConfig({ cliEnabled: true });
  try {
    assert.equal(run({ authorization: `Bearer ${token}` })?.userId, root);
    assert.equal(run({ authorization: `bearer ${token}` })?.userId, root, 'scheme is case-insensitive');
    assert.equal(run({}), null);
    assert.equal(run({ authorization: 'Bearer fnd1_bogus' }), null);
    assert.equal(run({ authorization: 'Basic dXNlcjpwYXNz' }), null, 'non-Bearer schemes ignored');
    // Flipping the switch off is an instant kill for every outstanding token — no revocation needed.
    setAuthConfig({ cliEnabled: false });
    assert.equal(run({ authorization: `Bearer ${token}` }), null, 'disabling the surface disables the token');
  } finally {
    setAuthConfig({ cliEnabled: false });
  }
});

test('apiAuthGate: a valid token passes under mode simple with NO session; nothing still 401s', () => {
  setAuthConfig({ mode: 'simple' });
  try {
    const res = () => ({ code: null, status(c) { this.code = c; return this; }, json() { return this; } });
    let passed = false;
    auth.apiAuthGate({ webSession: null, cliAuth: { userId: root, tokenHash: 'x' } }, res(), () => { passed = true; });
    assert.equal(passed, true, 'token satisfies the gate');
    passed = false;
    const r = res();
    auth.apiAuthGate({ webSession: null, cliAuth: null }, r, () => { passed = true; });
    assert.equal(passed, false, 'no token, no session → 401');
    assert.equal(r.code, 401);
  } finally {
    setAuthConfig({ mode: 'none' });
  }
});

test('resolveActingUserId: the token names its user in BOTH modes and beats the impersonation header', () => {
  const uid = getOrCreateTelegramUser(777002, 'cliactor');
  const cliAuth = { userId: uid, tokenHash: 'x' };
  // Mode none: token wins over the (ignored) header and over the root default.
  assert.equal(resolveActingUserId('1', null, cliAuth), uid);
  assert.equal(resolveActingUserId(null, null, cliAuth), uid);
  // Mode simple: token authenticates with no session at all; without it, no session = nobody.
  setAuthConfig({ mode: 'simple' });
  try {
    assert.equal(resolveActingUserId(null, null, cliAuth), uid);
    assert.equal(resolveActingUserId(null, null, null), null);
  } finally {
    setAuthConfig({ mode: 'none' });
  }
});

test('the "cmd" chat command mints a connect line on any channel — web and chat DMs alike', async () => {
  // Owner opt-in gate first: with the surface off (the default), even the web channel mints nothing.
  const off = await handleMessage({ userId: root, text: 'cmd', channel: 'web' });
  assert.doesNotMatch(off.reply, /fnd1_/, 'disabled surface mints nothing');
  assert.match(off.reply, /disabled|enable/i, 'points the owner at the switch');
  // The enable-it hint is an admin instruction, so it's owner-only: a guest's "cmd" while the surface
  // is off falls through the router and files as a task, as if the command didn't exist.
  const guestOff = await handleMessage({ userId: getOrCreateTelegramUser(777004, 'cmdguest'), text: 'cmd', channel: 'telegram' });
  assert.doesNotMatch(String(guestOff.reply), /terminal client|disabled/i, 'no admin hint for a guest');
  assert.match(String(guestOff.reply), /Filed/i, 'a guest’s "cmd" is just a word — filed as a task');
  setAuthConfig({ cliEnabled: true });
  try {
    const web = await handleMessage({ userId: root, text: 'cmd', channel: 'web' });
    assert.match(web.reply, /fanad https?:\/\/\S+ fnd1_[A-Za-z0-9_-]+/, 'web gets the ready-to-paste connect command');
    assert.match(web.reply, /shown ONCE/i);
    const row = lastRow();
    assert.equal(Number(row.user_id), root, 'minted for the acting account');
    assert.match(String(row.label || ''), /via cmd \(web\)/, 'labeled with its origin channel');
    // A vouched-in Telegram DM is the same identity proof /web leans on, so it mints directly —
    // no browser bunny-hop. The token belongs to THAT chat account, not the owner.
    const tgUser = getOrCreateTelegramUser(777003, 'cmdchat');
    const tg = await handleMessage({ userId: tgUser, text: 'cmd', channel: 'telegram' });
    assert.match(tg.reply, /fanad https?:\/\/\S+ fnd1_[A-Za-z0-9_-]+/, 'a chat DM gets the connect command directly');
    const tgRow = lastRow();
    assert.equal(Number(tgRow.user_id), tgUser, 'minted for the DM account itself');
    assert.match(String(tgRow.label || ''), /via cmd \(telegram\)/, 'origin channel in the label');
    // Exact-match only: a sentence starting with "cmd" is a task capture, not a token mint.
    const task = await handleMessage({ userId: root, text: 'cmd to clear the cache', channel: 'web' });
    assert.doesNotMatch(task.reply || '', /fnd1_/);
  } finally {
    setAuthConfig({ cliEnabled: false });
  }
});

test('last_used_at stamps at most hourly (the CLI polls — do not write per tick)', () => {
  const token = auth.mintCliToken(root, { label: 'throttle' });
  auth.resolveCliToken(token);
  const first = db.prepare('SELECT last_used_at FROM cli_tokens WHERE label = ?').get('throttle').last_used_at;
  assert.ok(first != null, 'first resolve stamps');
  auth.resolveCliToken(token);
  const second = db.prepare('SELECT last_used_at FROM cli_tokens WHERE label = ?').get('throttle').last_used_at;
  assert.equal(String(second), String(first), 'a seconds-old stamp is not rewritten');
});
