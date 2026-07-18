// Browser (non-Telegram) demo signups: while "demo mode" (the demoSignupOpen guard) is on, POST
// /api/auth/register opens an ACTIVE session with NO authenticator so a visitor drops straight into the app;
// turn demo mode off and every TOTP-less non-root account is force-marched into 2FA (effectiveSessionState
// downgrades its live session to needs_totp, and login resumes enrollment) before it can continue. Root and
// verified accounts are never touched. Seat cap is disabled here (demoSignupsPerIp=0) so it can't perturb the
// functional flows — the per-IP caps get their own file.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-webdemo-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const express = (await import('express')).default;
const { migrate } = await import('../server/db.js');
migrate();
const auth = await import('../server/auth.js');
const { sessionMiddleware, apiAuthGate, effectiveSessionState } = auth;
const authRouter = (await import('../server/routes/auth.js')).default;
const apiRouter = (await import('../server/routes/api.js')).default;
const { setAuthConfig, setGuardConfig } = await import('../server/settings.js');
const { createWebUser, setUserTotpVerified, getUserByUsername, getAuthRow } = await import('../server/repo.js');
const { generate } = await import('otplib');

// Mount order mirrors server/index.js: session cookie → open /api/auth surface → gated /api.
const app = express();
app.use(express.json());
app.use(sessionMiddleware);
app.use('/api/auth', authRouter);
app.use('/api', apiAuthGate, apiRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.closeAllConnections?.(); server.close(); });

// A minimal cookie jar: pull fanad_session out of a response's Set-Cookie and echo it back on later requests.
const cookieFrom = (res) => {
  for (const c of res.headers.getSetCookie?.() || []) {
    const m = /^fanad_session=([^;]*)/.exec(c);
    if (m) return `fanad_session=${m[1]}`;
  }
  return null;
};
const post = (path, body, cookie) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body || {}),
});
const get = (path, cookie) => fetch(base + path, { headers: { ...(cookie ? { cookie } : {}) } });
const secretOf = (uri) => new URL(uri).searchParams.get('secret');

// Demo box: login required, registration open, demo mode on, seat cap off.
setAuthConfig({ mode: 'simple', allowRegistration: true });
setGuardConfig({ demoSignupOpen: true, demoSignupsPerIp: 0 });

test('effectiveSessionState / demoModeOn: root & verified always active; TOTP-less follows demo mode', () => {
  const tExpr = getUserByUsername('ess_verified') || null;
  const tless = createWebUser({ username: 'ess_tless', passwordHash: 'x' });          // no TOTP
  const verified = tExpr ? tExpr.id : createWebUser({ username: 'ess_verified', passwordHash: 'x' });
  setUserTotpVerified(verified, 'enc', Date.now());

  assert.equal(effectiveSessionState(null), null);
  assert.equal(effectiveSessionState({ userId: tless, state: 'pending_totp' }), 'pending_totp', 'non-active passes through');
  assert.equal(effectiveSessionState({ userId: 1, state: 'active' }), 'active', 'root is exempt');

  setGuardConfig({ demoSignupOpen: true, demoSignupsPerIp: 0 });
  assert.equal(auth.demoModeOn(), true);
  assert.equal(effectiveSessionState({ userId: tless, state: 'active' }), 'active', 'demo on → TOTP-less honored');
  assert.equal(effectiveSessionState({ userId: verified, state: 'active' }), 'active');

  setGuardConfig({ demoSignupOpen: false });
  assert.equal(auth.demoModeOn(), false);
  assert.equal(effectiveSessionState({ userId: tless, state: 'active' }), 'needs_totp', 'demo off → downgraded');
  assert.equal(effectiveSessionState({ userId: verified, state: 'active' }), 'active', 'a verified account is never downgraded');

  setGuardConfig({ demoSignupOpen: true }); // restore for the flows below
});

