// AUTH_RESET break-glass (auth §9): a boot with the flag forces the stored mode back to 'none' so a
// locked-out operator (lost phone, lost KEK) can reach the web UI again — but credentials and the verified
// authenticator are PRESERVED, so re-enabling login afterwards is one dropdown, not a re-enrollment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-authreset-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';
process.env.AUTH_RESET = '1'; // must be set BEFORE config.js is imported

const { migrate } = await import('../server/db.js');
const { getAuthConfig, setAuthConfig } = await import('../server/settings.js');
const auth = await import('../server/auth.js');
const { setUserCredentials, getAuthRow } = await import('../server/repo.js');
const { generate } = await import('otplib');
migrate();

test('AUTH_RESET forces mode → none and preserves every credential', async () => {
  // Arrange: a fully-enrolled root with login turned on (the locked-out deployment).
  setUserCredentials(1, { username: 'admin', passwordHash: await auth.hashPassword('hunter22!') });
  const { otpauthUri } = await auth.beginTotpEnrollment(1, 'admin');
  const secret = new URL(otpauthUri).searchParams.get('secret');
  await auth.verifyTotpEnrollment(1, await generate({ secret }));
  setAuthConfig({ mode: 'simple', allowRegistration: true });
  assert.equal(getAuthConfig().mode, 'simple');

  auth.applyAuthResetIfRequested(); // what index.js runs at boot

  const cfg = getAuthConfig();
  assert.equal(cfg.mode, 'none', 'login forced off');
  assert.equal(cfg.allowRegistration, true, 'other auth settings untouched');
  const row = getAuthRow(1);
  assert.equal(row.username, 'admin', 'username preserved');
  assert.ok(row.password_hash, 'password preserved');
  assert.ok(row.totp_verified_at, '2FA enrollment preserved');
  assert.equal(await auth.checkTotp(1, await generate({ secret })), true, 'the authenticator still verifies');

  // Idempotent: a second boot with the flag still set is a no-op.
  auth.applyAuthResetIfRequested();
  assert.equal(getAuthConfig().mode, 'none');
});
