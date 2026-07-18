// TOTP 2FA (auth §9): enrollment parks a PENDING secret (encrypted at rest) without touching the users
// row; a live code promotes it (verified); a re-enroll keeps the OLD authenticator working until the new
// one is proven — a password alone can never swap in a fresh authenticator on a verified account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-authtotp-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate, db } = await import('../server/db.js');
const auth = await import('../server/auth.js');
const { getSetting } = await import('../server/settings.js');
const { getAuthRow } = await import('../server/repo.js');
const { generate } = await import('otplib');
migrate();

const secretOf = (uri) => new URL(uri).searchParams.get('secret');
// A code guaranteed wrong for `secret` (dodge the 1-in-a-million collision with the live code).
const wrongCodeFor = async (secret) => ((await generate({ secret })) === '000000' ? '111111' : '000000');

test('enrollment issues a QR + parks the secret PENDING and encrypted; the users row is untouched', async () => {
  const { otpauthUri, qrDataUrl } = await auth.beginTotpEnrollment(1, 'root');
  assert.ok(qrDataUrl.startsWith('data:image/png'), 'QR is a data-URL image');
  assert.ok(otpauthUri.startsWith('otpauth://totp/'), 'standard otpauth URI');
  assert.ok(secretOf(otpauthUri), 'the URI carries the base32 secret');
  assert.ok(auth.totpEnrollmentPending(1));
  const parked = getSetting('totp_pending:1', null);
  assert.match(parked, /^enc:(v1|t1):/, 'pending secret is encrypted at rest');
  const row = getAuthRow(1);
  assert.equal(row.totp_secret, null, 'nothing on the users row until a code proves the scan');
  assert.equal(row.totp_verified_at, null);
});

test('a wrong code does not verify; a live code promotes the secret (verified, encrypted)', async () => {
  const { otpauthUri } = await auth.beginTotpEnrollment(1, 'root');
  const secret = secretOf(otpauthUri);
  assert.equal(await auth.verifyTotpEnrollment(1, await wrongCodeFor(secret)), false);
  assert.equal(getAuthRow(1).totp_verified_at, null, 'still unverified after a wrong code');
  assert.equal(await auth.verifyTotpEnrollment(1, await generate({ secret })), true);
  const row = getAuthRow(1);
  assert.match(row.totp_secret, /^enc:(v1|t1):/, 'verified secret is encrypted at rest');
  assert.ok(row.totp_verified_at > 0);
  assert.equal(auth.totpEnrollmentPending(1), false, 'the parking spot is cleared');
  assert.equal(await auth.checkTotp(1, await generate({ secret })), true, 'login codes now work');
  assert.equal(await auth.checkTotp(1, await wrongCodeFor(secret)), false);
});

test('re-enroll: the OLD authenticator keeps working until the NEW one is proven', async () => {
  const oldSecret = secretOf((await auth.beginTotpEnrollment(1, 'root')).otpauthUri);
  await auth.verifyTotpEnrollment(1, await generate({ secret: oldSecret }));

  const newSecret = secretOf((await auth.beginTotpEnrollment(1, 'root')).otpauthUri); // re-enroll begins
  assert.notEqual(newSecret, oldSecret);
  assert.equal(await auth.checkTotp(1, await generate({ secret: oldSecret })), true, 'old codes still valid mid-re-enroll');
  assert.equal(await auth.checkTotp(1, await generate({ secret: newSecret })), false, 'new codes not live yet');

  assert.equal(await auth.verifyTotpEnrollment(1, await generate({ secret: newSecret })), true);
  assert.equal(await auth.checkTotp(1, await generate({ secret: newSecret })), true, 'new authenticator live');
  assert.equal(await auth.checkTotp(1, await generate({ secret: oldSecret })), false, 'old one retired');
});

test('verify with no pending enrollment is a plain false', async () => {
  assert.equal(auth.totpEnrollmentPending(1), false);
  assert.equal(await auth.verifyTotpEnrollment(1, '123456'), false);
});

test('garbage codes never throw', async () => {
  await auth.beginTotpEnrollment(1, 'root');
  for (const bad of [null, '', '12345', 'abcdef', '1234567', '12 34 56x']) {
    assert.equal(await auth.verifyTotpEnrollment(1, bad), false, `expected false for ${JSON.stringify(bad)}`);
  }
});
