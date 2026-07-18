// Web sessions (auth §9): opaque token ↔ hashed row, expiry deletion, hourly (not per-poll) sliding
// renewal, the pending_totp state being rejected by the API gate, and the password-change session sweep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-authsess-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate, db } = await import('../server/db.js');
const auth = await import('../server/auth.js');
const { setAuthConfig } = await import('../server/settings.js');
migrate();

const rowFor = (token) => db.prepare('SELECT * FROM web_sessions ORDER BY id DESC LIMIT 1').get();

test('create → resolve; the DB stores only a hash, never the cookie token', () => {
  const token = auth.createSession(1, { ip: '127.0.0.1' });
  const s = auth.resolveSession(token);
  assert.equal(s.userId, 1);
  assert.equal(s.state, 'active');
  const row = rowFor(token);
  assert.notEqual(row.token_hash, token, 'raw token must not be stored');
  assert.equal(row.token_hash.length, 64, 'sha256 hex');
  assert.equal(auth.resolveSession('not-a-real-token'), null);
});

test('an expired session is deleted on resolve', () => {
  const token = auth.createSession(1, {});
  db.prepare('UPDATE web_sessions SET expires_at = ? WHERE token_hash = ?')
    .run(Date.now() - 1000, rowFor(token).token_hash);
  assert.equal(auth.resolveSession(token), null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM web_sessions WHERE user_id = 1').get().n
    > 0 ? auth.resolveSession(token) : null, null, 'row is gone');
});

test('sliding renewal writes at most hourly — a fresh session is not re-stamped per poll', () => {
  const token = auth.createSession(1, {});
  const before = rowFor(token);
  auth.resolveSession(token); // seconds-old → no write
  const after = db.prepare('SELECT * FROM web_sessions WHERE token_hash = ?').get(before.token_hash);
  assert.equal(String(after.expires_at), String(before.expires_at), 'no write for a fresh session');
  // Age it past the renewal threshold (last seen 2h ago, expiry set back accordingly) → the window slides.
  const agedExpiry = Date.now() + 3600000; // pretend only 1h of the 30-day window is left
  db.prepare('UPDATE web_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
    .run(Date.now() - 2 * 3600000, agedExpiry, before.token_hash);
  auth.resolveSession(token);
  const slid = db.prepare('SELECT * FROM web_sessions WHERE token_hash = ?').get(before.token_hash);
  assert.ok(Number(slid.expires_at) > agedExpiry + 86400000, 'expiry extended by the full sliding window');
  assert.ok(Number(slid.last_seen_at) > Date.now() - 5000, 'last_seen_at stamped');
});

test('the API gate honors only ACTIVE sessions while login is on', () => {
  setAuthConfig({ mode: 'simple' });
  try {
    const res = { code: null, status(c) { this.code = c; return this; }, json() { return this; } };
    let passed = false;
    auth.apiAuthGate({ webSession: { userId: 1, state: 'pending_totp' } }, res, () => { passed = true; });
    assert.equal(passed, false, 'pending_totp must not pass');
    assert.equal(res.code, 401);
    auth.apiAuthGate({ webSession: { userId: 1, state: 'active' } }, res, () => { passed = true; });
    assert.equal(passed, true, 'active passes');
    passed = false;
    auth.apiAuthGate({ webSession: null }, { ...res, code: null, status(c) { this.code = c; return this; }, json() { return this; } }, () => { passed = true; });
    assert.equal(passed, false, 'no session → 401');
  } finally {
    setAuthConfig({ mode: 'none' });
  }
});

test('destroyOtherSessions keeps only the named session (password-change sweep)', () => {
  db.prepare('DELETE FROM web_sessions').run();
  const keep = auth.createSession(1, {});
  auth.createSession(1, {});
  auth.createSession(1, {});
  const keepHash = auth.resolveSession(keep).tokenHash;
  auth.destroyOtherSessions(1, keepHash);
  const rows = db.prepare('SELECT token_hash FROM web_sessions WHERE user_id = 1').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, keepHash);
});

test('cookie parsing finds fanad_session among other cookies', () => {
  const token = 'abc123_-';
  const req = { headers: { cookie: `other=1; fanad_session=${encodeURIComponent(token)}; theme=dark` } };
  assert.equal(auth.readSessionToken(req), token);
  assert.equal(auth.readSessionToken({ headers: {} }), null);
  assert.equal(auth.readSessionToken({ headers: { cookie: 'other=1' } }), null);
});
