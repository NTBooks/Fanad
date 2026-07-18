// The auth-mode switch (auth §9): env AUTH_MODE is only the DEFAULT until the DB holds a choice (telegram-
// pattern precedence), the config sanitizes its companions, and rootCredentialsReady demands the full set
// (username + password + VERIFIED 2FA) — the guard that makes flipping to 'simple' lockout-proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-authmode-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';
process.env.AUTH_MODE = 'simple'; // env default — must be set BEFORE config.js is imported

const { migrate } = await import('../server/db.js');
const { getAuthConfig, setAuthConfig } = await import('../server/settings.js');
const auth = await import('../server/auth.js');
const { setUserCredentials, getAuthRow } = await import('../server/repo.js');
const { generate } = await import('otplib');
migrate();

test('env AUTH_MODE is the default; a DB choice wins once set', () => {
  assert.equal(getAuthConfig().mode, 'simple', 'no DB value → the env default');
  setAuthConfig({ mode: 'none' });
  assert.equal(getAuthConfig().mode, 'none', 'the DB value wins over env');
  setAuthConfig({ mode: 'simple' });
  assert.equal(getAuthConfig().mode, 'simple');
  setAuthConfig({ mode: 'none' });
});

test('companions default off/empty and are sanitized', () => {
  const c = getAuthConfig();
  assert.equal(c.allowRegistration, false);
  assert.deepEqual(c.ipAllowlist, []);
  setAuthConfig({ ipAllowlist: ['  10.0.0.0/8 ', '', null, '1.2.3.4'] });
  assert.deepEqual(getAuthConfig().ipAllowlist, ['10.0.0.0/8', '1.2.3.4']);
  setAuthConfig({ ipAllowlist: [] });
  assert.deepEqual(getAuthConfig().ipAllowlist, []);
  // Junk mode values are ignored, not stored.
  setAuthConfig({ mode: 'yolo' });
  assert.equal(getAuthConfig().mode, 'none');
});

test('rootCredentialsReady demands username AND password AND a VERIFIED authenticator', async () => {
  assert.equal(auth.rootCredentialsReady(), false, 'fresh root has nothing set');
  setUserCredentials(1, { username: 'admin' });
  assert.equal(auth.rootCredentialsReady(), false, 'username alone is not enough');
  setUserCredentials(1, { passwordHash: await auth.hashPassword('hunter22!') });
  assert.equal(auth.rootCredentialsReady(), false, 'a PENDING (unverified) 2FA must not count');
  const { otpauthUri } = await auth.beginTotpEnrollment(1, 'admin');
  assert.equal(auth.rootCredentialsReady(), false, 'still pending');
  const secret = new URL(otpauthUri).searchParams.get('secret');
  assert.equal(await auth.verifyTotpEnrollment(1, await generate({ secret })), true);
  assert.equal(auth.rootCredentialsReady(), true, 'the full set unlocks the dropdown');
  assert.ok(getAuthRow(1).totp_verified_at > 0);
});
