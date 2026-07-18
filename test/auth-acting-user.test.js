// Acting-user resolution under web login (auth §9). Mode 'none' is byte-for-byte today's behavior
// (impersonation.test.js / impersonation-off.test.js). Mode 'simple' FLIPS the polarity: the session is
// the identity, the X-Fanad-User header is ignored entirely, and an absent/invalid session resolves to
// NOBODY (null → 401) — never root, or every expired cookie would be a privilege escalation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'fanad-authact-'));
process.env.LLM_PROVIDER = 'mock';
process.env.EMBED_PROVIDER = 'mock';
process.env.USER_IMPERSONATION = '1'; // the sharpest case: even with impersonation ON, login wins

const { migrate } = await import('../server/db.js');
const { defaultUserId, getOrCreateTelegramUser } = await import('../server/repo.js');
const { resolveActingUserId } = await import('../server/actingUser.js');
const { setAuthConfig } = await import('../server/settings.js');
migrate();

const other = getOrCreateTelegramUser(4242, 'other-person');

test('mode none: the impersonation header is honored (today\'s behavior)', () => {
  assert.equal(resolveActingUserId(String(other)), other);
  assert.equal(resolveActingUserId(''), defaultUserId());
});

test('mode simple: the session decides; the header is ignored even when both are present', () => {
  setAuthConfig({ mode: 'simple' });
  try {
    const active = { userId: other, state: 'active', tokenHash: 'x' };
    assert.equal(resolveActingUserId(null, active), other, 'active session wins');
    assert.equal(resolveActingUserId(String(defaultUserId()), active), other,
      'a header naming root must NOT override the session');
    assert.equal(resolveActingUserId(String(other), null), null,
      'a header with no session resolves to nobody — not root, not the named user');
    assert.equal(resolveActingUserId(null, { userId: other, state: 'pending_totp', tokenHash: 'y' }), null,
      'a pending (unfinished-2FA) session is not an identity');
    assert.equal(resolveActingUserId(undefined, undefined), null, 'nothing at all → nobody');
  } finally {
    setAuthConfig({ mode: 'none' });
  }
});

test('back to mode none: the header protocol resumes unchanged', () => {
  assert.equal(resolveActingUserId(String(other)), other);
  assert.equal(resolveActingUserId('999999'), defaultUserId(), 'bad header falls back to root again');
});
