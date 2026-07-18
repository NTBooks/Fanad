// Web login passwords (auth §9): scrypt hash/verify roundtrip, the self-describing stored format, and
// that malformed stored values fail closed (false, never a throw) — verifyPassword sits on the login path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-authpw-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';

const { migrate } = await import('../server/db.js');
const { hashPassword, verifyPassword, dummyPasswordHash } = await import('../server/auth.js');
migrate();

test('hash → verify roundtrip; the wrong password is rejected', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('correct horse battery stapl', stored), false);
  assert.equal(await verifyPassword('', stored), false);
});

test('the stored format is self-describing scrypt with a per-user salt', async () => {
  const a = await hashPassword('hunter22');
  const b = await hashPassword('hunter22');
  const parts = a.split(':');
  assert.equal(parts[0], 'scrypt');
  assert.equal(Number(parts[1]), 32768); // N
  assert.equal(Number(parts[2]), 8);     // r
  assert.equal(Number(parts[3]), 1);     // p
  assert.notEqual(a, b, 'same password, different salt → different hash');
  assert.equal(await verifyPassword('hunter22', b), true);
});

test('malformed stored values fail closed — false, never a throw', async () => {
  for (const bad of [null, undefined, '', 'garbage', 'scrypt:bad', 'scrypt:1:2:3:!!:!!', 'bcrypt$whatever']) {
    assert.equal(await verifyPassword('anything', bad), false, `expected false for ${JSON.stringify(bad)}`);
  }
});

test('dummyPasswordHash yields a real, verifiable-shape hash (the no-such-user timing burn)', async () => {
  const d = await dummyPasswordHash();
  assert.ok(d.startsWith('scrypt:'));
  assert.equal(await verifyPassword('any guess', d), false);
});