test('register with demo mode ON → active session, no TOTP; the account works immediately', async () => {
  const res = await post('/api/auth/register', { username: 'demoalice', password: 'passphrase1' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.active, true);
  assert.ok(!body.pendingTotp && !body.qrDataUrl, 'no 2FA enrollment in the response');
  assert.equal(getAuthRow(getUserByUsername('demoalice').id).totp_verified_at, null, 'account has no verified TOTP');

  const cookie = cookieFrom(res);
  assert.ok(cookie, 'an active session cookie was set');
  const status = await (await get('/api/auth/status', cookie)).json();
  assert.equal(status.authenticated, true);
  assert.equal(status.demoMode, true);
  assert.equal((await get('/api/tasks', cookie)).status, 200, 'the gated API is reachable');
});

test('register with demo mode OFF → the classic pending_totp + QR path is unchanged', async () => {
  setGuardConfig({ demoSignupOpen: false });
  const res = await post('/api/auth/register', { username: 'strictbob', password: 'passphrase1' });
  const body = await res.json();
  assert.equal(body.pendingTotp, true);
  assert.ok(body.qrDataUrl && body.otpauthUri, 'a 2FA QR is returned');
  const cookie = cookieFrom(res);
  assert.equal((await get('/api/tasks', cookie)).status, 401, 'a pending_totp session is not yet usable');
  setGuardConfig({ demoSignupOpen: true }); // restore
});

test('login for a TOTP-less account: password-only while demo on; forced enrollment once demo off', async () => {
  // demoalice exists from an earlier test (TOTP-less). Log in fresh (a new session) while demo is on.
  const on = await post('/api/auth/login', { username: 'demoalice', password: 'passphrase1' });
  assert.equal(on.status, 200);
  assert.deepEqual(await on.json(), { ok: true }, 'demo on → straight in, no 2FA');

  setGuardConfig({ demoSignupOpen: false });
  const off = await post('/api/auth/login', { username: 'demoalice', password: 'passphrase1' });
  const body = await off.json();
  assert.equal(body.pendingTotp, true, 'demo off → resume enrollment');
  assert.ok(body.qrDataUrl && body.otpauthUri);
  setGuardConfig({ demoSignupOpen: true }); // restore
});

test('turning demo mode off force-marches a live demo session into 2FA, then verifying restores it', async () => {
  // A fresh demo account with a live active session.
  const reg = await post('/api/auth/register', { username: 'democarol', password: 'passphrase1' });
  const cookie = cookieFrom(reg);
  assert.equal((await get('/api/tasks', cookie)).status, 200, 'usable while demo is on');

  // Owner turns the demo off.
  setGuardConfig({ demoSignupOpen: false });
  assert.equal((await get('/api/tasks', cookie)).status, 401, 'the same session no longer passes the gate');
  const status = await (await get('/api/auth/status', cookie)).json();
  assert.equal(status.authenticated, false);
  assert.equal(status.needsTotp, true, 'the SPA is told to enroll 2FA');

  // Enroll from the still-active session (no current password required — nothing to protect yet).
  const setup = await (await post('/api/auth/totp/setup', {}, cookie)).json();
  assert.ok(setup.qrDataUrl && setup.otpauthUri);
  const code = await generate({ secret: secretOf(setup.otpauthUri) });
  const verify = await post('/api/auth/totp/verify', { code }, cookie);
  assert.deepEqual(await verify.json(), { ok: true });

  // The very same session is active again — even with demo still off — because the account is now verified.
  assert.ok(getAuthRow(getUserByUsername('democarol').id).totp_verified_at > 0);
  assert.equal((await get('/api/tasks', cookie)).status, 200, 'verified → back in with no re-login');
  setGuardConfig({ demoSignupOpen: true }); // restore
});

test('a signup while the demo is PAUSED is refused (503), before any account or seat is created', async () => {
  setGuardConfig({ demoSignupOpen: true, demoPaused: true, demoSignupsPerIp: 0 });
  const res = await post('/api/auth/register', { username: 'pauseddan', password: 'passphrase1' });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'DEMO_PAUSED');
  assert.equal(getUserByUsername('pauseddan'), null, 'no orphan row');
  setGuardConfig({ demoPaused: false });
});
